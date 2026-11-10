import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeSpecHash,
  stableJson,
  validateExperimentSpec,
  validateRunResult,
  type ExperimentSpec,
  type RunResult,
} from '../src/experiment/spec.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import { CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';
import { spawn } from 'node:child_process';

function validSpec(overrides: Record<string, unknown> = {}): ExperimentSpec {
  return {
    specId: 'exp-fedavg-quick',
    version: 1,
    idea: null,
    comparisonIds: ['fedavg'],
    codeCommit: null,
    dataSnapshotId: 'sha256:deadbeef',
    sliceIds: ['slice-quick-1'],
    environment: { python: '3.11' },
    command: ['python', 'train.py', '--epochs', '1'],
    metrics: [{ name: 'accuracy', direction: 'higher' }],
    seeds: [42],
    resources: { gpus: 0 },
    budget: { maxMinutes: 10 },
    protocolId: null,
    createdAt: 1,
    ...overrides,
  } as ExperimentSpec;
}

function validResult(overrides: Record<string, unknown> = {}): RunResult {
  return {
    specId: 'exp-fedavg-quick',
    status: 'succeeded',
    logRefs: ['.research/logs/run.log'],
    artifactRefs: ['sha256:abc'],
    metrics: [{ name: 'accuracy', value: 0.91, n: 3 }],
    resourcesUsed: { gpuMinutes: 0.5 },
    failure: null,
    startedAt: 1,
    finishedAt: 2,
    ...overrides,
  } as RunResult;
}

describe('validateExperimentSpec', () => {
  it('accepts a complete spec', () => {
    expect(validateExperimentSpec(validSpec())).toEqual({ ok: true, errors: [] });
  });

  it('rejects non-object, bad id and bad version', () => {
    expect(validateExperimentSpec(null).ok).toBe(false);
    expect(validateExperimentSpec('x').ok).toBe(false);

    const badId = validateExperimentSpec(validSpec({ specId: 'Bad_ID' }));
    expect(badId.ok).toBe(false);
    expect(badId.errors.join(' ')).toContain('kebab-case');

    for (const version of [0, 1.5, '1', undefined]) {
      const result = validateExperimentSpec(validSpec({ version }));
      expect(result.ok, `version=${String(version)}`).toBe(false);
      expect(result.errors.join(' ')).toContain('version');
    }
  });

  it('requires non-empty command, metrics and integer seeds', () => {
    const emptyCmd = validateExperimentSpec(validSpec({ command: [] }));
    expect(emptyCmd.ok).toBe(false);
    expect(emptyCmd.errors.join(' ')).toContain('command');

    const noMetrics = validateExperimentSpec(validSpec({ metrics: [] }));
    expect(noMetrics.ok).toBe(false);
    expect(noMetrics.errors.join(' ')).toContain('metrics must not be empty');

    const badDirection = validateExperimentSpec(
      validSpec({ metrics: [{ name: 'acc', direction: 'up' }] }),
    );
    expect(badDirection.ok).toBe(false);
    expect(badDirection.errors.join(' ')).toContain('direction');

    const noSeeds = validateExperimentSpec(validSpec({ seeds: [] }));
    expect(noSeeds.ok).toBe(false);
    expect(noSeeds.errors.join(' ')).toContain('seeds');

    const floatSeed = validateExperimentSpec(validSpec({ seeds: [1.5] }));
    expect(floatSeed.ok).toBe(false);
  });

  it('allows idea binding or null', () => {
    expect(validateExperimentSpec(validSpec({ idea: { ideaId: 'idea-001', version: 2 } })).ok).toBe(
      true,
    );
    expect(validateExperimentSpec(validSpec({ idea: 'idea-001' })).ok).toBe(false);
  });
});

describe('validateRunResult', () => {
  it('accepts a complete result', () => {
    expect(validateRunResult(validResult())).toEqual({ ok: true, errors: [] });
  });

  it('requires failure details for non-success statuses', () => {
    const failed = validateRunResult(validResult({ status: 'failed', failure: null }));
    expect(failed.ok).toBe(false);
    expect(failed.errors.join(' ')).toContain('failure is required');

    const withFailure = validateRunResult(
      validResult({
        status: 'failed',
        failure: { category: 'dependency', summary: 'missing torch' },
        metrics: [],
      }),
    );
    expect(withFailure.ok).toBe(true);
  });

  it('rejects bad categories, non-finite metrics and inverted times', () => {
    const badCategory = validateRunResult(
      validResult({
        status: 'failed',
        failure: { category: 'vibes', summary: 'x' },
      }),
    );
    expect(badCategory.ok).toBe(false);
    expect(badCategory.errors.join(' ')).toContain('failure.category');

    const nan = validateRunResult(validResult({ metrics: [{ name: 'acc', value: NaN }] }));
    expect(nan.ok).toBe(false);
    expect(nan.errors.join(' ')).toContain('finite');

    const inverted = validateRunResult(validResult({ startedAt: 10, finishedAt: 5 }));
    expect(inverted.ok).toBe(false);
    expect(inverted.errors.join(' ')).toContain('finishedAt');

    const badStatus = validateRunResult(validResult({ status: 'running' }));
    expect(badStatus.ok).toBe(false);
  });
});

describe('computeSpecHash / stableJson', () => {
  it('is independent of key order', () => {
    const a = validSpec();
    const b = JSON.parse(JSON.stringify(validSpec())) as Record<string, unknown>;
    // Rebuild with different key insertion order.
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as ExperimentSpec;
    expect(stableJson(a)).toBe(stableJson(reordered));
    expect(computeSpecHash(a)).toBe(computeSpecHash(reordered));
  });

  it('changes when any value changes', () => {
    expect(computeSpecHash(validSpec())).not.toBe(computeSpecHash(validSpec({ seeds: [43] })));
    expect(computeSpecHash(validSpec())).not.toBe(computeSpecHash(validSpec({ version: 2 })));
  });

  it('handles nested arrays of objects deterministically', () => {
    const left = {
      m: [
        { name: 'a', direction: 'higher' },
        { name: 'b', direction: 'lower' },
      ],
    };
    const right = {
      m: [
        { direction: 'higher', name: 'a' },
        { direction: 'lower', name: 'b' },
      ],
    };
    expect(stableJson(left)).toBe(stableJson(right));
  });
});

describe('experiment registry (migration v7)', () => {
  let runtime: ProjectRuntime;
  let dir: string;

  beforeEach(async () => {
    dir = await makeProjectDir();
    runtime = await openRuntime(dir);
  });

  async function record(overrides: Record<string, unknown> = {}) {
    const spec = validSpec(overrides);
    await runtime.db.upsertExperiment({
      specId: spec.specId,
      version: spec.version,
      specHash: computeSpecHash(spec),
      status: 'planned',
      spec: spec as unknown as Record<string, unknown>,
      result: null,
      updatedAt: Date.now(),
    });
    return spec;
  }

  it('records, reads back and lists with status filter', async () => {
    await record();
    await record({ specId: 'exp-fedprox-quick' });
    const doc = await runtime.db.getExperiment('exp-fedavg-quick');
    expect(doc?.status).toBe('planned');
    expect(doc?.result).toBeNull();
    expect(doc?.specHash).toMatch(/^sha256:/);

    expect(await runtime.db.listExperiments()).toHaveLength(2);
    expect(await runtime.db.listExperiments({ status: 'planned' })).toHaveLength(2);
    expect(await runtime.db.listExperiments({ status: 'succeeded' })).toHaveLength(0);
    expect(await runtime.db.getExperiment('missing')).toBeNull();
  });

  it('is idempotent for identical hashes and enforces version bumps', async () => {
    const spec = await record();
    // Identical re-record: no error, result preserved once attached.
    await runtime.db.attachExperimentResult(
      spec.specId,
      validResult() as unknown as Record<string, unknown>,
      'succeeded',
    );
    await runtime.db.upsertExperiment({
      specId: spec.specId,
      version: spec.version,
      specHash: computeSpecHash(spec),
      status: 'succeeded',
      spec: spec as unknown as Record<string, unknown>,
      result: null, // ignored for identical hash
      updatedAt: Date.now(),
    });
    const kept = await runtime.db.getExperiment(spec.specId);
    expect(kept?.status).toBe('succeeded');
    expect(kept?.result).not.toBeNull();

    // Different hash at same/older version → refused with bump hint.
    const changed = validSpec({ seeds: [7] });
    await expect(
      runtime.db.upsertExperiment({
        specId: spec.specId,
        version: 1,
        specHash: computeSpecHash(changed),
        status: 'planned',
        spec: changed as unknown as Record<string, unknown>,
        result: null,
        updatedAt: Date.now(),
      }),
    ).rejects.toThrow(/bump version to 2/);

    // Bumped version replaces cleanly and clears the old result.
    await runtime.db.upsertExperiment({
      specId: spec.specId,
      version: 2,
      specHash: computeSpecHash(changed),
      status: 'planned',
      spec: changed as unknown as Record<string, unknown>,
      result: null,
      updatedAt: Date.now(),
    });
    const replaced = await runtime.db.getExperiment(spec.specId);
    expect(replaced?.version).toBe(2);
    expect(replaced?.result).toBeNull();
    expect(replaced?.status).toBe('planned');
  });

  it('attaches a result exactly once', async () => {
    const spec = await record();
    const updated = await runtime.db.attachExperimentResult(
      spec.specId,
      validResult() as unknown as Record<string, unknown>,
      'succeeded',
    );
    expect(updated.status).toBe('succeeded');
    expect(updated.result).not.toBeNull();

    await expect(
      runtime.db.attachExperimentResult(
        spec.specId,
        validResult() as unknown as Record<string, unknown>,
        'failed',
      ),
    ).rejects.toThrow(/already has a result/);

    await expect(
      runtime.db.attachExperimentResult(
        'ghost',
        validResult() as unknown as Record<string, unknown>,
        'succeeded',
      ),
    ).rejects.toThrow(/not found/);
  });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 30_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('ideaseek experiment CLI end-to-end', () => {
  let project: string;
  let specPath: string;
  let resultPath: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-exp-e2e-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
    specPath = join(project, 'spec.json');
    resultPath = join(project, 'result.json');
    await writeFile(specPath, JSON.stringify(validSpec(), null, 2), 'utf8');
    await writeFile(resultPath, JSON.stringify(validResult(), null, 2), 'utf8');
  }, 60_000);

  it('spec → list → result → show full lifecycle', async () => {
    const recorded = await runCli(project, ['experiment', 'spec', specPath, '--json']);
    expect(recorded.code).toBe(0);
    const specPayload = JSON.parse(recorded.stdout) as {
      specId: string;
      status: string;
      specHash: string;
      idempotent: boolean;
    };
    expect(specPayload).toMatchObject({
      specId: 'exp-fedavg-quick',
      status: 'planned',
      idempotent: false,
    });
    expect(specPayload.specHash).toMatch(/^sha256:/);

    // Identical re-record is idempotent.
    const again = await runCli(project, ['experiment', 'spec', specPath, '--json']);
    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as { idempotent: boolean }).idempotent).toBe(true);

    const planned = await runCli(project, ['experiment', 'list', '--json']);
    expect(planned.code).toBe(0);
    expect(
      (JSON.parse(planned.stdout) as { experiments: { status: string }[] }).experiments[0]!.status,
    ).toBe('planned');

    const attached = await runCli(project, ['experiment', 'result', resultPath, '--json']);
    expect(attached.code).toBe(0);
    const resultPayload = JSON.parse(attached.stdout) as {
      status: string;
      metrics: { name: string; value: number }[];
    };
    expect(resultPayload.status).toBe('succeeded');
    expect(resultPayload.metrics[0]).toMatchObject({ name: 'accuracy', value: 0.91 });

    const shown = await runCli(project, ['experiment', 'show', 'exp-fedavg-quick', '--json']);
    expect(shown.code).toBe(0);
    const doc = JSON.parse(shown.stdout) as {
      status: string;
      result: { metrics: unknown[] } | null;
      specHash: string;
    };
    expect(doc.status).toBe('succeeded');
    expect(doc.result?.metrics).toHaveLength(1);

    // Second result for the same version is refused.
    const dup = await runCli(project, ['experiment', 'result', resultPath]);
    expect(dup.code).not.toBe(0);
    expect(dup.stderr).toContain('already has a result');

    const filtered = await runCli(project, [
      'experiment',
      'list',
      '--status',
      'succeeded',
      '--json',
    ]);
    expect(filtered.code).toBe(0);
    expect((JSON.parse(filtered.stdout) as { experiments: unknown[] }).experiments).toHaveLength(1);
  }, 60_000);

  it('refuses a changed spec at the same version', async () => {
    expect((await runCli(project, ['experiment', 'spec', specPath])).code).toBe(0);
    const changed = validSpec({ seeds: [43] });
    const changedPath = join(project, 'spec-changed.json');
    await writeFile(changedPath, JSON.stringify(changed, null, 2), 'utf8');

    const refused = await runCli(project, ['experiment', 'spec', changedPath]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('bump version to 2');

    // Bumping the version succeeds and resets to planned.
    const bumpedPath = join(project, 'spec-v2.json');
    await writeFile(
      bumpedPath,
      JSON.stringify(validSpec({ version: 2, seeds: [43] }), null, 2),
      'utf8',
    );
    const bumped = await runCli(project, ['experiment', 'spec', bumpedPath, '--json']);
    expect(bumped.code).toBe(0);
    const payload = JSON.parse(bumped.stdout) as { version: number; status: string };
    expect(payload).toMatchObject({ version: 2, status: 'planned' });
  }, 60_000);

  it('rejects invalid specs, invalid JSON, missing files and unknown specs', async () => {
    const badPath = join(project, 'bad-spec.json');
    await writeFile(badPath, JSON.stringify(validSpec({ metrics: [], seeds: [] })), 'utf8');
    const badSpec = await runCli(project, ['experiment', 'spec', badPath]);
    expect(badSpec.code).not.toBe(0);
    expect(badSpec.stderr).toContain('invalid experiment spec');

    const brokenPath = join(project, 'broken.json');
    await writeFile(brokenPath, '{not json', 'utf8');
    const broken = await runCli(project, ['experiment', 'spec', brokenPath]);
    expect(broken.code).not.toBe(0);
    expect(broken.stderr).toContain('not valid JSON');

    const missing = await runCli(project, ['experiment', 'spec', join(project, 'nope.json')]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('cannot read');

    // Result without a recorded spec.
    const orphan = await runCli(project, ['experiment', 'result', resultPath]);
    expect(orphan.code).not.toBe(0);
    expect(orphan.stderr).toContain('not found');

    const ghostShow = await runCli(project, ['experiment', 'show', 'ghost-spec']);
    expect(ghostShow.code).not.toBe(0);
    expect(ghostShow.stderr).toContain('not found');

    const badStatus = await runCli(project, ['experiment', 'list', '--status', 'weird']);
    expect(badStatus.code).not.toBe(0);
    expect(badStatus.stderr).toContain('--status must be');
  }, 60_000);
});
