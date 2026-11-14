import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRunEnv, mergeRunEnv, RUN_ENV_KEYS } from '../src/experiment/run-env.js';
import { executeRepair } from '../src/comparison/repair.js';
import { runSmoke } from '../src/comparison/reproduce.js';
import type { RepairRecord } from '../src/comparison/types.js';
import { executeSpecRun } from '../src/idea/experiment.js';
import type { ExperimentSpec } from '../src/experiment/spec.js';
import { makeProjectDir } from './helpers.js';

/**
 * Run-env portability contract: an entry command learns dataset locations from
 * the environment, so the same comparison/idea code runs on Windows, WSL and a
 * Linux server without editing paths into the source.
 */

const ECHO = [
  `console.log("${RUN_ENV_KEYS.datasetRoots}=" + (process.env.${RUN_ENV_KEYS.datasetRoots}` +
    ` || "<none>") + " ${RUN_ENV_KEYS.projectRoot}=" + (process.env.${RUN_ENV_KEYS.projectRoot}` +
    ` || "<none>") + " ${RUN_ENV_KEYS.dataPath}=" + (process.env.${RUN_ENV_KEYS.dataPath}` +
    ` || "<none>"))`,
  'console.log(JSON.stringify({metrics:{accuracy:0.5}}))',
].join('; ');

async function projectWithDatasets(pick: (dir: string) => string[]): Promise<string> {
  const dir = await makeProjectDir('run-env');
  const roots = pick(dir);
  await writeFile(
    join(dir, 'research.yaml'),
    [
      'config_version: 1',
      'project:',
      '  name: run-env',
      'inputs:',
      '  readonly_datasets:',
      ...roots.map((r) => `    - ${JSON.stringify(r)}`),
      '',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

describe('buildRunEnv', () => {
  it('exposes the resolved project root and nothing else when no roots are set', async () => {
    const dir = await makeProjectDir('run-env-bare');
    const env = await buildRunEnv(dir);
    expect(env[RUN_ENV_KEYS.projectRoot]).toBe(dir);
    expect(env[RUN_ENV_KEYS.datasetRoots]).toBeUndefined();
  });

  it('joins configured dataset roots with the platform path delimiter', async () => {
    const dir = await projectWithDatasets((d) => [
      join(d, 'data', 'pacs'),
      join(d, 'data', 'domainnet'),
    ]);
    const env = await buildRunEnv(dir);
    expect(env[RUN_ENV_KEYS.datasetRoots]).toBe(
      [join(dir, 'data', 'pacs'), join(dir, 'data', 'domainnet')].join(delimiter),
    );
  });

  it('lets call-site overrides win over project env', async () => {
    const dir = await makeProjectDir('run-env-override');
    const merged = await mergeRunEnv(dir, { VIRTUAL_ENV: '/tmp/venv-a' });
    expect(merged.VIRTUAL_ENV).toBe('/tmp/venv-a');
    expect(merged[RUN_ENV_KEYS.projectRoot]).toBe(dir);
  });

  it('includes materialized corpora, which is the only form an entry can train on', async () => {
    const dir = await projectWithDatasets((d) => [join(d, 'datasets')]);
    const derived = join(dir, 'datasets-derived', 'pacs-quick');
    await mkdir(join(dir, 'knowledge'), { recursive: true });
    await mkdir(derived, { recursive: true });
    await writeFile(
      join(dir, 'knowledge', 'materializations.json'),
      JSON.stringify({
        schemaVersion: 1,
        records: [
          { status: 'ok', outDir: derived },
          { status: 'ok', outDir: derived },
        ],
      }),
      'utf8',
    );
    const env = await buildRunEnv(dir);
    // Configured root first, then the derived corpus, with duplicates folded.
    expect(env[RUN_ENV_KEYS.datasetRoots]).toBe([join(dir, 'datasets'), derived].join(delimiter));
  });

  it('survives a missing materialization ledger', async () => {
    const dir = await projectWithDatasets((d) => [join(d, 'datasets')]);
    expect(await buildRunEnv(dir)).toMatchObject({
      [RUN_ENV_KEYS.datasetRoots]: join(dir, 'datasets'),
    });
  });
});

describe('run env reaches the spawned entry', () => {
  it('comparison repair: the entry sees the dataset roots in its log', async () => {
    const dir = await projectWithDatasets((d) => [join(d, 'data', 'pacs')]);
    const worktree = join(dir, 'comparisons', 'fedavg', 'worktree');
    await mkdir(worktree, { recursive: true });
    let stored: RepairRecord | null = null;
    const result = await executeRepair({
      projectRoot: dir,
      methodId: 'fedavg',
      worktreeDir: worktree,
      entry: ['node', '-e', ECHO],
      maxRounds: 1,
      timeoutMs: 30_000,
      store: {
        load: async () => null,
        save: async (next) => {
          stored = next;
        },
      },
    });
    expect(result.outcome).toBe('passed');
    expect(stored).not.toBeNull();
    const repairLog = await readFile(
      join(dir, '.research', 'logs', 'repair-fedavg-r1.log'),
      'utf8',
    );
    expect(repairLog).toContain(`=${join(dir, 'data', 'pacs')} `);
    expect(repairLog).toContain(`${RUN_ENV_KEYS.projectRoot}=${dir}`);
  });

  it('smoke is handed the exact selection the caller asked for', async () => {
    // smoke is invoked with no path argument at all. Without the environment
    // the entry can only guess, and guessing means the worktree: the first
    // real reimplementation run reported "no images found" about a corpus that
    // was present because of nothing but that missing handoff.
    const dir = await projectWithDatasets((d) => [join(d, 'data', 'pacs')]);
    const worktree = join(dir, 'comparisons', 'fedavg', 'worktree');
    await mkdir(worktree, { recursive: true });
    const record = {
      methodId: 'fedavg',
      completedPhases: [],
      phases: [],
      outcome: 'running',
    } as unknown as Parameters<typeof runSmoke>[0];
    const { failure } = await runSmoke(
      record,
      {
        projectRoot: dir,
        methodId: 'fedavg',
        worktreeDir: worktree,
        entry: ['node', '-e', ECHO],
        dataPath: join(dir, 'datasets-derived', 'pacs-quick'),
        timeoutMs: 30_000,
        smokeTimeoutMs: 30_000,
        onPhase: async () => undefined,
      } as Parameters<typeof runSmoke>[1],
      [{ name: 'accuracy', direction: 'higher' }],
    );
    expect(failure).toBeNull();
    const log = await readFile(
      join(dir, '.research', 'logs', 'reproduce-fedavg-smoke.log'),
      'utf8',
    );
    expect(log).toContain(
      `${RUN_ENV_KEYS.dataPath}=${join(dir, 'datasets-derived', 'pacs-quick')}`,
    );
  });

  it('idea experiment: the spec run sees the dataset roots in its log', async () => {
    const dir = await projectWithDatasets((d) => [join(d, 'data', 'domainnet')]);
    await mkdir(join(dir, 'ideas', 'run-env-idea'), { recursive: true });
    const spec = {
      specId: 'spec-run-env',
      version: 1,
      idea: { ideaId: 'run-env-idea', version: 1 },
      comparisonIds: [],
      codeCommit: null,
      dataSnapshotId: 'data:snapshot-1',
      sliceIds: [],
      environment: { python: 'v3', notes: ['scale:smoke'] },
      command: ['node', '-e', ECHO],
      metrics: [{ name: 'accuracy', direction: 'higher' }],
      seeds: [42],
      resources: {},
      budget: { maxRuns: 1, maxMinutes: 5 },
      protocolId: null,
      createdAt: 1000,
    } as ExperimentSpec;
    const exec = await executeSpecRun(dir, 'run-env-idea', spec, 30_000);
    expect(exec.succeeded).toBe(true);
    const log = await readFile(join(dir, ...exec.logRef.split('/')), 'utf8');
    expect(log).toContain(join(dir, 'data', 'domainnet'));
  });
});
