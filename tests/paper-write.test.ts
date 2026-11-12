import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arisSkillsRoot } from '../src/aris/skill.js';
import {
  PAPER_WRITE_OUTPUT_CONTRACT,
  buildWriteRequest,
  parseManuscriptOutput,
  validateManuscript,
  type WriteContext,
} from '../src/paper/write.js';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * Phase 4.5C capability 3: ARIS paper-write. The manuscript artifact is
 * structured LaTeX content bound to the stored plan — same venue, sources
 * citing persisted ids; assembly/compile is explicitly NOT claimed.
 */

function validManuscript(): Record<string, unknown> {
  return {
    venue: 'ICLR',
    title: 'Locked-Protocol Study',
    abstract: 'We study the research question under a locked protocol.',
    sections: [
      {
        id: 'intro',
        heading: 'Introduction',
        latex: '\\section{Introduction}\nBody grounded in plan claims.',
        sources: ['plan-claims'],
      },
      {
        id: 'experiments',
        heading: 'Experiments',
        latex: '\\section{Experiments}',
        sources: ['repro-fedavg'],
      },
    ],
    bibliography: [{ key: 'mcmahan2017', bibtex: '@inproceedings{mcmahan2017, title={FedAvg}}' }],
    qualityPasses: ['reverse-outline'],
    manualFixes: ['camera-ready formatting'],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['no backend hosted'] },
  };
}

function writeContext(planVenue: string | null = null): WriteContext {
  return {
    plan: planVenue
      ? { venue: planVenue, sections: ['§0 Abstract', '§1 Introduction'], claims: ['claim A'] }
      : null,
    snapshot: {
      question: 'q',
      protocol: null,
      comparisons: [],
      experiments: [],
      ideas: [],
      researchMapHash: null,
    },
    question: 'q',
  };
}

describe('validateManuscript (contract)', () => {
  it('accepts a complete manuscript', () => {
    const result = validateManuscript(validManuscript());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  const rejected: { name: string; ms: unknown }[] = [
    { name: 'null', ms: null },
    {
      name: 'unknown venue',
      ms: (() => {
        const m = validManuscript();
        m.venue = 'arXiv';
        return m;
      })(),
    },
    {
      name: 'empty title',
      ms: (() => {
        const m = validManuscript();
        m.title = ' ';
        return m;
      })(),
    },
    {
      name: 'empty abstract',
      ms: (() => {
        const m = validManuscript();
        m.abstract = '';
        return m;
      })(),
    },
    {
      name: 'no sections',
      ms: (() => {
        const m = validManuscript();
        m.sections = [];
        return m;
      })(),
    },
    {
      name: 'duplicate section id',
      ms: (() => {
        const m = validManuscript();
        (m.sections as unknown[]).push(structuredClone((m.sections as unknown[])[0]));
        return m;
      })(),
    },
    {
      name: 'documentclass in section',
      ms: (() => {
        const m = validManuscript();
        (m.sections as Record<string, unknown>[])[0]!.latex = '\\documentclass{article}';
        return m;
      })(),
    },
    {
      name: 'section without sources',
      ms: (() => {
        const m = validManuscript();
        (m.sections as Record<string, unknown>[])[0]!.sources = [];
        return m;
      })(),
    },
    {
      name: 'no bibliography',
      ms: (() => {
        const m = validManuscript();
        m.bibliography = [];
        return m;
      })(),
    },
    {
      name: 'bibtex without @',
      ms: (() => {
        const m = validManuscript();
        (m.bibliography as Record<string, unknown>[])[0]!.bibtex = 'not bibtex';
        return m;
      })(),
    },
    {
      name: 'duplicate bib key',
      ms: (() => {
        const m = validManuscript();
        (m.bibliography as unknown[]).push(structuredClone((m.bibliography as unknown[])[0]));
        return m;
      })(),
    },
    {
      name: 'no quality passes',
      ms: (() => {
        const m = validManuscript();
        m.qualityPasses = [];
        return m;
      })(),
    },
    {
      name: 'bad manualFixes',
      ms: (() => {
        const m = validManuscript();
        m.manualFixes = [42];
        return m;
      })(),
    },
    {
      name: 'bad verdict',
      ms: (() => {
        const m = validManuscript();
        (m.reviewerFeedback as Record<string, unknown>).verdict = 'SHIP';
        return m;
      })(),
    },
  ];
  for (const testCase of rejected) {
    it(`rejects: ${testCase.name}`, () => {
      const result = validateManuscript(testCase.ms);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  }
});

describe('parseManuscriptOutput (plan venue pin)', () => {
  const fakeSkill = {
    name: 'paper-write',
    sha256: 'sha256:' + 'e'.repeat(64),
    frontmatter: {},
    description: 'fake',
    allowedTools: [],
    body: 'body',
    path: 'skills/paper-write/SKILL.md',
  } as Parameters<typeof buildWriteRequest>[0];

  it('rejects a venue that differs from the stored plan', () => {
    expect(() =>
      parseManuscriptOutput(JSON.stringify(validManuscript()), writeContext('NeurIPS')),
    ).toThrow(/does not match the stored plan venue/);
  });

  it('accepts the matching venue and skips the pin without a plan', () => {
    expect(
      parseManuscriptOutput(JSON.stringify(validManuscript()), writeContext('ICLR')).title,
    ).toBe('Locked-Protocol Study');
    expect(parseManuscriptOutput(JSON.stringify(validManuscript()), writeContext(null)).venue).toBe(
      'ICLR',
    );
  });

  it('binds the contract and plan into the request', () => {
    const request = buildWriteRequest(fakeSkill, writeContext('ICLR'));
    expect(request.instruction).toContain(PAPER_WRITE_OUTPUT_CONTRACT);
    expect(request.instruction).toContain('Venue: ICLR');
    expect(request.idempotencyKey.startsWith('paper-write:')).toBe(true);
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

function manuscriptFile(dir: string): string {
  return join(dir, 'reports', 'paper', 'manuscript.json');
}

describe('ideaseek paper write (e2e, fake harness)', () => {
  it('drafts a manuscript matching the stored plan venue, then reuses', async () => {
    const dir = await makeProjectDir();
    expect((await runCli(dir, ['paper', 'plan', '--harness', 'fake'])).code).toBe(0);

    const first = await runCli(dir, ['paper', 'write', '--harness', 'fake']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('manuscript written');
    expect(first.stdout).toContain('ICLR');
    expect(first.stdout).toContain('NOT assembled or compiled');

    const stored = JSON.parse(await readFile(manuscriptFile(dir), 'utf8')) as {
      contract: string;
      harnessRuntime: string;
      manuscript: {
        venue: string;
        sections: { id: string; sources: string[] }[];
        bibliography: { key: string }[];
        reviewerFeedback: { verdict: string };
      };
    };
    expect(stored.contract).toBe('paper-write-v1');
    expect(stored.harnessRuntime).toBe('fake');
    expect(stored.manuscript.venue).toBe('ICLR');
    expect(stored.manuscript.sections.length).toBeGreaterThan(0);
    expect(stored.manuscript.bibliography.length).toBeGreaterThan(0);
    expect(stored.manuscript.reviewerFeedback.verdict).toBe('REVIEW_UNAVAILABLE');

    const before = await readFile(manuscriptFile(dir), 'utf8');
    const second = await runCli(dir, ['paper', 'write', '--harness', 'fake']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('reused manuscript');
    expect(await readFile(manuscriptFile(dir), 'utf8')).toBe(before);
  }, 180_000);

  it('refuses a venue mismatch against the stored plan (zero writes)', async () => {
    const dir = await makeProjectDir();
    expect((await runCli(dir, ['paper', 'plan', '--harness', 'fake'])).code).toBe(0);
    const wrong = JSON.stringify({ ...validManuscript(), venue: 'NeurIPS' });
    const failed = await runCli(dir, ['paper', 'write', '--harness', 'fake'], {
      IDEASEEK_FAKE_PAPER_WRITE_OUTPUT: wrong,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('does not match the stored plan venue');
    await expect(readFile(manuscriptFile(dir), 'utf8')).rejects.toThrow();
  }, 120_000);

  it('maps quota blocks to exit 2 with nothing written', async () => {
    const dir = await makeProjectDir();
    const blocked = await runCli(dir, ['paper', 'write', '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('nothing was written');
    await expect(readFile(manuscriptFile(dir), 'utf8')).rejects.toThrow();

    const recovered = await runCli(dir, ['paper', 'write', '--harness', 'fake']);
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toContain('manuscript written');
  }, 120_000);

  it('refuses a tampered ARIS skill before any model call', async () => {
    const dir = await makeProjectDir();
    const copyRoot = await mkdtemp(join(tmpdir(), 'aris-write-tamper-'));
    await cp(arisSkillsRoot(), copyRoot, { recursive: true });
    const skillFile = join(copyRoot, 'skills', 'paper-write', 'SKILL.md');
    await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\n<!-- tampered -->\n`, 'utf8');

    const failed = await runCli(dir, ['paper', 'write', '--harness', 'fake'], {
      IDEASEEK_ARIS_SKILLS: copyRoot,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('SKILL_TAMPERED');
    await expect(readFile(manuscriptFile(dir), 'utf8')).rejects.toThrow();
  }, 120_000);
});
