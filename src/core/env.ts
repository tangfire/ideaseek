import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      if (process.env[key] !== undefined) continue; // host env wins
      process.env[key] = value;
      loaded.push(key); // names only — never values
    }
  }
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
