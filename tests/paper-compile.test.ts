import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assembleLaTeXProject,
  classifyCompileFailure,
  extractPageCount,
  findUnplacedFigures,
  readManuscriptDoc,
  unapprovedFigureBlockers,
  unapprovedFigureIncludes,
  VENUE_TEMPLATES,
} from '../src/paper/compile.js';
import type { Manuscript } from '../src/paper/write.js';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * Phase 4.5C capability 4: ARIS paper-compile as deterministic platform
 * code — assemble the stored manuscript with the vendored venue template,
 * run latexmk through the shared subprocess adapter, report honestly
 * (compiled | failed with log tail | blocked with next step). The
 * model-assisted fix loop is explicitly not claimed.
 */

function manuscript(venue = 'ICLR'): Manuscript {
  return {
    venue: venue as Manuscript['venue'],
    title: 'Locked & Loaded Study',
    abstract: 'We study the question under a locked protocol.',
    sections: [
      {
        id: 'intro',
        heading: 'Introduction',
        latex: '\\section{Introduction}\nBody text citing plan claims.',
        sources: ['plan-claims'],
      },
      {
        id: 'experiments',
        heading: 'Experiments',
        latex: '\\section{Experiments}\nResults by specId.',
        sources: ['repro-fedavg'],
      },
    ],
    bibliography: [{ key: 'mcmahan2017', bibtex: '@inproceedings{mcmahan2017, title={FedAvg}}' }],
    qualityPasses: ['reverse-outline'],
    manualFixes: [],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['no backend'] },
  };
}

describe('assembleLaTeXProject', () => {
  it('builds main.tex + references.bib from the manuscript and template preamble', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paper-assemble-'));
    const result = await assembleLaTeXProject(dir, manuscript());
    expect(result.template).toBe(VENUE_TEMPLATES.ICLR);

    const main = await readFile(result.mainPath, 'utf8');
    expect(main).toContain('\\documentclass');
    expect(main).toContain('\\begin{document}');
    // Escaped ampersand in the title.
    expect(main).toContain('\\title{Locked \\& Loaded Study}');
    expect(main).toContain('\\section{Introduction}');
    expect(main).toContain('\\section{Experiments}');
    expect(main).toContain('\\bibliography{references}');
    expect(main.trimEnd().endsWith('\\end{document}')).toBe(true);

    const bib = await readFile(result.bibPath, 'utf8');
    expect(bib).toContain('@inproceedings{mcmahan2017');
  }, 30_000);

  it('bundles IEEEtran class files for IEEE venues', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paper-assemble-ieee-'));
    const result = await assembleLaTeXProject(dir, manuscript('IEEE_CONF'));
    expect(result.template).toBe(VENUE_TEMPLATES.IEEE_CONF);
    const main = await readFile(result.mainPath, 'utf8');
    expect(main).toContain('IEEEtran');
    const cls = await readFile(join(dir, 'paper', 'IEEEtran.cls'), 'utf8');
    expect(cls.length).toBeGreaterThan(100);
  }, 30_000);

  it('refuses venues without a vendored template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paper-assemble-cvpr-'));
    await expect(
      assembleLaTeXProject(dir, manuscript('CVPR' as Manuscript['venue'])),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  }, 30_000);
});

describe('compile helpers', () => {
  it('extracts the page count from the latexmk log', () => {
    expect(extractPageCount('Output written on main.pdf (7 pages, 123456 bytes).')).toBe(7);
    expect(extractPageCount('no pdf here')).toBeNull();
  });

  it('classifies missing style files into actionable blockers', () => {
    const blockers = classifyCompileFailure(
      "! LaTeX Error: File `iclr2026_conference.sty' not found.",
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('iclr2026_conference.sty');
    expect(blockers[0]).toContain('ideaseek paper compile');
    expect(classifyCompileFailure('some unrelated log')).toEqual([]);
    expect(classifyCompileFailure('Emergency stop.').length).toBeGreaterThan(0);
  });

  it('counts a placed figure by its include path or its placement label', () => {
    // Observed: --place-figures inserted all four figures using their
    // rendered OUTPUT file names (figures/fig1_accuracy_comparison.pdf) plus
    // \label{fig:fig-1}; the check only looked for the plan id inside the
    // include path (figures/Fig 1), so every freshly placed figure read as
    // missing and the blocker refused the compile it had just satisfied.
    const plan = {
      figures: { figures: [{ id: 'Fig 1' }, { id: 'Fig 2' }, { id: 'Table 1' }] },
      preservedExisting: [],
      manualRemaining: ['Architecture diagram'],
    };
    const placedByLabel = [
      '\\includegraphics{../figures/fig1_accuracy_comparison.pdf}',
      '\\label{fig:fig-1}',
      '\\includegraphics{../figures/fig2_gap_cost_vs_accuracy.pdf}',
      '\\label{fig:fig-2}',
    ].join('\n');
    expect(findUnplacedFigures(placedByLabel, plan)).toEqual(['Table 1']);
    expect(findUnplacedFigures(`${placedByLabel}\n\\includegraphics{figures/Table 1.pdf}`, plan)).toEqual(
      [],
    );
    // manualRemaining is excused; the still-absent ids remain blockers.
    expect(
      findUnplacedFigures('', { ...plan, manualRemaining: ['Architecture diagram', 'Table 1'] }),
    ).toEqual(['Fig 1', 'Fig 2']);
    expect(findUnplacedFigures('', { figures: { figures: [{ id: 'Fig 9' }] } })).toEqual(['Fig 9']);
  });

  it('readManuscriptDoc fails with actionable codes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paper-read-'));
    await expect(readManuscriptDoc(dir)).rejects.toMatchObject({
      code: 'USER_INPUT_REQUIRED',
    });
    await mkdir(join(dir, 'reports', 'paper'), { recursive: true });
    await writeFile(
      join(dir, 'reports', 'paper', 'manuscript.json'),
      JSON.stringify({ contract: 'wrong-v1', inputHash: 'x', skill: {}, manuscript: {} }),
      'utf8',
    );
    await expect(readManuscriptDoc(dir)).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' });
  }, 30_000);
});

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

describe('ideaseek paper compile (e2e)', () => {
  it('refuses without a manuscript and points at paper write', async () => {
    const dir = await makeProjectDir();
    const failed = await runCli(dir, ['paper', 'compile']);
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain('ideaseek paper write');
  }, 60_000);

  it('assembles the project and reports an honest status with a report file', async () => {
    const dir = await makeProjectDir();
    expect((await runCli(dir, ['paper', 'write', '--harness', 'fake'])).code).toBe(0);

    const compiled = await runCli(dir, ['paper', 'compile', '--json']);
    // compiled -> 0; failed (e.g. venue style missing) -> 1; blocked -> 2.
    expect([0, 1, 2]).toContain(compiled.code);
    const report = JSON.parse(compiled.stdout) as {
      contract: string;
      status: string;
      venue: string;
      template: string | null;
      blockers: string[];
      logTail: string;
      pdfPath: string | null;
      pageCount: number | null;
      skill: { name: string };
      manuscriptInputHash: string;
      mainPath: string;
    };
    expect(report.contract).toBe('paper-compile-v1');
    expect(['compiled', 'failed', 'blocked']).toContain(report.status);
    expect(report.venue).toBe('ICLR');
    expect(report.skill.name).toBe('paper-compile');
    expect(report.manuscriptInputHash).toMatch(/^sha256:/);

    // Assembly always happens and is inspectable.
    const main = await readFile(report.mainPath, 'utf8');
    expect(main).toContain('\\section{Introduction}');
    const persisted = JSON.parse(
      await readFile(join(dir, 'reports', 'paper', 'compile-report.json'), 'utf8'),
    ) as { contract: string; status: string };
    expect(persisted.contract).toBe('paper-compile-v1');
    expect(persisted.status).toBe(report.status);

    if (report.status === 'compiled') {
      expect(report.pdfPath).toBeTruthy();
      expect(report.blockers).toEqual([]);
    } else if (report.status === 'blocked') {
      expect(report.blockers.length).toBeGreaterThan(0);
    } else {
      expect(report.blockers.length).toBeGreaterThan(0);
      expect(report.logTail.length).toBeGreaterThan(0);
    }
  }, 300_000);

  it('reports a missing latexmk as blocked, not failed (nothing ever ran)', async () => {
    // 'failed' means "ran and broke" and must carry a log tail; a tool that
    // cannot even start is an environment blocker with a next step. An empty
    // PATH makes the latexmk spawn fail with ENOENT whatever the host has.
    const dir = await makeProjectDir();
    expect((await runCli(dir, ['paper', 'write', '--harness', 'fake'])).code).toBe(0);
    const compiled = await runCli(dir, ['paper', 'compile', '--json'], {
      PATH: '/nonexistent-ideaseek-path',
    });
    expect([1, 2]).toContain(compiled.code);
    const report = JSON.parse(compiled.stdout) as {
      status: string;
      blockers: string[];
      logTail: string;
    };
    expect(report.status).toBe('blocked');
    expect(report.blockers.join(' ')).toContain('latexmk could not be started');
    expect(report.logTail).toBe('');
  }, 300_000);

  it('blocks venues without a vendored template with exit 2 and next step', async () => {
    const dir = await makeProjectDir();
    // No stored plan → a CVPR manuscript is allowed by the venue pin, but
    // compile has no vendored CVPR template → honest blocked report.
    const cvpr = JSON.stringify({
      venue: 'CVPR',
      title: 'CVPR Manuscript',
      abstract: 'Abstract body.',
      sections: [
        {
          id: 'intro',
          heading: 'Introduction',
          latex: '\\section{Introduction}Body.',
          sources: ['context'],
        },
      ],
      bibliography: [{ key: 'x2026', bibtex: '@article{x2026, title={X}}' }],
      qualityPasses: ['reverse-outline'],
      manualFixes: [],
      reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['none'] },
    });
    expect(
      (
        await runCli(dir, ['paper', 'write', '--harness', 'fake'], {
          IDEASEEK_FAKE_PAPER_WRITE_OUTPUT: cvpr,
        })
      ).code,
    ).toBe(0);

    const blocked = await runCli(dir, ['paper', 'compile', '--json']);
    expect(blocked.code).toBe(2);
    const report = JSON.parse(blocked.stdout) as { status: string; blockers: string[] };
    expect(report.status).toBe('blocked');
    expect(report.blockers.join(' ')).toContain('no vendored template for venue CVPR');
    expect(report.blockers.join(' ')).toContain('IEEE_CONF');
  }, 180_000);
});

/**
 * The reader side of the figure records: whatever `paper render-figures` and
 * `paper review-figure` write, `paper compile` must obey — because the PDF is
 * the artifact people actually read, and a verdict that changes nothing there
 * is decoration. These fixtures are hand-built rather than rendered so each
 * one isolates a single recorded state, including states the writers cannot
 * produce today but a hand-edited or older artifact can.
 */
async function projectWithRenderReport(figures: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'paper-figure-gate-'));
  await mkdir(join(dir, 'reports', 'paper'), { recursive: true });
  await writeFile(
    join(dir, 'reports', 'paper', 'figure-render.json'),
    `${JSON.stringify({ contract: 'figure-render-v1', status: 'rendered', figures }, null, 2)}\n`,
    'utf8',
  );
  return dir;
}

const verdict = (status: string) => ({ status, note: null, at: 1_760_000_000_000, history: [] });

const rendered = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  bytes: 2048,
  sha256: `sha256:${'0'.repeat(64)}`,
  ...extra,
});

const includes = (path: string): string =>
  ['\\begin{document}', `\\includegraphics{${path}}`, '\\end{document}'].join('\n');

describe('compile obeys the figure records', () => {
  it('accepts a rendered figure whose human verdict is approved', async () => {
    const dir = await projectWithRenderReport([
      {
        id: 'fig-1',
        ok: true,
        review: verdict('approved'),
        outputs: [rendered('figures/fig-1.pdf')],
      },
    ]);
    expect(await unapprovedFigureIncludes(dir, includes('figures/fig-1'))).toEqual([]);
  });

  it('accepts a rendered figure nobody has reviewed — absence of a verdict is not a rejection', async () => {
    // This is the case a stricter rule would break: `render-figures` writes
    // `unreviewed` for every figure it accepts, so treating it as a veto would
    // block every ordinary compile until someone approved each file by hand —
    // the shape of check that gets deleted under pressure, taking the real
    // rejection gate with it.
    const dir = await projectWithRenderReport([
      {
        id: 'fig-1',
        ok: true,
        review: verdict('unreviewed'),
        outputs: [rendered('figures/fig-1.pdf')],
      },
    ]);
    expect(await unapprovedFigureIncludes(dir, includes('figures/fig-1'))).toEqual([]);
  });

  it('blocks a figure a human rejected and names the verdict, the figure and the command', async () => {
    const dir = await projectWithRenderReport([
      {
        id: 'fig-1',
        ok: true,
        review: verdict('rejected'),
        outputs: [rendered('figures/fig-1.pdf')],
      },
    ]);
    const findings = await unapprovedFigureIncludes(dir, includes('figures/fig-1'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path: 'figures/fig-1.pdf',
      figureId: 'fig-1',
      reviewStatus: 'rejected',
      reason: 'review-rejected',
      overridable: false,
    });
    const text = unapprovedFigureBlockers(findings).join(' ');
    expect(text).toContain('reviewed "rejected"');
    expect(text).toContain('ideaseek paper review-figure fig-1 --status approved');
    expect(text).toContain('--allow-figures cannot overrule');
  });

  it('refuses to let --allow-figures wave through a rejected figure', async () => {
    // The flag is documented for hand-made files the renderer never judged;
    // letting it silence a researcher's verdict would make the record optional.
    const dir = await projectWithRenderReport([
      {
        id: 'fig-1',
        ok: true,
        review: verdict('rejected'),
        outputs: [rendered('figures/fig-1.pdf')],
      },
    ]);
    const named = ['figures/fig-1.pdf', 'fig-1.pdf', 'figures/fig-1'];
    for (const allowed of named) {
      const findings = await unapprovedFigureIncludes(dir, includes('figures/fig-1'), [allowed]);
      expect(findings.map((finding) => finding.path)).toEqual(['figures/fig-1.pdf']);
    }
  });

  it('treats a review status it does not know as no approval', async () => {
    const dir = await projectWithRenderReport([
      {
        id: 'fig-1',
        ok: true,
        review: verdict('looks-fine'),
        outputs: [rendered('figures/fig-1.pdf')],
      },
    ]);
    const findings = await unapprovedFigureIncludes(dir, includes('figures/fig-1'));
    expect(findings[0]).toMatchObject({ reason: 'review-rejected', reviewStatus: 'looks-fine' });
  });

  it('still blocks what the renderer did not accept, and says so from the record', async () => {
    const dir = await projectWithRenderReport([
      {
        id: 'fig-1',
        ok: false,
        review: verdict('unreviewed'),
        outputs: [rendered('figures/fig-1.pdf')],
      },
    ]);
    const findings = await unapprovedFigureIncludes(dir, includes('figures/fig-1'));
    expect(findings[0]).toMatchObject({ reason: 'not-rendered' });
    const text = unapprovedFigureBlockers(findings).join(' ');
    expect(text).toContain('ok: false');
    expect(text).toContain('ideaseek paper render-figures');
    expect(text).not.toContain('review-figure');
  });

  it('blocks an include with no render report at all, and excuses a named hand-made file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paper-figure-nogate-'));
    const findings = await unapprovedFigureIncludes(dir, includes('figures/manual.pdf'));
    expect(findings[0]).toMatchObject({ reason: 'not-rendered', figureId: null });
    expect(
      await unapprovedFigureIncludes(dir, includes('figures/manual.pdf'), ['manual.pdf']),
    ).toEqual([]);
    expect(
      await unapprovedFigureIncludes(dir, includes('figures/manual.pdf'), ['figures/manual.pdf']),
    ).toEqual([]);
  });

  it('approves a figure recorded inside a figures subdirectory', async () => {
    // DEFECT: the renderer used to record a declared target by the script's own
    // string (`sub/fig-1.pdf`) while scanning files as `figures/<name>`, so the
    // two bases could never both satisfy the include — and a figure in a
    // subdirectory was unapprovable no matter what it looked like.
    const dir = await projectWithRenderReport([
      {
        id: 'fig-1',
        ok: true,
        review: verdict('unreviewed'),
        outputs: [rendered('figures/sub/fig-1.pdf', { declared: 'sub/fig-1.pdf' })],
      },
    ]);
    expect(await unapprovedFigureIncludes(dir, includes('figures/sub/fig-1'))).toEqual([]);
  });

  it('explains a path the platform recorded elsewhere instead of blaming the render', async () => {
    const dir = await projectWithRenderReport([
      {
        id: 'fig-1',
        ok: true,
        review: verdict('unreviewed'),
        outputs: [rendered('figures/figures/fig-1.pdf', { declared: 'figures/fig-1.pdf' })],
      },
    ]);
    const findings = await unapprovedFigureIncludes(dir, includes('figures/fig-1'));
    expect(findings[0]).toMatchObject({ reason: 'not-rendered', figureId: 'fig-1' });
    const text = unapprovedFigureBlockers(findings).join(' ');
    expect(text).toContain('figures/figures/fig-1.pdf');
    expect(text).toContain('the script already runs in figures/');
    expect(text).not.toContain('rerun: ideaseek paper render-figures');
  });

  it('states plainly when the bytes are outside the figures tree and can never match', async () => {
    const dir = await projectWithRenderReport([
      {
        id: 'fig-1',
        ok: true,
        review: verdict('unreviewed'),
        outputs: [
          rendered('/tmp/fig-1.pdf', {
            unmatchable:
              'recorded at /tmp/fig-1.pdf, an absolute path outside the figures tree; the ' +
              'manuscript includes files under figures/, so no \\includegraphics can name this file',
          }),
        ],
      },
    ]);
    const findings = await unapprovedFigureIncludes(dir, includes('figures/fig-1'));
    expect(findings[0]).toMatchObject({ reason: 'outside-figures-tree', figureId: 'fig-1' });
    const text = unapprovedFigureBlockers(findings).join(' ');
    expect(text).toContain('never recorded under figures/');
    expect(text).toContain('not a missing approval');
    expect(text).toContain('/tmp/fig-1.pdf');
  });
});

describe('paper compile refuses a figure a human rejected (e2e)', () => {
  it('blocks the PDF while the recorded verdict is rejected, and only then builds', async () => {
    const dir = await makeProjectDir();
    expect((await runCli(dir, ['paper', 'plan', '--harness', 'fake'])).code).toBe(0);
    expect((await runCli(dir, ['paper', 'figure', '--harness', 'fake'])).code).toBe(0);
    const plan = JSON.parse(
      await readFile(join(dir, 'reports', 'paper', 'figures-plan.json'), 'utf8'),
    ) as { figures: { figures: { id: string }[] } };
    const ids = plan.figures.figures.map((figure) => figure.id);
    expect(ids.length).toBeGreaterThan(0);
    expect((await runCli(dir, ['paper', 'render-figures'])).code).toBe(0);

    const rejected = ids[0]!;
    const reviewed = await runCli(dir, [
      'paper',
      'review-figure',
      rejected,
      '--status',
      'rejected',
      '--note',
      'the axes do not match the locked protocol',
    ]);
    expect(reviewed.code).toBe(0);
    expect(reviewed.stdout).toContain('--allow-figures does not overrule this verdict');

    // A manuscript that places every planned figure, so the only thing left to
    // complain about is the verdict the platform used to ignore.
    const manuscript = JSON.stringify({
      venue: 'ICLR',
      title: 'Locked Protocol Study',
      abstract: 'Abstract grounded in the locked protocol.',
      sections: [
        {
          id: 'experiments',
          heading: 'Experiments',
          latex: `\\section{Experiments}\n${ids
            .map((id) => `\\includegraphics{figures/${id}}`)
            .join('\n')}`,
          sources: ['context'],
        },
      ],
      bibliography: [{ key: 'x2026', bibtex: '@article{x2026, title={X}}' }],
      qualityPasses: ['reverse-outline'],
      manualFixes: [],
      reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['none'] },
    });
    expect(
      (
        await runCli(dir, ['paper', 'write', '--harness', 'fake'], {
          IDEASEEK_FAKE_PAPER_WRITE_OUTPUT: manuscript,
        })
      ).code,
    ).toBe(0);

    // Even naming the file cannot get the rejected figure into the PDF.
    const blocked = await runCli(dir, [
      'paper',
      'compile',
      '--json',
      '--allow-figures',
      `figures/${rejected}.pdf`,
    ]);
    expect(blocked.code).toBe(2);
    const report = JSON.parse(blocked.stdout) as { status: string; blockers: string[] };
    expect(report.status).toBe('blocked');
    const text = report.blockers.join(' ');
    expect(text).toContain(`figures/${rejected}.pdf`);
    expect(text).toContain('reviewed "rejected"');
    expect(text).toContain(`ideaseek paper review-figure ${rejected} --status approved`);
    // The persisted report carries the same verdict as the printed one, so the
    // blocked build is auditable afterwards — decoded, not grepped, because the
    // artifact stores the quote escaped inside JSON.
    const persisted = JSON.parse(
      await readFile(join(dir, 'reports', 'paper', 'compile-report.json'), 'utf8'),
    ) as { status: string; blockers: string[] };
    expect(persisted.status).toBe('blocked');
    expect(persisted.blockers.join(' ')).toContain('reviewed "rejected"');

    expect(
      (await runCli(dir, ['paper', 'review-figure', rejected, '--status', 'approved'])).code,
    ).toBe(0);
    const built = await runCli(dir, ['paper', 'compile', '--json']);
    const after = JSON.parse(built.stdout) as { status: string; blockers: string[] };
    // The rejection is gone from the complaints; whatever remains is the host's
    // TeX situation, which this suite does not pretend to control.
    expect(after.blockers.join(' ')).not.toContain('review-figure');
  }, 300_000);
});
