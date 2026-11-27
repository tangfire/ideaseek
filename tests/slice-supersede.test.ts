import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, createDemoRun, openRuntime } from './helpers.js';
import { spawn } from 'node:child_process';

/**
 * `data slices --from-protocol` supersedes its own previous generation.
 *
 * Live defect: slices from an earlier protocol or snapshot stayed registered
 * forever, so `confirm protocol`'s single-snapshot gate blocked every future
 * lock (mixed snapshots + 0-row rows from a degenerate expansion) with no
 * user path to clean up — `--prune-invalid` only catches malformed hashes.
 * Slices are rebuildable by rule + seed, so the rebuild replaces the stale
 * generation and leaves every other slice source untouched.
 */

function validProposal() {
  return {
    protocolId: 'proto-supersede-v1',
    version: 1,
    taskDefinition: {
      value: 'leave-one-domain-out classification on a4-domain image corpus',
      source: 'paper-evidence',
      confidence: 0.9,
    },
    sampleUnit: { value: 'one image row', source: 'data-probe', confidence: 0.85 },
    labelSemantics: { value: 'class label column', source: 'user', confidence: 0.9 },
    splitRules: {
      value: ['hold out one domain per fold; remaining domains are clients'],
      source: 'adapter-rule',
      confidence: 0.85,
    },
    slicing: {
      value: [
        {
          fold: 'holdout-photo',
          holdoutColumn: 'domain',
          holdoutValues: ['photo'],
          clientColumn: 'domain',
          stratifyBy: 'label',
          seed: 42,
        },
      ],
      source: 'data-probe',
      confidence: 0.85,
    },
    leakageChecks: ['holdout domain never enters training'],
    preprocessing: ['per-client normalization fit on train only'],
    baselineEntries: [
      {
        methodId: 'feddg-prototype-alignment',
        entry: 'python3 smoke.py',
        source: 'code',
        confidence: 0.9,
      },
    ],
    primaryMetrics: [
      {
        name: 'unseen-domain mean accuracy (%)',
        direction: 'higher',
        unit: 'percent',
        source: 'paper-evidence',
        confidence: 0.8,
      },
    ],
    secondaryMetrics: [
      { name: 'per-domain accuracy', direction: 'higher', source: 'data-probe', confidence: 0.75 },
    ],
    statisticalSummary: ['mean ± std over 3 seeds'],
    smokeTest: { value: 'smoke tier, 1 seed', source: 'adapter-rule', confidence: 0.85 },
    resourceEstimate: { value: '3 quick runs', source: 'agent-inference', confidence: 0.6 },
    ablations: ['w/o prototype alignment'],
    supportCriteria: ['mean unseen-domain accuracy beats the same-run baseline'],
    refuteCriteria: ['delta ≤ 0 across seeds'],
    invalidRunCriteria: ['holdout domain leaked into training'],
    stopConditions: ['budget exhausted'],
    generatedAt: 1,
    generator: 'protocol-synth-v1',
  };
}

const PACS_CARD = {
  profiles: [
    {
      source: { path: 'datasets/pacs.parquet' },
      rows: 9991,
      columns: [{ name: 'label' }, { name: 'domain' }],
      labelCandidates: [{ column: 'label', confidence: 0.9 }],
      datasetSnapshotId: 'data-4fc041ee92ee',
    },
  ],
};

const PACS_IMAGE_PROFILE = {
  schemaVersion: 'image-profile-v1',
  generatedBy: 'test',
  source: {
    path: '/mnt/workspace/proj/datasets/pacs.parquet',
    format: 'parquet',
    bytes: 191395900,
    sha256: 'sha256:4fc041ee92eec6043fe6e2859e8bdd138e5f958bc621afd153879812cbe65ff5',
    columns: ['image', 'domain', 'label'],
  },
  samples: 9991,
  grouping: {
    column: 'domain',
    values: [
      { name: 'sketch', count: 3929 },
      { name: 'cartoon', count: 2344 },
      { name: 'art_painting', count: 2048 },
      { name: 'photo', count: 1670 },
    ],
  },
  classes: {
    column: 'label',
    values: Array.from({ length: 7 }, (_, index) => ({ name: String(index), count: 1400 })),
    distinct: 7,
  },
  imageBytesColumn: null,
  resolution: {},
  splitRules: [],
  warnings: [],
};

function runCli(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function seedProposal(dir: string, proposal: unknown): Promise<void> {
  const rt = await openRuntime(dir, { recover: false });
  try {
    const run = await createDemoRun(rt, 'supersede seed');
    const task = await rt.db.claimNextTask(run.runId, 'seed-worker', { leaseMs: 60_000 });
    const staged = await rt.store.stage(
      'protocol-proposal',
      `${JSON.stringify(proposal, null, 2)}\n`,
      { filename: 'protocol-proposal.json' },
    );
    await rt.db.beginCommit({
      taskId: task!.taskId,
      workerId: 'seed-worker',
      attempt: task!.attempt,
      artifacts: [
        {
          kind: 'protocol-proposal',
          tempPath: staged.tempPath,
          contentHash: staged.contentHash,
          size: staged.size,
          meta: staged.meta,
        },
      ],
      result: { summary: 'seeded proposal', artifacts: [] },
    });
    await rt.store.promote([staged]);
    await rt.db.finalizeCommit({ taskId: task!.taskId, workerId: 'seed-worker' });
  } finally {
    await rt.close();
  }
}

interface SliceSeed {
  sliceId: string;
  datasetSnapshotId: string;
  scale: string;
  record: Record<string, unknown>;
}

async function seedSlices(dir: string, seeds: SliceSeed[]): Promise<void> {
  const rt = await openRuntime(dir, { recover: false });
  try {
    for (const seed of seeds) {
      await rt.db.upsertSlice({ ...seed, createdAt: 1_000 });
    }
  } finally {
    await rt.close();
  }
}

async function sliceIds(dir: string): Promise<string[]> {
  const rt = await openRuntime(dir, { recover: false });
  try {
    return (await rt.db.listSlices()).map((entry) => entry.sliceId);
  } finally {
    await rt.close();
  }
}

function staleFromProtocolSlice(snapshot = 'data-000000000000', suffix = 'dead01'): SliceSeed {
  return {
    sliceId: `ds-${snapshot.slice(5, 17)}-quick-${suffix}`,
    datasetSnapshotId: snapshot,
    scale: 'quick',
    record: {
      sliceId: `ds-${snapshot.slice(5, 17)}-quick-${suffix}`,
      datasetSnapshotId: snapshot,
      scale: 'quick',
      rule: 'stale generation from an older protocol',
      ruleVersion: 2,
      inputHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      outputHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      stats: { totalRows: 100, selectedRows: 10 },
      seed: 42,
      boundaries: [],
      generatedBy: 'ideaseek data slices --from-protocol',
      generatedAt: 1_000,
      limits: [],
      distributionCheck: { ok: true, warnings: [] },
    },
  };
}

function foreignSlice(): SliceSeed {
  return {
    sliceId: 'ds-111111111111-quick-face',
    datasetSnapshotId: 'data-111111111111',
    scale: 'quick',
    record: {
      sliceId: 'ds-111111111111-quick-face',
      datasetSnapshotId: 'data-111111111111',
      scale: 'quick',
      rule: 'side experiment built from a CSV',
      ruleVersion: 2,
      inputHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      outputHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      stats: { totalRows: 50, selectedRows: 5 },
      seed: 42,
      boundaries: [],
      generatedBy: 'ideaseek data slices --build-from',
      generatedAt: 1_000,
      limits: [],
      distributionCheck: { ok: true, warnings: [] },
    },
  };
}

describe('CLI: data slices --from-protocol supersedes the stale generation', () => {
  async function setup(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), name));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const knowledge = join(dir, 'knowledge');
    await mkdir(knowledge, { recursive: true });
    await writeFile(join(knowledge, 'dataset-card.json'), JSON.stringify(PACS_CARD), 'utf8');
    await writeFile(
      join(knowledge, 'image-profiles.json'),
      JSON.stringify({ profiles: [PACS_IMAGE_PROFILE] }),
      'utf8',
    );
    await seedProposal(dir, validProposal());
    return dir;
  }

  it('rebuilds the current generation, drops stale from-protocol slices and keeps other sources', async () => {
    const dir = await setup('ideaseek-supersede-');
    await seedSlices(dir, [staleFromProtocolSlice(), foreignSlice()]);

    const rebuild = await runCli(dir, ['data', 'slices', '--from-protocol', '--json']);
    expect(rebuild.code).toBe(0);
    const payload = JSON.parse(rebuild.stdout) as {
      built: number;
      superseded: string[];
      slices: { datasetSnapshotId: string; stats: { selectedRows: number } }[];
    };
    expect(payload.built).toBe(3); // 1 fold × smoke/quick/standard
    expect(payload.superseded).toEqual(['ds-000000000000-quick-dead01']);
    expect(payload.slices.every((slice) => slice.datasetSnapshotId === 'data-4fc041ee92ee')).toBe(
      true,
    );
    expect(payload.slices.every((slice) => slice.stats.selectedRows > 0)).toBe(true);

    const ids = await sliceIds(dir);
    expect(ids).not.toContain('ds-000000000000-quick-dead01');
    expect(ids).toContain('ds-111111111111-quick-face'); // other sources untouched
    expect(ids.filter((id) => id.startsWith('ds-4fc041ee92ee-'))).toHaveLength(3);
  }, 120_000);

  it('a mixed-snapshot generation blocks confirm until the rebuild supersedes it', async () => {
    const dir = await setup('ideaseek-supersede-block-');
    // Two stale generations from different snapshots — the live defect:
    // mixed snapshots plus 0-row expansions blocked every future lock.
    await seedSlices(dir, [
      staleFromProtocolSlice('data-000000000000', 'dead01'),
      staleFromProtocolSlice('data-222222222222', 'dead02'),
    ]);

    const blocked = await runCli(dir, ['confirm', 'protocol', '--json']);
    expect(blocked.code).toBe(2);
    const blockedPayload = JSON.parse(blocked.stdout) as { locked: boolean; errors: string[] };
    expect(blockedPayload.locked).toBe(false);
    expect(blockedPayload.errors.join(' ')).toContain('mixed snapshots');

    const rebuild = await runCli(dir, ['data', 'slices', '--from-protocol', '--json']);
    expect(rebuild.code).toBe(0);
    const payload = JSON.parse(rebuild.stdout) as { superseded: string[] };
    expect(payload.superseded.sort()).toEqual([
      'ds-000000000000-quick-dead01',
      'ds-222222222222-quick-dead02',
    ]);

    const confirm = await runCli(dir, ['confirm', 'protocol', '--by', 'researcher', '--json']);
    expect(confirm.code).toBe(0);
    const locked = JSON.parse(confirm.stdout) as { locked: boolean; errors?: string[] };
    expect(locked.locked).toBe(true);
  }, 120_000);
});
