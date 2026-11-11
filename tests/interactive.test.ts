import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BLOCK_BANNER, PLAIN_MARK, renderBanner } from '../src/cli/banner.js';
import { formatEventLine, paint } from '../src/cli/format.js';
import { resolveSlash, slashCompleter, SLASH_COMMANDS } from '../src/cli/repl.js';
import type { RunEvent } from '../src/workflow/types.js';
import { CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
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

interface Repl {
  child: ChildProcessWithoutNullStreams;
  output(): string;
  write(line: string): void;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  quit(): Promise<{ code: number; stdout: string; stderr: string }>;
}

function startRepl(cwd: string, extraArgs: string[] = []): Repl {
  const child = spawn(process.execPath, [CLI_BIN, 'interactive', ...extraArgs], {
    cwd,
    env: { ...process.env, IDEASEEK_CLI: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));

  const output = () => stdout + stderr;
  // Writing to a child that already exited must not crash the test.
  child.stdin.on('error', () => {});

  const waitFor = (pattern: RegExp, timeoutMs = 20_000): Promise<string> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (pattern.test(output())) {
          clearInterval(timer);
          resolve(output());
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timeout waiting for ${pattern}; output so far:\n${output()}`));
        }
      }, 100);
    });

  const quit = (): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`repl did not exit; output:\n${output()}`));
      }, 20_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.stdin.write('/quit\n');
      // Backup: EOF also closes the REPL if /quit was consumed already.
      setTimeout(() => child.stdin.end(), 2_000);
    });

  return {
    child,
    output,
    write: (line) => child.stdin.write(line),
    waitFor,
    quit,
  };
}

function fakeEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    seq: 1,
    runId: 'run-1',
    ts: Date.now(),
    phase: 'PAPER_ANALYSIS',
    objectId: 'paper-018',
    role: 'PaperExtractor',
    eventType: 'task_succeeded',
    summary: 'paper extracted 18/42',
    status: 'completed',
    artifactRefs: [],
    ...overrides,
  };
}

describe('slash registry (unit)', () => {
  it('completes by prefix and ignores non-slash input', () => {
    expect(slashCompleter('/sta')).toEqual([['/status'], '/sta']);
    expect(slashCompleter('/')).toEqual([SLASH_COMMANDS.map((cmd) => cmd.name), '/']);
    expect(slashCompleter('status')).toEqual([[], 'status']);
    expect(slashCompleter('/zzz')).toEqual([[], '/zzz']);
  });

  it('resolves exact, unique-prefix, ambiguous and unknown inputs', () => {
    expect(resolveSlash('/status')).toEqual({ kind: 'exact', name: '/status' });
    expect(resolveSlash('/sta')).toEqual({ kind: 'prefix', name: '/status' });
    expect(resolveSlash('/log')).toEqual({ kind: 'prefix', name: '/logs' });
    const ambiguous = resolveSlash('/r');
    expect(ambiguous.kind).toBe('ambiguous');
    expect(resolveSlash('/nope')).toEqual({ kind: 'unknown' });
  });

  it('covers the Phase 1.5 command set', () => {
    const names = SLASH_COMMANDS.map((cmd) => cmd.name);
    for (const required of [
      '/help',
      '/status',
      '/next',
      '/papers',
      '/comparisons',
      '/ideas',
      '/experiments',
      '/logs',
      '/approve',
      '/reject',
      '/pause',
      '/resume',
      '/continue',
      '/report',
      '/quit',
    ]) {
      expect(names, `missing ${required}`).toContain(required);
    }
  });
});

describe('banner and event formatting (unit)', () => {
  it('falls back to the short mark when plain or narrow', () => {
    expect(renderBanner({ plain: true })).toBe(PLAIN_MARK);
    expect(renderBanner({ columns: 40 })).toBe(PLAIN_MARK);
    expect(BLOCK_BANNER).toContain('██╗    ██████╗');
    const previousTerm = process.env.TERM;
    delete process.env.TERM;
    try {
      expect(renderBanner({ columns: 200 })).toContain('IdeaSeek · Research from evidence');
    } finally {
      if (previousTerm === undefined) delete process.env.TERM;
      else process.env.TERM = previousTerm;
    }
    expect(BLOCK_BANNER.split('\n')).toHaveLength(6);
  });

  it('paints nothing in plain mode or non-TTY output', () => {
    const painted = paint('x', 'success', { plain: true });
    expect(painted).toBe('x');
    // Tests run with piped stdout (not a TTY), so colors are off by default.
    expect(paint('x', 'error')).toBe('x');
  });

  it('formats event lines with phase/role/object/status and redacts secrets', () => {
    const line = formatEventLine(fakeEvent(), { plain: true });
    expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\]/);
    expect(line).toContain('PAPER_ANALYSIS');
    expect(line).toContain('PaperExtractor');
    expect(line).toContain('object=paper-018');
    expect(line).toContain('completed');
    expect(line).toContain('paper extracted 18/42');

    const leaky = formatEventLine(
      fakeEvent({ summary: 'call failed api_key=sk-secret123456789 token=abc123' }),
      { plain: true },
    );
    expect(leaky).not.toContain('sk-secret123456789');
    expect(leaky).not.toContain('abc123');
    expect(leaky).toContain('***');
  });
});

describe('ideaseek interactive (CLI)', () => {
  it('/help lists commands; unknown input and unknown slash commands give hints', async () => {
    const dir = await makeProjectDir();
    const repl = startRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/help\n');
    await repl.waitFor(/Ideaseek commands/);
    repl.write('/bogus\n');
    await repl.waitFor(/unknown command: \/bogus/);
    // Plain text routes to the supervisor (fake harness in tests) — the
    // REPL must never print "unknown input".
    const enqueued = await runCli(dir, ['run', '--question', 'nl route', '--enqueue-only']);
    expect(enqueued.code).toBe(0);
    repl.write('plain text input\n');
    await repl.waitFor(/recorded pending-approval decision/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown input');
    expect(done.stdout).toContain('/status');
    expect(done.stdout).toContain('/quit');
    expect(done.stdout).toContain('try /help');
  }, 60_000);

  it('unique prefix resolves (Tab completer contract)', async () => {
    const dir = await makeProjectDir();
    const repl = startRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/pau\n'); // unique prefix → /pause
    await repl.waitFor(/no run exists/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown command: /pau');
    expect(done.stdout).not.toContain('ambiguous prefix: /pau');
  }, 60_000);

  it('/status and /next relay the real commands', async () => {
    const dir = await makeProjectDir();
    const repl = startRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/status\n');
    await repl.waitFor(/Run：尚无|Run:/);
    repl.write('/next\n');
    await repl.waitFor(/当前阶段/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('ideaseek run');
    expect(done.stdout).toContain('建议');
  }, 60_000);

  it('/pause and /resume give interactive feedback on a live run', async () => {
    const dir = await makeProjectDir();
    const enqueued = await runCli(dir, ['run', '--question', 'repl pause', '--enqueue-only']);
    expect(enqueued.code).toBe(0);

    const repl = startRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/pause\n');
    await repl.waitFor(/is now PAUSED/);
    repl.write('/resume\n');
    await repl.waitFor(/is now RUNNING/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    // Quit never cancels the run.
    const status = await runCli(dir, ['status', '--json']);
    const payload = JSON.parse(status.stdout) as { run: { status: string } };
    expect(payload.run.status).toBe('RUNNING');
  }, 60_000);

  it('approval gate: /approve reports nothing pending; /reject records a decision event', async () => {
    const dir = await makeProjectDir();
    const enqueued = await runCli(dir, ['run', '--question', 'approval test', '--enqueue-only']);
    expect(enqueued.code).toBe(0);

    const repl = startRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/approve\n');
    await repl.waitFor(/no protocol proposal/);
    repl.write('/reject dataset unit unclear\n');
    await repl.waitFor(/recorded rejection/);
    const done = await repl.quit();
    expect(done.code).toBe(0);

    const events = await runCli(dir, ['events', '--json']);
    const payload = JSON.parse(events.stdout) as {
      events: { eventType: string; summary: string }[];
    };
    const decision = payload.events.find((event) => event.eventType === 'decision');
    expect(decision?.summary).toBe('rejected: dataset unit unclear');
  }, 60_000);

  it('/logs shows task detail with redacted output', async () => {
    const dir = await makeProjectDir();
    const enqueued = await runCli(dir, ['run', '--question', 'logs test', '--enqueue-only']);
    expect(enqueued.code).toBe(0);
    const events = await runCli(dir, ['events', '--json']);
    const payload = JSON.parse(events.stdout) as {
      events: { eventType: string; objectId: string | null }[];
    };
    const taskId = payload.events.find(
      (event) => event.eventType === 'task_enqueued' && event.objectId,
    )!.objectId!;
    expect(taskId).toBeTruthy();

    const repl = startRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write(`/logs ${taskId}\n`);
    await repl.waitFor(new RegExp(`${taskId}.*demo\\.(ingest|analyze)`));
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('queued');

    // Direct CLI form works too (slash is a relay, not a second implementation).
    const direct = await runCli(dir, ['logs', taskId, '--json']);
    expect(direct.code).toBe(0);
    expect(JSON.parse(direct.stdout)).toHaveProperty('status');
  }, 60_000);

  it('--plain uses the short mark and emits no ANSI colors', async () => {
    const dir = await makeProjectDir();
    const repl = startRepl(dir, ['--plain']);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/help\n');
    await repl.waitFor(/Ideaseek commands/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).toContain(PLAIN_MARK);
    expect(done.stdout).not.toContain('██╗');
    // eslint-disable-next-line no-control-regex
    expect(done.stdout).not.toMatch(/\x1b\[/);
  }, 60_000);

  it('replays persisted events on attach and again after reconnect; secrets never render', async () => {
    const dir = await makeProjectDir();
    const enqueued = await runCli(dir, ['run', '--question', 'replay test', '--enqueue-only']);
    expect(enqueued.code).toBe(0);

    // Inject a secret-looking event summary (defense-in-depth check).
    const runtime = await openRuntime(dir);
    try {
      await runtime.db.appendEvent({
        runId: (await runtime.db.getLatestRun(runtime.project.id))!.runId,
        phase: 'PAPER_ANALYSIS',
        objectId: null,
        role: 'tester',
        eventType: 'note',
        summary: 'debug api_key=sk-envsecret1234567890',
        status: null,
      });
    } finally {
      await runtime.close();
    }

    // First session: attach replays from seq 0 (run created … injected note).
    const first = startRepl(dir);
    await first.waitFor(/run created/);
    await first.waitFor(/task demo\.ingest queued/);
    await first.waitFor(/api_key=\*\*\*/);
    expect(first.output()).not.toContain('sk-envsecret1234567890');
    const firstQuit = await first.quit();
    expect(firstQuit.code).toBe(0);

    // Reconnect: a fresh session replays the same history from the start.
    const second = startRepl(dir);
    await second.waitFor(/run created/);
    const secondQuit = await second.quit();
    expect(secondQuit.code).toBe(0);
    expect(secondQuit.stdout).toContain('run created');

    // The run survived both interactive sessions (quit never cancels).
    const status = await runCli(dir, ['status', '--json']);
    expect((JSON.parse(status.stdout) as { run: { status: string } }).run.status).toBe('RUNNING');
  }, 90_000);
});

describe('bare invocation modes', () => {
  it('non-TTY bare invocation prints a hint instead of hanging', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-bare-'));
    const result = await runCli(dir, []);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no command given');
    expect(result.stdout).toContain('ideaseek interactive');
  }, 30_000);

  it('--json snapshot emits machine-readable status and events without secrets', async () => {
    const dir = await makeProjectDir();
    const enqueued = await runCli(dir, ['run', '--question', 'json snapshot', '--enqueue-only']);
    expect(enqueued.code).toBe(0);

    const runtime = await openRuntime(dir);
    try {
      await runtime.db.appendEvent({
        runId: (await runtime.db.getLatestRun(runtime.project.id))!.runId,
        phase: 'PAPER_ANALYSIS',
        objectId: null,
        role: 'tester',
        eventType: 'note',
        summary: 'leak check token=sk-jsonsecret0987654321',
        status: null,
      });
    } finally {
      await runtime.close();
    }

    const snapshot = await runCli(dir, ['--json']);
    // Mirrors `status --json`: RUNNING runs exit 3 (still have work).
    expect([0, 3]).toContain(snapshot.code);
    const lines = snapshot.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toHaveProperty('project');
    expect(lines[1]).toHaveProperty('events');

    expect(snapshot.stdout).not.toContain('sk-jsonsecret0987654321');
    expect(snapshot.stdout).toContain('***');

    // Subcommand --json still parses as the subcommand's own flag.
    const status = await runCli(dir, ['status', '--json']);
    expect(JSON.parse(status.stdout)).toHaveProperty('run');
  }, 60_000);
});

describe('natural language in the REPL (Journey E)', () => {
  it('answers read-only queries from persisted state', async () => {
    const dir = await makeProjectDir();
    const repl = startRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('status\n');
    await repl.waitFor(/Run/);
    repl.write('为什么 idea-x 还没通过？\n');
    await repl.waitFor(/当前阶段|建议|下一条命令/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('项目');
  }, 60_000);

  it('turns high-impact requests into pending-approval Decisions without executing them', async () => {
    const dir = await makeProjectDir();
    // A run must exist to bind decisions to.
    const enqueued = await runCli(dir, ['run', '--question', 'nl decision', '--enqueue-only']);
    expect(enqueued.code).toBe(0);

    const repl = startRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('优先验证 idea-002，先别给 idea-001 分配 GPU\n');
    await repl.waitFor(/pending-approval decision/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('nothing was changed');

    const events = await runCli(dir, ['events', '--json']);
    const decision = (
      JSON.parse(events.stdout) as {
        events: { eventType: string; status: string; summary: string }[];
      }
    ).events.find((e) => e.eventType === 'decision');
    expect(decision).toBeTruthy();
    expect(decision!.status).toBe('pending-approval');
    expect(decision!.summary).toContain('优先验证 idea-002');
    // Nothing was executed: no idea workspace appeared.
    await expect(
      readFile(join(dir, 'ideas', 'idea-002', 'workspace.json'), 'utf8'),
    ).rejects.toThrow();
  }, 60_000);

  it('routes unclassifiable text to the supervisor — never "unknown input"', async () => {
    const dir = await makeProjectDir();
    const enqueued = await runCli(dir, ['run', '--question', 'nl route', '--enqueue-only']);
    expect(enqueued.code).toBe(0);
    const repl = startRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('xyzzy random gibberish\n');
    // Fake supervisor classifies it as a pending action → decision propose.
    await repl.waitFor(/recorded pending-approval decision/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown input');
    expect(done.stdout).toContain('nothing was changed');
  }, 60_000);
});
