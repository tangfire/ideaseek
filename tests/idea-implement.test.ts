import { describe, expect, it } from 'vitest';
import {
  buildIdeaImplementationContext,
  checkAuthoredFiles,
  IDEA_IMPLEMENT_INSTRUCTION,
  parseIdeaImplementationOutput,
  writeIdeaFiles,
} from '../src/idea/implement.js';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IdeaCard } from '../src/idea/card.js';

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
