import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { budget, CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';
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
    }, budget(60_000));
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

// Budgets here are scaled, not relaxed (see `budget` in helpers.ts): the
// handshake these turns depend on now retries a cold start, which is the right
// product behaviour and a longer worst case by design. Waiting is still on a
// condition and assertions are unchanged — a test that cannot finish in the
// scaled window still fails.

describe('Ink activity rendering input normalization', () => {
  it('splits multiline output, preserves safe SGR colors and strips cursor escapes', () => {
    const bus = new ActivityBus();
    bus.push('first\n\u001b[2J\u001b[31msecond\u001b[0m\r\nthird');
    expect(bus.lines).toEqual(['first', '\u001b[31msecond\u001b[0m', 'third']);
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
    // Scaled like every other budget in this file: the fixed 45s was the first
    // thing a loaded machine overran, and when it did the message said only
    // "timeout waiting for X".
    waitFor: async (pattern, timeoutMs = budget(45_000)) => {
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
  it(
    'runs the TUI checklist: layout, palette, dispatch, Ctrl-C hint, /quit',
    async () => {
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
        // The composer is framed by top/bottom hairline rules with the brand
        // prompt and live cursor cell (safe on dark and light terminal themes).
        expect(repl.output()).toMatch(/─{10,}[\s\S]*ideaseek › ▏[\s\S]*─{10,}/);

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

        // Shift+Tab cycles the two research tiers through the audited /mode
        // use-case (docs/MODES.md) — three positions: RESEARCH → ANALYSIS →
        // CODING → RESEARCH. The third is a conversation FOCUS, not a permission
        // tier: it only reroutes plain text to DSH turns, and `agent` never comes
        // back as a tier because no code ever enforced the limits it claimed.
        await repl.write('\x1b[Z');
        await repl.waitFor(/session mode: research → analysis/);
        await repl.waitFor(/ink-interactive · ANALYSIS/);
        await repl.write('\x1b[Z');
        await repl.waitFor(/session focus: coding —/);
        await repl.waitFor(/focus grants no permissions/);
        await repl.waitFor(/ink-interactive · CODING/);
        // Leaving the focus turns it off first, then asks for the next tier —
        // and the Analysis→Research preparation gate (PROGRESS 84) legitimately
        // refuses, so one keystroke cannot drop an unprepared project into
        // experiment mode.
        await repl.write('\x1b[Z');
        await repl.waitFor(/session focus: coding off/);
        await repl.waitFor(/blocked by material gaps/);
        await repl.waitFor(/ink-interactive · ANALYSIS/);
        await repl.write('/mode research --force');
        await repl.write('\r');
        await repl.waitFor(/session mode: analysis → research/);
        await repl.waitFor(/ink-interactive · RESEARCH/);
        await repl.waitFor(/RESEARCH.*Shift\+Tab mode/);

        // Alt+C toggles CODING focus orthogonally while keeping the research tier
        // visible (CODING · RESEARCH) and without hitting the Analysis gate on exit.
        await repl.write('\x1bc');
        await repl.waitFor(/session focus: ask → coding \(tier remains research\)/);
        await repl.waitFor(/ink-interactive · CODING · RESEARCH/);
        await repl.write('\x1bc');
        await repl.waitFor(/session focus: coding → ask \(tier remains research\)/);
        await repl.waitFor(/ink-interactive · RESEARCH/);
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
    },
    budget(150_000),
  );

  it(
    'mouse wheel scrolls history on the alt screen; live events still follow',
    async () => {
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
    },
    budget(180_000),
  );

  it(
    'agent tool approvals surface in the TUI and answer with y/n',
    async () => {
      const dir = await makeProjectDir('ink-approve');
      // Canned turn (no model, no spend): asks to run pwsh once per turn and
      // completes with the operator's answer over the stdio channel.
      const repl = startInk(dir, [], { IDEASEEK_FAKE_AGENT_TURN: '1' });
      try {
        await repl.waitFor(/ideaseek ›/, 60_000);
        // The tier badge does not change: `/agent` is a turn, not a mode.
        await repl.waitFor(/ink-approve · RESEARCH/, 60_000);

        // Submit → step-level tool request streams first, then the approval
        // request: transcript audit line + input line flips to the
        // `y allow once · n reject` prompt.
        await repl.write('/agent check the workspace');
        await repl.write('\r');
        await repl.waitFor(/⚙ pwsh \{"command":"ls"\}/);
        await repl.waitFor(/approval required: pwsh/);
        await repl.waitFor(/allow pwsh\? y allow once/);
        // The footer says what the turn is actually doing — waiting for a
        // human, not generic "running". (waitFor, not expect: Ink writes a
        // frame top-down, so the footer bytes land just after the bar's.)
        await repl.waitFor(/waiting for approval…/);

        // y → allowed once; the tool result streams, the canned turn completes.
        await repl.write('y');
        await repl.waitFor(/⚙ ✓ pwsh/);
        await repl.waitFor(/approval allowed once: pwsh/);
        await repl.waitFor(/Fake turn complete/);

        // Second turn → n → rejected with the model-visible standing-by reply.
        // Wait on the TURN-SPECIFIC reason: both turns ask for pwsh, and a
        // generic pattern would match the first turn's still-buffered line
        // instantly — the 'n' would then type into the composer instead of
        // answering the live approval.
        await repl.write('/agent again please');
        await repl.write('\r');
        await repl.waitFor(/approval required: pwsh — workspace probe for: again please/);
        await repl.write('n');
        await repl.waitFor(/⚙ ✗ pwsh/);
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
    },
    budget(120_000),
  );

  it(
    'models setup masks the API key and fails closed offline',
    async () => {
      const dir = await makeProjectDir('ink-models');
      const repl = startInk(dir);
      try {
        await repl.waitFor(/ideaseek ›/, 60_000);
        await repl.waitFor(/ink-models · RESEARCH/, 60_000);

        // Open the wizard with a provider and a dead base URL — the connection
        // test then fails offline (same trick as tests/models-setup.test.ts), so
        // the full prompt → stdin → child chain runs without any network.
        await repl.write('/models setup deepseek --base-url http://127.0.0.1:1');
        await repl.write('\r');
        await repl.waitFor(/API key \(input hidden\)/);

        const secret = 'sk-test-super-secret-42';
        await repl.write(secret);
        await repl.waitFor(/•{10,}/); // masked as bullets
        expect(repl.output()).not.toContain(secret); // never echoed anywhere

        await repl.write('\r'); // submit → child reads stdin, test fails, nothing written
        await repl.waitFor(/connection test FAILED/);
        expect(repl.output()).not.toContain(secret); // still nowhere

        await repl.write('/');
        await repl.write('quit');
        await repl.write('\r');
        expect(await repl.done).toBe(0);
      } finally {
        await cleanup(dir, repl.child);
      }
    },
    budget(120_000),
  );

  it(
    'models setup offers the provider catalog and accepts a number',
    async () => {
      const dir = await makeProjectDir('ink-models-catalog');
      const repl = startInk(dir);
      try {
        await repl.waitFor(/ideaseek ›/, 60_000);

        // No provider chosen: show the catalog and stop — never wire a provider
        // the researcher did not pick, and never open the key prompt yet.
        await repl.write('/models setup');
        await repl.write('\r');
        await repl.waitFor(/which provider\?/);
        await repl.waitFor(/1\. deepseek/);
        expect(repl.output()).not.toContain('API key (input hidden)');

        // Choosing by number resolves the id and opens the masked prompt. The
        // dead base URL keeps the connection test offline and fail-closed.
        await repl.write('/models setup 1 --base-url http://127.0.0.1:1');
        await repl.write('\r');
        await repl.waitFor(/API key \(input hidden\)/, 60_000);

        const secret = 'sk-catalog-probe-secret-1';
        await repl.write(secret);
        await repl.waitFor(/•{10,}/);
        expect(repl.output()).not.toContain(secret);
        await repl.write('\r');
        await repl.waitFor(/connection test FAILED/);
        expect(repl.output()).not.toContain(secret);

        await repl.write('/');
        await repl.write('quit');
        await repl.write('\r');
        expect(await repl.done).toBe(0);
      } finally {
        await cleanup(dir, repl.child);
      }
    },
    budget(180_000),
  );

  it(
    'renders workspace greeting, ? shortcuts, Ctrl+O details, Ctrl+F search and Alt+M mouse toggle',
    async () => {
      const dir = await makeProjectDir('ink-pro-ux');
      const repl = startInk(dir);
      try {
        await repl.waitFor(/ideaseek ›/, 60_000);
        await repl.waitFor(/workspace: papers 0 · datasets 0/, 60_000);

        // `?` opens the shortcut cheat-sheet overlay; Esc dismisses it.
        await repl.write('?');
        await repl.waitFor(/Shortcuts \(Esc \/ \? to close\)/);
        await repl.write('\x1b');
        await new Promise((resolve) => setTimeout(resolve, 400));

        // Ctrl+O toggles compact/expanded details toast in footer.
        await repl.write('\x0f');
        await repl.waitFor(/details: expanded/);

        // Alt+M toggles mouse tracking off so terminal drag-select works cleanly.
        await repl.write('\x1bm');
        await repl.waitFor(/mouse: text selection/);
        expect(repl.output()).toContain('\x1b[?1006l\x1b[?1000l');

        // Ctrl+F searches the transcript live and Esc closes search.
        await repl.write('\x06');
        await repl.waitFor(/Find:/);
        await repl.write('papers');
        await repl.waitFor(/1\/1/);
        await repl.write('\x1b');
        await new Promise((resolve) => setTimeout(resolve, 400));

        await repl.write('\x04');
        expect(await repl.done).toBe(0);
      } finally {
        await cleanup(dir, repl.child);
      }
    },
    budget(120_000),
  );

  it(
    'Ctrl-D exits without cancelling anything and restores the screen',
    async () => {
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
    },
    budget(120_000),
  );
});
