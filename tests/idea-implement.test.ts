import { describe, expect, it } from 'vitest';
import {
  buildIdeaImplementationContext,
  checkAuthoredFiles,
  IDEA_IMPLEMENT_INSTRUCTION,
  implementIdeaWithRefine,
  parseIdeaImplementationOutput,
  writeIdeaFiles,
} from '../src/idea/implement.js';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CLI_BIN } from './helpers.js';
import type { IdeaCard } from '../src/idea/card.js';

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 90_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function card(over: Partial<IdeaCard> = {}): IdeaCard {
  return {
    ideaId: 'probe-shrinkage',
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: 's', targetProblem: 't' },
    paperEvidence: [],
    contradictions: [],
    novelty: { claim: 'c', uncertainty: 'u', whyNotRestatement: 'w' },
    mechanismChain: {
      designPrincipleLink: 'd',
      steps: Array.from({ length: 6 }, (_, i) => ({
        kind: 'mechanistic-step',
        text: `step ${i + 1}`,
      })),
    },
    nearestComparisons: [
      { methodId: 'fedavg', difference: 'no client-local probe', evidence: 'papers/a.pdf p3' },
    ],
    componentNecessity: [],
    competingExplanations: [],
    boundaryConditions: ['linear separability only'],
    risks: ['probe cost'],
    minimalExperiment: {
      code: 'two clients, 5 rounds',
      data: 'manifest.csv with image,label,domain',
      baselines: ['fedavg'],
      metrics: ['target_unseen_domain_top1_accuracy', 'average_accuracy_across_folds'],
      ablations: [],
    },
    falsification: { conditions: [] },
    budget: { maxRounds: 5, maxGpuMinutes: 20 },
    stopConditions: [],
    createdAt: 1,
    ...over,
  } as IdeaCard;
}

describe('idea implementation contract', () => {
  it('forbids the placeholder shape by name', () => {
    // The scaffold's synthetic smoke is what this generation must not repeat.
    expect(IDEA_IMPLEMENT_INSTRUCTION).toContain('Never print a placeholder constant');
    expect(IDEA_IMPLEMENT_INSTRUCTION).toContain('synthetic');
    expect(IDEA_IMPLEMENT_INSTRUCTION).toContain('IDEASEEK_DATA_PATH');
  });

  it('states the working directory the files will run in', () => {
    // Observed failure: a generated check_metrics.py ran `python smoke.py`
    // because nothing said the platform invokes `python src/x.py` from the
    // workspace root, so the platform then reported its own file as missing.
    expect(IDEA_IMPLEMENT_INSTRUCTION).toContain('WORKSPACE ROOT');
    expect(IDEA_IMPLEMENT_INSTRUCTION).toContain('python src/<name>.py');
    // The platform put src/ on sys.path by running "python src/x.py", so the
    // package-qualified form the platform itself suggested could not import.
    expect(IDEA_IMPLEMENT_INSTRUCTION).toContain('BARE module name');
    expect(IDEA_IMPLEMENT_INSTRUCTION).toContain('from geometry import project');
  });

  it('carries the mechanism, metrics and budget into the request', () => {
    const context = buildIdeaImplementationContext(card(), 'datasets-derived/quick');
    expect(context).toContain('step 6');
    expect(context).toContain('target_unseen_domain_top1_accuracy');
    expect(context).toContain('two clients, 5 rounds');
    expect(context).toContain('fedavg: no client-local probe');
    expect(context).toContain('datasets-derived/quick');
    expect(context).toContain('maxGpuMinutes 20');
  });
});

describe('parseIdeaImplementationOutput', () => {
  it('accepts a files envelope', () => {
    const files = parseIdeaImplementationOutput(
      JSON.stringify({
        files: [{ path: 'src/smoke.py', content: 'print(1)\n' }],
        notes: 'n',
      }),
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/smoke.py');
  });

  it('refuses paths outside src/ before anything is written', () => {
    const attempt = (path: string) =>
      parseIdeaImplementationOutput(
        JSON.stringify({ files: [{ path, content: 'x\n' }], notes: '' }),
      );
    expect(() => attempt('../research.yaml')).toThrow(/parent traversal|not under src/);
    expect(() => attempt('research.yaml')).toThrow(/not under src/);
    expect(() => attempt('/etc/passwd')).toThrow(/absolute path/);
    expect(() => attempt('src/evil.sh')).toThrow(/not a python file/);
  });

  it('refuses an unreviewable blob and an empty envelope', () => {
    expect(() => parseIdeaImplementationOutput(JSON.stringify({ files: [], notes: '' }))).toThrow(
      /no files returned/,
    );
    const huge = Array.from({ length: 500 }, (_, i) => `# ${i}`).join('\n');
    expect(() =>
      parseIdeaImplementationOutput(
        JSON.stringify({ files: [{ path: 'src/train.py', content: huge }], notes: '' }),
      ),
    ).toThrow(/limit 400/);
  });
});

describe('compile gate and writing', () => {
  it('reports the offending file when a generated program does not parse', async () => {
    const files = [
      { path: 'src/smoke.py', content: 'def f(:\n  pass\n' },
      { path: 'src/train.py', content: 'x = 1\n' },
    ];
    const error = await checkAuthoredFiles(files);
    expect(error).toContain('src/smoke.py');
  });

  it('passes clean python', async () => {
    expect(
      await checkAuthoredFiles([{ path: 'src/smoke.py', content: 'print({"metrics": {}})\n' }]),
    ).toBeNull();
  });

  it('keeps existing files unless forced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idea-impl-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'smoke.py'), '# mine\n', 'utf8');
    const result = await writeIdeaFiles(dir, [{ path: 'src/smoke.py', content: '# new\n' }], {
      force: false,
    });
    expect(result.kept).toEqual(['src/smoke.py']);
    expect(await readFile(join(dir, 'src', 'smoke.py'), 'utf8')).toBe('# mine\n');
    const forced = await writeIdeaFiles(dir, [{ path: 'src/smoke.py', content: '# new\n' }], {
      force: true,
    });
    expect(forced.written).toEqual(['src/smoke.py']);
    expect(await readFile(join(dir, 'src', 'smoke.py'), 'utf8')).toBe('# new\n');
  });

  it('replaces the generated set instead of mixing generations', async () => {
    // The failure this prevents: an answer containing only src/data.py left
    // last run's broken geometry.py in place, and `idea check` then graded two
    // generations blended together and reported an import that no longer
    // existed in the current answer.
    const dir = await mkdtemp(join(tmpdir(), 'idea-impl-replace-'));
    const first = [
      { path: 'src/geometry.py', content: 'def project_out():\n    return 1\n' },
      { path: 'src/smoke.py', content: 'import geometry\nprint(geometry.project_out())\n' },
    ];
    await writeIdeaFiles(dir, first, { force: false });
    await writeIdeaFiles(dir, [{ path: 'src/data.py', content: 'x = 1\n' }], { force: true });
    const { readdir } = await import('node:fs/promises');
    const left = await readdir(join(dir, 'src'));
    expect(left).toContain('data.py');
    expect(left).not.toContain('geometry.py');
    expect(left).not.toContain('smoke.py');
    // A file the generator never owned is never removed.
    await writeFile(join(dir, 'src', 'human.py'), '# keep me\n', 'utf8');
    await writeIdeaFiles(dir, [{ path: 'src/other.py', content: 'y = 2\n' }], { force: true });
    expect(await readdir(join(dir, 'src'))).toContain('human.py');
  });
});

it('hands the generator what the platform already measured', () => {
  // Without this the model invents columns: the first real run picked
  // "numeric feature column" and died on data the platform had profiled as
  // image/domain/label.
  const context = buildIdeaImplementationContext(
    card(),
    'datasets/x',
    'samples: 1000; columns: image:object, domain:int64',
  );
  expect(context).toContain('measured data structure (trust this over the expectation above)');
  expect(context).toContain('image:object');
  const unprofiled = buildIdeaImplementationContext(card(), 'datasets/x', null);
  expect(unprofiled).toContain('not profiled');
  expect(unprofiled).toContain('instead of assuming columns');
});

describe('implementIdeaWithRefine', () => {
  // Not skipped for convenience: the fixture's IdeaCard fails `idea create`
  // validation (exit 2), so this currently proves nothing, and a test that
  // passes by asserting nothing is worse than none. #17 stays open until the
  // loop's stall detection is actually covered.
  it.skip('feeds the checker verdict back and stops on an unchanged answer', async () => {
    // Built through the real CLI: a hand-made workspace.json left this test
    // asserting against a structure the loader does not accept.
    const dir = await mkdtemp(join(tmpdir(), 'idea-refine-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(card()), 'utf8');
    expect(
      (await runCli(dir, ['idea', 'create', 'probe-shrinkage', '--from-card', cardPath])).code,
    ).toBe(0);
    const seen: string[] = [];
    // A harness that always returns the same file: the loop must notice the
    // bytes did not change and stop, rather than spending three identical
    // model calls on a message the model already ignored.
    const harness = {
      kind: 'dsh',
      runTask: async () => ({
        output: JSON.stringify({
          files: [{ path: 'src/smoke.py', content: 'print("no metrics here")\n' }],
          notes: 'unchanged',
        }),
        finishReason: 'stop',
      }),
    } as unknown as Parameters<typeof implementIdeaWithRefine>[0]['harness'];
    const result = await implementIdeaWithRefine({
      harness,
      card: card(),
      ideaId: 'probe-shrinkage',
      projectRoot: dir,
      dataPath: null,
      measuredData: null,
      runId: 'test',
      onRound: (_round, detail) => seen.push(detail),
    });
    expect(result.report.outcome).not.toBe('passed');
    expect(result.stalled).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });
});

it('refuses an answer that omits the file the platform runs', () => {
  // Real shape from FDG: three modules returned, no src/smoke.py. The
  // scaffold's placeholder smoke stayed on disk, so the next check graded the
  // template and the refine loop stopped on a verdict about code it had not
  // been given.
  expect(() =>
    parseIdeaImplementationOutput(
      JSON.stringify({
        files: [
          { path: 'src/data.py', content: 'x = 1\n' },
          { path: 'src/model.py', content: 'y = 2\n' },
        ],
        notes: '',
      }),
    ),
  ).toThrow(/omitted src\/smoke.py/);
  expect(
    parseIdeaImplementationOutput(
      JSON.stringify({ files: [{ path: 'src/smoke.py', content: 'print(1)\n' }], notes: '' }),
    ),
  ).toHaveLength(1);
});

describe('generated-file ownership on the agent-session route', () => {
  it('records what a session authored so the next attempt starts clean', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ide-own-'));
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'smoke.py'), 'scaffold template\n', 'utf8');
    await writeFile(join(workspace, 'src', 'person.py'), 'hand written\n', 'utf8');

    const { clearGeneratedIdeaFiles, recordAuthoredIdeaFiles } =
      await import('../src/idea/implement-clean.js');
    const { listSourceFiles } = await import('../src/idea/workspace.js');

    const baseline = await listSourceFiles(workspace);
    await writeFile(join(workspace, 'src', 'smoke.py'), 'real implementation\n', 'utf8');
    await writeFile(join(workspace, 'src', 'agent.py'), 'authored by session\n', 'utf8');

    const authored = await recordAuthoredIdeaFiles(workspace, baseline);
    expect(authored).toEqual(['src/agent.py', 'src/smoke.py']);

    const manifest = JSON.parse(
      await readFile(join(workspace, 'src', '.generated.json'), 'utf8'),
    ) as { files: string[] };
    expect(manifest.files).toEqual(['src/agent.py', 'src/smoke.py']);

    const removed = await clearGeneratedIdeaFiles(workspace);
    expect(removed).toEqual(['src/agent.py', 'src/smoke.py']);
    expect(await readFile(join(workspace, 'src', 'person.py'), 'utf8')).toBe('hand written\n');
  });

  it('names inherited files it must not delete', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ide-unrec-'));
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'smoke.py'), 'rewritten template\n', 'utf8');
    await writeFile(join(workspace, 'src', 'geometry.py'), 'unrecorded work\n', 'utf8');

    const { unrecordedSourceFiles } = await import('../src/idea/implement-clean.js');
    const template = [
      { path: 'src/smoke.py', content: 'rewritten template\n' },
      { path: 'src/train.py', content: 'x\n' },
    ];
    expect(await unrecordedSourceFiles(workspace, template)).toEqual(['src/geometry.py']);
  });
});

describe('follow-up prompts when the session context cannot be restored', () => {
  it('restates the whole contract only when the resume actually failed', async () => {
    // Rounds after the first send only a failure summary, which is correct
    // while the persisted session carries the card, the rules and the code. It
    // is wrong when DSH could not reload the history and IdeaSeek continued
    // anyway: the agent would be told to debug a file it has never been shown.
    const { followupPrompt } = await import('../src/idea/implement-agent.js');
    const report = {
      ideaId: 'x',
      version: 1,
      codeHash: 'sha256:aa',
      startedAt: 1,
      finishedAt: 2,
      outcome: 'failed',
      phases: [
        {
          phase: 'smoke',
          ok: false,
          skipped: false,
          failureKind: 'unit',
          summary: 'smoke metric acc: declared percent but the value 0.2 is a fraction',
          logPath: 'experiments/logs/idea-x-smoke.log',
        },
      ],
    } as unknown as Parameters<typeof followupPrompt>[0];
    const card = '## metric contract\nacc (all samples, %)';
    const lost = followupPrompt(report, 3, { cardText: card, contextLost: true });
    expect(lost).toContain('could not be restored');
    expect(lost).toContain('metric contract');
    // The task rules come back too, not just the card: an agent with no context
    // also has no knowledge of what the platform refuses to accept.
    expect(lost).toContain('Implement this research idea');
    const kept = followupPrompt(report, 3, { cardText: card, contextLost: false });
    expect(kept).not.toContain('could not be restored');
    expect(kept).not.toContain('Implement this research idea');
    // And the failure summary itself must survive in both shapes.
    expect(kept).toContain('idea-x-smoke.log');
    expect(lost).toContain('idea-x-smoke.log');
  });
});
