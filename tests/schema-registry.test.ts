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
// Task #14 registered 22 of these, so the list shrinks to what genuinely has
// no schema behind it. The assertion below fails if a name stays here after
// being registered — debt lists that never shrink become the place a missing
// validator hides.
const PROMPT_ONLY_CONTRACTS = new Set(['integrity-audit-v1']);

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

it('every registered schema compiles in the validator itself', async () => {
  // Registration is all-up-front so $ref links resolve, which means one schema
  // with a dialect the validator does not know poisons every other contract:
  // a draft/2020-12 file added to a draft-07 registry took 342 tests down and
  // nothing but running a validation caught it. Presence checks are not
  // enough — the schema has to actually load.
  const { validateAgainstSchema } = await import('../src/core/schema/index.js');
  for (const name of listSchemaNames()) {
    expect(() => validateAgainstSchema(name, {}), name).not.toThrow();
  }
});
