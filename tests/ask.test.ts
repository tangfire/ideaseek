import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import { sanitizeSupervisorCliArgs } from '../src/commands/ask.js';
import { extractAgentSessionId } from '../src/cli/shell/session.js';

/**
 * Free-text entry quality (field reports): greetings must answer
 * instantly instead of a cold "rephrase" wall, supervisor-supplied argv
 * must never crash into a commander dump or execute non-read-only
 * commands, and the unclear fallback must orient instead of scold.
 */

function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...extraEnv },
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

describe('sanitizeSupervisorCliArgs (unit)', () => {
  it('strips the binary name models like to prepend', () => {
    expect(sanitizeSupervisorCliArgs(['ideaseek', 'status'])).toEqual(['status']);
    expect(sanitizeSupervisorCliArgs(['ideaseek.exe', 'next'])).toEqual(['next']);
    expect(sanitizeSupervisorCliArgs(['node', 'papers'])).toEqual(['papers']);
  });

  it('normalizes help spellings to the flag', () => {
    expect(sanitizeSupervisorCliArgs(['help'])).toEqual(['--help']);
    expect(sanitizeSupervisorCliArgs(['ideaseek', 'help'])).toEqual(['--help']);
    expect(sanitizeSupervisorCliArgs(['-h'])).toEqual(['--help']);
  });

  it('keeps read-only queries verbatim', () => {
    expect(sanitizeSupervisorCliArgs(['status', '--json'])).toEqual(['status', '--json']);
    expect(sanitizeSupervisorCliArgs(['idea', 'list'])).toEqual(['idea', 'list']);
    expect(sanitizeSupervisorCliArgs(['comparison', 'list'])).toEqual(['comparison', 'list']);
  });

  it('refuses anything that is not on the read-only surface', () => {
    expect(sanitizeSupervisorCliArgs(['run', '--question', 'injected'])).toBeNull();
    expect(sanitizeSupervisorCliArgs(['cleanup', '--yes'])).toBeNull();
    expect(sanitizeSupervisorCliArgs(['mode', 'agent'])).toBeNull();
    expect(sanitizeSupervisorCliArgs(['cancel'])).toBeNull();
    expect(sanitizeSupervisorCliArgs(['ideaseek'])).toBeNull();
    expect(sanitizeSupervisorCliArgs([])).toBeNull();
  });
});

describe('extractAgentSessionId (unit)', () => {
  it('parses the agent CLI summary line', () => {
    expect(
      extractAgentSessionId(
        'agent turn → session ses_abc123 (new, finish=stop, 2 event(s))\n  hello\n',
      ),
    ).toBe('ses_abc123');
    expect(extractAgentSessionId('no session here')).toBeNull();
  });
});

describe('ask free-text quality (CLI)', () => {
  it('greets instantly with orientation — no model, no "rephrase" wall', async () => {
    const dir = await makeProjectDir();
    const hi = await runCli(dir, ['ask', 'hi']);
    expect(hi.code, hi.stderr).toBe(0);
    expect(hi.stdout).toContain('IdeaSeek supervisor ready');
    expect(hi.stdout).toContain('/status');
    expect(hi.stdout).not.toContain('rephrase');
    expect(hi.stdout).not.toContain('recorded pending-approval');
  }, 60_000);

  it('answers capability questions the same way', async () => {
    const dir = await makeProjectDir();
    const cap = await runCli(dir, ['ask', 'hello, what can you do?']);
    expect(cap.code, cap.stderr).toBe(0);
    expect(cap.stdout).toContain('IdeaSeek supervisor ready');
    expect(cap.stdout).not.toContain('too many arguments');
  }, 60_000);

  it('relays supervisor queries only after sanitizing the argv', async () => {
    const dir = await makeProjectDir();
    const override = JSON.stringify({ kind: 'query', cliArgs: ['ideaseek', 'status'], answer: '' });
    const relayed = await runCli(dir, ['ask', 'qqq zzz', '--harness', 'fake'], {
      IDEASEEK_FAKE_SUPERVISOR_OUTPUT: override,
    });
    // Without stripping, ["ideaseek","status"] crashed into a raw
    // commander dump ("too many arguments… ideaseek, help").
    expect(relayed.stdout + relayed.stderr).not.toContain('too many arguments');
    expect(relayed.stdout).toContain('项目');
  }, 60_000);

  it('never executes non-read-only supervisor suggestions', async () => {
    const dir = await makeProjectDir();
    await runCli(dir, ['run', '--question', 'guard', '--enqueue-only']);
    const override = JSON.stringify({
      kind: 'query',
      cliArgs: ['run', '--question', 'injected'],
      answer: '',
    });
    const refused = await runCli(dir, ['ask', 'qqq zzz', '--harness', 'fake'], {
      IDEASEEK_FAKE_SUPERVISOR_OUTPUT: override,
    });
    expect(refused.stdout).toContain('not read-only, not executed');
    expect(refused.stdout).toContain('nothing was changed');
    expect(refused.stdout).not.toContain('run created');
  }, 60_000);

  it('redacts a pasted API key before the supervisor call and the audit summary', async () => {
    const dir = await makeProjectDir();
    await runCli(dir, ['run', '--question', 'guard', '--enqueue-only']);
    // An empty summary forces the fallback that used to reuse the raw input.
    const override = JSON.stringify({ kind: 'pending-action', summary: '', reason: 'budget' });
    const result = await runCli(
      dir,
      ['ask', 'raise the cap, my key is sk-ABCDEFGHIJKLMNOPQRSTUV', '--harness', 'fake'],
      { IDEASEEK_FAKE_SUPERVISOR_OUTPUT: override },
    );
    const all = result.stdout + result.stderr;
    expect(all).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUV');
    expect(all).toContain('sk-***');
  }, 60_000);

  it('unclear input gets an orienting fallback, not "rephrase"', async () => {
    const dir = await makeProjectDir();
    const override = JSON.stringify({ kind: 'unclear', answer: '', summary: 'x' });
    const unclear = await runCli(dir, ['ask', 'qqq zzz', '--harness', 'fake'], {
      IDEASEEK_FAKE_SUPERVISOR_OUTPUT: override,
    });
    expect(unclear.code).toBe(0);
    // The classifier announces itself before the model round trip — the
    // silent-spinner dead air was a field complaint.
    expect(unclear.stdout).toContain('supervisor (fake): classifying…');
    expect(unclear.stdout).toContain('not sure how to help');
    expect(unclear.stdout).not.toContain('rephrase');
  }, 60_000);
});
