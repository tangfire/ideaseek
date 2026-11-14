import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeApiKey } from '../dsh/api-key.js';
import { IdeaseekError } from '../core/errors.js';

/**
 * `/models setup` machinery (docs/CLI_SPEC 模型配置, docs/MODEL_ROUTING
 * 设计目标): hidden key input, DSH credential wiring, minimal connection
 * test and redacted recovery.
 *
 * Secret boundary (hard rule): IdeaSeek NEVER writes a key VALUE to any
 * file it controls. The DSH provider config stores `apiKeyEnv` — the
 * NAME of an environment variable (the pinned DSH's own credential
 * mechanism); user config stores only `credentialRef` (env:NAME /
 * dsh:id). A supplied key lives in memory for the connection test and
 * is discarded. Nothing here logs, persists or echoes the value.
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
 * The only endpoints IdeaSeek will assume. Kept here so the write path and the
 * connection test agree — a user configuring DeepSeek should not have to pass
 * `--base-url` twice to reach a host everyone knows.
 */
export function knownBaseUrl(provider: string): string | undefined {
  return provider === 'deepseek' ? 'https://api.deepseek.com' : undefined;
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
  if (explicit !== null && explicit.length > 0) {
    return { present: true, value: explicit, source: 'stdin' };
  }
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) {
    return { present: true, value: fromEnv, source: 'env' };
  }
  return { present: false, value: null, source: 'none' };
}
