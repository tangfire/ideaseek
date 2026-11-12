import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assembleLaTeXProject,
  classifyCompileFailure,
  extractPageCount,
  readManuscriptDoc,
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
