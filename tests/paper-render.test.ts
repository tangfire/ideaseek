import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * Phase 7 figure pipeline slice: `paper render-figures` executes the
 * scripts persisted by `paper figure` (MPLBACKEND=Agg, shared subprocess
 * adapter with tree-kill timeouts) and hashes every produced output into
 * reports/paper/figure-render.json — the source-manifest trail.
 */

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 240_000,
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function seedFigurePlan(dir: string): Promise<void> {
  expect((await runCli(dir, ['paper', 'plan', '--harness', 'fake'])).code).toBe(0);
  expect((await runCli(dir, ['paper', 'figure', '--harness', 'fake'])).code).toBe(0);
}

describe('ideaseek paper render-figures (e2e)', () => {
  it('refuses without a figure plan and points at paper figure', async () => {
    const dir = await makeProjectDir();
    const failed = await runCli(dir, ['paper', 'render-figures']);
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain('ideaseek paper figure');
  }, 60_000);

  it('executes the persisted scripts and hashes the rendered outputs', async () => {
    const dir = await makeProjectDir();
    await seedFigurePlan(dir);

    const rendered = await runCli(dir, ['paper', 'render-figures', '--json']);
    expect(rendered.code).toBe(0);
    const report = JSON.parse(rendered.stdout) as {
      contract: string;
      status: string;
      figures: {
        id: string;
        ok: boolean;
        outputs: { path: string; bytes: number; sha256: string }[];
        formats: string[];
        caption: string;
        statistics: string[];
        scriptSha256: string;
        review: { status: string };
        error: string | null;
      }[];
      python: string;
      skill: { name: string };
      planInputHash: string;
    };
    expect(report.contract).toBe('figure-render-v1');
    expect(report.status).toBe('rendered');
    expect(report.skill.name).toBe('paper-figure');
    expect(report.planInputHash).toMatch(/^sha256:/);
    expect(report.python.length).toBeGreaterThan(0);
    expect(report.figures.length).toBeGreaterThan(0);

    const figure = report.figures[0]!;
    expect(figure.ok).toBe(true);
    expect(figure.error).toBeNull();
    expect(figure.outputs.length).toBeGreaterThan(0);
    expect(figure.outputs[0]!.path).toMatch(/^figures\//);
    expect(figure.outputs[0]!.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The rendered file really exists on disk.
    expect(await exists(join(dir, figure.outputs[0]!.path))).toBe(true);

    // Source-manifest fields: dual formats (script writes pdf+png), caption,
    // statistics definition, code-version hash and review status.
    expect(figure.formats).toContain('pdf');
    expect(figure.formats).toContain('png');
    expect(figure.caption).toContain('Fake caption');
    expect(figure.statistics.length).toBeGreaterThan(0);
    expect(figure.scriptSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(figure.review.status).toBe('unreviewed');

    const persisted = JSON.parse(
      await readFile(join(dir, 'reports', 'paper', 'figure-render.json'), 'utf8'),
    ) as { contract: string; status: string };
    expect(persisted.contract).toBe('figure-render-v1');
    expect(persisted.status).toBe('rendered');
  }, 300_000);

  it('records human review status per figure (source manifest)', async () => {
    const dir = await makeProjectDir();
    await seedFigurePlan(dir);
    expect((await runCli(dir, ['paper', 'render-figures'])).code).toBe(0);

    const approved = await runCli(dir, [
      'paper',
      'review-figure',
      'fig-1',
      '--status',
      'approved',
      '--note',
      'caption matches the plan claim',
    ]);
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain('figure fig-1 review: approved');

    const stored = JSON.parse(
      await readFile(join(dir, 'reports', 'paper', 'figure-render.json'), 'utf8'),
    ) as {
      figures: {
        id: string;
        review: { status: string; note: string | null; history: unknown[] };
      }[];
    };
    const review = stored.figures.find((figure) => figure.id === 'fig-1')!.review;
    expect(review.status).toBe('approved');
    expect(review.note).toContain('caption matches');
    expect(review.history).toHaveLength(1); // previous unreviewed kept

    // Re-review flips again and appends history (append-only trail).
    expect(
      (
        await runCli(dir, [
          'paper',
          'review-figure',
          'fig-1',
          '--status',
          'rejected',
          '--note',
          'blurry',
        ])
      ).code,
    ).toBe(0);
    const after = JSON.parse(
      await readFile(join(dir, 'reports', 'paper', 'figure-render.json'), 'utf8'),
    ) as { figures: { id: string; review: { status: string; history: unknown[] } }[] };
    expect(after.figures.find((figure) => figure.id === 'fig-1')!.review.status).toBe('rejected');
    expect(after.figures.find((figure) => figure.id === 'fig-1')!.review.history).toHaveLength(2);

    // Unknown id and bad status are hard errors.
    const unknown = await runCli(dir, ['paper', 'review-figure', 'nope', '--status', 'approved']);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('unknown figure id');
    const badStatus = await runCli(dir, ['paper', 'review-figure', 'fig-1', '--status', 'meh']);
    expect(badStatus.code).not.toBe(0);
    expect(badStatus.stderr).toContain('approved | rejected');
  }, 300_000);

  it('fails scripts honestly (exit != 0 → failed report, exit 1)', async () => {
    const dir = await makeProjectDir();
    await seedFigurePlan(dir);

    const broken = JSON.stringify({
      style: 'publication',
      dpi: 300,
      format: 'pdf',
      figures: [
        {
          id: 'fig-1',
          type: 'bar',
          title: 'Broken',
          caption: 'Broken figure.',
          statistics: ['always fails'],
          dataSources: [{ kind: 'context', ref: 'x' }],
          // Saves first, then fails: the plan contract requires a declared
          // output, and what this test is about is a script that fails during
          // rendering, not one that never promised a file.
          script:
            'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nfig.savefig("figures/fig-1.pdf")\nraise SystemExit(3)\n',
          latexInclude: '\\includegraphics{figures/fig-1}',
          claims: ['claim'],
        },
      ],
      preservedExisting: [],
      manualRemaining: [],
      reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['none'] },
    });
    // Regenerate the plan with the broken script (same context → --force).
    const regenerated = await runCli(dir, ['paper', 'figure', '--harness', 'fake', '--force'], {
      IDEASEEK_FAKE_PAPER_FIGURE_OUTPUT: broken,
    });
    expect(regenerated.code).toBe(0);

    const failed = await runCli(dir, ['paper', 'render-figures', '--json']);
    expect(failed.code).toBe(1);
    const report = JSON.parse(failed.stdout) as {
      status: string;
      figures: { ok: boolean; error: string | null }[];
    };
    expect(report.status).toBe('failed');
    expect(report.figures[0]!.ok).toBe(false);
    expect(report.figures[0]!.error).toBeTruthy();
  }, 300_000);
});

describe('declared save targets', () => {
  it('reads the outputs a script promises to write', async () => {
    const { parseSaveTargets } = await import('../src/paper/render-figures.js');
    expect(
      parseSaveTargets(
        [
          'import matplotlib.pyplot as plt',
          'fig, ax = plt.subplots()',
          'fig.savefig("figures/Fig 1.pdf")',
          "fig.savefig('figures/Fig 1.png')",
          'fig.savefig(f"figures/{name}.svg")',
        ].join('\n'),
      ),
    ).toEqual(['figures/Fig 1.pdf', 'figures/Fig 1.png']);
    expect(parseSaveTargets('plt.plot([1, 2])')).toEqual([]);
  });

  it('resolves plain string constants that savefig names', async () => {
    // Observed: every real plan writes OUT_PDF = 'fig.pdf' + savefig(OUT_PDF).
    // The literal-only scan found no declared targets, so the verdict fell
    // back to "new files since start" and a deterministic re-render of
    // unchanged scripts reported "script exited 0 without saving any figure
    // file" for each of them — the idempotency failure the declared-target
    // path was built to prevent.
    const { parseSaveTargets } = await import('../src/paper/render-figures.js');
    const script = [
      "OUT_PDF = 'fig2_gap_cost_vs_accuracy.pdf'",
      "OUT_PNG = 'fig2_gap_cost_vs_accuracy.png'",
      'RESULTS = ../reports/paper/results.json', // not a string literal — ignored
      'fig.savefig(OUT_PDF)',
      'fig.savefig(OUT_PNG, dpi=300)',
      'savefig(UNKNOWN_CONST)', // no declaration — stays unresolved
    ].join('\n');
    expect(parseSaveTargets(script)).toEqual([
      'fig2_gap_cost_vs_accuracy.pdf',
      'fig2_gap_cost_vs_accuracy.png',
    ]);
  });
});

/**
 * One basis for a recorded output: where the bytes actually are, relative to
 * the project. The compile gate compares these strings against
 * `\includegraphics{figures/…}`, so a second basis inside the same array
 * silently made whole classes of figure unapprovable — and the blocker that
 * followed blamed the script for the platform's own mismatch.
 */
describe('canonicalOutputPath', () => {
  const cases: { target: string; path: string; declared: string | null }[] = [
    // A bare name is what the shipped scripts write; it resolves inside the
    // figures tree, so the record gains the prefix and the script's string is
    // not worth repeating.
    { target: 'fig-1.pdf', path: 'figures/fig-1.pdf', declared: null },
    { target: 'sub/fig-1.pdf', path: 'figures/sub/fig-1.pdf', declared: 'sub/fig-1.pdf' },
    { target: 'plots/x.pdf', path: 'figures/plots/x.pdf', declared: 'plots/x.pdf' },
    // A target that already carries the prefix lands one level deeper than the
    // name suggests: recorded where it lands, with both strings kept.
    {
      target: 'figures/fig-1.pdf',
      path: 'figures/figures/fig-1.pdf',
      declared: 'figures/fig-1.pdf',
    },
    // Windows-authored scripts may use backslashes; the record carries one
    // spelling only — the slash form — because two spellings of one file is the
    // bug this function exists to remove.
    { target: 'sub\\fig-1.pdf', path: 'figures/sub/fig-1.pdf', declared: 'sub/fig-1.pdf' },
  ];
  for (const testCase of cases) {
    it(`records ${testCase.target} where the file really is`, async () => {
      const { canonicalOutputPath } = await import('../src/paper/render-figures.js');
      const figuresDir = resolve('ideaseek-basis-test', 'figures');
      const basis = canonicalOutputPath(testCase.target, figuresDir, 'figures');
      expect(basis.path).toBe(testCase.path);
      expect(basis.declared).toBe(testCase.declared);
      expect(basis.unmatchable).toBeNull();
      expect(basis.abs.startsWith(figuresDir)).toBe(true);
    });
  }

  it('keeps the declared string and says it can never match when the bytes are elsewhere', async () => {
    const { canonicalOutputPath } = await import('../src/paper/render-figures.js');
    const figuresDir = resolve('ideaseek-basis-test', 'figures');
    for (const target of ['/tmp/fig-1.pdf', '../outside/fig-1.pdf']) {
      const basis = canonicalOutputPath(target, figuresDir, 'figures');
      expect(basis.unmatchable).toContain('outside the figures tree');
      // Not a fabricated `figures/…` name for a file that is not there.
      expect(basis.path.startsWith('figures/')).toBe(false);
    }
  });
});

describe('rendering into a subdirectory (e2e)', () => {
  it('records the file where it is instead of crashing on the directory', async () => {
    // The scan loop treated every entry of `readdir(figures/)` as a file, so
    // the `sub` directory a subdirectory-saving script creates reached
    // sha256OfFile and threw EISDIR: the whole render failed on a figure that
    // had worked. This script draws nothing with matplotlib on purpose — the
    // platform judges the artifact, not the plotting library.
    const dir = await makeProjectDir();
    await seedFigurePlan(dir);
    const subdirectory = JSON.stringify({
      style: 'publication',
      dpi: 300,
      format: 'pdf',
      figures: [
        {
          id: 'fig-1',
          type: 'bar',
          title: 'Into a subdirectory',
          caption: 'Written under figures/sub by the script itself.',
          statistics: ['stub vector written for this test'],
          dataSources: [{ kind: 'context', ref: 'x' }],
          script: [
            '# no matplotlib here on purpose: the platform judges the saved bytes,',
            '# not which plotting library wrote them (the figure plan validator says so).',
            'import os',
            'class _Canvas:',
            '    def savefig(self, path):',
            '        directory = os.path.dirname(path)',
            '        if directory:',
            '            os.makedirs(directory, exist_ok=True)',
            '        with open(path, "wb") as handle:',
            '            handle.write(b"%PDF-1.4\\n% stub vector\\n")',
            'fig = _Canvas()',
            'fig.savefig("sub/fig-1.pdf")',
          ].join('\n'),
          latexInclude: '\\includegraphics{figures/sub/fig-1}',
          claims: ['the stub file is the figure under test'],
        },
      ],
      preservedExisting: [],
      manualRemaining: [],
      reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['none'] },
    });
    const planned = await runCli(dir, ['paper', 'figure', '--harness', 'fake', '--force'], {
      IDEASEEK_FAKE_PAPER_FIGURE_OUTPUT: subdirectory,
    });
    expect(planned.code, planned.stdout + planned.stderr).toBe(0);

    const rendered = await runCli(dir, ['paper', 'render-figures', '--json']);
    expect(rendered.code, rendered.stdout + rendered.stderr).toBe(0);
    const report = JSON.parse(rendered.stdout) as {
      status: string;
      figures: { id: string; ok: boolean; outputs: { path: string; declared?: string }[] }[];
    };
    expect(report.figures[0]!.ok).toBe(true);
    const paths = report.figures[0]!.outputs.map((output) => output.path);
    expect(paths).toContain('figures/sub/fig-1.pdf');
    // One basis only: never the bare script string, never the directory name.
    expect(paths).not.toContain('sub/fig-1.pdf');
    expect(paths).not.toContain('figures/sub');
    const recorded = report.figures[0]!.outputs.find(
      (output) => output.path === 'figures/sub/fig-1.pdf',
    );
    expect(recorded!.declared).toBe('sub/fig-1.pdf');
    expect(await exists(join(dir, 'figures', 'sub', 'fig-1.pdf'))).toBe(true);
  }, 300_000);
});

describe('review-figure refuses a damaged render report instead of crashing', () => {
  async function projectWithReport(report: unknown): Promise<string> {
    const dir = await makeProjectDir();
    await seedFigurePlan(dir);
    expect((await runCli(dir, ['paper', 'render-figures'])).code).toBe(0);
    await writeFile(
      join(dir, 'reports', 'paper', 'figure-render.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    return dir;
  }

  const figureWithoutHistory = {
    contract: 'figure-render-v1',
    status: 'rendered',
    figures: [
      {
        id: 'fig-1',
        ok: true,
        outputs: [{ path: 'figures/fig-1.pdf', bytes: 1, sha256: `sha256:${'0'.repeat(64)}` }],
        // A review block that lost its append-only trail: the shape that used
        // to reach `...previous.history` and throw a TypeError.
        review: { status: 'approved', note: 'hand edited', at: 1_760_000_000_000 },
      },
    ],
  };

  it('reports INVALID_ARTIFACT naming the missing history, not a TypeError', async () => {
    const dir = await projectWithReport(figureWithoutHistory);
    const result = await runCli(dir, ['paper', 'review-figure', 'fig-1', '--status', 'rejected']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('[INVALID_ARTIFACT]');
    expect(result.stderr).toContain('history');
    expect(result.stderr).toContain('ideaseek paper render-figures');
    // The point of the guard: a crash would report an internal fault instead.
    expect(result.stderr).not.toMatch(/is not iterable|TypeError/);
  }, 300_000);

  it('reports INVALID_ARTIFACT for a non-array history and a damaged figures list', async () => {
    const damaged = structuredClone(figureWithoutHistory);
    (damaged.figures[0] as { review: Record<string, unknown> }).review.history = 'seen it';
    const dir = await projectWithReport(damaged);
    const badHistory = await runCli(dir, [
      'paper',
      'review-figure',
      'fig-1',
      '--status',
      'approved',
    ]);
    expect(badHistory.stderr).toContain('[INVALID_ARTIFACT]');
    expect(badHistory.stderr).toContain('history');

    const noList = { contract: 'figure-render-v1', status: 'rendered', figures: {} };
    const other = await projectWithReport(noList);
    const badFigures = await runCli(other, [
      'paper',
      'review-figure',
      'fig-1',
      '--status',
      'approved',
    ]);
    expect(badFigures.stderr).toContain('[INVALID_ARTIFACT]');
    expect(badFigures.stderr).not.toMatch(/is not a function|TypeError/);
  }, 300_000);

  it('still records a verdict on a figure whose review block is simply absent', async () => {
    // The guard must not become the bug class it fixes: `review` is optional in
    // older reports, and refusing to record an approval there would block valid
    // work — and a guard that rejects valid work gets removed under pressure.
    const noReview = structuredClone(figureWithoutHistory);
    delete (noReview.figures[0] as { review?: unknown }).review;
    const dir = await projectWithReport(noReview);
    const recorded = await runCli(dir, [
      'paper',
      'review-figure',
      'fig-1',
      '--status',
      'approved',
      '--note',
      'checked against the protocol',
    ]);
    expect(recorded.code).toBe(0);
    const stored = JSON.parse(
      await readFile(join(dir, 'reports', 'paper', 'figure-render.json'), 'utf8'),
    ) as { figures: { id: string; review: { status: string; history: unknown[] } }[] };
    const review = stored.figures.find((entry) => entry.id === 'fig-1')!.review;
    expect(review.status).toBe('approved');
    expect(review.history).toHaveLength(1);
  }, 300_000);
});
