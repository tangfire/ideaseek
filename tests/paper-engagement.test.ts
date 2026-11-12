import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arisSkillsRoot } from '../src/aris/skill.js';
import {
  REBUTTAL_SCHEMA,
  SLIDES_SCHEMA,
  TALK_SCHEMA,
  buildEngagementRequest,
  parseSlidesDeck,
  validateRebuttal,
  validateSlidesDeck,
  validateTalkPlan,
  type EngagementContext,
} from '../src/paper/engagement.js';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * Phase 4.5C rebuttal / paper-slides / paper-talk workflows: three
 * sibling capabilities over one shared engagement context (stored plan +
 * manuscript + slides + persisted reviews — the honest reviewer
 * stand-in). Same discipline as the other paper-* capabilities.
 */

function validRebuttal(): Record<string, unknown> {
  return {
    overallResponse: 'The locked-protocol evidence addresses the concerns.',
    pointResponses: [
      {
        point: 'insufficient evidence',
        response: 'Grounded in repro-fedavg.',
        evidence: [{ source: 'repro-fedavg', location: 'result.metrics' }],
      },
    ],
    newEvidence: [],
    revisedClaims: [],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['no backend'] },
  };
}

function validSlides(): Record<string, unknown> {
  return {
    venue: 'ICLR',
    talkType: 'conference',
    slideCount: 3,
    slides: [1, 2, 3].map((number) => ({
      number,
      title: `Slide ${number}`,
      bullets: [`Point ${number}`],
      speakerNotes: `Notes ${number}.`,
      claimSources: ['plan-claim'],
    })),
    talkScript: 'A word-for-word script.',
    timeBudgetMinutes: 15,
    qaPrep: [{ question: 'Q?', answer: 'A.', source: 'protocol' }],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['no backend'] },
  };
}

function validTalk(): Record<string, unknown> {
  return {
    readiness: 'draft',
    checklist: [{ item: 'slides present', status: 'pass', detail: 'stored deck found' }],
    talkTrack: 'Question → evidence → takeaway.',
    qAndA: [{ question: 'Q?', answer: 'A.', source: 'plan-claim' }],
    blockers: [],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['no backend'] },
  };
}

function context(planVenue: string | null = null): EngagementContext {
  return {
    question: 'q',
    plan: planVenue
      ? { venue: planVenue, contribution: 'c', claims: ['claim A'], sections: ['§1'] }
      : null,
    manuscript: null,
    slides: null,
    snapshot: {
      question: 'q',
      protocol: null,
      comparisons: [],
      experiments: [],
      ideas: [],
      researchMapHash: null,
    },
    reviews: [],
  };
}

describe('rebuttal-v1 contract', () => {
  it('accepts a valid rebuttal and rejects broken shapes', () => {
    expect(validateRebuttal(validRebuttal()).ok).toBe(true);
    expect(validateRebuttal(null).ok).toBe(false);
    const empty = validRebuttal();
    empty.pointResponses = [];
    expect(validateRebuttal(empty).ok).toBe(false);
    const noEvidence = validRebuttal();
    (noEvidence.pointResponses as Record<string, unknown>[])[0]!.evidence = [];
    expect(validateRebuttal(noEvidence).ok).toBe(false);
    const badVerdict = validRebuttal();
    (badVerdict.reviewerFeedback as Record<string, unknown>).verdict = 'LGTM';
    expect(validateRebuttal(badVerdict).ok).toBe(false);
  });
});

describe('paper-slides-v1 contract', () => {
  it('accepts a valid deck', () => {
    expect(validateSlidesDeck(validSlides()).ok).toBe(true);
  });

  it('rejects count mismatches, duplicate numbers and short decks', () => {
    const mismatch = validSlides();
    mismatch.slideCount = 5;
    expect(validateSlidesDeck(mismatch).ok).toBe(false);

    const dup = validSlides();
    (dup.slides as Record<string, unknown>[])[2]!.number = 1;
    expect(validateSlidesDeck(dup).ok).toBe(false);

    const short = validSlides();
    short.slides = (short.slides as unknown[]).slice(0, 2);
    short.slideCount = 2;
    const result = validateSlidesDeck(short);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('at least 3');
  });

  it('pins the deck venue to the stored plan', () => {
    expect(() => parseSlidesDeck(JSON.stringify(validSlides()), context('NeurIPS'))).toThrow(
      /does not match the stored plan venue/,
    );
    expect(parseSlidesDeck(JSON.stringify(validSlides()), context('ICLR')).slideCount).toBe(3);
    expect(parseSlidesDeck(JSON.stringify(validSlides()), context(null)).venue).toBe('ICLR');
  });

  it('binds the contract and context anchors into the request', () => {
    const fakeSkill = {
      name: 'paper-slides',
      sha256: 'sha256:' + 'f'.repeat(64),
      frontmatter: {},
      description: 'fake',
      allowedTools: [],
      body: 'body',
      path: 'skills/paper-slides/SKILL.md',
    } as Parameters<typeof buildEngagementRequest>[0];
    const request = buildEngagementRequest(fakeSkill, context('ICLR'), 'slides', SLIDES_SCHEMA);
    expect(request.instruction).toContain(SLIDES_OUTPUT_MARK);
    expect(request.instruction).toContain('Stored plan: venue=ICLR');
    expect(request.idempotencyKey.startsWith(`${SLIDES_SCHEMA}:`)).toBe(true);
  });
});

const SLIDES_OUTPUT_MARK = 'paper-slides-v1';

describe('paper-talk-v1 contract', () => {
  it('accepts a valid draft plan', () => {
    expect(validateTalkPlan(validTalk()).ok).toBe(true);
  });

  it('enforces readiness invariants', () => {
    const readyWithBlocker = validTalk();
    readyWithBlocker.readiness = 'ready';
    readyWithBlocker.blockers = ['missing slides'];
    expect(validateTalkPlan(readyWithBlocker).ok).toBe(false);

    const readyWithFail = validTalk();
    readyWithFail.readiness = 'ready';
    (readyWithFail.checklist as Record<string, unknown>[])[0]!.status = 'fail';
    expect(validateTalkPlan(readyWithFail).ok).toBe(false);

    const blockedEmpty = validTalk();
    blockedEmpty.readiness = 'blocked';
    expect(validateTalkPlan(blockedEmpty).ok).toBe(false);

    const draftWithBlocker = validTalk();
    draftWithBlocker.blockers = ['x'];
    expect(validateTalkPlan(draftWithBlocker).ok).toBe(false);

    const ready = validTalk();
    ready.readiness = 'ready';
    expect(validateTalkPlan(ready).ok).toBe(true);
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

function storedPath(dir: string, file: string): string {
  return join(dir, 'reports', 'paper', file);
}

describe('ideaseek paper rebuttal / slides / talk (e2e, fake harness)', () => {
  it('rebuttal: writes, reuses, and fails closed on quota', async () => {
    const dir = await makeProjectDir();
    const first = await runCli(dir, ['paper', 'rebuttal', '--harness', 'fake']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('rebuttal written');

    const stored = JSON.parse(await readFile(storedPath(dir, 'rebuttal.json'), 'utf8')) as {
      contract: string;
      payload: { overallResponse: string; pointResponses: unknown[] };
    };
    expect(stored.contract).toBe(REBUTTAL_SCHEMA);
    expect(stored.payload.pointResponses.length).toBeGreaterThan(0);

    const second = await runCli(dir, ['paper', 'rebuttal', '--harness', 'fake']);
    expect(second.stdout).toContain('reused rebuttal');

    const blocked = await runCli(dir, ['paper', 'rebuttal', '--harness', 'fake', '--force'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('nothing was written');
  }, 180_000);

  it('slides: pins venue to the stored plan and reuses', async () => {
    const dir = await makeProjectDir();
    expect((await runCli(dir, ['paper', 'plan', '--harness', 'fake'])).code).toBe(0);

    const first = await runCli(dir, ['paper', 'slides', '--harness', 'fake']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('slide deck written');
    expect(first.stdout).toContain('Phase 7');

    const stored = JSON.parse(await readFile(storedPath(dir, 'slides.json'), 'utf8')) as {
      contract: string;
      payload: { venue: string; slideCount: number; slides: unknown[] };
    };
    expect(stored.contract).toBe(SLIDES_SCHEMA);
    expect(stored.payload.venue).toBe('ICLR'); // pinned to plan venue
    expect(stored.payload.slideCount).toBe(3);

    const second = await runCli(dir, ['paper', 'slides', '--harness', 'fake']);
    expect(second.stdout).toContain('reused slide deck');
  }, 180_000);

  it('slides: refuses a venue mismatch against the plan (zero writes)', async () => {
    const dir = await makeProjectDir();
    expect((await runCli(dir, ['paper', 'plan', '--harness', 'fake'])).code).toBe(0);
    const wrong = JSON.stringify({ ...validSlides(), venue: 'CVPR' });
    const failed = await runCli(dir, ['paper', 'slides', '--harness', 'fake'], {
      IDEASEEK_FAKE_SLIDES_OUTPUT: wrong,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('does not match the stored plan venue');
    await expect(readFile(storedPath(dir, 'slides.json'), 'utf8')).rejects.toThrow();
  }, 120_000);

  it('talk: writes a draft readiness plan and reuses', async () => {
    const dir = await makeProjectDir();
    const first = await runCli(dir, ['paper', 'talk', '--harness', 'fake']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('talk plan written');

    const stored = JSON.parse(await readFile(storedPath(dir, 'talk.json'), 'utf8')) as {
      contract: string;
      payload: { readiness: string; checklist: unknown[] };
    };
    expect(stored.contract).toBe(TALK_SCHEMA);
    expect(stored.payload.readiness).toBe('draft');
    expect(stored.payload.checklist.length).toBeGreaterThan(0);

    const second = await runCli(dir, ['paper', 'talk', '--harness', 'fake']);
    expect(second.stdout).toContain('reused talk plan');
  }, 180_000);

  it('rejects contract-violating output with zero writes', async () => {
    const dir = await makeProjectDir();
    const failed = await runCli(dir, ['paper', 'slides', '--harness', 'fake'], {
      IDEASEEK_FAKE_SLIDES_OUTPUT: '{"venue":"ICLR","slideCount":3,"slides":[]}',
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('violates the contract');
    await expect(readFile(storedPath(dir, 'slides.json'), 'utf8')).rejects.toThrow();
  }, 120_000);

  it('refuses a tampered ARIS skill before any model call', async () => {
    const dir = await makeProjectDir();
    const copyRoot = await mkdtemp(join(tmpdir(), 'aris-eng-tamper-'));
    await cp(arisSkillsRoot(), copyRoot, { recursive: true });
    const skillFile = join(copyRoot, 'skills', 'paper-talk', 'SKILL.md');
    await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\n<!-- tampered -->\n`, 'utf8');

    const failed = await runCli(dir, ['paper', 'talk', '--harness', 'fake'], {
      IDEASEEK_ARIS_SKILLS: copyRoot,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('SKILL_TAMPERED');
    await expect(readFile(storedPath(dir, 'talk.json'), 'utf8')).rejects.toThrow();
  }, 120_000);
});
