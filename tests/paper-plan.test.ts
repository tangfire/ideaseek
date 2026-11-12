import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arisSkillsRoot } from '../src/aris/skill.js';
import {
  PAPER_PLAN_OUTPUT_CONTRACT,
  PAPER_PLAN_SCHEMA,
  buildPaperPlanRequest,
  validatePaperPlan,
  type PaperPlanSnapshot,
} from '../src/paper/plan.js';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * Phase 4.5C capability: ARIS paper-plan over locked/persisted results.
 * The contract mirrors the skill's Step-7 output; the request binds a
 * read-only snapshot so claims cite hashable sources; the command fails
 * closed (integrity → quota → contract) with zero writes.
 */

function validPlan(): Record<string, unknown> {
  return {
    paperType: 'empirical-study',
    venue: 'ICLR',
    maxPages: 9,
    contribution: 'A locked-protocol study of the research question',
    claimsEvidence: [
      {
        claim: 'Method A beats the baseline on the locked split',
        evidence: [{ source: 'repro-fedavg', location: 'result.metrics.accuracy' }],
        status: 'supported',
      },
    ],
    structure: [
      {
        section: '§0 Abstract',
        purpose: 'state contribution and strongest evidence',
        keyPoints: ['contribution', 'main number'],
      },
    ],
    figurePlan: [
      {
        id: 'fig-1',
        kind: 'bar',
        caption: 'Main comparison',
        supportsClaims: ['Method A beats the baseline on the locked split'],
      },
    ],
    citationPlan: [{ topic: 'federated baselines', candidates: ['mcmahan17a'] }],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['no backend hosted'] },
    nextSteps: ['draft the introduction'],
  };
}

function snapshot(): PaperPlanSnapshot {
  return {
    question: 'heterogeneous models in federated learning',
    protocol: { protocolId: 'proto-x', protocolHash: 'sha256:' + 'a'.repeat(64), lockedAt: 1 },
    comparisons: [{ methodId: 'fedavg', status: 'smoke-tested', required: true }],
    experiments: [
      {
        specId: 'repro-fedavg',
        version: 1,
        status: 'succeeded',
        metrics: [{ name: 'accuracy', value: 0.4 }],
      },
    ],
    ideas: [{ ideaId: 'alpha', verdict: 'supported' }],
    researchMapHash: 'sha256:' + 'b'.repeat(64),
  };
}

describe('validatePaperPlan (contract)', () => {
  it('accepts a complete plan', () => {
    const result = validatePaperPlan(validPlan());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  const rejected: { name: string; plan: unknown }[] = [
    { name: 'null', plan: null },
    { name: 'array', plan: [] },
    {
      name: 'missing venue',
      plan: (() => {
        const p = validPlan();
        delete p.venue;
        return p;
      })(),
    },
    {
      name: 'unknown venue',
      plan: (() => {
        const p = validPlan();
        p.venue = 'arXiv';
        return p;
      })(),
    },
    {
      name: 'maxPages 0',
      plan: (() => {
        const p = validPlan();
        p.maxPages = 0;
        return p;
      })(),
    },
    {
      name: 'empty claims',
      plan: (() => {
        const p = validPlan();
        p.claimsEvidence = [];
        return p;
      })(),
    },
    {
      name: 'claim without evidence',
      plan: (() => {
        const p = validPlan();
        (p.claimsEvidence as Record<string, unknown>[])[0]!.evidence = [];
        return p;
      })(),
    },
    {
      name: 'bad claim status',
      plan: (() => {
        const p = validPlan();
        (p.claimsEvidence as Record<string, unknown>[])[0]!.status = 'proven';
        return p;
      })(),
    },
    {
      name: 'empty structure',
      plan: (() => {
        const p = validPlan();
        p.structure = [];
        return p;
      })(),
    },
    {
      name: 'empty figures',
      plan: (() => {
        const p = validPlan();
        p.figurePlan = [];
        return p;
      })(),
    },
    {
      name: 'bad verdict',
      plan: (() => {
        const p = validPlan();
        (p.reviewerFeedback as Record<string, unknown>).verdict = 'ACCEPTED';
        return p;
      })(),
    },
    {
      name: 'empty nextSteps',
      plan: (() => {
        const p = validPlan();
        p.nextSteps = [];
        return p;
      })(),
    },
  ];
  for (const testCase of rejected) {
    it(`rejects: ${testCase.name}`, () => {
      const result = validatePaperPlan(testCase.plan);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  }
});

describe('buildPaperPlanRequest', () => {
  const fakeSkill = {
    name: 'paper-plan',
    sha256: 'sha256:' + 'c'.repeat(64),
    frontmatter: {},
    description: 'fake paper-plan for unit tests',
    allowedTools: [],
    body: 'skill body',
    path: 'skills/paper-plan/SKILL.md',
  } as Parameters<typeof buildPaperPlanRequest>[0];

  it('binds skill hash + snapshot into a stable inputHash and full contract', () => {
    const a = buildPaperPlanRequest(fakeSkill, snapshot());
    const b = buildPaperPlanRequest(fakeSkill, snapshot());
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.idempotencyKey).toBe(`paper-plan:${a.inputHash}`);
    expect(a.instruction).toContain(PAPER_PLAN_OUTPUT_CONTRACT);
    expect(a.instruction).toContain('proto-x');
    expect(a.instruction).toContain('repro-fedavg');
    expect(a.context).toContain('Research question: heterogeneous models');
  });

  it('changes inputHash when the snapshot changes', () => {
    const changed = snapshot();
    changed.protocol = null;
    expect(buildPaperPlanRequest(fakeSkill, changed).inputHash).not.toBe(
      buildPaperPlanRequest(fakeSkill, snapshot()).inputHash,
    );
  });

  it('requires REVIEW_UNAVAILABLE in the contract text', () => {
    expect(PAPER_PLAN_OUTPUT_CONTRACT).toContain('REVIEW_UNAVAILABLE');
    expect(PAPER_PLAN_SCHEMA).toBe('paper-plan-v1');
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

function planFile(dir: string): string {
  return join(dir, 'reports', 'paper', 'plan.json');
}

describe('ideaseek paper plan (e2e, fake harness)', () => {
  it('writes a contract-valid plan bound to the persisted snapshot, then reuses it', async () => {
    const dir = await makeProjectDir();
    const first = await runCli(dir, ['paper', 'plan', '--harness', 'fake']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('paper plan written');
    expect(first.stdout).toContain('ICLR');
    expect(first.stdout).toContain('REVIEW_UNAVAILABLE');
    expect(first.stdout).toContain('review reports/paper/plan.json');

    const stored = JSON.parse(await readFile(planFile(dir), 'utf8')) as {
      contract: string;
      inputHash: string;
      skill: { name: string; sha256: string };
      harnessRuntime: string;
      snapshot: { protocol: unknown; question: string };
      plan: { venue: string; claimsEvidence: unknown[]; reviewerFeedback: { verdict: string } };
    };
    expect(stored.contract).toBe('paper-plan-v1');
    expect(stored.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stored.skill.name).toBe('paper-plan');
    expect(stored.harnessRuntime).toBe('fake');
    expect(stored.snapshot.protocol).toBeNull();
    expect(stored.snapshot.question).toBe('(no run yet)');
    expect(stored.plan.venue).toBe('ICLR');
    expect(stored.plan.claimsEvidence.length).toBeGreaterThan(0);
    expect(stored.plan.reviewerFeedback.verdict).toBe('REVIEW_UNAVAILABLE');

    // Identical inputs → idempotent reuse, byte-identical file.
    const before = await readFile(planFile(dir), 'utf8');
    const second = await runCli(dir, ['paper', 'plan', '--harness', 'fake']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('reused paper plan');
    expect(await readFile(planFile(dir), 'utf8')).toBe(before);

    // --force regenerates (new generatedAt, same contract).
    const forced = await runCli(dir, ['paper', 'plan', '--harness', 'fake', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain('paper plan written');
  }, 120_000);

  it('rejects contract-violating output with zero writes', async () => {
    const dir = await makeProjectDir();
    const failed = await runCli(dir, ['paper', 'plan', '--harness', 'fake'], {
      IDEASEEK_FAKE_PAPER_PLAN_OUTPUT: '{"paperType":42}',
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('paper-plan output violates');
    await expect(readFile(planFile(dir), 'utf8')).rejects.toThrow();
  }, 60_000);

  it('maps quota blocks to exit 2 with nothing written, then recovers', async () => {
    const dir = await makeProjectDir();
    const blocked = await runCli(dir, ['paper', 'plan', '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('QUOTA_EXHAUSTED');
    expect(blocked.stderr).toContain('nothing was written');
    await expect(readFile(planFile(dir), 'utf8')).rejects.toThrow();

    const recovered = await runCli(dir, ['paper', 'plan', '--harness', 'fake']);
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toContain('paper plan written');
  }, 120_000);

  it('refuses a tampered ARIS skill before any model call', async () => {
    const dir = await makeProjectDir();
    const copyRoot = await mkdtemp(join(tmpdir(), 'aris-paper-tamper-'));
    await cp(arisSkillsRoot(), copyRoot, { recursive: true });
    const skillFile = join(copyRoot, 'skills', 'paper-plan', 'SKILL.md');
    await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\n<!-- tampered -->\n`, 'utf8');

    const failed = await runCli(dir, ['paper', 'plan', '--harness', 'fake'], {
      IDEASEEK_ARIS_SKILLS: copyRoot,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('SKILL_TAMPERED');
    await expect(readFile(planFile(dir), 'utf8')).rejects.toThrow();
  }, 120_000);

  it('--json emits the full contract payload', async () => {
    const dir = await makeProjectDir();
    const json = await runCli(dir, ['paper', 'plan', '--harness', 'fake', '--json']);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      contract: string;
      reused: boolean;
      inputHash: string;
      plan: { venue: string; nextSteps: string[] };
    };
    expect(payload.contract).toBe('paper-plan-v1');
    expect(payload.reused).toBe(false);
    expect(payload.inputHash).toMatch(/^sha256:/);
    expect(payload.plan.nextSteps.length).toBeGreaterThan(0);
  }, 60_000);
});
