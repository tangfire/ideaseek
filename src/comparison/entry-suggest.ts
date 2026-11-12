import type { EntryCandidate, RepositoryUnderstanding } from '../knowledge/repository.js';

/**
 * Wrapper/smoke flow for the Codebase Analyst (Phase 4): turns discovered
 * entry candidates into BOUNDED, explicitly-confirmed smoke commands.
 *
 * Safety rules:
 * - Nothing here executes anything — suggestions are printed and only an
 *   explicit `--apply` persists one (the analyst's needsConfirmation gate).
 * - Wrappers are non-training by construction: test entries become a
 *   pytest invocation, everything else an argparse-style `--help` probe
 *   that imports the module and parses the CLI without running training.
 */

export interface EntrySuggestion {
  kind: 'test' | 'eval' | 'train' | 'other';
  path: string;
  confidence: number;
  /** Bounded argv to run inside the worktree (never auto-executed). */
  argv: string[];
  /** What passing this command actually proves. */
  verifies: string;
}

const KIND_PREFERENCE: Record<EntrySuggestion['kind'], number> = {
  test: 0,
  eval: 1,
  train: 2,
  other: 3,
};

function toSuggestion(candidate: EntryCandidate, kind: EntrySuggestion['kind']): EntrySuggestion {
  if (kind === 'test') {
    return {
      kind,
      path: candidate.path,
      confidence: candidate.confidence,
      argv: ['python', '-m', 'pytest', candidate.path, '-x', '-q'],
      verifies: 'tests execute in the isolated worktree (bounded, no training)',
    };
  }
  const boundedNote =
    kind === 'train'
      ? 'module imports and the CLI parses (bounded — never trains)'
      : 'module imports and the CLI parses (bounded)';
  return {
    kind,
    path: candidate.path,
    confidence: candidate.confidence,
    argv: ['python', candidate.path, '--help'],
    verifies: boundedNote,
  };
}

/**
 * Deterministic suggestion list: test → eval → train → other, ties broken
 * by confidence then path; capped at `limit`.
 */
export function buildEntrySuggestions(
  understanding: RepositoryUnderstanding,
  limit = 5,
): EntrySuggestion[] {
  const groups: [EntrySuggestion['kind'], EntryCandidate[]][] = [
    ['test', understanding.entrypoints.test],
    ['eval', understanding.entrypoints.evaluation],
    ['train', understanding.entrypoints.training],
    ['other', understanding.entrypoints.other],
  ];
  const all: EntrySuggestion[] = [];
  for (const [kind, candidates] of groups) {
    for (const candidate of candidates) all.push(toSuggestion(candidate, kind));
  }
  all.sort(
    (a, b) =>
      KIND_PREFERENCE[a.kind] - KIND_PREFERENCE[b.kind] ||
      b.confidence - a.confidence ||
      a.path.localeCompare(b.path),
  );
  return all.slice(0, limit);
}
