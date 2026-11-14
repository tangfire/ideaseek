import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';
import { ActivityBus } from '../src/cli/shell/app.js';

/** One-shot CLI call for test setup (create runs, enqueue tasks). */
function runCli(cwd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out`));
    }, 60_000);
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/**
 * Ink interactive shell conformance (ADR-010): the built CLI runs the Ink
 * TUI over piped stdio via IDEASEEK_FORCE_INK (fake-TTY surface, same
 * approach as the spike driver), driving the REAL dispatch/event/session
 * path — not the spike stub. Chunked key writes mirror a real terminal;
 * batching would parse as one paste.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Ink activity rendering input normalization', () => {
  it('splits multiline output and strips embedded ANSI before Ink renders it', () => {
    const bus = new ActivityBus();
    bus.push('first\n\u001b[31msecond\u001b[0m\r\nthird');
    expect(bus.lines).toEqual(['first', 'second', 'third']);
  });
});

interface InkRepl {
  child: ChildProcessWithoutNullStreams;
  output(): string;
  write(chunk: string): Promise<void>;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  done: Promise<number>;
}

function startInk(
  cwd: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): InkRepl {
  const child = spawn(process.execPath, [CLI_BIN, 'interactive', ...extraArgs], {
    cwd,
    env: {
      ...process.env,
      IDEASEEK_CLI: '1',
      IDEASEEK_FORCE_INK: '1',
      IDEASEEK_TTY_ROWS: '40',
      IDEASEEK_TTY_COLS: '100',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let out = '';
  child.stdout.on('data', (chunk) => (out += String(chunk)));
  child.stderr.on('data', (chunk) => (out += String(chunk)));
  const done = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));
  return {
    child,
    output: () => out,
    write: async (chunk) => {
      child.stdin.write(chunk);
      // Generous pacing: under full-suite parallelism the child's event loop
      // can block long enough for two chunks to coalesce into one paste.
      await sleep(300);
    },
    waitFor: async (pattern, timeoutMs = 45_000) => {
      const started = Date.now();
      while (!pattern.test(out)) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(`timeout waiting for ${pattern}; output:\n${out.slice(-2000)}`);
        }
        await sleep(60);
      }
      return out;
    },
    done,
  };
}

/** Windows can keep the temp dir locked briefly after the child exits. */
async function cleanup(dir: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  child.kill('SIGKILL');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

describe('interactive Ink renderer (built CLI, real dispatch)', () => {
  it('runs the TUI checklist: layout, palette, dispatch, Ctrl-C hint, /quit', async () => {
    const dir = await makeProjectDir('ink-interactive');
    const repl = startInk(dir);
    try {
      // First ink import over a cold/cross-OS filesystem can take seconds.
      await repl.waitFor(/ideaseek ›/, 60_000);
      // Header context arrives from `status --json` after the first frame.
      await repl.waitFor(/ink-interactive · RESEARCH/, 60_000);
      await repl.waitFor(/RESEARCH.*Shift\+Tab mode/);
      expect(repl.output()).toContain('\x1b[?1049h'); // alternate screen ON
      expect(repl.output()).toContain('[IS]'); // short mark at 100 cols
      // The first frame must land INSIDE the alternate screen, not before it.
      expect(repl.output().indexOf('\x1b[?1049h')).toBeLessThan(
        repl.output().indexOf('ideaseek ›'),
      );
      // The composer is a full-width tinted bar: prompt + cursor cell +
      // Braille-blank padding to the terminal edge (colors are stripped
      // on pipes; the U+2800 padding cells survive Ink's trimEnd).
      expect(repl.output()).toMatch(/ideaseek › ▏⠀{5,}/);

      // Ctrl-C FIRST, while the activity pane is still fresh: ink's piped
      // byte stream keeps only partial rows once later frames rewrite them,
      // so the hint is asserted before anything else lands in the pane.
      // It must hint, never quit.
      await repl.write('\x03');
      await repl.waitFor(/Ctrl-C: use \/quit to exit/);
      expect(repl.output()).not.toContain('\x1b[?1049l'); // still running

      // `/` opens the palette in place; typing filters it; arrows select.
      await repl.write('/');
      await repl.waitFor(/› \/help/);
      await repl.write('st');
      await repl.waitFor(/ideaseek › \/st/);
      expect(repl.output()).toContain('/status');
      expect(repl.output()).toContain('run state, tasks, workers, recent events');
      await repl.write('\x1b[B'); // down → fill input with /status
      await repl.waitFor(/› \/status/);

      // Enter dispatches through the shared session → real CLI relay.
      await repl.write('\r');
      await repl.waitFor(/Run/); // `ideaseek status` output
      // The utterance is echoed into the transcript (❯ + bold cyan), so
      // user input, responses and timestamped events stay distinguishable.
      expect(repl.output()).toContain('❯ /status');
      // While the relay ran, the input line itself carried the spinner.
      expect(repl.output()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

      // Shift+Tab cycles session mode through the audited /mode use-case.
      await repl.write('\x1b[Z');
      await repl.waitFor(/session mode: research → agent/);
      await repl.waitFor(/ink-interactive · AGENT/);
      await repl.waitFor(/AGENT.*Shift\+Tab mode/);
      await repl.write('\x1b[Z');
      await repl.waitFor(/session mode: agent → research/);
      await repl.waitFor(/ink-interactive · RESEARCH/);
      await repl.waitFor(/RESEARCH.*Shift\+Tab mode/);
      // Session-mode audit decisions are recorded but must never stream —
      // otherwise every startup replays a wall of identical DECISION lines
      // (the DB record stays queryable via `ideaseek events`). Wait long
      // enough for the poll to have picked the event up if it leaked.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(repl.output()).not.toContain('change-session-mode');

      // Delete at end-of-line removes the previous character in the TUI.
      // The cursor cell blinks (▏ ⇄ space), so accept either state — the
      // contract is that the row shows `ab` followed by the cursor cell,
      // never the pre-delete `abc`.
      await repl.write('abc');
      await repl.write('\x1b[3~');
      await repl.waitFor(/ideaseek › abc/);
      await repl.waitFor(/ideaseek › ab[▏ ]/);
      await repl.write('\x15'); // Ctrl-U clears the test input before /help

      // Local dispatch (/help) needs no subprocess — proves the Ink path
      // shares the classic dispatch. Chunked like a real terminal.
      await repl.write('/');
      await repl.write('help');
      await repl.write('\r');
      await repl.waitFor(/Ideaseek commands:/);

      // /quit exits cleanly and restores the primary screen.
      await repl.write('/');
      await repl.write('quit');
      await repl.write('\r');
      const code = await repl.done;
      expect(code).toBe(0);
      expect(repl.output()).toContain('bye — background runs keep going');
      expect(repl.output()).toContain('\x1b[?1049l'); // alternate screen OFF

      // Clean session-end marker was awaited before exit (recovery contract).
      const marker = JSON.parse(
        await readFile(join(dir, '.research', 'last-session.json'), 'utf8'),
      ) as { endedAt?: string; clean?: boolean };
      expect(marker.endedAt).toBeTruthy();
      expect(marker.clean).toBe(true);
    } finally {
      await cleanup(dir, repl.child);
    }
  }, 150_000);

  it('mouse wheel scrolls history on the alt screen; live events still follow', async () => {
    const dir = await makeProjectDir('ink-wheel');
    const enqueued = await runCli(dir, ['run', '--question', 'wheel scroll', '--enqueue-only']);
    expect(enqueued.code, enqueued.stderr).toBe(0);

    // Enough replayed events to overflow one screen (visible ≈ 36 rows).
    const runtime = await openRuntime(dir);
    try {
      const run = await runtime.db.getLatestRun(runtime.project.id);
      for (let i = 0; i < 60; i += 1) {
        await runtime.db.appendEvent({
          runId: run!.runId,
          phase: 'DEMO',
          objectId: null,
          role: 'tester',
          eventType: 'note',
          summary: `scroll-marker ${i}`,
          status: null,
        });
      }
    } finally {
      await runtime.close();
    }

    const repl = startInk(dir);
    try {
      await repl.waitFor(/ideaseek ›/, 60_000);
      await repl.waitFor(/ink-wheel · RESEARCH/, 60_000);
      // Button-event tracking + SGR: the alternate screen has NO
      // scrollback, so the wheel only works if the app reports it.
      expect(repl.output()).toContain('\x1b[?1000;1006h');
      // Replay fills the pane past one screen (marker 40 sits in the tail).
      await repl.waitFor(/scroll-marker 40/, 60_000);

      // Wheel up ×8 → 48 lines back → the scrolled hint appears.
      for (let i = 0; i < 8; i += 1) await repl.write('\x1b[<64;10;5M');
      await repl.waitFor(/scrolled up/);

      // Wheel down past the top clamp → back at the bottom (offset 0).
      for (let i = 0; i < 15; i += 1) await repl.write('\x1b[<65;10;5M');

      // A fresh live event renders again — proof the pane is following
      // (while anchored mid-history the tail would stay out of the window).
      const follow = await openRuntime(dir);
      try {
        const run = await follow.db.getLatestRun(follow.project.id);
        await follow.db.appendEvent({
          runId: run!.runId,
          phase: 'DEMO',
          objectId: null,
          role: 'tester',
          eventType: 'note',
          summary: 'scroll-live-follow',
          status: null,
        });
      } finally {
        await follow.close();
      }
      await repl.waitFor(/scroll-live-follow/);

      // /quit exits cleanly (the Ink helper awaits the `done` promise).
      await repl.write('/');
      await repl.write('quit');
      await repl.write('\r');
      expect(await repl.done).toBe(0);
    } finally {
      await cleanup(dir, repl.child);
    }
  }, 180_000);

  it('agent tool approvals surface in the TUI and answer with y/n', async () => {
    const dir = await makeProjectDir('ink-approve');
    // Canned turn (no model, no spend): asks to run pwsh once per turn and
    // completes with the operator's answer over the stdio channel.
    const repl = startInk(dir, ['--mode', 'agent'], { IDEASEEK_FAKE_AGENT_TURN: '1' });
    try {
      await repl.waitFor(/ideaseek ›/, 60_000);
      await repl.waitFor(/ink-approve · AGENT/, 60_000);

      // Submit → approval request: transcript audit line + input line
      // flips to the `y allow once · n reject` prompt.
      await repl.write('check the workspace');
      await repl.write('\r');
      await repl.waitFor(/approval required: pwsh/);
      await repl.waitFor(/allow pwsh\? y allow once/);

      // y → allowed once; the canned turn completes.
      await repl.write('y');
      await repl.waitFor(/approval allowed once: pwsh/);
      await repl.waitFor(/Fake turn complete/);

      // Second turn → n → rejected with the model-visible standing-by reply.
      // Wait on the TURN-SPECIFIC reason: both turns ask for pwsh, and a
      // generic pattern would match the first turn's still-buffered line
      // instantly — the 'n' would then type into the composer instead of
      // answering the live approval.
      await repl.write('again please');
      await repl.write('\r');
      await repl.waitFor(/approval required: pwsh — workspace probe for: again please/);
      await repl.write('n');
      await repl.waitFor(/approval rejected: pwsh/);
      await repl.waitFor(/standing by without the tool/);

      // The composer is free again after the approval resolves.
      await repl.write('/');
      await repl.write('quit');
      await repl.write('\r');
      expect(await repl.done).toBe(0);
    } finally {
      await cleanup(dir, repl.child);
    }
  }, 120_000);

  it('Ctrl-D exits without cancelling anything and restores the screen', async () => {
    const dir = await makeProjectDir('ink-interactive-eof');
    const repl = startInk(dir);
    try {
      await repl.waitFor(/ideaseek ›/, 60_000);
      await repl.write('\x04'); // EOF semantics on an empty line
      const code = await repl.done;
      expect(code).toBe(0);
      expect(repl.output()).toContain('\x1b[?1049l');
    } finally {
      await cleanup(dir, repl.child);
    }
  }, 120_000);
});
