import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSchemaNames, validateAgainstSchema } from '../src/core/schema/index.js';

/**
 * No contract may exist only inside a prompt (#14).
 *
 * IdeaSeek tells models what JSON to return in prose, and names the contract in
 * `outputSchema: '<name>'`. For most of those names no JSON Schema existed, so
 * the "contract" was a wish: nothing structurally checked the answer, the same
 * shape could not be shared with the Python worker or an ARIS skill, and a
 * renamed field surfaced only when downstream code happened to crash. This test
 * is the guard for that class: the set of names the code asks for must be a
 * subset of the registry, and every registered file must compile.
 */

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) sourceFiles(path, out);
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

function contractNamesUsed(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles('src')) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/outputSchema:\s*'([a-z0-9-]+)'/g)) {
      const name = match[1]!;
      found.set(name, [...(found.get(name) ?? []), file]);
    }
    for (const match of text.matchAll(/_SCHEMA\s*=\s*'([a-z0-9-]+)'/g)) {
      const name = match[1]!;
      found.set(name, [...(found.get(name) ?? []), file]);
    }
  }
  return found;
}

describe('schema registry completeness (a named contract must exist)', () => {
  it('registers every contract name the code asks a model to satisfy', () => {
    const registered = new Set<string>(listSchemaNames());
    const used = contractNamesUsed();
    const missing: string[] = [];
    for (const [name, files] of used) {
      if (!registered.has(name)) {
        missing.push(`${name} (${[...new Set(files)].join(', ')})`);
      }
    }
    expect(
      missing,
      `contracts referenced but not registered as JSON Schema:\n${missing.join('\n')}`,
    ).toEqual([]);
    // Measured, not invented: the scan finds 44 distinct names today. A
    // threshold plucked above the real number is a test that fails for the wrong
    // reason the first time a contract is renamed.
    expect(used.size).toBeGreaterThanOrEqual(40);
  });

  it('every schema file in the directory is registered and compiles', () => {
    const dir = join('src', 'core', 'schema', 'schemas');
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    const registered = new Set<string>(listSchemaNames());
    const orphans = files
      .map((name) => name.replace(/\.json$/, ''))
      .filter((name) => !registered.has(name));
    // An unregistered schema file is worse than absent: it reads as a contract
    // while nothing enforces it.
    expect(orphans, `schema files not registered:\n${orphans.join('\n')}`).toEqual([]);

    for (const name of listSchemaNames()) {
      // Ajv compiles on import (the registry constructs it eagerly), so reaching
      // here proves the document is valid draft-07; this call additionally
      // proves it can be resolved by name and answers a minimal object without
      // throwing.
      const answer = validateAgainstSchema(name as Parameters<typeof validateAgainstSchema>[0], {});
      expect(answer.ok, `${name} rejected an empty object without a schema error`).toBe(false);
      expect(answer.errors.join(' ')).not.toMatch(/no schema with key|missing schema/i);
    }
  });

  it('keeps the fake harness honest about the shapes it claims to produce', async () => {
    // The fake adapter exists so CI can run the pipeline without a model. When
    // its canned payloads drift from the real contract, every fake-green test
    // becomes a lie about the real path — so conformance is asserted here rather
    // than discovered in production.
    const { FakeHarnessAdapter } = (await import('../src/dsh/fake-adapter.js')) as unknown as {
      FakeHarnessAdapter: new (options?: Record<string, unknown>) => {
        runTask: (request: Record<string, unknown>) => Promise<{ output: string }>;
      };
    };
    // The adapter requires initialize() before runTask; reaching it only via
    // the composition root hides that contract from a test that wants to ask
    // the harness directly, which is exactly what a conformance probe must do.
    const harness = new FakeHarnessAdapter({});
    await harness.initialize();
    const samples: { schema: string; taskId: string; instruction: string }[] = [
      {
        schema: 'supervisor-intent-v1',
        taskId: 'intent',
        instruction: 'what should I do next',
      },
    ];
    for (const sample of samples) {
      const result = harness.runTask({
        runId: 'run-conformance',
        taskId: sample.taskId,
        profile: 'demo',
        instruction: sample.instruction,
        outputSchema: sample.schema,
        budget: { timeoutMs: 30_000 },
        idempotencyKey: `conformance:${sample.schema}`,
        inputs: [{ kind: 'text', name: 'context', content: 'probe' }],
      } as unknown as Record<string, unknown>);
      return result.then((answered) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(answered.output);
        } catch {
          throw new Error(`${sample.schema}: fake harness emitted non-JSON`);
        }
        const checked = validateAgainstSchema(
          sample.schema as Parameters<typeof validateAgainstSchema>[0],
          parsed,
        );
        expect(checked.errors, `${sample.schema}: fake payload violates its own contract`).toEqual(
          [],
        );
      });
    }
  });
});
