import { expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSchemaNames } from '../src/core/schema/index.js';

/**
 * Every schema name a prompt asks the model to return has to resolve in the
 * registry. `comparison implement` shipped asking for
 * `implementation-program-v1` while the registry entry and its JSON file were
 * still uncommitted: typecheck passed, tests passed, and the first call on a
 * fresh clone would fail. The constants are the only place that couples the two
 * sides, so they are what this asserts.
 */
async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry_ of await readdir(dir, { withFileTypes: true })) {
    if (entry_.isDirectory() && !['node_modules', 'dist', '.git'].includes(entry_.name)) {
      found.push(...(await sourceFiles(join(dir, entry_.name))));
    } else if (entry_.name.endsWith('.ts')) {
      found.push(join(dir, entry_.name));
    }
  }
  return found;
}

/**
 * Contract names a prompt asks the model to return. Two kinds exist and the
 * difference matters: a name in the registry is validated before it is trusted,
 * a name outside it is decoration in the prompt text and nothing else.
 *
 * `comparison implement` shipped asking for `implementation-program-v1` while
 * its registry entry and JSON file were still uncommitted — typecheck green,
 * tests green, first call on a fresh clone broken. Anything validated must
 * therefore resolve here, and anything not validated has to be declared as
 * unvalidated rather than drift in unnoticed.
 */
const VALIDATED_ELSEWHERE = new Set(['implementation-program-v1']);

/**
 * Prompt-only contracts with no validator. Recorded as debt on purpose: each
 * one is an agent output the platform accepts on trust. Adding a name here is
 * the deliberate step; silently not noticing it is what this test prevents.
 */
const PROMPT_ONLY_CONTRACTS = new Set([
  'reproduction-blueprint-v1',
  'dependency-plan-v1',
  'comparison-matrix-v1',
  'comparison-matrix-proposal-v1',
  'fairness-lock-v1',
  'full-plan-v1',
  'dataset-discovery-v1',
  'mechanism-analysis-v1',
  'idea-discuss-v1',
  'idea-diagnosis-v1',
  'synthesis-lead-v1',
  'evidence-audit-v1',
  'result-to-claim-v1',
  'research-material-assessment-v1',
  'integrity-audit-v1',
  'page-visual-v1',
  'research-wiki-v1',
  'paper-compile-v1',
  'overleaf-export-v1',
  'figure-render-v1',
]);

it('every declared output schema is either registered or declared prompt-only', async () => {
  const files = await sourceFiles(fileURLToPath(new URL('../src', import.meta.url)));
  const declared = new Map<string, string>();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/([A-Z][A-Z0-9_]*SCHEMA[A-Z0-9_]*)\s*=\s*'([^']+)'/g)) {
      declared.set(match[2]!, `${match[1]} in ${relative('', file)}`);
    }
  }
  expect(declared.size).toBeGreaterThan(20);
  const registered = new Set<string>(listSchemaNames());
  const unexplained = [...declared.entries()]
    .filter(([name]) => !registered.has(name) && !PROMPT_ONLY_CONTRACTS.has(name))
    .map(([name, where]) => `${name} (${where})`);
  expect(unexplained).toEqual([]);
  // A registered schema must not stay in the prompt-only list, or the debt
  // reads as larger than it is and a real validator goes unnoticed.
  const stale = [...PROMPT_ONLY_CONTRACTS].filter((name) => registered.has(name));
  expect(stale).toEqual([]);
  for (const name of VALIDATED_ELSEWHERE) expect(registered.has(name)).toBe(true);
});

it('each registered schema has a JSON file in the package', async () => {
  const dir = fileURLToPath(new URL('../src/core/schema/schemas/', import.meta.url));
  const missing: string[] = [];
  for (const name of listSchemaNames()) {
    try {
      await readFile(join(dir, `${name}.json`), 'utf8');
    } catch {
      missing.push(name);
    }
  }
  expect(missing).toEqual([]);
});
