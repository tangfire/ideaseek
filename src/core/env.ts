import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared KEY=VALUE line ingestion. Precedence (order-independent):
 * a non-empty value we never wrote is the real host env and always wins;
 * among files the credentials file (rank 1) outranks a local .env (rank 2);
 * a re-read of the same file refreshes the value (key rotation without
 * restart). An empty/blank existing value is treated as unset so a stray
 * `KEY=` line cannot shadow a real key. Values are never logged or returned
 * (only names), comments/blank lines skipped, malformed lines ignored.
 */
const RANK_CREDENTIALS = 1;
const RANK_LOCAL = 2;
const ingestedRank = new Map<string, number>();

function ingestEnvText(text: string, loaded: string[], rank: number): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (!/^[A-Z0-9_]+$/i.test(key)) continue;
    const existing = process.env[key];
    if (existing !== undefined && existing.trim() !== '') {
      const prior = ingestedRank.get(key);
      if (prior === undefined || prior < rank) continue; // host env or higher-ranked file wins
    }
    process.env[key] = value;
    ingestedRank.set(key, rank);
    loaded.push(key); // names only — never values
  }
}

/**
 * Loads KEY=VALUE pairs from a local .env into process.env WITHOUT overriding
 * variables that are already set, and without ever logging or returning the
 * values (docs: credentials stay in the host environment; .env is gitignored).
 * Search order: <cwd>/.env then the package root .env (dev repo / install).
 */
export function loadLocalEnv(cwd: string = process.cwd()): string[] {
  const candidates = [join(cwd, '.env'), packageRootEnv()];
  const loaded: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    let text: string;
    try {
      text = readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    ingestEnvText(text, loaded, RANK_LOCAL);
  }
  return loaded;
}

/**
 * The user-level credentials file `/models setup` writes to: sibling of the
 * user config (IDEASEEK_USER_CONFIG override honored, so tests isolate),
 * default `~/.ideaseek/credentials.env`. Same path logic as
 * user-config.ts userConfigPath — kept local to avoid a core→config import.
 * This file is the ONLY on-disk home for a key value: 0600, outside any
 * repo, never echoed — the no-store boundary covers config/git/logs/events.
 */
export function userCredentialsPath(): string {
  const override = process.env.IDEASEEK_USER_CONFIG;
  const cfg =
    override && override.trim() ? override.trim() : join(homedir(), '.ideaseek', 'config.yaml');
  return join(dirname(cfg), 'credentials.env');
}

/**
 * Loads the user credentials file into process.env (same contract as
 * loadLocalEnv: host env wins, names only). Runs at CLI startup so every
 * consumer — doctor, models test, harness — sees the key exactly as if it
 * had been exported, while `/models setup` remains the only journey a user
 * needs: save once, works in every later shell and child process.
 */
export function loadUserCredentials(): string[] {
  const path = userCredentialsPath();
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const loaded: string[] = [];
  ingestEnvText(text, loaded, RANK_CREDENTIALS);
  return loaded;
}

function packageRootEnv(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/core or dist/core -> package root
    return join(here, '..', '..', '.env');
  } catch {
    return '';
  }
}
