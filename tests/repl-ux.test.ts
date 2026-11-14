import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  closeMenu,
  moveSelection,
  openMenu,
  renderMenu,
  resolveSlash,
  selectedCommand,
  truncateForWidth,
} from '../src/cli/slash-menu.js';
import { tokenizeArgs } from '../src/cli/tokens.js';
import { CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Interactive menu + supervisor routing (docs/TERMINAL_UX). The forced-TTY
 * child (IDEASEEK_FORCE_TTY=1) exercises the REAL readline keypress path
 * over piped escape sequences — an equivalent to a PTY for menu/completion
 * behavior without a native dependency.
 */

interface Repl {
  child: ChildProcessWithoutNullStreams;
  output(): string;
  write(data: string): void;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  quit(): Promise<{ code: number; stdout: string; stderr: string }>;
}

function startTtyRepl(
  cwd: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): Repl {
  const child = spawn(process.execPath, [CLI_BIN, 'interactive', ...extraArgs], {
    cwd,
    env: { ...process.env, IDEASEEK_CLI: '1', IDEASEEK_FORCE_TTY: '1', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  child.stdin.on('error', () => {});
  const output = () => stdout + stderr;

  const waitFor = (pattern: RegExp, timeoutMs = 20_000): Promise<string> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (pattern.test(output())) {
          clearInterval(timer);
          resolve(output());
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timeout waiting for ${pattern}; output:\n${output()}`));
        }
      }, 80);
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
      setTimeout(() => child.stdin.end(), 2_000);
    });

  return { child, output, write: (d) => child.stdin.write(d), waitFor, quit };
}

describe('slash menu state machine (unit)', () => {
  it('opens filtered by prefix and moves selection with wrap-around', () => {
    const all = openMenu('/');
    expect(all.open).toBe(true);
    expect(all.visible.length).toBeGreaterThan(10);

    const filtered = openMenu('/sta');
    expect(filtered.visible.map((c) => c.name)).toEqual(['/status']);

    const down = moveSelection(all, 1);
    expect(down.selected).toBe(1);
    expect(selectedCommand(down)!.name).toBe(down.visible[1]!.name);
    // wrap: up from 0 → last
    const wrapped = moveSelection(openMenu('/'), -1);
    expect(wrapped.selected).toBe(wrapped.visible.length - 1);
    // closed menu never moves
    expect(moveSelection(closeMenu(), 1).open).toBe(false);
  });

  it('renders command, description, selected marker and usage footer', () => {
    const state = openMenu('/');
    const rows = renderMenu(state, { columns: 120, keyHints: true });
    const helpRow = rows.find((row) => row.includes('/help'))!;
    expect(helpRow).toContain('show this help');
    // First command is selected by default.
    expect(helpRow.startsWith('> ')).toBe(true);
    expect(rows.join('\n')).toContain('usage: /help');
    expect(rows.join('\n')).toContain('↑/↓ select');

    // Argument hints: select /logs → usage shows <task-id>.
    const logsIndex = state.visible.findIndex((c) => c.name === '/logs');
    const logsState = { ...state, selected: logsIndex };
    const logsRows = renderMenu(logsState, { columns: 120 });
    expect(logsRows.join('\n')).toContain('usage: /logs <task-id>');
  });

  it('truncates rows for narrow terminals (resize-safe)', () => {
    expect(truncateForWidth('abcdefghij', 5)).toBe('abcd…');
    expect(truncateForWidth('abc', 10)).toBe('abc');
    expect(truncateForWidth('abc', 0)).toBe('abc');
    const narrow = renderMenu(openMenu('/'), { columns: 30 });
    for (const row of narrow) expect(row.length).toBeLessThanOrEqual(30);
  });

  it('keeps unique-prefix resolution (/sta → /status)', () => {
    expect(resolveSlash('/sta')).toEqual({ kind: 'prefix', name: '/status' });
    expect(resolveSlash('/logs')).toEqual({ kind: 'exact', name: '/logs' });
  });

  it('tokenizes quoted arguments the way a shell would', () => {
    expect(tokenizeArgs('--round new --question "ux test"')).toEqual([
      '--round',
      'new',
      '--question',
      'ux test',
    ]);
    expect(tokenizeArgs('plain words')).toEqual(['plain', 'words']);
    expect(tokenizeArgs('')).toEqual([]);
  });
});

describe('forced-TTY REPL (PTY-equivalent via escape sequences)', () => {
  it('typing / opens the menu immediately with commands and descriptions', async () => {
    const dir = await makeProjectDir();
    const repl = startTtyRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/');
    // Menu appears on keypress — no Enter/Tab needed.
    await repl.waitFor(/show this help/);
    await repl.waitFor(/task detail with redacted logs/);
    await repl.waitFor(/usage: \/help/);
    await repl.waitFor(/↑\/↓ select/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown input');
  }, 60_000);

  it('keeps the typed slash input visible while filtering the menu', async () => {
    const dir = await makeProjectDir();
    const repl = startTtyRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/model');
    // Typed characters are echoed as cursor-positioned writes on the prompt
    // line (`m` lands at column 13, right after `ideaseek › /`), and the
    // menu filters live to the typed prefix. The old contiguous-string
    // assertion only ever matched when a stream error happened to redraw
    // the input line — it must not depend on that noise returning.
    await repl.waitFor(/\[13Gm/);
    await repl.waitFor(/> \/models/);
    await repl.waitFor(/usage: \/models/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
  }, 60_000);

  it('arrow keys select a command and Enter runs it', async () => {
    const dir = await makeProjectDir();
    const repl = startTtyRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/');
    await repl.waitFor(/show this help/);
    // Down twice: /help → /init → /status, then Enter executes it.
    repl.write('\x1b[B');
    await repl.waitFor(/> \/init/);
    repl.write('\x1b[B');
    await repl.waitFor(/> \/status/);
    repl.write('\r');
    await repl.waitFor(/Run/); // status output (Run：尚无 or run id)
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown command');
  }, 60_000);

  it('Esc closes the menu without executing anything', async () => {
    const dir = await makeProjectDir();
    const repl = startTtyRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/');
    await repl.waitFor(/show this help/);
    repl.write('\x1b'); // Esc
    // Node resolves a lone ESC only after its ~500ms escapeCodeTimeout;
    // an Enter sent earlier would be merged into the escape sequence.
    await new Promise((resolve) => setTimeout(resolve, 700));
    // Empty Enter after close must not produce an ambiguous-prefix error.
    repl.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('ambiguous prefix');
    expect(done.stdout).not.toContain('unknown command: /');
  }, 60_000);

  it('Tab completes a unique prefix and Enter runs it', async () => {
    const dir = await makeProjectDir();
    const repl = startTtyRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/sta');
    await new Promise((resolve) => setTimeout(resolve, 200));
    repl.write('\t');
    await new Promise((resolve) => setTimeout(resolve, 200));
    repl.write('\r');
    await repl.waitFor(/Run/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('ideaseek');
    expect(done.stdout).not.toContain('unknown command: /status');
  }, 60_000);

  it('unique prefix on Enter resolves without Tab (/pau → /pause)', async () => {
    const dir = await makeProjectDir();
    const repl = startTtyRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/pau\r');
    // No run exists → pause relays an honest RUN_NOT_FOUND, proving dispatch.
    await repl.waitFor(/no run exists|RUN_NOT_FOUND/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown command: /pau');
  }, 60_000);

  it('shows argument usage hints while typing "/logs "', async () => {
    const dir = await makeProjectDir();
    const repl = startTtyRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/logs ');
    await repl.waitFor(/usage: \/logs <task-id>/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
  }, 60_000);

  it('Ctrl-C hints without exiting; /quit exits cleanly', async () => {
    const dir = await makeProjectDir();
    const repl = startTtyRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    repl.write('\x03'); // Ctrl-C with empty line
    await repl.waitFor(/Ctrl-C: use \/quit/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('bye');
  }, 60_000);

  it('classic path answers agent tool approvals with a bare y/n line', async () => {
    const dir = await makeProjectDir();
    // A coding turn is an explicit `/agent` entry, not a tier the sentence
    // happens to land in.
    const repl = startTtyRepl(dir, [], { IDEASEEK_FAKE_AGENT_TURN: '1' });
    await repl.waitFor(/ideaseek ›/);
    repl.write('/agent check the workspace\r');
    // Step-level tool request streams before the approval prompt.
    await repl.waitFor(/⚙ pwsh \{"command":"ls"\}/);
    await repl.waitFor(/approval required: pwsh/);
    // The answer bypasses the command queue — the turn is blocked on it.
    repl.write('y\r');
    await repl.waitFor(/⚙ ✓ pwsh/);
    await repl.waitFor(/approval allowed once: pwsh/);
    await repl.waitFor(/Fake turn complete/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
  }, 60_000);

  it('agent sessions continue across TUI restarts through the registry', async () => {
    const dir = await makeProjectDir();
    const env = { IDEASEEK_FAKE_AGENT_TURN: '1' };

    // Session A: one turn, answered, recorded to knowledge/agent-sessions.json.
    const first = startTtyRepl(dir, [], env);
    await first.waitFor(/ideaseek ›/);
    first.write('/agent hello there\r');
    await first.waitFor(/approval required: pwsh/);
    first.write('y\r');
    await first.waitFor(/Fake turn complete/);
    const quit1 = await first.quit();
    expect(quit1.code).toBe(0);

    // Fresh TUI: seeds --resume from the registry — same conversation.
    const second = startTtyRepl(dir, [], env);
    await second.waitFor(/ideaseek ›/);
    second.write('/agent again please\r');
    await second.waitFor(/resumed session session-fake-e2e/);
    await second.waitFor(/approval required: pwsh/);
    second.write('y\r');
    await second.waitFor(/agent turn → session session-fake-e2e \(resumed,/);
    await second.waitFor(/Fake turn complete/);
    const quit2 = await second.quit();
    expect(quit2.code).toBe(0);
  }, 120_000);

  it('Ctrl-C interrupts the command that is currently running', async () => {
    const dir = await makeProjectDir();
    // Stretch the relay's abortable window (env test seam) so the
    // interrupt does not race a fast command.
    const repl = startTtyRepl(dir, [], { IDEASEEK_RELAY_DELAY_MS: '8000' });
    await repl.waitFor(/ideaseek ›/);
    repl.write('check status please\r');
    await repl.waitFor(/check status please/); // echoed by readline
    await new Promise((resolve) => setTimeout(resolve, 400));
    repl.write('\x03'); // Ctrl-C while the relay is mid-flight
    await repl.waitFor(/interrupted — the running command was stopped/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('recorded pending-approval'); // ask never ran
  }, 60_000);

  it('EOF exits cleanly without cancelling anything', async () => {
    const dir = await makeProjectDir();
    const child = spawn(process.execPath, [CLI_BIN, 'interactive'], {
      cwd: dir,
      env: { ...process.env, IDEASEEK_CLI: '1', IDEASEEK_FORCE_TTY: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    const code = await new Promise<number>((resolve) => {
      child.on('close', (c) => resolve(c ?? -1));
      child.stdin.write('/help\n');
      setTimeout(() => child.stdin.end(), 500); // EOF after help
    });
    expect(code).toBe(0);
    expect(output).toContain('Ideaseek commands');
    expect(output).not.toContain('unknown input');
  }, 60_000);

  it('preserves in-progress input across an incoming event (flood safety)', async () => {
    const dir = await makeProjectDir();
    // Existing run so attach has events to replay, plus a live one to append.
    const enqueued = await runCli(dir, ['run', '--question', 'flood', '--enqueue-only']);
    expect(enqueued.code).toBe(0);

    const repl = startTtyRepl(dir);
    await repl.waitFor(/ideaseek ›/);
    // Wait for replay to settle, then type WITHOUT submitting.
    await repl.waitFor(/task demo\.|run created|event stream ended|queued/);
    repl.write('/sta'); // partial input, no Enter
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Inject an event while the user is mid-typing.
    const runtime = await openRuntime(dir);
    try {
      const run = await runtime.db.getLatestRun(runtime.project.id);
      await runtime.db.appendEvent({
        runId: run!.runId,
        phase: 'DEMO',
        objectId: null,
        role: 'tester',
        eventType: 'note',
        summary: 'mid-typing event flood',
        status: null,
      });
    } finally {
      await runtime.close();
    }
    await repl.waitFor(/mid-typing event flood/);

    // The typed buffer survived: Enter now runs /status (completed prefix).
    repl.write('tus\r');
    await repl.waitFor(/Run/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown command: /statu');
  }, 90_000);
});

describe('new slash commands and NL routing (CLI)', () => {
  it('/mode shows tier, project and permissions and switches research↔analysis', async () => {
    const project = await makeProjectDir();
    const repl = startTtyRepl(project);
    await repl.waitFor(/ideaseek ›/);

    repl.write('/mode\r');
    await repl.waitFor(/session mode : research/);
    await repl.waitFor(/permissions {2}:/);
    await repl.waitFor(/the science pipeline treats papers\//);

    repl.write('/mode analysis\r');
    // The switch itself stays two short lines: migration + audit event,
    // then a one-line permission recap — never the full summary wall.
    await repl.waitFor(/session mode: research → analysis/);
    // A switch recaps only the tier's first permission line; the rest of the
    // summary is one explicit /mode away.
    await repl.waitFor(/read-only preparation/);

    // The full summary is one explicit /mode away.
    repl.write('/mode\r');
    await repl.waitFor(/session mode : analysis/);
    await repl.waitFor(/cannot lock protocols/);

    // `agent` is no longer a tier: the old spelling is refused with a pointer
    // and leaves the persisted tier untouched.
    repl.write('/mode agent\r');
    await repl.waitFor(/不是权限档位/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown command: /mode');
    // The non-interactive CLI reads the same persisted session state.
    const shown = await runCli(project, ['mode', '--json']);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      sessionMode: 'analysis',
      project: 'test-project',
    });
  }, 90_000);

  it('interactive --mode analysis starts the session in the analysis tier', async () => {
    const project = await makeProjectDir();
    const repl = startTtyRepl(project, ['--mode', 'analysis']);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/mode\r');
    await repl.waitFor(/session mode : analysis/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
  }, 60_000);

  it('/agent routes to the real DSH agent turn', async () => {
    const project = await makeProjectDir();
    // A bogus model name makes the real turn fail honestly in ~4s BEFORE
    // any model call (never spend credentials implicitly) — and its
    // failure text comes from the agent CLI, not from the ask supervisor.
    const repl = startTtyRepl(project, [], {
      DEEPSEEK_API_KEY: '',
      IDEASEEK_AGENT_MODEL: 'ideaseek-no-such-model',
    });
    await repl.waitFor(/ideaseek ›/);
    repl.write('/agent hello there\r');
    await repl.waitFor(/DSH session failed|agent turn failed|models setup|doctor/, 60_000);
    expect(repl.output()).not.toContain('recorded pending-approval decision');
    expect(repl.output()).not.toContain('IdeaSeek supervisor ready');
    const done = await repl.quit();
    expect(done.code).toBe(0);
  }, 90_000);

  it('/mode --strategy changes the research strategy with confirmation', async () => {
    const project = await makeProjectDir();
    const repl = startTtyRepl(project);
    await repl.waitFor(/ideaseek ›/);

    repl.write('/mode\r');
    await repl.waitFor(/research strategy: auto/);
    // Guided change needs --confirm.
    repl.write('/mode --strategy starter\r');
    await repl.waitFor(/--confirm/);
    // With confirmation it applies (no run yet → decision not recorded note).
    repl.write('/mode --strategy starter --confirm\r');
    await repl.waitFor(/research strategy: auto → starter/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    const yaml = await readFile(join(project, 'research.yaml'), 'utf8');
    expect(yaml).toContain('mode: starter');
    // Direct CLI form shares the same use-case.
    const shown = await runCli(project, ['mode', '--json']);
    expect(JSON.parse(shown.stdout)).toMatchObject({ strategy: 'starter' });
  }, 90_000);

  it('/open lists and opens knowledge documents read-only', async () => {
    const project = await makeProjectDir();
    await writeFile(
      join(project, 'knowledge', 'sample-note.md'),
      '# Sample\nfirst line of the note\n',
      'utf8',
    );
    const repl = startTtyRepl(project);
    await repl.waitFor(/ideaseek ›/);

    repl.write('/open\r');
    await repl.waitFor(/sample-note\.md/);
    repl.write('/open sample-note\r');
    await repl.waitFor(/first line of the note/);
    repl.write('/open does-not-exist\r');
    await repl.waitFor(/no project or document matches/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown command: /open');
  }, 90_000);

  it('/open previews then switches the session project with --confirm', async () => {
    const alpha = await makeProjectDir('alpha');
    const beta = await makeProjectDir('beta');
    const repl = startTtyRepl(alpha);
    await repl.waitFor(/ideaseek ›/);

    // Step 1: preview — target plus mode/project/permission summary.
    repl.write(`/open "${beta}"\r`);
    await repl.waitFor(/switch target : beta/);
    await repl.waitFor(/session mode : research/);
    await repl.waitFor(/confirm: \/open .*--confirm/);

    // Step 2: --confirm chdirs the session and reprints the new context.
    repl.write(`/open "${beta}" --confirm\r`);
    await repl.waitFor(/session → /);
    await repl.waitFor(/project\s+: beta/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown command: /open');
    expect(done.stdout).not.toContain('unknown input');
  }, 90_000);

  it('/rounds /ideate /feedback relay to their CLI use-cases', async () => {
    const project = await makeProjectDir();
    const repl = startTtyRepl(project);
    await repl.waitFor(/ideaseek ›/);

    repl.write('/rounds\r');
    await repl.waitFor(/no ideation rounds/);
    repl.write('/ideate --round new --question "ux test"\r');
    await repl.waitFor(/round r1 created|question: ux test/);
    repl.write('/rounds\r');
    await repl.waitFor(/r1/);
    // Invalid label proves the relay reaches the real validator.
    repl.write('/feedback meh --idea ghost\r');
    await repl.waitFor(/label must be one of/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown command: /ideate');
  }, 120_000);

  it('/ideas reports real idea state instead of placeholder text', async () => {
    const project = await makeProjectDir();
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeIdeaCard('ux-idea')), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'ux-idea', '--from-card', cardPath])).code,
    ).toBe(0);

    const repl = startTtyRepl(project);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/ideas\r');
    await repl.waitFor(/ux-idea/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('PROPOSED');
    expect(done.stdout).not.toContain('Phase 5');
    expect(done.stdout).not.toContain('no ideas recorded');
  }, 90_000);

  it('bare --json snapshot stays machine-readable', async () => {
    const project = await makeProjectDir();
    const result = await runCli(project, ['--json']);
    expect(result.code).toBe(0);
    const firstLine = result.stdout.split(/\r?\n/).filter((l) => l.trim())[0]!;
    const payload = JSON.parse(firstLine) as { project: string; run: unknown };
    expect(payload.project).toBeTruthy();
    expect(payload).toHaveProperty('run');
    expect(result.stdout).not.toContain('ideaseek ›');
  }, 60_000);
});

function makeIdeaCard(ideaId: string): Record<string, unknown> {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: 's', targetProblem: 't' },
    paperEvidence: [{ paperRef: 'p', statement: 's', evidence: 'e' }],
    contradictions: ['c'],
    novelty: { claim: 'c', uncertainty: 'u', whyNotRestatement: 'w' },
    mechanismChain: {
      designPrincipleLink: 'l',
      steps: [
        { kind: 'observation', text: 'a' },
        { kind: 'hypothesis', text: 'b' },
        { kind: 'intervention', text: 'c' },
        { kind: 'expected-change', text: 'd' },
        { kind: 'baseline-difference', text: 'e' },
        { kind: 'falsifier', text: 'f' },
      ],
    },
    nearestComparisons: [{ methodId: 'm', difference: 'd', evidence: 'e' }],
    componentNecessity: [{ component: 'c', role: 'necessary-mechanism', removeEffect: 'r' }],
    competingExplanations: ['x'],
    boundaryConditions: ['x'],
    risks: ['x'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'd',
      baselines: ['b'],
      metrics: ['m'],
      ablations: ['a'],
    },
    falsification: { conditions: ['f'] },
    budget: { maxRounds: 1, maxGpuMinutes: 10 },
    stopConditions: ['s'],
    createdAt: 1,
  };
}

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
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
