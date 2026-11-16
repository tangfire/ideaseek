import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
});
