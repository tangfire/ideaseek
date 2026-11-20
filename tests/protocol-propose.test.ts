import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_PROMPT_VERSION,
  buildProtocolInput,
  PROTOCOL_INSTRUCTION,
} from '../src/experiment/protocol-synth.js';
import { PROTOCOL_SOURCES, validateProtocolProposal } from '../src/experiment/protocol.js';
import { CLI_BIN } from './helpers.js';

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
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

describe('buildProtocolInput', () => {
  it('compacts cards and flags missing datasets for confirmation', () => {
    const input = buildProtocolInput({
      question: 'q',
      cards: [
        {
          paperId: 'p1',
          source: 'papers/a.pdf',
          title: 'T',
          problem: 'P',
          methodSummary: 'M',
          datasets: ['MNIST', 'unknown'],
          metrics: ['accuracy'],
          topClaims: [{ text: 'claim one', quote: 'q', page: 1 }],
          limitations: [],
        },
      ],
      datasetProfile: null,
    });
    expect(input.corpusPapers).toBe(1);
    expect(input.papers[0]!.datasets).toEqual(['MNIST', 'unknown']);
    expect(input.dataset.present).toBe(false);
    expect(input.dataset.note).toContain('agent-inference');
    expect(PROTOCOL_PROMPT_VERSION).toContain('protocol-proposal');
  });
});

describe('PROTOCOL_INSTRUCTION source enum', () => {
  // Acceptance STAGE 4：模型在 splitRules.source 上编造取值，三次重试全被
  // validateProtocolProposal 拒绝——枚举只写在 taskDefinition 的 schema 行上，
  // Rules 行没有约束到其余 sourced 字段。
  it('binds every sourced field to PROTOCOL_SOURCES in the Rules line', () => {
    const rulesLine = PROTOCOL_INSTRUCTION.split('\n').find((l) => l.startsWith('Rules:'));
    expect(rulesLine, 'Rules line missing').toBeTruthy();
    expect(rulesLine).toContain('every "source" field must be one of');
    for (const source of PROTOCOL_SOURCES) expect(rulesLine).toContain(source);
  });
});

describe('CLI: protocol propose → confirm loop (fake harness)', () => {
  async function prepare(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-protocol-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
    try {
      await makeFixturePdf(join(dir, 'papers', 'alpha.pdf'), 'Alpha');
    } catch {
      return dir; // python missing: subsequent steps will assert their own guards
    }
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    expect((await runCli(dir, ['ingest', '--json'])).code).toBe(0);
    expect((await runCli(dir, ['extract', '--parallel', '2', '--json'], 120_000)).code).toBe(0);
    return dir;
  }

  it('proposes, confirms and locks; rerun reports the proposal is current', async () => {
    const dir = await prepare();
    const { readdir } = await import('node:fs/promises');
    if ((await readdir(join(dir, 'papers'))).length === 0) return; // python missing

    const proposed = await runCli(dir, ['protocol', 'propose', '--json'], 120_000);
    expect(proposed.code).toBe(0);
    const payload = JSON.parse(proposed.stdout) as {
      exitReason: string;
      inputHash: string;
      tasks: Record<string, number>;
    };
    expect(payload.exitReason).toBe('completed');
    expect(payload.tasks.succeeded).toBe(1);

    // Confirmation loop: validation + leakage gate + idempotent lock.
    const confirmed = await runCli(dir, ['confirm', 'protocol', '--by', 'researcher', '--json']);
    expect(confirmed.code).toBe(0);
    const lock = JSON.parse(confirmed.stdout) as {
      locked: boolean;
      protocolHash: string;
      confirmations: string[];
    };
    expect(lock.locked).toBe(true);
    expect(lock.protocolHash).toMatch(/^sha256:/);
    // No user dataset ⇒ data-dependent rules must be listed for confirmation.
    expect(lock.confirmations.length).toBeGreaterThan(0);

    const again = await runCli(dir, ['protocol', 'propose', '--json'], 60_000);
    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as { action?: string }).action).toBe('proposal-current');
  }, 300_000);

  it('refuses without extracted cards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-protocol-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const result = await runCli(dir, ['protocol', 'propose']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ideaseek extract');
  }, 60_000);

  it('proposal contract accepts only grounded structures', () => {
    expect(
      validateProtocolProposal({
        protocolId: 'proto-x-v1',
        version: 1,
        generator: 'g',
        generatedAt: 1,
        taskDefinition: { value: 'v', source: 'agent-inference', confidence: 0.5 },
        sampleUnit: { value: 'v', source: 'user', confidence: 1 },
        labelSemantics: { value: 'v', source: 'user', confidence: 1 },
        splitRules: { value: ['r'], source: 'adapter-rule', confidence: 0.8 },
        leakageChecks: ['x'],
        preprocessing: ['y'],
        baselineEntries: [{ methodId: 'm', entry: 'e', source: 'code', confidence: 0.9 }],
        primaryMetrics: [
          { name: 'acc', direction: 'higher', source: 'paper-evidence', confidence: 0.9 },
        ],
        secondaryMetrics: [],
        statisticalSummary: ['mean'],
        smokeTest: { value: 's', source: 'adapter-rule', confidence: 0.9 },
        resourceEstimate: { value: 'r', source: 'agent-inference', confidence: 0.6 },
        ablations: ['a'],
        supportCriteria: ['s'],
        refuteCriteria: ['r'],
        invalidRunCriteria: ['i'],
        stopConditions: ['budget'],
      }).errors,
    ).toEqual([]);
  });
});
