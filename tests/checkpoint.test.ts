import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildCheckpointManifest,
  computeSpecConfigHash,
  parseCheckpointPolicy,
  parseCheckpointSavedLine,
  parseProgressLine,
  scanEntryOutput,
  validateCheckpointCompatibility,
} from '../src/experiment/checkpoint.js';
import type { ExperimentSpec } from '../src/experiment/spec.js';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN } from './helpers.js';

/**
 * Experiment-level checkpoint contract (docs/LONG_RUNNING_WORKFLOWS): policy
 * parsing, config hashing, resume compatibility gates, progress parsing and
 * the task-level recovery downgrade for entries that never save state.
 */

function spec(): ExperimentSpec {
  return {
    specId: 'idea-ck-test',
    version: 1,
    idea: { ideaId: 'ck-test', version: 1 },
    comparisonIds: [],
    codeCommit: null,
    dataSnapshotId: 'data:snapshot-1',
    sliceIds: [],
    environment: { python: 'v24', notes: ['scale:smoke'] },
    command: ['python', 'src/smoke.py'],
    metrics: [{ name: 'accuracy', direction: 'higher' }],
    seeds: [42],
    resources: {},
    budget: { maxRuns: 1, maxMinutes: 5 },
    protocolId: 'proto-1',
    createdAt: 1000,
  } as ExperimentSpec;
}

describe('checkpoint policy and config hash (unit)', () => {
  it('parses policies and defaults invalid shapes to none', () => {
    expect(parseCheckpointPolicy(undefined)).toEqual({ kind: 'none' });
    expect(parseCheckpointPolicy({ kind: 'steps', every: 100 })).toEqual({
      kind: 'steps',
      every: 100,
    });
    expect(parseCheckpointPolicy({ kind: 'epoch' })).toEqual({ kind: 'epoch' });
    expect(parseCheckpointPolicy({ kind: 'bogus', every: 5 })).toEqual({ kind: 'none' });
    expect(parseCheckpointPolicy({ kind: 'steps', every: -3 })).toEqual({ kind: 'steps' });
  });

  it('config hash ignores wall-clock fields but tracks execution inputs', () => {
    const base = spec();
    const same = computeSpecConfigHash({ ...base, createdAt: 999_999, version: 7 });
    expect(computeSpecConfigHash(base)).toBe(same);

    expect(computeSpecConfigHash({ ...base, command: ['python', 'src/train.py'] })).not.toBe(
      computeSpecConfigHash(base),
    );
    expect(computeSpecConfigHash({ ...base, seeds: [42, 43] })).not.toBe(
      computeSpecConfigHash(base),
    );
    expect(computeSpecConfigHash({ ...base, dataSnapshotId: 'data:other' })).not.toBe(
      computeSpecConfigHash(base),
    );
    expect(
      computeSpecConfigHash({
        ...base,
        environment: { ...base.environment, notes: ['scale:quick'] },
      }),
    ).not.toBe(computeSpecConfigHash(base));
  });
});

describe('resume compatibility gate (unit)', () => {
  const current: {
    codeHash: string;
    protocolId: string | null;
    dataSnapshotId: string;
    configHash: `sha256:${string}`;
  } = {
    codeHash: 'sha256:' + 'a'.repeat(64),
    protocolId: 'proto-1',
    dataSnapshotId: 'data:snapshot-1',
    configHash: computeSpecConfigHash(spec()),
  };

  it('accepts a fully matching checkpoint', () => {
    const result = validateCheckpointCompatibility(
      {
        codeHash: current.codeHash,
        protocolId: current.protocolId,
        dataSnapshotId: current.dataSnapshotId,
        configHash: current.configHash,
      },
      current,
    );
    expect(result).toEqual({ compatible: true, mismatches: [] });
  });

  it('blocks resume on ANY drift: code, protocol, data or config', () => {
    const cases: {
      codeHash: string;
      protocolId: string | null;
      dataSnapshotId: string;
      configHash: `sha256:${string}`;
    }[] = [
      { ...current, codeHash: 'sha256:' + 'b'.repeat(64) },
      { ...current, protocolId: 'proto-2' },
      { ...current, dataSnapshotId: 'data:other' },
      { ...current, configHash: `sha256:${'c'.repeat(64)}` },
    ];
    for (const checkpoint of cases) {
      const result = validateCheckpointCompatibility(checkpoint, current);
      expect(result.compatible).toBe(false);
      expect(result.mismatches.length).toBeGreaterThan(0);
    }
    const all = validateCheckpointCompatibility(
      {
        codeHash: 'sha256:' + 'b'.repeat(64),
        protocolId: null,
        dataSnapshotId: 'data:other',
        configHash: `sha256:${'c'.repeat(64)}`,
      },
      current,
    );
    expect(all.mismatches.length).toBe(4);
  });
});

describe('progress and checkpoint output parsing (unit)', () => {
  it('parses heartbeats, saved markers and mixed output', () => {
    expect(
      parseProgressLine('{"progress": {"step": 3, "epoch": 1, "checkpoint": "ckpt-3"}}'),
    ).toEqual({ step: 3, epoch: 1, checkpoint: 'ckpt-3' });
    expect(parseProgressLine('{"metrics": {"accuracy": 0.5}}')).toBeNull();
    expect(parseProgressLine('not json')).toBeNull();

    expect(
      parseCheckpointSavedLine(
        '{"checkpoint_saved": {"checkpointId": "ckpt-1", "step": 2, "files": [{"path": "model.pt"}]}}',
      ),
    ).toEqual({ checkpointId: 'ckpt-1', step: 2, files: [{ path: 'model.pt' }] });
    expect(parseCheckpointSavedLine('{"progress": {"step": 1}}')).toBeNull();

    const scan = scanEntryOutput(
      [
        'warming up',
        '{"progress": {"step": 1}}',
        '{"checkpoint_saved": {"checkpointId": "ckpt-1", "step": 1}}',
        '{"progress": {"step": 5, "checkpoint": "ckpt-1"}}',
        '{"metrics": {"accuracy": 0.5}}',
      ].join('\n'),
    );
    expect(scan.heartbeat).toMatchObject({ step: 5, checkpointId: 'ckpt-1' });
    expect(scan.saved).toHaveLength(1);
    expect(scan.saved[0]!.checkpointId).toBe('ckpt-1');
  });

  it('builds a full manifest bound to spec identity', () => {
    const manifest = buildCheckpointManifest(
      { checkpointId: 'ckpt-9', step: 7, files: [{ path: 'model.pt', sha256: 'abc' }] },
      spec(),
      'sha256:' + 'a'.repeat(64),
    );
    expect(manifest).toMatchObject({
      checkpointId: 'ckpt-9',
      specId: 'idea-ck-test',
      step: 7,
      protocolId: 'proto-1',
      dataSnapshotId: 'data:snapshot-1',
      codeHash: 'sha256:' + 'a'.repeat(64),
    });
    expect(manifest.configHash).toBe(computeSpecConfigHash(spec()));
    expect(manifest.files).toEqual([{ path: 'model.pt', sha256: 'abc' }]);
  });
});

function makeCard(ideaId: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: 's', targetProblem: 't' },
    paperEvidence: [{ paperRef: 'p', statement: 's', evidence: 'e' }],
    contradictions: ['c'],
    novelty: { claim: 'c', uncertainty: 'u', whyNotRestatement: 'w' },
    mechanismChain: {
      designPrincipleLink: 'l',
      steps: [
        { kind: 'observation', text: 'a' },
        { kind: 'hypothesis', text: 'b' },
        { kind: 'intervention', text: 'c' },
        { kind: 'expected-change', text: 'd' },
        { kind: 'baseline-difference', text: 'e' },
        { kind: 'falsifier', text: 'f' },
      ],
    },
    nearestComparisons: [{ methodId: 'm', difference: 'd', evidence: 'e' }],
    componentNecessity: [{ component: 'c', role: 'necessary-mechanism', removeEffect: 'r' }],
    competingExplanations: ['x'],
    boundaryConditions: ['x'],
    risks: ['x'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'd',
      baselines: ['b'],
      metrics: ['accuracy'],
      ablations: ['a'],
    },
    falsification: { conditions: ['f'] },
    budget: { maxRounds: 1, maxGpuMinutes: 10 },
    stopConditions: ['s'],
    createdAt: 1,
  } as IdeaCard;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
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
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** A checkpoint-aware smoke entry with phase-driven behavior for tests. */
const CHECKPOINT_SMOKE = `import json
import os
import sys

STATE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state.txt")
ARGV_LOG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "argv.log")

def main():
    with open(ARGV_LOG, "a", encoding="utf-8") as fh:
        fh.write(" ".join(sys.argv[1:]) + "\\n")
    state = ""
    if os.path.exists(STATE):
        with open(STATE, "r", encoding="utf-8") as fh:
            state = fh.read().strip()
    if "--resume-from" in sys.argv:
        print(json.dumps({"metrics": {"accuracy": 0.75}, "resumed": True}))
        return 0
    if state == "":
        # first invocation (the check ladder): behave like a healthy smoke.
        with open(STATE, "w", encoding="utf-8") as fh:
            fh.write("checked")
        print(json.dumps({"metrics": {"accuracy": 0.5}}))
        return 0
    if state == "checked":
        # the experiment run: save a checkpoint, heartbeat, then crash.
        print(json.dumps({"progress": {"step": 2, "checkpoint": "ckpt-1"}}))
        print(json.dumps({"checkpoint_saved": {"checkpointId": "ckpt-1", "step": 2, "files": [{"path": "model.pt"}]}}))
        sys.stderr.write("simulated crash after checkpoint\\n")
        return 1
    print(json.dumps({"metrics": {"accuracy": 0.6}}))
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

describe('checkpoint-aware experiment runs (CLI)', () => {
  it('persists recovery mode, checkpoint manifest and resumes via --resume', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-ckpt-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('ck-idea')), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'ck-idea', '--from-card', cardPath])).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'set-status', 'ck-idea', 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', 'ck-idea'])).code).toBe(0);

    const worktree = join(project, 'ideas', 'ck-idea');
    await writeFile(join(worktree, 'src', 'smoke.py'), CHECKPOINT_SMOKE, 'utf8');
    // Opt into the checkpoint policy so the runner forwards --checkpoint-every.
    const configPath = join(worktree, 'config', 'train.json');
    const cfg = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    cfg.checkpoint = { kind: 'steps', every: 5 };
    await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    // Check ladder passes (first smoke invocation behaves healthy).
    const check = await runCli(project, ['idea', 'check', 'ck-idea', '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);

    // Experiment run: entry saves a checkpoint then crashes.
    const failed = await runCli(project, ['idea', 'experiment', 'ck-idea', '--json']);
    expect(failed.code).toBe(1);
    const progressPath = join(worktree, 'experiments', 'progress-idea-ck-idea.json');
    const progress = JSON.parse(await readFile(progressPath, 'utf8')) as {
      recovery: string;
      policy: { kind: string; every?: number };
      heartbeat: { step: number; checkpointId: string } | null;
      checkpoints: { checkpointId: string; configHash: string; codeHash: string | null }[];
      resumeHint: { checkpointId: string; compatible: boolean; mismatches: string[] } | null;
      interrupt: string | null;
    };
    expect(progress.recovery).toBe('checkpoint');
    expect(progress.policy).toEqual({ kind: 'steps', every: 5 });
    expect(progress.heartbeat).toMatchObject({ step: 2, checkpointId: 'ckpt-1' });
    expect(progress.checkpoints).toHaveLength(1);
    expect(progress.checkpoints[0]!.checkpointId).toBe('ckpt-1');
    expect(progress.checkpoints[0]!.configHash).toMatch(/^sha256:/);
    expect(progress.resumeHint).toMatchObject({ checkpointId: 'ckpt-1', compatible: true });
    expect(progress.resumeHint!.mismatches).toEqual([]);
    expect(progress.interrupt).toBeNull();

    // The policy was forwarded to the entry (recorded via argv log).
    const argvLog = await readFile(join(worktree, 'argv.log'), 'utf8');
    expect(argvLog).toContain('--checkpoint-every 5');

    // Resume: compatible checkpoint → --resume-from appended, run succeeds.
    const resumed = await runCli(project, ['idea', 'experiment', 'ck-idea', '--resume', '--json']);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    const resumePayload = JSON.parse(resumed.stdout) as {
      resultStatus: string;
      version: number;
    };
    expect(resumePayload.resultStatus).toBe('succeeded');
    const argvAfter = await readFile(join(worktree, 'argv.log'), 'utf8');
    expect(argvAfter).toContain('--resume-from ckpt-1');
    // After the successful resume, THIS run saved no new checkpoint, so the
    // progress file honestly reports task-level with no resume target.
    const after = JSON.parse(await readFile(progressPath, 'utf8')) as {
      recovery: string;
      resumeHint: unknown;
    };
    expect(after.recovery).toBe('task-level');
    expect(after.resumeHint).toBeNull();
  }, 180_000);

  it('refuses --resume for task-level recovery (no checkpoint saved)', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-ckpt-tl-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('tl-idea')), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'tl-idea', '--from-card', cardPath])).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'set-status', 'tl-idea', 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', 'tl-idea'])).code).toBe(0);

    // A hanging smoke entry: the check ladder tolerates it (default 60s
    // timeout, the sleep finishes), the experiment with --timeout 300ms
    // is force-killed → task-level recovery, no checkpoint.
    const hangSmoke = `import json, time, sys
print(json.dumps({"progress": {"step": 1}}))
time.sleep(3)
print(json.dumps({"metrics": {"accuracy": 0.5}}))
`;
    await writeFile(join(project, 'ideas', 'tl-idea', 'src', 'smoke.py'), hangSmoke, 'utf8');

    const check = await runCli(project, ['idea', 'check', 'tl-idea', '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);

    const timedOut = await runCli(project, [
      'idea',
      'experiment',
      'tl-idea',
      '--timeout',
      '300',
      '--json',
    ]);
    expect(timedOut.code).toBe(1);
    const progress = JSON.parse(
      await readFile(
        join(project, 'ideas', 'tl-idea', 'experiments', 'progress-idea-tl-idea.json'),
        'utf8',
      ),
    ) as { recovery: string; interrupt: string | null; checkpoints: unknown[] };
    expect(progress.recovery).toBe('task-level');
    expect(progress.interrupt).toBe('force-kill');
    expect(progress.checkpoints).toEqual([]);

    // --resume must refuse: there is nothing to resume from.
    const resume = await runCli(project, ['idea', 'experiment', 'tl-idea', '--resume']);
    expect(resume.code).not.toBe(0);
    expect(resume.stderr).toContain('task-level recovery');
    expect(resume.stderr).toContain('WITHOUT --resume');
  }, 180_000);
});
