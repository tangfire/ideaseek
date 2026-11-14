import { homedir } from 'node:os';
import { IdeaseekError } from '../core/errors.js';
import { join } from 'node:path';

/**
 * User-level configuration (PRODUCT_GAPS #3, CONFIG_SPEC): provider and
 * credential REFERENCES, default model route, notification webhooks and
 * notification preferences live in ~/.ideaseek/config.yaml — never in a
 * project's research.yaml. A credential reference is a NAME
 * (`env:DEEPSEEK_API_KEY` or `dsh:<store-id>`); embedding an actual secret
 * value in either config layer is a hard error.
 */

export interface UserConfig {
  version: 1;
  models: {
    provider: string;
    defaultRoute: string;
    /** e.g. env:DEEPSEEK_API_KEY or dsh:deepseek — never a raw value. */
    credentialRef: string | null;
  };
  notifications: {
    enabled: boolean;
    webhook: string | null;
  };
}

export interface LoadedUserConfig {
  config: UserConfig;
  path: string;
  existed: boolean;
  /** Per-field provenance: user-default | user-file. */
  sources: Record<string, 'user-default' | 'user-file'>;
  errors: string[];
}

export function userConfigPath(): string {
  const override = process.env.IDEASEEK_USER_CONFIG;
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.ideaseek', 'config.yaml');
}

export function defaultUserConfig(): UserConfig {
  return {
    version: 1,
    models: {
      provider: 'deepseek-official',
      defaultRoute: 'default',
      credentialRef: null,
    },
    notifications: { enabled: false, webhook: null },
  };
}

const CREDENTIAL_REF = /^(env:[A-Za-z_][A-Za-z0-9_]*|dsh:[a-z0-9-]+)$/;

/**
 * Validates raw user-config YAML/JSON-ish object. Strict: unknown fields and
 * secret-shaped values are errors (a typo must never silently become a
 * default, and a secret must never be stored here).
 */
export function validateUserConfig(raw: unknown): {
  config: UserConfig;
  sources: LoadedUserConfig['sources'];
  errors: string[];
} {
  const config = defaultUserConfig();
  const sources: LoadedUserConfig['sources'] = {
    'models.provider': 'user-default',
    'models.defaultRoute': 'user-default',
    'models.credentialRef': 'user-default',
    'notifications.enabled': 'user-default',
    'notifications.webhook': 'user-default',
  };
  const errors: string[] = [];
  if (raw === null || raw === undefined) return { config, sources, errors };
  if (!isObject(raw)) return { config, sources, errors: ['user config must be a mapping'] };

  const known = new Set(['version', 'models', 'notifications']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push(`unknown key: ${key}`);
  }
  if (raw.version !== undefined && raw.version !== 1) {
    errors.push(`unsupported user config version: ${String(raw.version)} (expected 1)`);
  }

  if (raw.models !== undefined) {
    if (!isObject(raw.models)) {
      errors.push('models must be a mapping');
    } else {
      const models = raw.models;
      for (const key of Object.keys(models)) {
        if (!['provider', 'defaultRoute', 'credentialRef'].includes(key)) {
          errors.push(`unknown key: models.${key}`);
        }
      }
      if (models.provider !== undefined) {
        if (typeof models.provider !== 'string' || !models.provider.trim()) {
          errors.push('models.provider must be a non-empty string');
        } else {
          config.models.provider = models.provider.trim();
          sources['models.provider'] = 'user-file';
        }
      }
      if (models.defaultRoute !== undefined) {
        if (
          typeof models.defaultRoute !== 'string' ||
          !/^[a-z0-9][a-z0-9-]*$/.test(models.defaultRoute)
        ) {
          errors.push('models.defaultRoute must be kebab-case');
        } else {
          config.models.defaultRoute = models.defaultRoute;
          sources['models.defaultRoute'] = 'user-file';
        }
      }
      if (models.credentialRef !== undefined && models.credentialRef !== null) {
        if (typeof models.credentialRef !== 'string') {
          errors.push('models.credentialRef must be a string reference (env:NAME or dsh:id)');
        } else if (/sk-|Bearer\s|api[_-]?key\s*=/i.test(models.credentialRef)) {
          errors.push(
            'models.credentialRef looks like a SECRET VALUE — store only references ' +
              '(env:DEEPSEEK_API_KEY or dsh:<id>); secrets never enter any config file',
          );
        } else if (!CREDENTIAL_REF.test(models.credentialRef)) {
          errors.push('models.credentialRef must match env:NAME or dsh:id');
        } else {
          config.models.credentialRef = models.credentialRef;
          sources['models.credentialRef'] = 'user-file';
        }
      }
    }
  }

  if (raw.notifications !== undefined) {
    if (!isObject(raw.notifications)) {
      errors.push('notifications must be a mapping');
    } else {
      for (const key of Object.keys(raw.notifications)) {
        if (!['enabled', 'webhook'].includes(key)) {
          errors.push(`unknown key: notifications.${key}`);
        }
      }
      const notes = raw.notifications as { enabled?: unknown; webhook?: unknown };
      if (notes.enabled !== undefined) {
        if (typeof notes.enabled !== 'boolean') {
          errors.push('notifications.enabled must be a boolean');
        } else {
          config.notifications.enabled = notes.enabled;
          sources['notifications.enabled'] = 'user-file';
        }
      }
      if (notes.webhook !== undefined && notes.webhook !== null) {
        if (typeof notes.webhook !== 'string' || !/^https?:\/\//.test(notes.webhook)) {
          errors.push('notifications.webhook must be an http(s) URL');
        } else if (/sk-|token=/i.test(notes.webhook)) {
          errors.push('notifications.webhook must not embed tokens/secrets');
        } else {
          config.notifications.webhook = notes.webhook;
          sources['notifications.webhook'] = 'user-file';
        }
      }
    }
  }

  return { config, sources, errors };
}

/**
 * Loads ~/.ideaseek/config.yaml (or IDEASEEK_USER_CONFIG). Missing file →
 * defaults with zero errors. Parse/validation problems are returned, never
 * thrown, so `doctor`/`config explain` can report them.
 */
export async function loadUserConfig(): Promise<LoadedUserConfig> {
  const path = userConfigPath();
  const base: LoadedUserConfig = {
    config: defaultUserConfig(),
    path,
    existed: false,
    sources: {},
    errors: [],
  };
  let text: string;
  try {
    const { readFile } = await import('node:fs/promises');
    text = await readFile(path, 'utf8');
  } catch {
    const defaults = validateUserConfig(null);
    return { ...base, sources: defaults.sources, errors: [] };
  }
  base.existed = true;
  let raw: unknown;
  try {
    const { parse } = await import('yaml');
    raw = parse(text);
  } catch (error) {
    return { ...base, errors: [`user config is not valid YAML: ${(error as Error).message}`] };
  }
  const validated = validateUserConfig(raw);
  return {
    config: validated.config,
    path,
    existed: true,
    sources: validated.sources,
    errors: validated.errors,
  };
}

/**
 * Safely patches the models block of the user config (the missing setter
 * `models setup` needs). Reuses validateUserConfig as the authority:
 * unknown keys, secret-shaped values and bad refs are hard errors — the
 * file on disk is re-validated as a WHOLE before any write, and the
 * write is atomic. Never accepts or stores a key VALUE.
 */
export async function saveUserModelsPatch(patch: {
  provider?: string;
  credentialRef?: string;
  defaultRoute?: string;
}): Promise<{ path: string; changed: string[] }> {
  const path = userConfigPath();
  const { readFile } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  let text: string | null = null;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = null; // missing file → defaults
  }
  let raw: unknown = null;
  if (text !== null) {
    try {
      raw = parse(text);
    } catch (error) {
      // Invalid existing YAML must NEVER be clobbered by a patch.
      throw new IdeaseekError(
        'INVALID_ARGUMENT',
        `refusing to patch unreadable user config ${path}: ${(error as Error).message}`,
      );
    }
  }
  const base =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const modelsRaw =
    base.models && typeof base.models === 'object' && !Array.isArray(base.models)
      ? { ...(base.models as Record<string, unknown>) }
      : {};
  const changed: string[] = [];
  if (patch.provider !== undefined) {
    modelsRaw.provider = patch.provider;
    changed.push('models.provider');
  }
  if (patch.credentialRef !== undefined) {
    modelsRaw.credentialRef = patch.credentialRef;
    changed.push('models.credentialRef');
  }
  if (patch.defaultRoute !== undefined) {
    modelsRaw.defaultRoute = patch.defaultRoute;
    changed.push('models.defaultRoute');
  }
  const nextRaw: Record<string, unknown> = { ...base, models: modelsRaw };
  if (nextRaw.version === undefined) nextRaw.version = 1;
  const validated = validateUserConfig(nextRaw);
  if (validated.errors.length > 0) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `refusing to save user config: ${validated.errors.join('; ')}`,
      { errors: validated.errors },
    );
  }
  const { stringify } = await import('yaml');
  const { writeFileAtomic, ensureDir } = await import('../core/atomic.js');
  const { dirname } = await import('node:path');
  await ensureDir(dirname(path));
  await writeFileAtomic(
    path,
    `${stringify(nextRaw)}
`,
  );
  return { path, changed };
}

/** Resolves a credential reference to presence-only status (never the value). */
export function resolveCredentialPresence(ref: string | null): {
  ref: string | null;
  presence: 'not-configured' | 'configured' | 'missing' | 'store';
} {
  if (!ref) return { ref: null, presence: 'not-configured' };
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const value = process.env[name];
    return { ref, presence: value && value.trim() ? 'configured' : 'missing' };
  }
  if (ref.startsWith('dsh:')) return { ref, presence: 'store' };
  return { ref, presence: 'missing' };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
