import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import {
  MECHANISM_ANALYSIS_SCHEMA,
  parseMechanismOutput,
  type MechanismContext,
} from '../src/idea/mechanism.js';

/**
 * Mechanism Analyst (docs/AGENT_ROLES.md): mechanism / design-principle /
 * contradiction graph from persisted syntheses and failure boundaries.
 * Role boundary 不能把相关性当因果机制 is machine-enforced via
 * correlationCaution: true; evidence sources must come from the context.
 */

function context(): MechanismContext {
  return {
    sources: ['speculation', 'synthesis:federated learning', 'idea-analysis:alpha'],
    lines: [
      'Topic syntheses:',
      '  - federated learning:',
      '      · reweighting — fix drift [label-skew]',
    ],
  };
}

function validAnalysis(): Record<string, unknown> {
  return {
    contract: MECHANISM_ANALYSIS_SCHEMA,
    mechanisms: [
      {
        name: 'drift-aware reweighting',
        designPrinciple: 'compensate drift before aggregation',
        conditions: ['label-skew partitions'],
        groundedIn: [{ source: 'synthesis:federated learning', location: 'mechanisms[0]' }],
      },
    ],
    designPrinciples: [
      {
        principle: 'correct the objective where mismatch originates',
        supportsMechanisms: ['drift-aware reweighting'],
      },
    ],
    contradictions: [],
    causalityStatement: 'Association under the locked protocol; causality needs the ablation.',
    correlationCaution: true,
  };
}

function expectRejected(output: Record<string, unknown>, pattern: RegExp): void {
  try {
    parseMechanismOutput(JSON.stringify(output), context());
    expect.unreachable('should have thrown');
  } catch (error) {
    expect((error as { message: string }).message).toMatch(pattern);
  }
}

describe('parseMechanismOutput (contract + boundaries)', () => {
  it('accepts a complete analysis', () => {
    const parsed = parseMechanismOutput(JSON.stringify(validAnalysis()), context());
    expect(parsed.mechanisms).toHaveLength(1);
    expect(parsed.correlationCaution).toBe(true);
  });

  it('rejects wrong contract, empty mechanisms and unknown principle links', () => {
    expectRejected({ ...validAnalysis(), contract: 'other-v1' }, /contract must be/);
    const empty = validAnalysis();
    empty.mechanisms = [];
    expectRejected(empty, /mechanisms must be a non-empty/);
    const ghost = validAnalysis();
    (ghost.designPrinciples as Record<string, unknown>[])[0]!.supportsMechanisms = ['ghost-mech'];
    expectRejected(ghost, /unknown mechanism "ghost-mech"/);
  });

  it('enforces the causality boundary', () => {
    const noStatement = validAnalysis();
    noStatement.causalityStatement = ' ';
    expectRejected(noStatement, /causalityStatement/);

    const noCaution = validAnalysis();
    noCaution.correlationCaution = false;
    expectRejected(noCaution, /never causation/);
  });

  it('rejects invented sources and broken contradictions', () => {
    const invented = validAnalysis();
    (invented.mechanisms as Record<string, unknown>[])[0]!.groundedIn = [
      { source: 'made-up-synthesis', location: 'x' },
    ];
    expectRejected(invented, /not among the context sources/);

    const notArray = validAnalysis();
    notArray.contradictions = 'none';
    expectRejected(notArray, /contradictions must be an array/);

    const badContradiction = validAnalysis();
    badContradiction.contradictions = [{ claimA: 'a', claimB: 'b', resolution: 'r', evidence: [] }];
    expectRejected(badContradiction, /evidence must be a non-empty/);
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

describe('ideaseek mech (e2e, fake harness)', () => {
  it('writes a correlation-cautioned graph, then reuses it', async () => {
    const dir = await makeProjectDir();
    const first = await runCli(dir, ['mech', '--harness', 'fake']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain('mechanism graph written');
    expect(first.stdout).toContain('correlationCaution: true');

    const stored = JSON.parse(
      await readFile(join(dir, 'knowledge', 'mechanism-graph.json'), 'utf8'),
    ) as {
      contract: string;
      inputHash: string;
      analysis: {
        correlationCaution: boolean;
        mechanisms: { name: string }[];
        causalityStatement: string;
      };
    };
    expect(stored.contract).toBe('mechanism-analysis-v1');
    expect(stored.analysis.correlationCaution).toBe(true);
    expect(stored.analysis.mechanisms.length).toBeGreaterThan(0);
    expect(stored.analysis.causalityStatement.length).toBeGreaterThan(0);

    const second = await runCli(dir, ['mech', '--harness', 'fake']);
    expect(second.stdout).toContain('reused mechanism graph');
  }, 180_000);

  it('maps quota blocks to exit 2 with nothing written', async () => {
    const dir = await makeProjectDir();
    const blocked = await runCli(dir, ['mech', '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('nothing was written');
    await expect(
      readFile(join(dir, 'knowledge', 'mechanism-graph.json'), 'utf8'),
    ).rejects.toThrow();
  }, 180_000);

  it('rejects output that drops the causality caution (zero writes)', async () => {
    const dir = await makeProjectDir();
    const bad = JSON.stringify({
      contract: MECHANISM_ANALYSIS_SCHEMA,
      mechanisms: [
        {
          name: 'm',
          designPrinciple: 'p',
          conditions: ['c'],
          evidence: [{ source: 'speculation', location: 'x' }],
          groundedIn: [{ source: 'speculation', location: 'x' }],
        },
      ],
      designPrinciples: [{ principle: 'p', supportsMechanisms: ['m'] }],
      contradictions: [],
      causalityStatement: 'looks causal to me',
      correlationCaution: false,
    });
    const failed = await runCli(dir, ['mech', '--harness', 'fake'], {
      IDEASEEK_FAKE_MECH_OUTPUT: bad,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('never causation');
    await expect(
      readFile(join(dir, 'knowledge', 'mechanism-graph.json'), 'utf8'),
    ).rejects.toThrow();
  }, 180_000);
});
