import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import {
  resolveApproval,
  redactAgentText,
  recordAgentSession,
  readAgentSessions,
  agentSessionsPath,
  toolIsAllowListed,
  executionTurnIsUnapprovable,
  refusalWhenExecutionCannotBeApproved,
  WarmAgentHost,
} from '../src/dsh/session.js';
import { composeTurnPrompt } from '../src/commands/agent.js';

/**
 * Agent mode → real DSH coding session (rule: no fixed greetings, no
 * ask-supervisor stand-in). Approval policy and redaction are unit
 * tested; the CLI refuses missing prompts, lists sessions, and — without
 * credentials — must FAIL HONESTLY instead of fabricating a reply.
 * A real model turn is opt-in via IDEASEEK_REAL_DSH_E2E (never spends
 * credentials implicitly).
 */

function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string | null> = {},
  timeoutMs = 90_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    env.IDEASEEK_CLI = '1';
    // extraEnv both scrubs (null) and ADDS keys — a caller-provided
    // IDEASEEK_FAKE_AGENT_TURN must reach the child, or a test written to be
    // offline silently spends real credentials instead.
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd, env });
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
    child.stdin.end();
  });
}

describe('approval policy (never auto-approve)', () => {
  const detail = { toolName: 'shell.exec', reason: 'run tests', sessionId: 's1' };

  it('deny policy rejects without asking', async () => {
    const decision = await resolveApproval('deny', true, async () => true, detail);
    expect(decision.outcome).toBe('rejected');
    expect(decision.reason).toContain('--deny-tools');
  });

  it('interactive without a TTY rejects (safe default, never approval)', async () => {
    const decision = await resolveApproval('interactive', false, async () => true, detail);
    expect(decision.outcome).toBe('rejected');
    expect(decision.reason).toContain('TTY');
  });

  it('interactive with a TTY maps y/n to one-shot grant/reject', async () => {
    const yes = await resolveApproval('interactive', true, async () => true, detail);
    expect(yes.outcome).toBe('allowed-once');
    const no = await resolveApproval('interactive', true, async () => false, detail);
    expect(no.outcome).toBe('rejected');
    expect(no.reason).toContain('rejected');
  });

  it('pre-grants only what a human enumerated, and says which grant allowed it', async () => {
    // A non-interactive session is the case that used to be hopeless: an agent
    // writing research code cannot run any of it without a shell, so the whole
    // turn spent itself discovering that. The remedy is an explicit grant, not
    // an implicit approval.
    const granted = await resolveApproval('interactive', false, null, detail, ['shell.exec']);
    expect(granted.outcome).toBe('allowed-once');
    expect(granted.reason).toContain('allowlist');
    expect(granted.reason).toContain('--allow-tools');

    const other = await resolveApproval('interactive', false, null, detail, ['something-else']);
    expect(other.outcome).toBe('rejected');
  });

  it('denies even a listed tool when the operator said no tools at all', async () => {
    // Precedence is the security property: --deny-tools outranks an allowlist,
    // or a stray flag would reopen exactly what the operator closed.
    const decision = await resolveApproval('deny', false, null, detail, ['shell.exec', 'pwsh']);
    expect(decision.outcome).toBe('rejected');
    expect(decision.reason).toContain('--deny-tools');
  });

  it('names shell as a capability without asking the operator to know the OS spelling', () => {
    // DSH reports `pwsh` on Windows and `bash` on POSIX; granting "shell"
    // covers the runtime's shell for this confined workspace and nothing else.
    expect(toolIsAllowListed('pwsh', ['shell'])).toBe(true);
    expect(toolIsAllowListed('BASH', ['shell'])).toBe(true);
    expect(toolIsAllowListed('file_write', ['shell'])).toBe(false);
    expect(toolIsAllowListed('pwsh', [])).toBe(false);
    expect(toolIsAllowListed('project_read', ['project_read'])).toBe(true);
  });

  it('points a refused tool at the way to grant it', async () => {
    const decision = await resolveApproval('interactive', false, null, {
      ...detail,
      toolName: 'pwsh',
    });
    expect(decision.outcome).toBe('rejected');
    expect(decision.reason).toContain('--allow-tools shell');
  });
});

describe('execution-requiring turns refuse before they are paid for', () => {
  it('refuses a turn that must run commands with nobody to approve them', () => {
    // The product path that used to burn four agent rounds: `idea implement`
    // passed policy 'interactive' on the strength of a TTY, attached no prompt
    // function, every tool call was refused in silence, and the turn ended with
    // the agent itself reporting that no shell could execute. The decision is
    // four inputs, so it is asserted as a decision — spawning DSH to discover
    // the answer costs half a minute and fails outright without a key.
    expect(
      executionTurnIsUnapprovable({
        needsExecution: true,
        policy: 'interactive',
        allowTools: [],
        canAsk: false,
      }),
    ).toBe(true);
  });

  it('does not refuse when a human can answer, the shell is granted, or no shell is needed', () => {
    const base = {
      needsExecution: true as const,
      policy: 'interactive' as const,
      allowTools: [],
      canAsk: false,
    };
    // A channel with somebody holding it is exactly what an interactive TUI run has.
    expect(executionTurnIsUnapprovable({ ...base, canAsk: true })).toBe(false);
    // An operator's pre-grant is the other legitimate way, and needs no person.
    expect(executionTurnIsUnapprovable({ ...base, allowTools: ['shell'] })).toBe(false);
    // A denied turn is the sharpest case, not an exception: real evidence was
    // `idea implement` with stdin redirected (so policy 'deny'), which the gate
    // let through and four agent rounds later still read "approval rejected:
    // pwsh (denied by --deny-tools policy)". A task that must execute commands
    // and a policy that forbids tools cannot ever pass, so it is refused here.
    expect(executionTurnIsUnapprovable({ ...base, policy: 'deny' })).toBe(true);
    // Deny is also refused when a grant exists, because the flag is the later,
    // more specific instruction — the operator said no tools for THIS turn.
    expect(
      executionTurnIsUnapprovable({ ...base, policy: 'deny', allowTools: ['shell'], canAsk: true }),
    ).toBe(true);
    // And a reasoning-only turn (the --no-tools fallback, alignment, verdicts)
    // must never be blocked by a rule about executing commands.
    expect(executionTurnIsUnapprovable({ ...base, needsExecution: undefined })).toBe(false);
  });

  it('names both remedies in the refusal a researcher actually reads', async () => {
    const text = refusalWhenExecutionCannotBeApproved([]);
    expect(text).toContain('--allow-tools shell');
    expect(text).toContain('policy.agent_allow_tools');
    // The cheaper correct alternative, which needs no model session at all.
    expect(text).toContain('idea check');
    expect(refusalWhenExecutionCannotBeApproved(['read_file'])).toContain(
      'currently granted: read_file',
    );
  });

  it('refuses through the real call path before any runtime is spawned', async () => {
    // The predicate alone would not prove the turn is guarded by it: this calls
    // runAgentTurn and asserts it throws in milliseconds, having never started
    // a session (no DSH boot, no token spend, no half-written idea workspace).
    if (process.stdin.isTTY === true && process.env.IDEASEEK_AGENT_APPROVAL !== 'stdio') {
      // A runner that attached a real terminal with a prompter would legitimately
      // be able to ask; this environment is not that, and the test says so.
      return;
    }
    const startedAt = Date.now();
    const { runAgentTurn } = await import('../src/dsh/session.js');
    const { IdeaseekError } = await import('../src/core/errors.js');
    let caught: unknown = null;
    try {
      await runAgentTurn({
        cwd: process.cwd(),
        prompt: 'implement the idea and run it',
        policy: 'interactive',
        needsExecution: true,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IdeaseekError);
    const refusal = caught as { code?: string; message: string };
    expect(refusal.code).toBe('USER_INPUT_REQUIRED');
    expect(refusal.message).toContain('--allow-tools shell');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe('configure-then-use without restarting', () => {
  it('runTurn re-reads the credentials file a child /models setup just wrote', async () => {
    // The TUI captures the key via a child process (models setup
    // --api-key-stdin), so this process's env stays keyless until something
    // re-reads the file. WarmAgentHost.runTurn must reload BEFORE the
    // approval gate and the harness spawn — otherwise the harness child is
    // born keyless and only an app restart ever sees the saved key.
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-jit-'));
    const configPath = join(dir, 'config.yaml');
    await writeFile(join(dir, 'credentials.env'), 'IDEASEEK_JIT_PROBE=sk-jit-probe\n', 'utf8');
    const savedUserConfig = process.env.IDEASEEK_USER_CONFIG;
    const savedProbe = process.env.IDEASEEK_JIT_PROBE;
    delete process.env.IDEASEEK_JIT_PROBE;
    process.env.IDEASEEK_USER_CONFIG = configPath;
    try {
      const host = new WarmAgentHost();
      const startedAt = Date.now();
      // Deny + must-execute is refused by the pure gate, so nothing spawns:
      // the assertion below isolates the reload itself.
      await expect(
        host.runTurn({
          cwd: dir,
          prompt: 'hello',
          needsExecution: true,
          policy: 'deny',
          allowTools: [],
        }),
      ).rejects.toMatchObject({ code: 'USER_INPUT_REQUIRED' });
      expect(process.env.IDEASEEK_JIT_PROBE).toBe('sk-jit-probe');
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      if (savedUserConfig === undefined) delete process.env.IDEASEEK_USER_CONFIG;
      else process.env.IDEASEEK_USER_CONFIG = savedUserConfig;
      if (savedProbe === undefined) delete process.env.IDEASEEK_JIT_PROBE;
      else process.env.IDEASEEK_JIT_PROBE = savedProbe;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('redaction', () => {
  it('scrubs bearer tokens and key shapes from diagnostics', () => {
    const dirty = 'auth failed for Bearer sk-abc123456789 and https://x?k=sk-xyz987654321';
    const clean = redactAgentText(dirty);
    expect(clean).not.toContain('sk-abc123456789');
    expect(clean).not.toContain('sk-xyz987654321');
    expect(clean).toContain('[redacted]');
  });
});

describe('session registry', () => {
  it('persists turn history, dedups and sorts newest first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-agent-'));
    await recordAgentSession(dir, { sessionId: 's-old', prompt: 'first prompt', cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordAgentSession(dir, { sessionId: 's-new', prompt: 'second prompt', cwd: dir });
    await recordAgentSession(dir, {
      sessionId: 's-old',
      prompt: 'first prompt updated',
      cwd: dir,
      finishReason: 'stop',
    });

    const registry = JSON.parse(await readFile(agentSessionsPath(dir), 'utf8')) as {
      contract: string;
      sessions: {
        sessionId: string;
        promptHead: string;
        title: string;
        turns: number;
        cwd: string;
        scope: string;
        lastFinish: string | null;
      }[];
    };
    expect(registry.contract).toBe('agent-sessions-v2');
    expect(registry.sessions.map((s) => s.sessionId)).toEqual(['s-old', 's-new']);
    expect(registry.sessions[0]!.promptHead).toBe('first prompt updated');
    // The list name stays the FIRST prompt (recognizable tomorrow), the head
    // tracks the latest one — and the turn count is the "what did it do here"
    // signal a plain id list never gave.
    expect(registry.sessions[0]!.title).toBe('first prompt');
    expect(registry.sessions[0]!.turns).toBe(2);
    expect(registry.sessions[1]!.turns).toBe(1);
    expect(registry.sessions[0]!.cwd).toBe(dir);
    expect(registry.sessions[0]!.scope).toBe('project');
    expect(registry.sessions[0]!.lastFinish).toBe('stop');
    // No key-shaped material ever lands in the registry.
    expect(JSON.stringify(registry)).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
  });

  it('reads a v1 registry, keeps its order and caps the list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-agent-v1-'));
    await mkdir(join(dir, 'knowledge'), { recursive: true });
    const legacy = {
      contract: 'agent-sessions-v1',
      sessions: Array.from({ length: 51 }, (_, index) => ({
        sessionId: `legacy-${index}`,
        updatedAt: 1_700_000_000_000 - index,
        promptHead: `old prompt ${index}`,
      })),
    };
    await writeFile(agentSessionsPath(dir), JSON.stringify(legacy, null, 2), 'utf8');

    const before = await readAgentSessions(dir);
    expect(before.contract).toBe('agent-sessions-v2');
    // v1 records had no cwd/scope: they inherit the file location (project) and
    // get their single prompt as title, with turns=1 rather than a guess.
    expect(before.sessions[0]).toMatchObject({
      sessionId: 'legacy-0',
      title: 'old prompt 0',
      cwd: '',
      scope: 'project',
      turns: 1,
      lastFinish: null,
    });

    await recordAgentSession(dir, { sessionId: 'fresh', prompt: 'newest', cwd: dir });
    const after = await readAgentSessions(dir);
    expect(after.sessions.length).toBe(50);
    expect(after.sessions[0]!.sessionId).toBe('fresh');
    expect(after.sessions.some((s) => s.sessionId === 'legacy-50')).toBe(false);

    // Outside a project the same file shape reads as general scope.
    const stateDir = await mkdtemp(join(tmpdir(), 'ideaseek-agent-user-'));
    await writeFile(
      join(stateDir, 'agent-sessions.json'),
      JSON.stringify({
        contract: 'agent-sessions-v1',
        sessions: [{ sessionId: 'g-1', updatedAt: 1, promptHead: 'fix the bug' }],
      }),
      'utf8',
    );
    process.env.IDEASEEK_USER_CONFIG = join(stateDir, 'config.yaml');
    try {
      const general = await readAgentSessions(null);
      expect(general.sessions[0]).toMatchObject({ sessionId: 'g-1', scope: 'general' });
    } finally {
      delete process.env.IDEASEEK_USER_CONFIG;
    }
  });
});

describe('ideaseek agent CLI', () => {
  it('lists sessions, refuses an empty prompt, and never fabricates replies', async () => {
    const dir = await makeProjectDir();

    const empty = await runCli(dir, ['agent', '--list']);
    expect(empty.code, empty.stdout + empty.stderr).toBe(0);
    expect(empty.stdout).toContain('no agent sessions yet');

    const noPrompt = await runCli(dir, ['agent']);
    expect(noPrompt.code).not.toBe(0);
    expect(noPrompt.stderr).toContain('prompt');

    // Real DSH turn WITHOUT credentials and with an unknown provider:
    // the command must fail honestly — no canned greeting, no fake text.
    const failed = await runCli(
      dir,
      ['agent', 'say hello', '--deny-tools', '--provider', 'ideaseek-no-such-route', '--json'],
      { DEEPSEEK_API_KEY: null, IDEASEEK_REAL_DSH_E2E: null },
      120_000,
    );
    expect(failed.code, failed.stdout + failed.stderr).not.toBe(0);
    expect(failed.stdout + failed.stderr).not.toContain('Hello!');
    expect(failed.stdout + failed.stderr).not.toMatch(/fake (reply|greeting|response)/i);
    // Failure is actionable (boot/model recovery), never silent.
    expect(failed.stdout + failed.stderr).toMatch(
      /DSH session failed|agent turn failed|models setup|doctor/,
    );
  }, 180_000);

  it.skipIf(!process.env.IDEASEEK_REAL_DSH_E2E)(
    'real DSH turn (opt-in IDEASEEK_REAL_DSH_E2E): mints a session and records it',
    async () => {
      const dir = await makeProjectDir();
      const turn = await runCli(
        dir,
        ['agent', 'Reply with exactly: pong', '--deny-tools', '--json'],
        {},
        300_000,
      );
      expect(turn.code, turn.stdout + turn.stderr).toBe(0);
      const payload = JSON.parse(turn.stdout) as {
        sessionId: string;
        finishReason: string | null;
        response: string;
      };
      expect(payload.sessionId).toMatch(/\S/);
      expect(payload.response.length).toBeGreaterThan(0);
      const registry = JSON.parse(
        await readFile(join(dir, 'knowledge', 'agent-sessions.json'), 'utf8'),
      ) as { sessions: { sessionId: string }[] };
      expect(registry.sessions[0]!.sessionId).toBe(payload.sessionId);

      // Resume continues the SAME session id.
      const resumed = await runCli(
        dir,
        [
          'agent',
          'Reply with exactly: pong2',
          '--resume',
          payload.sessionId,
          '--deny-tools',
          '--json',
        ],
        {},
        300_000,
      );
      expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
      const resumePayload = JSON.parse(resumed.stdout) as { sessionId: string; resumed: boolean };
      expect(resumePayload.resumed).toBe(true);
      expect(resumePayload.sessionId).toBe(payload.sessionId);
    },
    600_000,
  );
});

describe('first-turn project brief', () => {
  it('prepends persisted project state only to a new session', async () => {
    const dir = await makeProjectDir();

    // No run yet: the brief says so instead of inventing a research question.
    const bare = await composeTurnPrompt(dir, '修一下预处理', true);
    expect(bare).toContain('[IdeaSeek 项目上下文');
    expect(bare).toContain('尚未开始 run');
    expect(bare).toContain('papers/、datasets/、comparisons/upstream/');
    expect(bare.trimEnd().endsWith('修一下预处理')).toBe(true);

    expect((await runCli(dir, ['run', '--question', 'domain shift', '--enqueue-only'])).code).toBe(
      0,
    );
    const brief = await composeTurnPrompt(dir, '修一下预处理', true);
    expect(brief).toContain('question: domain shift');
    expect(brief).toContain('--- 用户指令 ---');
    // The user's own instruction stays the last thing the model reads.
    expect(brief.split('--- 用户指令 ---')[1]?.trim()).toBe('修一下预处理');

    // A resumed session already holds this context; its prompt is untouched.
    expect(await composeTurnPrompt(dir, '继续', false)).toBe('继续');

    // With sessionId tracking, unchanged state returns prompt verbatim; a tier
    // switch injects a compact state delta on the next resumed turn.
    const firstTracked = await composeTurnPrompt(dir, '第一步', true, { sessionId: 'ses-track-1' });
    expect(firstTracked).toContain('research tier: research');
    expect(await composeTurnPrompt(dir, '第二步', false, { sessionId: 'ses-track-1' })).toBe(
      '第二步',
    );
    const { writeSessionMode } = await import('../src/session/mode.js');
    await writeSessionMode(dir, 'analysis');
    const afterSwitch = await composeTurnPrompt(dir, '第三步', false, {
      sessionId: 'ses-track-1',
    });
    expect(afterSwitch).toContain('[IdeaSeek 状态同步]');
    expect(afterSwitch).toContain('tier=analysis');
    expect(afterSwitch.trimEnd().endsWith('第三步')).toBe(true);
    // Next turn with unchanged state stays clean again.
    expect(await composeTurnPrompt(dir, '第四步', false, { sessionId: 'ses-track-1' })).toBe(
      '第四步',
    );
  }, 180_000);

  it('audits coding turns to project-agent-audit.jsonl when no active run exists', async () => {
    const dir = await makeProjectDir();
    const { auditProjectAgentTurn, readRecentProjectAgentAudits } =
      await import('../src/dsh/turn-runner.js');
    const seq = await auditProjectAgentTurn(dir, {
      sessionId: 'ses-no-run',
      resumed: false,
      eventCount: 2,
      approvalsCount: 1,
      prompt: 'fix data loader',
      finishReason: 'completed',
    });
    expect(seq).toBeNull();
    const entries = await readRecentProjectAgentAudits(dir);
    expect(entries).toHaveLength(1);
    expect(String(entries[0]!.summary)).toContain('fix data loader');
  }, 60_000);
});

describe('general scope: agent outside an IdeaSeek project', () => {
  it('runs with no project, keeps resume state user-level and invents no research artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-general-'));
    const env = {
      IDEASEEK_FAKE_AGENT_TURN: '1',
      IDEASEEK_USER_CONFIG: join(dir, '.state', 'config.yaml'),
      // Scrubbed so a broken fake hook fails the test instead of spending
      // whatever key this machine happens to have configured.
      DEEPSEEK_API_KEY: null,
    };

    const turn = await runCli(dir, ['agent', '排查这个空指针', '--json'], env);
    expect(turn.code, turn.stdout + turn.stderr).toBe(0);
    const payload = JSON.parse(turn.stdout) as {
      scope: string;
      sessionId: string;
      inputDrift: unknown;
      eventSeq: unknown;
    };
    expect(payload.scope).toBe('general');
    // No baseline, no run: nothing to report drift against and nothing to audit.
    expect(payload.inputDrift).toBeNull();
    expect(payload.eventSeq).toBeNull();

    const human = await runCli(dir, ['agent', '排查这个空指针'], env);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('不记 RunEvent');

    // Session continuity lives in the user-level state dir, not a project store.
    const registry = JSON.parse(
      await readFile(join(dir, '.state', 'agent-sessions.json'), 'utf8'),
    ) as { sessions: { sessionId: string }[] };
    expect(registry.sessions.some((s) => s.sessionId === payload.sessionId)).toBe(true);

    // And the plain repo gained no IdeaSeek state (no knowledge/, no .research/).
    await expect(readFile(join(dir, 'knowledge', 'agent-sessions.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(dir, '.research', 'session.json'), 'utf8')).rejects.toThrow();

    const again = await runCli(
      dir,
      ['agent', '继续', '--resume', payload.sessionId, '--json'],
      env,
    );
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ resumed: true, scope: 'general' });

    const listed = await runCli(dir, ['agent', '--list'], env);
    expect(listed.stdout).toContain('agent-sessions.json');
    expect(listed.stdout).toContain(payload.sessionId);
  }, 240_000);
});
