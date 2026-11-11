import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arisSkillsRoot } from '../src/aris/skill.js';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * Capability 1 (Phase 4.5): idea-creator generation backend wired to
 * IdeaCard/IdeationRound. Covers the ARIS skill adapter success path,
 * idempotent inputHash reuse, honest empty output, invalid-output failure
 * (nothing written), missing round, skill tamper refusal, quota block
 * recovery and the ideate → generate hand-off hint.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out`));
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

interface GeneratePayload {
  roundId: string;
  reused: boolean;
  inputHash: string;
  skill: { name: string; sha256: string };
  count: number;
  reason?: string | null;
  rejected?: { ideaId: string | null; errors: string[] }[];
  paths?: string[];
  eventSeq?: number | null;
  blocked?: string;
}

async function seededProject(): Promise<{ dir: string; roundId: string }> {
  const dir = await makeProjectDir();
  const run = await runCli(dir, ['run', '--question', 'generate test', '--enqueue-only']);
  expect(run.code).toBe(0);
  const ideate = await runCli(dir, ['ideate', '--round', 'new', '--question', 'better clients']);
  expect(ideate.code).toBe(0);
  expect(ideate.stdout).toContain('ideaseek idea generate --round r1');
  return { dir, roundId: 'r1' };
}

const indexFile = (dir: string, roundId: string): string =>
  join(dir, 'knowledge', 'ideation-rounds', roundId, 'candidates.json');

describe('ideaseek idea generate (ARIS idea-creator backend)', () => {
  it('generates a valid card, records an event, and feeds validate/create', async () => {
    const { dir, roundId } = await seededProject();

    const generated = await runCli(dir, [
      'idea',
      'generate',
      '--round',
      roundId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(generated.code).toBe(0);
    const payload = JSON.parse(generated.stdout) as GeneratePayload;
    expect(payload).toMatchObject({
      roundId,
      reused: false,
      count: 1,
      skill: { name: 'idea-creator' },
    });
    expect(payload.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.eventSeq).toBeGreaterThan(0);

    const index = JSON.parse(await readFile(indexFile(dir, roundId), 'utf8')) as {
      contract: string;
      candidates: { ideaId: string; status: string }[];
      skill: { name: string };
    };
    expect(index.contract).toBe('idea-candidates-v1');
    expect(index.skill.name).toBe('idea-creator');
    expect(index.candidates[0]!.ideaId).toBe('gen-fake-1');

    const cardPath = join(
      dir,
      'knowledge',
      'ideation-rounds',
      roundId,
      'candidates',
      'gen-fake-1.json',
    );
    const validated = await runCli(dir, ['idea', 'validate', cardPath, '--require-candidate']);
    expect(validated.code).toBe(0);
    const created = await runCli(dir, ['idea', 'create', 'gen-fake-1', '--from-card', cardPath]);
    expect(created.code).toBe(0);

    const events = await runCli(dir, ['events', '--json']);
    expect(events.stdout).toContain('idea_candidates');
    expect(events.stdout).toContain('ARIS idea-creator');
  }, 120_000);

  it('reuses the same inputHash instead of regenerating', async () => {
    const { dir, roundId } = await seededProject();
    const first = await runCli(dir, [
      'idea',
      'generate',
      '--round',
      roundId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(first.code).toBe(0);
    const before = await readFile(indexFile(dir, roundId), 'utf8');

    const second = await runCli(dir, [
      'idea',
      'generate',
      '--round',
      roundId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(second.code).toBe(0);
    const payload = JSON.parse(second.stdout) as GeneratePayload;
    expect(payload.reused).toBe(true);
    expect(payload.inputHash).toBe((JSON.parse(first.stdout) as GeneratePayload).inputHash);
    expect(await readFile(indexFile(dir, roundId), 'utf8')).toBe(before);

    // Reuse must not double-record the audit event.
    const events = await runCli(dir, ['events', '--json']);
    const occurrences = events.stdout.split('idea_candidates').length - 1;
    expect(occurrences).toBe(1);
  }, 120_000);

  it('records an honest empty result with a reason (never padded)', async () => {
    const { dir, roundId } = await seededProject();
    const generated = await runCli(
      dir,
      ['idea', 'generate', '--round', roundId, '--harness', 'fake', '--json'],
      { IDEASEEK_FAKE_IDEA_OUTPUT: '{"candidates":[],"reason":"no defensible new idea"}' },
    );
    expect(generated.code).toBe(0);
    const payload = JSON.parse(generated.stdout) as GeneratePayload;
    expect(payload).toMatchObject({ count: 0, reason: 'no defensible new idea' });
    const index = JSON.parse(await readFile(indexFile(dir, roundId), 'utf8')) as {
      candidates: unknown[];
      reason: string;
    };
    expect(index.candidates).toHaveLength(0);
    expect(index.reason).toBe('no defensible new idea');
  }, 120_000);

  it('rejects invalid model output without writing anything', async () => {
    const { dir, roundId } = await seededProject();
    const failed = await runCli(
      dir,
      ['idea', 'generate', '--round', roundId, '--harness', 'fake'],
      { IDEASEEK_FAKE_IDEA_OUTPUT: '{"candidates":[{"ideaId":"Bad Id"}]}' },
    );
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toMatch(/PARSE_FAILED|rejected/);
    await expect(readFile(indexFile(dir, roundId), 'utf8')).rejects.toThrow();
  }, 120_000);

  it('fails clearly when the round does not exist', async () => {
    const dir = await makeProjectDir();
    const failed = await runCli(dir, ['idea', 'generate', '--round', 'r9']);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('ideation round r9 not found');
  }, 60_000);

  it('refuses a tampered ARIS skill before any model call', async () => {
    const { dir, roundId } = await seededProject();
    const copyRoot = await mkdtemp(join(tmpdir(), 'aris-gen-tamper-'));
    await cp(arisSkillsRoot(), copyRoot, { recursive: true });
    const skillFile = join(copyRoot, 'skills', 'idea-creator', 'SKILL.md');
    await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\n<!-- tampered -->\n`, 'utf8');

    const failed = await runCli(
      dir,
      ['idea', 'generate', '--round', roundId, '--harness', 'fake'],
      { IDEASEEK_ARIS_SKILLS: copyRoot },
    );
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('SKILL_TAMPERED');
    await expect(readFile(indexFile(dir, roundId), 'utf8')).rejects.toThrow();
  }, 120_000);

  it('maps quota blocks to exit 2 with nothing written, then recovers', async () => {
    const { dir, roundId } = await seededProject();
    const blocked = await runCli(
      dir,
      ['idea', 'generate', '--round', roundId, '--harness', 'fake'],
      { IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED' },
    );
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('QUOTA_EXHAUSTED');
    expect(blocked.stderr).toContain('nothing was written');
    await expect(readFile(indexFile(dir, roundId), 'utf8')).rejects.toThrow();

    // Quota restored → the same command succeeds (no burned attempt state).
    const recovered = await runCli(dir, [
      'idea',
      'generate',
      '--round',
      roundId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(recovered.code).toBe(0);
    expect((JSON.parse(recovered.stdout) as GeneratePayload).count).toBe(1);
  }, 120_000);

  it('emits a real hypothesis statement through the round context', async () => {
    const { dir, roundId } = await seededProject();
    const generated = await runCli(dir, [
      'idea',
      'generate',
      '--round',
      roundId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(generated.code).toBe(0);
    const index = JSON.parse(await readFile(indexFile(dir, roundId), 'utf8')) as {
      candidates: { hypothesis: { statement: string } }[];
    };
    expect(index.candidates[0]!.hypothesis.statement.length).toBeGreaterThan(10);
  }, 120_000);
});
