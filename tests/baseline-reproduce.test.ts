import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkMetricFeasibility,
  computeAlgorithmFingerprint,
  defaultEntry,
  validateReproductionBlueprint,
} from '../src/comparison/reproduce.js';
import type { ReproductionBlueprint, ReproductionRecord } from '../src/comparison/types.js';
import { CLI_BIN } from './helpers.js';

const GOOD_SOURCE = `import json, os, sys

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'check-data':
        if not os.path.exists('data/train.csv'):
            sys.stderr.write('missing data/train.csv\\n')
            return 1
        return 0
    if cmd == 'check-metrics':
        acc = 3.0 / 4.0
        if not (0.0 <= acc <= 1.0):
            return 1
        return 0
    if cmd == 'smoke':
        print(json.dumps({'metrics': {'accuracy': 0.75}}))
        return 0
    sys.stderr.write('unknown command: %s\\n' % cmd)
    return 2

if __name__ == '__main__':
    sys.exit(main())
`;

const MISSING_DEP_SOURCE = `import totally_missing_module_xyz

print('never reached')
`;

function blueprint(methodId: string, source: string): ReproductionBlueprint {
  return {
    methodId,
    paperExplicit: [
      {
        statement: 'client models are averaged weighted by sample counts',
        evidence: 'fedavg-paper p.3',
      },
    ],
    assumptions: ['optimizer defaults to SGD with lr=0.01'],
    missingDetails: ['client sampling rate is not stated'],
    confidence: 'medium',
    algorithm: {
      source,
      dataInterface: { description: 'csv with feature columns and one label column' },
      metrics: [{ name: 'accuracy', direction: 'higher' }],
      hyperparameters: { lr: 0.01, local_epochs: 1 },
    },
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('checkMetricFeasibility (protocol vs implementation)', () => {
  it('blocks when none of the protocol metrics can come from the implementation', () => {
    const result = checkMetricFeasibility(
      ['Unseen-domain top-1 accuracy (target domain, LODO)', 'AVG'],
      ['wallclock_seconds'],
    );
    expect(result.status).toBe('blocked');
    expect(result.covered).toEqual([]);
    expect(result.uncovered).toHaveLength(2);
  });

  it('matches across case and punctuation without knowing any field vocabulary', () => {
    expect(
      checkMetricFeasibility(['Unseen-Domain Top-1 Accuracy'], ['unseen_domain_top1_accuracy'])
        .status,
    ).toBe('covered');
  });

  it('is partial, not blocked, when some protocol metrics are reachable', () => {
    const result = checkMetricFeasibility(
      ['unseen_domain_accuracy', 'avg_accuracy'],
      ['unseen_domain_accuracy', 'wallclock'],
    );
    expect(result.status).toBe('partial');
    expect(result.covered).toEqual(['unseen_domain_accuracy']);
    expect(result.uncovered).toEqual(['avg_accuracy']);
  });

  it('does not invent a requirement when either side is empty', () => {
    expect(checkMetricFeasibility([], ['accuracy']).status).toBe('no-protocol');
    expect(checkMetricFeasibility(['accuracy'], []).status).toBe('no-implementation-metrics');
  });
});

describe('validateReproductionBlueprint (unit)', () => {
  const base = blueprint('fedavg', GOOD_SOURCE);

  it('accepts a complete blueprint with paper grounding', () => {
    const result = validateReproductionBlueprint(base, {
      methodId: 'fedavg',
      paperRefs: ['paper-1'],
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('rejects missing paper grounding, empty evidence and bad confidence', () => {
    const noPapers = validateReproductionBlueprint(base, { methodId: 'fedavg', paperRefs: [] });
    expect(noPapers.ok).toBe(false);
    expect(noPapers.errors.join(' ')).toContain('paperRefs');

    const emptyExplicit = validateReproductionBlueprint(
      { ...base, paperExplicit: [] },
      { methodId: 'fedavg', paperRefs: ['paper-1'] },
    );
    expect(emptyExplicit.ok).toBe(false);
    expect(emptyExplicit.errors.join(' ')).toContain('paperExplicit');

    const noEvidence = validateReproductionBlueprint(
      {
        ...base,
        paperExplicit: [{ statement: 'x', evidence: '  ' }],
      },
      { methodId: 'fedavg', paperRefs: ['paper-1'] },
    );
    expect(noEvidence.ok).toBe(false);
    expect(noEvidence.errors.join(' ')).toContain('evidence');

    const badConfidence = validateReproductionBlueprint(
      { ...base, confidence: 'certain' },
      { methodId: 'fedavg', paperRefs: ['paper-1'] },
    );
    expect(badConfidence.ok).toBe(false);

    const mismatch = validateReproductionBlueprint(base, {
      methodId: 'other',
      paperRefs: ['paper-1'],
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.join(' ')).toContain('does not match');
  });
});

describe('computeAlgorithmFingerprint (unit)', () => {
  it('changes with source, metrics and hyperparameters but not with key order', () => {
    const bp = blueprint('fedavg', GOOD_SOURCE);
    const algo = {
      source: GOOD_SOURCE,
      entry: defaultEntry(bp.algorithm),
      dataInterface: bp.algorithm.dataInterface,
      metrics: bp.algorithm.metrics,
      hyperparameters: bp.algorithm.hyperparameters,
    };
    const reordered = {
      hyperparameters: algo.hyperparameters,
      metrics: algo.metrics,
      dataInterface: algo.dataInterface,
      entry: algo.entry,
      source: algo.source,
    };
    expect(computeAlgorithmFingerprint(algo)).toBe(computeAlgorithmFingerprint(reordered));
    expect(computeAlgorithmFingerprint(algo)).not.toBe(
      computeAlgorithmFingerprint({ ...algo, source: `${GOOD_SOURCE}\n# tweak` }),
    );
    expect(computeAlgorithmFingerprint(algo)).not.toBe(
      computeAlgorithmFingerprint({ ...algo, hyperparameters: { lr: 0.1 } }),
    );
  });
});

describe('ideaseek baseline reproduce (CLI)', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-repro-e2e-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
  }, 60_000);

  async function registerReimpl(id: string): Promise<void> {
    const reg = await runCli(project, [
      'comparison',
      'register',
      id,
      '--source',
      'paper-reimplementation',
      '--paper',
      'fedavg-paper',
    ]);
    expect(reg.code).toBe(0);
  }

  async function writeBlueprint(id: string, bp: ReproductionBlueprint): Promise<void> {
    const dir = join(project, 'comparisons', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'blueprint.json'), JSON.stringify(bp, null, 2), 'utf8');
  }

  it('rejects a smoke run that reports metrics it did not compute', async () => {
    // Observed live: generated code exited 0 with
    // {"deps":"torch unavailable...","status":"ephemeral_passed"}. A passing
    // smoke that faked its numbers would poison every downstream conclusion.
    const FAKE_PASS = `import json, sys
cmd = sys.argv[1] if len(sys.argv) > 1 else ''
if cmd == 'check-data':
    print(json.dumps({"status": "ok", "samples": 1}))
elif cmd == 'check-metrics':
    print(json.dumps({"metrics": {"acc": 0.5}}))
elif cmd == 'smoke':
    print(json.dumps({"status": "ephemeral_passed", "metrics": {"acc": 0.91}}))
`;
    await registerReimpl('fedavg-fake');
    await writeBlueprint('fedavg-fake', blueprint('fedavg-fake', FAKE_PASS));

    const repro = await runCli(project, [
      'baseline',
      'reproduce',
      '--method',
      'fedavg-fake',
      '--json',
    ]);
    const payload = JSON.parse(repro.stdout) as {
      outcome: string;
      failedPhase?: string;
      summary?: string;
    };
    expect(payload.outcome).not.toBe('validated');
    expect(payload.failedPhase ?? payload.summary ?? '').toMatch(/smoke/i);
  }, 120_000);

  it('success: validates, records provenance, attaches an experiment result and passes the gate', async () => {
    await registerReimpl('fedavg');
    await writeBlueprint('fedavg', blueprint('fedavg', GOOD_SOURCE));
    // Data interface holds: the fixture data lives in the worktree.
    await mkdir(join(project, 'comparisons', 'fedavg', 'worktree', 'data'), { recursive: true });
    await writeFile(
      join(project, 'comparisons', 'fedavg', 'worktree', 'data', 'train.csv'),
      'x,y\n1,0\n',
      'utf8',
    );

    const repro = await runCli(project, ['baseline', 'reproduce', '--method', 'fedavg', '--json']);
    expect(repro.code, repro.stderr).toBe(0);
    const payload = JSON.parse(repro.stdout) as {
      outcome: string;
      status: string;
      confidence: string;
      algorithmModified: boolean;
      specId: string;
      smokeMetrics: { name: string; value: number }[];
      phases: { phase: string; ok: boolean }[];
    };
    expect(payload).toMatchObject({
      outcome: 'validated',
      status: 'smoke-tested',
      confidence: 'medium',
      algorithmModified: false,
      specId: 'repro-fedavg',
    });
    expect(payload.smokeMetrics).toEqual([{ name: 'accuracy', value: 0.75 }]);
    expect(payload.phases.map((p) => p.phase)).toEqual([
      'check-code',
      'check-data',
      'check-metrics',
      'smoke',
    ]);
    expect(payload.phases.every((p) => p.ok)).toBe(true);

    // Provenance: reproduction.json + README carry the audit fields.
    const record = JSON.parse(
      await readFile(join(project, 'comparisons', 'fedavg', 'reproduction.json'), 'utf8'),
    ) as ReproductionRecord;
    expect(record.outcome).toBe('validated');
    expect(record.paperExplicit[0]!.statement).toContain('averaged weighted');
    expect(record.assumptions).toHaveLength(1);
    expect(record.missingDetails).toEqual(['client sampling rate is not stated']);
    expect(record.confidence).toBe('medium');
    expect(record.patchHash).toMatch(/^sha256:/);
    expect(record.specId).toBe('repro-fedavg');

    const readme = await readFile(
      join(project, 'comparisons', 'fedavg', 'worktree', 'README.md'),
      'utf8',
    );
    expect(readme).toContain('paper-reimplementation');
    expect(readme).toContain('NOT official code');
    expect(readme).toContain('client sampling rate is not stated');
    expect(readme).toContain('Reproduction confidence: **medium**');

    // No upstream clone exists for a reimplementation (nothing user-owned).
    expect(await exists(join(project, 'comparisons', 'fedavg', 'upstream'))).toBe(false);

    // Unified ExperimentSpec/RunResult attached (scale=smoke).
    const shown = await runCli(project, ['experiment', 'show', 'repro-fedavg', '--json']);
    expect(shown.code).toBe(0);
    const doc = JSON.parse(shown.stdout) as {
      status: string;
      result: { metrics: { name: string; value: number }[] } | null;
    };
    expect(doc.status).toBe('succeeded');
    expect(doc.result?.metrics).toEqual([{ name: 'accuracy', value: 0.75 }]);

    // Gate accepts the reproduction.
    const gate = await runCli(project, ['comparison', 'gate']);
    expect(gate.code).toBe(0);
    expect(gate.stdout).toContain('PASS  fedavg  smoke-tested');

    // method.yaml synced with entry + reproduction summary.
    const yaml = await readFile(join(project, 'comparisons', 'fedavg', 'method.yaml'), 'utf8');
    expect(yaml).toContain('reproduction:');
    expect(yaml).toContain('reproduce.py');
  }, 120_000);

  it('rejects incomplete paper grounding before touching status or worktree', async () => {
    await registerReimpl('fedavg');
    await writeBlueprint('fedavg', { ...blueprint('fedavg', GOOD_SOURCE), paperExplicit: [] });

    const repro = await runCli(project, ['baseline', 'reproduce', '--method', 'fedavg']);
    expect(repro.code).toBe(2);
    expect(repro.stderr).toContain('paperExplicit');

    // No side effects: status unchanged, worktree never created.
    const listed = await runCli(project, ['comparison', 'list', '--json']);
    const methods = (JSON.parse(listed.stdout) as { methods: { status: string }[] }).methods;
    expect(methods[0]!.status).toBe('candidate');
    expect(await exists(join(project, 'comparisons', 'fedavg', 'worktree'))).toBe(false);
    expect(await exists(join(project, 'comparisons', 'fedavg', 'reproduction.json'))).toBe(false);
  }, 60_000);

  it('reports code generation failure when the source file is missing', async () => {
    await registerReimpl('fedavg');
    await writeBlueprint('fedavg', blueprint('fedavg', ''));

    const repro = await runCli(project, [
      'baseline',
      'reproduce',
      '--method',
      'fedavg',
      '--code',
      join(project, 'no-such-file.py'),
    ]);
    expect(repro.code).toBe(2);
    expect(repro.stderr).toContain('code generation failed');

    const listed = await runCli(project, ['comparison', 'list', '--json']);
    const methods = (JSON.parse(listed.stdout) as { methods: { status: string }[] }).methods;
    expect(methods[0]!.status).toBe('candidate');
  }, 60_000);

  it('classifies a dependency failure at check-code and blocks the method', async () => {
    await registerReimpl('fedavg');
    await writeBlueprint('fedavg', blueprint('fedavg', MISSING_DEP_SOURCE));

    const repro = await runCli(project, ['baseline', 'reproduce', '--method', 'fedavg', '--json']);
    expect(repro.code).toBe(1);
    const payload = JSON.parse(repro.stdout) as {
      outcome: string;
      failedPhase: string;
      failureKind: string;
    };
    expect(payload).toMatchObject({
      outcome: 'failed',
      failedPhase: 'check-code',
      failureKind: 'missing-dependency',
    });

    const listed = await runCli(project, ['comparison', 'list', '--json']);
    const methods = (
      JSON.parse(listed.stdout) as {
        methods: { status: string; record: { statusReason?: string } }[];
      }
    ).methods;
    expect(methods[0]!.status).toBe('blocked');
    expect(methods[0]!.record.statusReason).toContain('check-code failed');

    const record = JSON.parse(
      await readFile(join(project, 'comparisons', 'fedavg', 'reproduction.json'), 'utf8'),
    ) as ReproductionRecord;
    expect(record.outcome).toBe('failed');
    expect(record.phases.at(-1)).toMatchObject({ phase: 'check-code', ok: false });
  }, 120_000);

  it('fails at the data interface check, then recovers to smoke-tested after data arrives', async () => {
    await registerReimpl('fedavg');
    await writeBlueprint('fedavg', blueprint('fedavg', GOOD_SOURCE));

    const failed = await runCli(project, ['baseline', 'reproduce', '--method', 'fedavg', '--json']);
    expect(failed.code).toBe(1);
    const failPayload = JSON.parse(failed.stdout) as { failedPhase: string };
    expect(failPayload.failedPhase).toBe('check-data');

    // Recovery: provide the data the interface requires, rerun from blocked.
    await mkdir(join(project, 'comparisons', 'fedavg', 'worktree', 'data'), { recursive: true });
    await writeFile(
      join(project, 'comparisons', 'fedavg', 'worktree', 'data', 'train.csv'),
      'x,y\n1,0\n',
      'utf8',
    );
    const fixed = await runCli(project, ['baseline', 'reproduce', '--method', 'fedavg', '--json']);
    expect(fixed.code, fixed.stderr).toBe(0);
    expect((JSON.parse(fixed.stdout) as { outcome: string }).outcome).toBe('validated');

    const listed = await runCli(project, ['comparison', 'list', '--json']);
    const methods = (JSON.parse(listed.stdout) as { methods: { status: string }[] }).methods;
    expect(methods[0]!.status).toBe('smoke-tested');
  }, 120_000);

  it('resumes an in-progress record without redoing completed phases', async () => {
    await registerReimpl('fedavg');
    await writeBlueprint('fedavg', blueprint('fedavg', GOOD_SOURCE));

    // First session fails at check-data (no data yet).
    const first = await runCli(project, ['baseline', 'reproduce', '--method', 'fedavg', '--json']);
    expect(first.code).toBe(1);

    // Simulate a crash between phases: flip the record back to in-progress.
    const recordPath = join(project, 'comparisons', 'fedavg', 'reproduction.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as ReproductionRecord;
    expect(record.completedPhases).toContain('check-code');
    record.outcome = 'in-progress';
    await writeFile(recordPath, JSON.stringify(record, null, 2), 'utf8');
    const readmeBefore = await readFile(
      join(project, 'comparisons', 'fedavg', 'worktree', 'README.md'),
      'utf8',
    );

    // Data arrives; the resumed run skips brief/generate/check-code.
    await mkdir(join(project, 'comparisons', 'fedavg', 'worktree', 'data'), { recursive: true });
    await writeFile(
      join(project, 'comparisons', 'fedavg', 'worktree', 'data', 'train.csv'),
      'x,y\n1,0\n',
      'utf8',
    );
    const resumed = await runCli(project, [
      'baseline',
      'reproduce',
      '--method',
      'fedavg',
      '--json',
    ]);
    expect(resumed.code, resumed.stderr).toBe(0);

    const after = JSON.parse(await readFile(recordPath, 'utf8')) as ReproductionRecord;
    expect(after.outcome).toBe('validated');
    expect(after.completedPhases.filter((p) => p === 'generate')).toHaveLength(1);
    // check-code ran once (not re-executed on resume); check-data has both
    // the earlier failure and the resumed success.
    expect(after.phases.filter((p) => p.phase === 'check-code')).toHaveLength(1);
    const dataPhases = after.phases.filter((p) => p.phase === 'check-data');
    expect(dataPhases).toHaveLength(2);
    expect(dataPhases[0]!.ok).toBe(false);
    expect(dataPhases[1]!.ok).toBe(true);

    const readmeAfter = await readFile(
      join(project, 'comparisons', 'fedavg', 'worktree', 'README.md'),
      'utf8',
    );
    expect(readmeAfter).toBe(readmeBefore); // generation was skipped
  }, 120_000);

  it('requires --algorithm-modified when semantics change, then marks the method', async () => {
    await registerReimpl('fedavg');
    await writeBlueprint('fedavg', blueprint('fedavg', GOOD_SOURCE));
    await mkdir(join(project, 'comparisons', 'fedavg', 'worktree', 'data'), { recursive: true });
    await writeFile(
      join(project, 'comparisons', 'fedavg', 'worktree', 'data', 'train.csv'),
      'x,y\n1,0\n',
      'utf8',
    );
    const first = await runCli(project, ['baseline', 'reproduce', '--method', 'fedavg', '--json']);
    expect(first.code, first.stderr).toBe(0);

    // Same entry, changed algorithm source → new fingerprint.
    const changed = blueprint('fedavg', `${GOOD_SOURCE}\n# semantic tweak\n`);
    await writeBlueprint('fedavg', changed);
    const silent = await runCli(project, ['baseline', 'reproduce', '--method', 'fedavg']);
    expect(silent.code).toBe(2);
    expect(silent.stderr).toContain('algorithm semantics changed');
    expect(silent.stderr).toContain('--algorithm-modified');

    const flagged = await runCli(project, [
      'baseline',
      'reproduce',
      '--method',
      'fedavg',
      '--algorithm-modified',
      '--reason',
      'aggregated with median instead of mean',
      '--json',
    ]);
    expect(flagged.code, flagged.stderr).toBe(0);
    const payload = JSON.parse(flagged.stdout) as { algorithmModified: boolean };
    expect(payload.algorithmModified).toBe(true);

    const readme = await readFile(
      join(project, 'comparisons', 'fedavg', 'worktree', 'README.md'),
      'utf8',
    );
    expect(readme).toContain('algorithm-modified');
    expect(readme).toContain('median instead of mean');

    const yaml = await readFile(join(project, 'comparisons', 'fedavg', 'method.yaml'), 'utf8');
    expect(yaml).toContain('algorithm-modified:');

    const gate = await runCli(project, ['comparison', 'gate']);
    expect(gate.code).toBe(0);
    expect(gate.stdout).toContain('(algorithm-modified, revised method)');

    // New spec version with the fresh fingerprint + result.
    const shown = await runCli(project, ['experiment', 'show', 'repro-fedavg', '--json']);
    const doc = JSON.parse(shown.stdout) as { version: number; status: string };
    expect(doc.version).toBe(2);
    expect(doc.status).toBe('succeeded');
  }, 180_000);

  it('refuses official-code methods (repair owns those) and missing blueprints', async () => {
    const official = await runCli(project, [
      'comparison',
      'register',
      'fedavg',
      '--source',
      'official-code',
      '--paper',
      'p1',
    ]);
    expect(official.code).toBe(0);
    const wrongKind = await runCli(project, ['baseline', 'reproduce', '--method', 'fedavg']);
    expect(wrongKind.code).toBe(2);
    expect(wrongKind.stderr).toContain('paper-reimplementation');
    expect(wrongKind.stderr).toContain('baseline repair');

    // paper-reimplementation without a blueprint file.
    await runCli(project, [
      'comparison',
      'register',
      'fedproto',
      '--source',
      'paper-reimplementation',
      '--paper',
      'p2',
    ]);
    const noBlueprint = await runCli(project, ['baseline', 'reproduce', '--method', 'fedproto']);
    // FILE_NOT_FOUND maps to the task-failed exit code (docs/CLI_SPEC).
    expect(noBlueprint.code).toBe(1);
    expect(noBlueprint.stderr).toContain('blueprint');
  }, 60_000);
});
