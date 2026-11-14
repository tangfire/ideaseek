import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Workspace autocomplete index for `@` mentions and slash sub-arguments
 * (docs/TERMINAL_UX.md). Read-only, bounded filesystem scan — never modifies
 * inputs, never spawns subprocesses, never holds database locks.
 */

export interface CompletionEntry {
  kind: 'mention' | 'arg';
  value: string;
  label: string;
  description: string;
}

const MENTION_ROOTS = [
  'papers',
  'datasets',
  'comparisons',
  'ideas',
  'knowledge',
  'reports',
  'incoming',
] as const;

const MAX_ENTRIES = 160;
const MAX_DEPTH = 2;

async function walkDir(
  root: string,
  rel: string,
  depth: number,
  out: CompletionEntry[],
): Promise<void> {
  if (out.length >= MAX_ENTRIES || depth > MAX_DEPTH) return;
  const full = join(root, rel);
  let entries;
  try {
    entries = await readdir(full, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) break;
    if (
      entry.name.startsWith('.') ||
      entry.name === 'node_modules' ||
      entry.name === '__pycache__'
    ) {
      continue;
    }
    const nextRel = `${rel}/${entry.name}`.replace(/\\/g, '/');
    const topKind = rel.split('/')[0] ?? 'file';
    if (entry.isDirectory()) {
      out.push({
        kind: 'mention',
        value: `@${nextRel}`,
        label: `@${nextRel}/`,
        description: `${topKind} directory`,
      });
      await walkDir(root, nextRel, depth + 1, out);
    } else if (entry.isFile()) {
      out.push({
        kind: 'mention',
        value: `@${nextRel}`,
        label: `@${nextRel}`,
        description: `${topKind} file`,
      });
    }
  }
}

/** Collects `@path` candidates from the project's research directories. */
export async function scanWorkspaceMentions(cwd: string): Promise<CompletionEntry[]> {
  const out: CompletionEntry[] = [];
  for (const rootDir of MENTION_ROOTS) {
    if (out.length >= MAX_ENTRIES) break;
    await walkDir(cwd, rootDir, 1, out);
  }
  return out;
}

/** Filters mention candidates by fuzzy substring match (prefix matches first). */
export function filterMentions(
  candidates: readonly CompletionEntry[],
  rawQuery: string,
  limit = 16,
): CompletionEntry[] {
  const query = rawQuery.replace(/^@/, '').trim().toLowerCase();
  if (!query) return candidates.slice(0, limit);
  const scored: { entry: CompletionEntry; score: number }[] = [];
  for (const entry of candidates) {
    const hay = entry.label.toLowerCase();
    const idx = hay.indexOf(query);
    if (idx === -1) continue;
    // Favor filename / segment boundary matches and shorter paths.
    const boundaryBonus = idx === 1 || hay[idx - 1] === '/' ? -20 : 0;
    scored.push({ entry, score: idx + boundaryBonus + hay.length * 0.01 });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((item) => item.entry);
}

const SLASH_ARG_MAP: Readonly<Record<string, readonly CompletionEntry[]>> = {
  '/mode': [
    { kind: 'arg', value: 'research', label: 'research', description: 'scientific workflow tier' },
    {
      kind: 'arg',
      value: 'analysis',
      label: 'analysis',
      description: 'read-only material prep tier',
    },
    { kind: 'arg', value: 'coding', label: 'coding', description: 'switch focus to DSH coding' },
    {
      kind: 'arg',
      value: '--strategy starter',
      label: '--strategy starter',
      description: 'explore without requiring full comparisons',
    },
    {
      kind: 'arg',
      value: '--strategy standard',
      label: '--strategy standard',
      description: 'balanced research gate budget',
    },
  ],
  '/models': [
    { kind: 'arg', value: 'list', label: 'list', description: 'show active tier model routes' },
    {
      kind: 'arg',
      value: 'providers',
      label: 'providers',
      description: 'show configured model providers',
    },
    { kind: 'arg', value: 'setup', label: 'setup', description: 'configure provider API key' },
    {
      kind: 'arg',
      value: 'test --route deep',
      label: 'test --route deep',
      description: 'verify model connectivity',
    },
  ],
  '/ideate': [
    {
      kind: 'arg',
      value: '--round new',
      label: '--round new',
      description: 'start a fresh ideation round',
    },
    {
      kind: 'arg',
      value: '--continue',
      label: '--continue',
      description: 'continue active ideation round',
    },
  ],
  '/rounds': [
    { kind: 'arg', value: 'list', label: 'list', description: 'list all ideation rounds' },
    { kind: 'arg', value: 'show ', label: 'show <id>', description: 'inspect a specific round' },
  ],
  '/open': [
    {
      kind: 'arg',
      value: '--confirm',
      label: '--confirm',
      description: 'confirm switching session project',
    },
  ],
};

/** Returns argument suggestions when typing `<slash-cmd> <arg-prefix>`. */
export function getSlashArgSuggestions(
  command: string,
  argFragment: string,
  dynamicOpenTargets: readonly CompletionEntry[] = [],
): CompletionEntry[] {
  const staticArgs = SLASH_ARG_MAP[command] ?? [];
  const pool = command === '/open' ? [...dynamicOpenTargets, ...staticArgs] : staticArgs;
  if (pool.length === 0) return [];
  const needle = argFragment.trim().toLowerCase();
  if (!needle) return [...pool];
  return pool.filter(
    (entry) =>
      entry.label.toLowerCase().includes(needle) || entry.value.toLowerCase().includes(needle),
  );
}
