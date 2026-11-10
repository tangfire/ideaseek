import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  assessIdeaCard,
  assessIdeaGate,
  validateIdeaCard,
  CHAIN_KINDS,
  type IdeaCard,
} from '../src/idea/card.js';
import { CLI_BIN } from './helpers.js';

function validCard(overrides: Record<string, unknown> = {}): IdeaCard {
  return {
    ideaId: 'client-aware-reweighting',
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: {
      statement: 'reweighting client losses by prediction disagreement improves rare-class recall',
      targetProblem: 'FedAvg underperforms on non-IID long-tail client data',
    },
    paperEvidence: [
      {
        paperRef: 'fedavg-paper',
        statement: 'uniform averaging dilutes minority-class signal',
        evidence: 'fedavg-paper p.5 §4.2',
      },
    ],
    contradictions: [
      'paper A claims disagreement weighting helps, paper B reports no gain on similar data',
    ],
    novelty: {
      claim: 'first to tie reweighting to per-client calibration error measured on the server',
      uncertainty: 'may collapse when client sample sizes are balanced',
      whyNotRestatement:
        'prior work reweights by sample count; this reweights by measurable calibration error, a different mechanism',
    },
    mechanismChain: {
      designPrincipleLink: 'inverts FedAvg averaging assumption flagged by papers §3',
      steps: [
        {
          kind: 'observation',
          text: 'clients with skewed labels show high server-side calibration error',
        },
        {
          kind: 'hypothesis',
          text: 'down-weighting those clients reduces minority-class dilution',
        },
        {
          kind: 'intervention',
          text: 'server reweights client updates by exp(-calibration error)',
        },
        {
          kind: 'expected-change',
          text: 'rare-class recall rises without hurting mean accuracy >1%',
        },
        {
          kind: 'baseline-difference',
          text: 'differs from FedAvg/FedProx which weight by sample count only',
        },
        { kind: 'falsifier', text: 'no recall gain on 3 seeds, or mean accuracy drops >2%' },
      ],
    },
    nearestComparisons: [
      {
        methodId: 'fedavg',
        difference: 'sample-count weighting vs calibration-error weighting',
        evidence: 'fedavg-paper p.3 Algorithm 1',
      },
    ],
    componentNecessity: [
      {
        component: 'server calibration probe',
        role: 'necessary-mechanism',
        removeEffect: 'reweighting becomes random; recall gain disappears',
      },
    ],
    competingExplanations: ['gain comes from lower effective learning rate, not reweighting'],
    boundaryConditions: ['balanced client sizes (no skew) should show no benefit'],
    risks: ['calibration probe costs one extra pass over held-out data'],
    minimalExperiment: {
      code: 'ideas/client-aware-reweighting/src/train.py',
      data: 'slice smoke-1 of the federated npz',
      baselines: ['fedavg', 'fedprox'],
      metrics: ['rare-class recall', 'mean accuracy'],
      ablations: ['no reweighting', 'random reweighting'],
    },
    falsification: {
      conditions: ['recall delta < 0 on 3 seeds', 'accuracy drop > 2%'],
    },
    budget: { maxRounds: 3, maxGpuMinutes: 120 },
    stopConditions: ['budget exhausted', 'two rounds without signal'],
    createdAt: 1,
    ...overrides,
  } as IdeaCard;
}

function chainKindsCard(drop: string): IdeaCard {
  const card = validCard();
  return {
    ...card,
    // A card failing the mechanism gate must declare the draft status.
    status: 'DRAFT_COMPOSITION',
    mechanismChain: {
      ...card.mechanismChain,
      steps: card.mechanismChain.steps.filter((step) => step.kind !== drop),
    },
  } as IdeaCard;
}

describe('validateIdeaCard', () => {
  it('accepts a complete card', () => {
    expect(validateIdeaCard(validCard())).toEqual({ ok: true, errors: [] });
  });

  it('enforces version/parentVersion coupling', () => {
    expect(validateIdeaCard(validCard({ version: 2, parentVersion: null })).ok).toBe(false);
    expect(validateIdeaCard(validCard({ version: 2, parentVersion: 1 })).ok).toBe(true);
    expect(
      validateIdeaCard(validCard({ version: 1, parentVersion: 0 })).errors.join(' '),
    ).toContain('parentVersion must be null');
    expect(
      validateIdeaCard(validCard({ version: 2, parentVersion: 5 })).errors.join(' '),
    ).toContain('parentVersion must be an integer < version');
  });

  it('requires cited evidence, nearest comparisons and falsification', () => {
    expect(validateIdeaCard(validCard({ paperEvidence: [] })).ok).toBe(false);
    expect(validateIdeaCard(validCard({ nearestComparisons: [] })).ok).toBe(false);
    expect(validateIdeaCard(validCard({ falsification: { conditions: [] } })).ok).toBe(false);
    expect(validateIdeaCard(validCard({ contradictions: [] })).ok).toBe(false);
    expect(validateIdeaCard(validCard({ stopConditions: [] })).ok).toBe(false);
    expect(validateIdeaCard(validCard({ status: 'ACTIVE' })).errors.join(' ')).toContain(
      'status must be',
    );
    expect(
      validateIdeaCard(
        validCard({ novelty: { claim: 'x', uncertainty: '', whyNotRestatement: 'y' } }),
      ).ok,
    ).toBe(false);
    expect(validateIdeaCard(validCard({ budget: { maxRounds: 0, maxGpuMinutes: 10 } })).ok).toBe(
      false,
    );
  });

  it('requires every mechanism chain kind to be present structurally', () => {
    // Steps with unknown kinds are structural errors.
    const card = validCard();
    const bad = {
      ...card,
      mechanismChain: {
        ...card.mechanismChain,
        steps: [{ kind: 'vibes', text: 'x' }],
      },
    };
    const result = validateIdeaCard(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('kind must be one of');
    expect(CHAIN_KINDS).toHaveLength(6);
  });
});

describe('assessIdeaGate / assessIdeaCard', () => {
  it('passes a complete card as CANDIDATE', () => {
    const gate = assessIdeaGate(validCard());
    expect(gate).toEqual({ ok: true, status: 'CANDIDATE', blockers: [] });
    const result = assessIdeaCard(validCard());
    expect(result.ok).toBe(true);
  });

  it('holds cards with an incomplete chain at DRAFT_COMPOSITION', () => {
    const gate = assessIdeaGate(chainKindsCard('falsifier'));
    expect(gate.ok).toBe(false);
    expect(gate.status).toBe('DRAFT_COMPOSITION');
    expect(gate.blockers.join(' ')).toContain('missing falsifier');

    const multi = ['observation', 'falsifier'].reduce(
      (acc, kind) => acc.filter((step) => step.kind !== kind),
      validCard().mechanismChain.steps,
    );
    const multiGate = assessIdeaGate({
      ...validCard(),
      mechanismChain: { ...validCard().mechanismChain, steps: multi },
    });
    expect(multiGate.blockers.join(' ')).toContain('missing observation, falsifier');
  });

  it('rejects a gate failure dressed up as CANDIDATE', () => {
    const draft = chainKindsCard('falsifier');
    // Same card but claiming candidate status must be an error.
    const lying = { ...draft, status: 'CANDIDATE' } as IdeaCard;
    const result = assessIdeaCard(lying);
    expect(result.ok).toBe(false);
    expect(result.validation.errors.join(' ')).toContain('DRAFT_COMPOSITION');

    // Honest draft passes validation with blockers reported.
    const honest = assessIdeaCard(draft);
    expect(honest.ok).toBe(true);
    expect(honest.gate.ok).toBe(false);
    expect(honest.gate.status).toBe('DRAFT_COMPOSITION');
  });

  it('flags multi-component surface compositions', () => {
    const surface = validCard({
      componentNecessity: [
        { component: 'module A', role: 'engineering', removeEffect: 'nothing notable' },
        { component: 'module B', role: 'engineering', removeEffect: 'nothing notable' },
      ],
    });
    const gate = assessIdeaGate(surface);
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toContain('surface composition');
    // status must then be DRAFT_COMPOSITION
    const result = assessIdeaCard(surface);
    expect(result.ok).toBe(false);
  });

  it('accepts multi-component ideas that declare a necessary mechanism', () => {
    const sound = validCard({
      componentNecessity: [
        { component: 'probe', role: 'necessary-mechanism', removeEffect: 'gain vanishes' },
        { component: 'logger', role: 'engineering', removeEffect: 'cosmetic only' },
      ],
    });
    expect(assessIdeaGate(sound).ok).toBe(true);
  });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 30_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
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

describe('ideaseek idea validate (CLI)', () => {
  it('validates a candidate card and reports queue eligibility', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-idea-'));
    const file = join(dir, 'card.json');
    await writeFile(file, JSON.stringify(validCard(), null, 2), 'utf8');

    const result = await runCli(dir, ['idea', 'validate', file, '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      valid: boolean;
      gate: string;
      eligibleForQueue: boolean;
      blockers: string[];
    };
    expect(payload).toMatchObject({
      valid: true,
      gate: 'CANDIDATE',
      eligibleForQueue: true,
      blockers: [],
    });

    const plain = await runCli(dir, ['idea', 'validate', file]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('eligible for the experiment queue');
  }, 30_000);

  it('reports drafts honestly and can enforce candidacy for the queue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-idea-'));
    const file = join(dir, 'draft.json');
    await writeFile(file, JSON.stringify(chainKindsCard('falsifier'), null, 2), 'utf8');

    // Valid draft: exit 0, but clearly held back.
    const draft = await runCli(dir, ['idea', 'validate', file, '--json']);
    expect(draft.code).toBe(0);
    const payload = JSON.parse(draft.stdout) as {
      valid: boolean;
      gate: string;
      eligibleForQueue: boolean;
      blockers: string[];
    };
    expect(payload).toMatchObject({
      valid: true,
      gate: 'DRAFT_COMPOSITION',
      eligibleForQueue: false,
    });
    expect(payload.blockers.join(' ')).toContain('missing falsifier');

    // Pre-experiment check enforces candidacy.
    const strict = await runCli(dir, ['idea', 'validate', file, '--require-candidate']);
    expect(strict.code).toBe(2);
    expect(strict.stdout).toContain('held at DRAFT_COMPOSITION');
  }, 30_000);

  it('fails on malformed cards and bad files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-idea-'));

    const lyingFile = join(dir, 'lying.json');
    await writeFile(
      lyingFile,
      JSON.stringify({ ...chainKindsCard('falsifier'), status: 'CANDIDATE' }),
      'utf8',
    );
    const lying = await runCli(dir, ['idea', 'validate', lyingFile, '--json']);
    expect(lying.code).toBe(2);
    const payload = JSON.parse(lying.stdout) as { valid: boolean; errors: string[] };
    expect(payload.valid).toBe(false);
    expect(payload.errors.join(' ')).toContain('DRAFT_COMPOSITION');

    const brokenFile = join(dir, 'broken.json');
    await writeFile(brokenFile, '{not json', 'utf8');
    const broken = await runCli(dir, ['idea', 'validate', brokenFile]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('not valid JSON');

    const missing = await runCli(dir, ['idea', 'validate', join(dir, 'nope.json')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('cannot read');
  }, 30_000);
});
