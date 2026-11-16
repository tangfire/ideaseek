import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arisSkillsRoot } from '../src/aris/skill.js';
import {
  PAPER_FIGURE_OUTPUT_CONTRACT,
  buildFigureRequest,
  parsePaperFigureOutput,
  validatePaperFigurePlan,
  type FigureContext,
} from '../src/paper/figure.js';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * Phase 4.5C capability 2: ARIS paper-figure integration. The contract
 * captures figure specs + plotting script sources bound to the STORED
 * paper plan's figure ids (traceability); scripts are persisted, never
 * executed here (Phase 7 owns the figure pipeline).
 */

function validFigurePlan(): Record<string, unknown> {
  return {
    style: 'publication',
    dpi: 300,
    format: 'pdf',
    figures: [
      {
        id: 'fig-1',
        type: 'bar',
        title: 'Main comparison',
        caption: 'Main comparison under the locked protocol.',
        statistics: ['bar height = final accuracy'],
        dataSources: [{ kind: 'experiment-spec', ref: 'repro-fedavg' }],
        script: `import json, matplotlib.pyplot as plt
rows = json.load(open("repro-fedavg"))
fig, ax = plt.subplots()
ax.bar(rows["labels"], rows["values"])
fig.savefig("figures/fig.pdf")
fig.savefig("figures/fig.png")`,
        latexInclude: '\\includegraphics{figures/fig-1}',
        claims: ['Method A beats the baseline'],
      },
    ],
    preservedExisting: [],
    manualRemaining: ['architecture diagram (manual)'],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['no backend hosted'] },
  };
}

function context(plannedIds: string[] = []): FigureContext {
  return {
    plannedFigureIds: plannedIds,
    snapshot: {
      question: 'q',
      protocol: null,
      comparisons: [],
      experiments: [],
      ideas: [],
      researchMapHash: null,
    },
    existingFigures: [],
    question: 'q',
    resultsGuide: '(none exported)',
    resultsFile: null,
  };
}

describe('validatePaperFigurePlan (contract)', () => {
  it('accepts a complete plan', () => {
    const result = validatePaperFigurePlan(validFigurePlan());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts resource and sensitivity figure types (Phase 7 chart coverage)', () => {
    const plan = validFigurePlan();
    (plan.figures as Record<string, unknown>[]).push(
      {
        id: 'fig-res',
        type: 'resource',
        title: 'GPU-hours per method',
        caption: 'Total GPU-hours under the locked budget.',
        statistics: ['bar height = gpu-hours'],
        dataSources: [{ kind: 'result-file', ref: 'result-1' }],
        script: `import json, matplotlib.pyplot as plt
rows = json.load(open("result-1"))
fig, ax = plt.subplots()
ax.bar(rows["labels"], rows["values"])
fig.savefig("figures/fig.pdf")
fig.savefig("figures/fig.png")`,
        latexInclude: '\\includegraphics{figures/fig-res}',
        claims: ['Method A costs less than the baseline'],
      },
      {
        id: 'fig-sens',
        type: 'sensitivity',
        title: 'Recall vs drift weight',
        caption: 'Sensitivity of rare-class recall to the drift coefficient.',
        statistics: ['x = drift weight, y = rare-class recall'],
        dataSources: [{ kind: 'result-file', ref: 'result-2' }],
        script: `import json, matplotlib.pyplot as plt
rows = json.load(open("result-2"))
fig, ax = plt.subplots()
ax.bar(rows["labels"], rows["values"])
fig.savefig("figures/fig.pdf")
fig.savefig("figures/fig.png")`,
        latexInclude: '\\includegraphics{figures/fig-sens}',
        claims: ['Recall peaks at weight 0.5'],
      },
    );
    const result = validatePaperFigurePlan(plan);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  const rejected: { name: string; plan: unknown }[] = [
    { name: 'null', plan: null },
    {
      name: 'bad style',
      plan: (() => {
        const p = validFigurePlan();
        p.style = 'print';
        return p;
      })(),
    },
    {
      name: 'dpi 71',
      plan: (() => {
        const p = validFigurePlan();
        p.dpi = 71;
        return p;
      })(),
    },
    {
      name: 'bad format',
      plan: (() => {
        const p = validFigurePlan();
        p.format = 'svg';
        return p;
      })(),
    },
    {
      name: 'empty figures',
      plan: (() => {
        const p = validFigurePlan();
        p.figures = [];
        return p;
      })(),
    },
    {
      name: 'unknown type',
      plan: (() => {
        const p = validFigurePlan();
        (p.figures as Record<string, unknown>[])[0]!.type = 'pie';
        return p;
      })(),
    },
    {
      name: 'duplicate id',
      plan: (() => {
        const p = validFigurePlan();
        (p.figures as unknown[]).push(structuredClone((p.figures as unknown[])[0]));
        return p;
      })(),
    },
    {
      name: 'script without matplotlib',
      plan: (() => {
        const p = validFigurePlan();
        (p.figures as Record<string, unknown>[])[0]!.script = 'print("hi")';
        return p;
      })(),
    },
    {
      name: 'missing latexInclude',
      plan: (() => {
        const p = validFigurePlan();
        delete (p.figures as Record<string, unknown>[])[0]!.latexInclude;
        return p;
      })(),
    },
    {
      name: 'no data sources',
      plan: (() => {
        const p = validFigurePlan();
        (p.figures as Record<string, unknown>[])[0]!.dataSources = [];
        return p;
      })(),
    },
    {
      name: 'missing caption',
      plan: (() => {
        const p = validFigurePlan();
        delete (p.figures as Record<string, unknown>[])[0]!.caption;
        return p;
      })(),
    },
    {
      name: 'empty statistics',
      plan: (() => {
        const p = validFigurePlan();
        (p.figures as Record<string, unknown>[])[0]!.statistics = [];
        return p;
      })(),
    },
    {
      name: 'bad source kind',
      plan: (() => {
        const p = validFigurePlan();
        (p.figures as Record<string, unknown>[])[0]!.dataSources = [{ kind: 'guess', ref: 'x' }];
        return p;
      })(),
    },
    {
      name: 'empty claims',
      plan: (() => {
        const p = validFigurePlan();
        (p.figures as Record<string, unknown>[])[0]!.claims = [];
        return p;
      })(),
    },
    {
      name: 'bad manualRemaining',
      plan: (() => {
        const p = validFigurePlan();
        p.manualRemaining = [''];
        return p;
      })(),
    },
    {
      name: 'bad verdict',
      plan: (() => {
        const p = validFigurePlan();
        (p.reviewerFeedback as Record<string, unknown>).verdict = 'LGTM';
        return p;
      })(),
    },
  ];
  for (const testCase of rejected) {
    it(`rejects: ${testCase.name}`, () => {
      const result = validatePaperFigurePlan(testCase.plan);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  }
});

describe('parsePaperFigureOutput (plan pin)', () => {
  const fakeSkill = {
    name: 'paper-figure',
    sha256: 'sha256:' + 'd'.repeat(64),
    frontmatter: {},
    description: 'fake',
    allowedTools: [],
    body: 'body',
    path: 'skills/paper-figure/SKILL.md',
  } as Parameters<typeof buildFigureRequest>[0];

  it('rejects output that misses a planned figure id', () => {
    expect(() =>
      parsePaperFigureOutput(JSON.stringify(validFigurePlan()), context(['fig-1', 'fig-2'])),
    ).toThrow(/misses planned figure id/);
  });

  it('accepts output covering every planned id', () => {
    const plan = validFigurePlan();
    (plan.figures as Record<string, unknown>[]).push({
      id: 'fig-2',
      type: 'line',
      title: 'Curves',
      caption: 'Training curves.',
      statistics: ['y = metric over steps'],
      dataSources: [{ kind: 'result-file', ref: 'logs/run.json' }],
      script: `import json, matplotlib.pyplot as plt
rows = json.load(open("logs/run.json"))
fig, ax = plt.subplots()
ax.bar(rows["labels"], rows["values"])
fig.savefig("figures/fig.pdf")
fig.savefig("figures/fig.png")`,
      latexInclude: '\\includegraphics{figures/fig-2}',
      claims: ['curves converge'],
    });
    const parsed = parsePaperFigureOutput(JSON.stringify(plan), context(['fig-1', 'fig-2']));
    expect(parsed.figures).toHaveLength(2);
  });

  it('skips the pin check when no plan exists and binds the contract in requests', () => {
    const parsed = parsePaperFigureOutput(JSON.stringify(validFigurePlan()), context([]));
    expect(parsed.figures[0]!.id).toBe('fig-1');
    const request = buildFigureRequest(fakeSkill, context(['fig-1']));
    expect(request.instruction).toContain(PAPER_FIGURE_OUTPUT_CONTRACT);
    expect(request.instruction).toContain('fig-1');
    expect(request.idempotencyKey.startsWith('paper-figure:')).toBe(true);
  });
});

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...env },
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

function figureFile(dir: string): string {
  return join(dir, 'reports', 'paper', 'figures-plan.json');
}

describe('ideaseek paper figure (e2e, fake harness)', () => {
  it('plans figures pinned to the stored paper plan, then reuses', async () => {
    const dir = await makeProjectDir();
    expect((await runCli(dir, ['paper', 'plan', '--harness', 'fake'])).code).toBe(0);

    const first = await runCli(dir, ['paper', 'figure', '--harness', 'fake']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('figure plan written');
    expect(first.stdout).toContain('NOT executed');
    expect(first.stdout).toContain('manual (not auto-generated)');

    const stored = JSON.parse(await readFile(figureFile(dir), 'utf8')) as {
      contract: string;
      inputHash: string;
      harnessRuntime: string;
      figures: {
        style: string;
        dpi: number;
        figures: { id: string; script: string; latexInclude: string }[];
        manualRemaining: string[];
        reviewerFeedback: { verdict: string };
      };
    };
    expect(stored.contract).toBe('paper-figure-v1');
    expect(stored.harnessRuntime).toBe('fake');
    expect(stored.figures.style).toBe('publication');
    expect(stored.figures.dpi).toBe(300);
    // Pinned to the plan's figure id (fig-1 from paper-plan's figurePlan).
    expect(stored.figures.figures.map((figure) => figure.id)).toEqual(['fig-1']);
    expect(stored.figures.figures[0]!.script).toContain('matplotlib');
    expect(stored.figures.figures[0]!.latexInclude).toContain('\\includegraphics');
    const firstFigure = stored.figures.figures[0] as unknown as {
      caption: string;
      statistics: string[];
    };
    expect(firstFigure.caption).toContain('Fake caption');
    expect(firstFigure.statistics.length).toBeGreaterThan(0);
    expect(stored.figures.manualRemaining.length).toBeGreaterThan(0);
    expect(stored.figures.reviewerFeedback.verdict).toBe('REVIEW_UNAVAILABLE');

    const before = await readFile(figureFile(dir), 'utf8');
    const second = await runCli(dir, ['paper', 'figure', '--harness', 'fake']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('reused figure plan');
    expect(await readFile(figureFile(dir), 'utf8')).toBe(before);
  }, 180_000);

  it('refuses output that drops a planned figure id (zero writes)', async () => {
    const dir = await makeProjectDir();
    expect((await runCli(dir, ['paper', 'plan', '--harness', 'fake'])).code).toBe(0);
    const bad = JSON.stringify({
      ...validFigurePlan(),
      figures: [
        {
          ...(validFigurePlan().figures as Record<string, unknown>[])[0],
          id: 'fig-other',
        },
      ],
    });
    const failed = await runCli(dir, ['paper', 'figure', '--harness', 'fake'], {
      IDEASEEK_FAKE_PAPER_FIGURE_OUTPUT: bad,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('misses planned figure id');
    await expect(readFile(figureFile(dir), 'utf8')).rejects.toThrow();
  }, 120_000);

  it('maps quota blocks to exit 2 with nothing written', async () => {
    const dir = await makeProjectDir();
    const blocked = await runCli(dir, ['paper', 'figure', '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('nothing was written');
    await expect(readFile(figureFile(dir), 'utf8')).rejects.toThrow();

    const recovered = await runCli(dir, ['paper', 'figure', '--harness', 'fake']);
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toContain('figure plan written');
  }, 120_000);

  it('refuses a tampered ARIS skill before any model call', async () => {
    const dir = await makeProjectDir();
    const copyRoot = await mkdtemp(join(tmpdir(), 'aris-figure-tamper-'));
    await cp(arisSkillsRoot(), copyRoot, { recursive: true });
    const skillFile = join(copyRoot, 'skills', 'paper-figure', 'SKILL.md');
    await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\n<!-- tampered -->\n`, 'utf8');

    const failed = await runCli(dir, ['paper', 'figure', '--harness', 'fake'], {
      IDEASEEK_ARIS_SKILLS: copyRoot,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('SKILL_TAMPERED');
    await expect(readFile(figureFile(dir), 'utf8')).rejects.toThrow();
  }, 120_000);
});
