import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeApiKey } from '../dsh/api-key.js';
import { IdeaseekError } from '../core/errors.js';
import { loadUserCredentials } from '../core/env.js';

/**
 * `/models setup` machinery (docs/CLI_SPEC 模型配置, docs/MODEL_ROUTING
 * 设计目标): hidden key input, DSH credential wiring, minimal connection
 * test and redacted recovery.
 *
 * Secret boundary (owner ruling, 2026-11-19 — the journey is "/models
 * setup once, works everywhere"): a key VALUE lives in exactly one on-disk
 * place — the user credentials file (`credentials.env` beside the user
 * config, mode 0600, outside any repo, written only from hidden input) —
 * or in the host environment / secret manager. Everything IdeaSeek holds
 * as CONFIG stays value-free: DSH provider config stores `apiKeyEnv` (the
 * NAME), user config stores only `credentialRef` (env:NAME / dsh:id).
 * Nothing here logs or echoes the value; a failed connection test writes
 * nothing at all.
 */

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function dshHome(): string {
  const override = process.env.DSH_HOME;
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.dsh');
}

export function dshSettingsPath(): string {
  return join(dshHome(), 'settings.yaml');
}

/** Env-var names only — anything secret-shaped is a config smell, not a name. */
export function assertEnvName(name: string): void {
  // Secret-shaped input gets the specific refusal first (better recovery
  // than the generic name rule).
  if (/sk-|Bearer|api[_-]?key\s*=/i.test(name)) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      '--api-key-env looks like a SECRET VALUE — pass only the variable NAME; secrets never enter config files',
    );
  }
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `--api-key-env must be an environment VARIABLE NAME (e.g. DEEPSEEK_API_KEY), got "${name.slice(0, 40)}"`,
    );
  }
}

export function assertProviderId(provider: string): void {
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `--provider must be kebab-case (got "${provider.slice(0, 40)}")`,
    );
  }
}

/**
 * Persists a validated key value to the user credentials file — the single
 * on-disk home for secrets (see the boundary note above). Same-name lines
 * are replaced, other lines survive, the file is created 0700/0600
 * best-effort (Windows maps modes loosely). The value never appears in any
 * message, payload or error; callers pass it in and drop their copy.
 */
export async function saveUserCredential(
  name: string,
  value: string,
): Promise<{ path: string; created: boolean }> {
  assertEnvName(name);
  if (/[\r\n]/.test(value)) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      'API key must not contain line breaks — nothing was saved',
    );
  }
  const { userCredentialsPath } = await import('../core/env.js');
  const { readFile, mkdir, chmod } = await import('node:fs/promises');
  const { writeFileAtomic } = await import('../core/atomic.js');
  const path = userCredentialsPath();
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    existing = '';
  }
  const kept = existing
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith(`${name}=`));
  kept.push(`${name}=${value}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${kept.join('\n')}\n`);
  try {
    await chmod(path, 0o600);
  } catch {
    // best effort — a platform without POSIX modes still gets the file
    // outside any repo, which is the boundary that matters.
  }
  return { path, created: existing.length === 0 };
}

export interface DshProviderView {
  provider: string;
  apiKeyEnv: string | null;
  baseURL: string | null;
  api: string | null;
  exists: boolean;
}

/** Reads one provider's credential wiring from DSH settings (names only). */
export async function readDshProvider(provider: string): Promise<DshProviderView> {
  const { readFile } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  let doc: unknown = null;
  try {
    doc = parse(await readFile(dshSettingsPath(), 'utf8'));
  } catch {
    doc = null;
  }
  const root = (doc ?? {}) as Record<string, unknown>;
  const llm = root['llm-pi-ai'] as Record<string, unknown> | undefined;
  const providers = llm?.providers as Record<string, unknown> | undefined;
  const entry = providers?.[provider] as Record<string, unknown> | undefined;
  if (!entry) {
    return { provider, apiKeyEnv: null, baseURL: null, api: null, exists: false };
  }
  return {
    provider,
    apiKeyEnv: typeof entry.apiKeyEnv === 'string' ? entry.apiKeyEnv : null,
    baseURL: typeof entry.baseURL === 'string' ? entry.baseURL : null,
    api: typeof entry.api === 'string' ? entry.api : null,
    exists: true,
  };
}

export interface DshSettingsWrite {
  provider: string;
  apiKeyEnv: string;
  created: boolean;
  path: string;
}

/**
 * The only endpoints IdeaSeek will assume. Deliberately one entry: an endpoint
 * guessed wrong costs a failed connection test, not a corrupted research run,
 * so unknown providers stay explicit about their base URL.
 */
export const KNOWN_PROVIDERS: readonly { id: string; baseUrl: string; api: string }[] = [
  { id: 'deepseek', baseUrl: 'https://api.deepseek.com', api: 'openai-completions' },
];

export function knownBaseUrl(provider: string): string | undefined {
  return KNOWN_PROVIDERS.find((entry) => entry.id === provider)?.baseUrl;
}

export interface ProviderListing {
  id: string;
  /** From DSH settings when present, else the known default, else null. */
  baseUrl: string | null;
  apiKeyEnv: string | null;
  known: boolean;
  configured: boolean;
}

/**
 * Known defaults merged with whatever DSH settings.yaml already declares.
 * Reads names and endpoints only — credential values are never loaded here.
 */
export async function listProviders(): Promise<ProviderListing[]> {
  const { readFile } = await import('node:fs/promises');
  const { parseDocument } = await import('yaml');
  const known = new Map(KNOWN_PROVIDERS.map((entry) => [entry.id, entry]));
  const found = new Map<string, { apiKeyEnv: string | null; baseURL: string | null }>();
  try {
    const doc = parseDocument(await readFile(dshSettingsPath(), 'utf8'));
    if (doc.errors.length === 0) {
      const providers = doc.getIn(['llm-pi-ai', 'providers']) as
        Record<string, { apiKeyEnv?: unknown; baseURL?: unknown }> | undefined;
      for (const [id, entry] of Object.entries(providers ?? {})) {
        found.set(id, {
          apiKeyEnv: typeof entry?.apiKeyEnv === 'string' ? entry.apiKeyEnv : null,
          baseURL: typeof entry?.baseURL === 'string' ? entry.baseURL : null,
        });
      }
    }
  } catch {
    // No settings file yet: the catalog is still the known defaults.
  }
  const ids = [...new Set([...known.keys(), ...found.keys()])];
  return ids.map((id) => {
    const entry = found.get(id);
    return {
      id,
      baseUrl: entry?.baseURL ?? known.get(id)?.baseUrl ?? null,
      apiKeyEnv: entry?.apiKeyEnv ?? null,
      known: known.has(id),
      configured: entry !== undefined,
    };
  });
}

/**
 * Sets `llm-pi-ai.providers.<id>.apiKeyEnv` (a NAME) via yaml Document
 * round-trip — comments and unrelated keys are preserved. Creating a
 * provider requires an explicit --base-url (well-known deepseek endpoint
 * excepted); no other silent defaults.
 */
export async function writeDshApiKeyEnv(
  provider: string,
  envName: string,
  opts: { baseUrl?: string; api?: string } = {},
): Promise<DshSettingsWrite> {
  assertProviderId(provider);
  assertEnvName(envName);
  const { readFile } = await import('node:fs/promises');
  const { writeFileAtomic, ensureDir } = await import('../core/atomic.js');
  const { dirname } = await import('node:path');
  const { parseDocument } = await import('yaml');
  const path = dshSettingsPath();
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = '';
  }
  const doc = parseDocument(text || 'llm-pi-ai:\n  providers: {}\n');
  if (doc.errors.length > 0) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `DSH settings ${path} is not valid YAML — fix it first (${doc.errors[0]?.message ?? 'parse error'})`,
    );
  }
  let created = false;
  if (doc.getIn(['llm-pi-ai', 'providers', provider]) === undefined) {
    const baseUrl = opts.baseUrl ?? knownBaseUrl(provider);
    if (!baseUrl) {
      throw new IdeaseekError(
        'USER_INPUT_REQUIRED',
        `provider "${provider}" is not in ${path} — pass --base-url to create it (no silent defaults)`,
      );
    }
    doc.setIn(
      ['llm-pi-ai', 'providers', provider],
      doc.createNode({
        displayName: provider,
        api: opts.api ?? 'openai-completions',
        baseURL: baseUrl,
        apiKeyEnv: envName,
      }),
    );
    created = true;
  } else {
    doc.setIn(['llm-pi-ai', 'providers', provider, 'apiKeyEnv'], envName);
  }
  // Belt and braces: never persist key-shaped material anywhere here.
  const serialized = doc.toString();
  if (/sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9]/.test(serialized)) {
    throw new IdeaseekError(
      'INTERNAL',
      'refusing to write DSH settings: serialized document contains key-shaped material',
    );
  }
  await ensureDir(dirname(path));
  await writeFileAtomic(path, serialized);
  return { provider, apiKeyEnv: envName, created, path };
}

export interface ConnectionTestResult {
  ok: boolean;
  status: number | null;
  /** Redacted detail — never the key, never raw response bodies. */
  detail: string;
}

/**
 * Minimal connectivity probe: GET <baseURL>/models with the key in the
 * Authorization header. Errors are classified and redacted; the key is
 * never included in the result or thrown messages.
 */
export async function connectionTest(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<ConnectionTestResult> {
  let url: URL;
  try {
    url = new URL(baseUrl.replace(/\/+$/, '') + '/models');
  } catch {
    return { ok: false, status: null, detail: 'base URL is not a valid URL' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (response.ok) {
      let count = 0;
      try {
        const body = (await response.json()) as { data?: unknown[] };
        count = Array.isArray(body.data) ? body.data.length : 0;
      } catch {
        count = 0;
      }
      return {
        ok: true,
        status: response.status,
        detail: `GET ${url.pathname} → ${response.status} (${count} model(s) listed)`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        detail: `GET ${url.pathname} → ${response.status} (rejected: key not accepted — check the env var value and provider)`,
      };
    }
    return {
      ok: false,
      status: response.status,
      detail: `GET ${url.pathname} → ${response.status} (provider error)`,
    };
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    const redacted = message
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
      .slice(0, 200);
    return { ok: false, status: null, detail: `connection failed: ${redacted}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Shape-checks a supplied key with DSH's own normalizeApiKey. */
export function normalizeSuppliedKey(
  raw: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const check = normalizeApiKey(raw);
  if (check.ok) return { ok: true, value: check.value };
  return { ok: false, reason: check.reason };
}

/**
 * Resolves the key VALUE for a connection test without persisting it:
 * explicit in-memory value > process.env[envName]. Returns presence only
 * to callers that do not need the value.
 */
export function resolveTestKey(
  explicit: string | null,
  envName: string,
): { present: boolean; value: string | null; source: 'stdin' | 'env' | 'none' } {
  // Just-in-time reload: the credentials file may be written after this
  // process started — `models test` must see a key saved seconds ago
  // without the user restarting anything.
  loadUserCredentials();
  if (explicit !== null && explicit.length > 0) {
    return { present: true, value: explicit, source: 'stdin' };
  }
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) {
    return { present: true, value: fromEnv, source: 'env' };
  }
  return { present: false, value: null, source: 'none' };
}
