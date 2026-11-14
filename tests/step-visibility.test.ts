import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Step-level agent visibility (PROGRESS 86): harness tool_call events
 * stream into the RunEvent ledger LIVE (not batched after completion),
 * and training progress heartbeats become experiment_progress events —
 * both visible through `ideaseek events` / attach / TUI (generic event
 * rendering). Summaries are sanitized at the adapter (HarnessEvent
 * contract); telemetry failures never break the task.
 */

function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...extraEnv },
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
    child.stdin.end();
  });
}

async function setupIdeaWithProgressPrinter(dir: string): Promise<void> {
  const cardPath = join(dir, 'card.json');
  await writeFile(
    cardPath,
    JSON.stringify({
      ideaId: 'alpha',
      version: 1,
      parentVersion: null,
      status: 'DRAFT_COMPOSITION',
      hypothesis: { statement: 'Drift lifts recall.', targetProblem: 'gap' },
      paperEvidence: [{ paperRef: 'p1', statement: 'fedavg', evidence: 'p.1' }],
      contradictions: ['prior work disagrees'],
      novelty: { claim: 'term', uncertainty: 'thin', whyNotRestatement: 'new' },
      mechanismChain: {
        designPrincipleLink: 'x',
        steps: [{ kind: 'observation', text: 'y' }],
      },
      nearestComparisons: [{ methodId: 'fedavg', difference: 'adds term', evidence: 'table 2' }],
      componentNecessity: [],
      competingExplanations: ['lr explains it'],
      boundaryConditions: ['label-skew only'],
      risks: ['noise'],
      minimalExperiment: {
        code: 'src/train.py',
        data: 'smoke',
        baselines: ['fedavg'],
        metrics: ['dice'],
        ablations: ['w/o term'],
      },
      falsification: { conditions: ['no gain'] },
      budget: { maxRounds: 3, maxGpuMinutes: 60 },
      stopConditions: ['budget'],
      createdAt: 1,
    }),
    'utf8',
  );
  expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
  expect((await runCli(dir, ['idea', 'set-status', 'alpha', 'IMPLEMENTING'])).code).toBe(0);
  expect((await runCli(dir, ['idea', 'scaffold', 'alpha'])).code).toBe(0);
  await writeFile(
    join(dir, 'ideas', 'alpha', 'src', 'train.py'),
    'import json\n' +
      'print(json.dumps({"progress": {"step": 1, "epoch": 0}}))\n' +
      'print(json.dumps({"progress": {"step": 2, "epoch": 1}}))\n' +
      'print(json.dumps({"metrics": {"dice": 0.5}}))\n',
    'utf8',
  );
  // smoke scale executes src/smoke.py — give it the same printer.
  await writeFile(
    join(dir, 'ideas', 'alpha', 'src', 'smoke.py'),
    'import json\n' +
      'print(json.dumps({"progress": {"step": 1, "epoch": 0}}))\n' +
      'print(json.dumps({"progress": {"step": 2, "epoch": 1}}))\n' +
      'print(json.dumps({"metrics": {"dice": 0.5}}))\n',
    'utf8',
  );
  const trainPath = join(dir, 'ideas', 'alpha', 'config', 'train.json');
  const cfg = JSON.parse(
    await readFile(join(dir, 'ideas', 'alpha', 'config', 'train.json'), 'utf8'),
  ) as Record<string, unknown>;
  cfg.seeds = [42, 7];
  await writeFile(trainPath, JSON.stringify(cfg), 'utf8');
  expect((await runCli(dir, ['idea', 'check', 'alpha'])).code).toBe(0);
}

describe('live tool_call events in the RunEvent stream', () => {
  it('a harness turn appends harness_tool_call events visible via ideaseek events', async () => {
    const dir = await makeProjectDir();
    // A run exists so synthetic ask runIds remap onto it (FK-safe ledger).
    expect(
      (await runCli(dir, ['run', '--question', 'step visibility', '--enqueue-only'])).code,
    ).toBe(0);

    const ask = await runCli(
      dir,
      ['ask', 'wibble zorkmid quuxly ponder the anomaly', '--json'],
      {
        IDEASEEK_FAKE_TOOL_CALLS: JSON.stringify([
          { tool: 'project_read', summary: '{"path":"ideas"}', ok: true },
          { tool: 'shell', summary: 'ls -la', ok: false },
        ]),
      },
      120_000,
    );
    expect(ask.code, ask.stdout + ask.stderr).toBe(0);
    const rt = await openRuntime(dir, { recover: false });
    try {
      const run = await rt.db.getLatestRun(rt.project.id);
      const events = await rt.db.listEvents(run!.runId, { limit: 10_000 });
      const toolEvents = events.filter((event) => event.eventType === 'harness_tool_call');
      expect(toolEvents.length).toBeGreaterThanOrEqual(2);
      expect(toolEvents.map((event) => event.summary).join(' | ')).toContain('project_read');
      expect(toolEvents.map((event) => event.summary).join(' | ')).toContain('shell');
      expect(toolEvents.some((event) => event.status === 'ok')).toBe(true);
      expect(toolEvents.some((event) => event.status === 'error')).toBe(true);
      // Step-level: events landed DURING the turn on the real run (not a
      // synthetic ask-session id — the FK forbids that).
      expect(toolEvents.every((event) => event.runId === run!.runId)).toBe(true);
    } finally {
      await rt.close();
    }

    // The generic events view renders them (attach/TUI share this stream).
    const eventsCmd = await runCli(dir, ['events', '--json']);
    expect(eventsCmd.code, eventsCmd.stdout + eventsCmd.stderr).toBe(0);
    const payload = JSON.parse(eventsCmd.stdout) as {
      events: { eventType: string }[];
    };
    expect(payload.events.some((event) => event.eventType === 'harness_tool_call')).toBe(true);
  }, 180_000);
});

describe('experiment progress heartbeats → experiment_progress events', () => {
  it('a smoke run with progress lines records step-level RunEvents on the latest run', async () => {
    const dir = await makeProjectDir();
    await setupIdeaWithProgressPrinter(dir);
    expect((await runCli(dir, ['run', '--question', 'progress run', '--enqueue-only'])).code).toBe(
      0,
    );

    const experiment = await runCli(dir, [
      'idea',
      'experiment',
      'alpha',
      '--scale',
      'smoke',
      '--json',
    ]);
    expect(experiment.code, experiment.stdout + experiment.stderr).toBe(0);

    const rt = await openRuntime(dir, { recover: false });
    try {
      const run = await rt.db.getLatestRun(rt.project.id);
      const events = await rt.db.listEvents(run!.runId, { limit: 10_000 });
      const progress = events.filter((event) => event.eventType === 'experiment_progress');
      expect(progress.length).toBeGreaterThanOrEqual(1);
      const summaries = progress.map((event) => event.summary).join(' | ');
      expect(summaries).toContain('"step":1');
      expect(progress.every((event) => event.objectId === 'idea-alpha')).toBe(true);
      expect(progress.every((event) => event.runId === run!.runId)).toBe(true);
    } finally {
      await rt.close();
    }

    const eventsCmd = await runCli(dir, ['events', '--json']);
    const payload = JSON.parse(eventsCmd.stdout) as { events: { eventType: string }[] };
    expect(payload.events.some((event) => event.eventType === 'experiment_progress')).toBe(true);
  }, 300_000);

  it('without any run the progress recorder no-ops (experiment still succeeds)', async () => {
    const dir = await makeProjectDir();
    await setupIdeaWithProgressPrinter(dir);
    const experiment = await runCli(dir, [
      'idea',
      'experiment',
      'alpha',
      '--scale',
      'smoke',
      '--json',
    ]);
    expect(experiment.code, experiment.stdout + experiment.stderr).toBe(0);
    // No run exists → no experiment_progress events anywhere (honest no-op).
    const rt = await openRuntime(dir, { recover: false });
    try {
      const run = await rt.db.getLatestRun(rt.project.id);
      expect(run).toBeNull();
    } finally {
      await rt.close();
    }
  }, 300_000);
});
