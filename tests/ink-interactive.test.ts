import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * Ink interactive shell conformance (ADR-010): the built CLI runs the Ink
 * TUI over piped stdio via IDEASEEK_FORCE_INK (fake-TTY surface, same
 * approach as the spike driver), driving the REAL dispatch/event/session
 * path — not the spike stub. Chunked key writes mirror a real terminal;
 * batching would parse as one paste.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface InkRepl {
  child: ChildProcessWithoutNullStreams;
  output(): string;
  write(chunk: string): Promise<void>;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  done: Promise<number>;
}

function startInk(cwd: string): InkRepl {
  const child = spawn(process.execPath, [CLI_BIN, 'interactive'], {
    cwd,
    env: {
      ...process.env,
      IDEASEEK_CLI: '1',
      IDEASEEK_FORCE_INK: '1',
      IDEASEEK_TTY_ROWS: '40',
      IDEASEEK_TTY_COLS: '100',
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
      await repl.waitFor(/Project/, 60_000);
      expect(repl.output()).toContain('\x1b[?1049h'); // alternate screen ON
      expect(repl.output()).toContain('[IS]'); // short mark at 100 cols
      // The first frame must land INSIDE the alternate screen, not before it.
      expect(repl.output().indexOf('\x1b[?1049h')).toBeLessThan(
        repl.output().indexOf('ideaseek ›'),
      );

      // Ctrl-C FIRST, while the activity pane is still fresh: ink's piped
      // byte stream keeps only partial rows once later frames rewrite them,
      // so the hint is asserted before anything else lands in the pane.
      // It must hint, never quit.
      await repl.write('\x03');
      await repl.waitFor(/Ctrl-C: use \/quit to exit/);
      expect(repl.output()).not.toContain('\x1b[?1049l'); // still running

      // `/` opens the palette in place; typing filters it; arrows select.
      await repl.write('/');
      await repl.waitFor(/> \/help/);
      await repl.write('st');
      await repl.waitFor(/ideaseek › \/st/);
      expect(repl.output()).toContain('/status');
      await repl.write('\x1b[B'); // down → fill input with /status
      await repl.waitFor(/> \/status/);

      // Enter dispatches through the shared session → real CLI relay.
      await repl.write('\r');
      await repl.waitFor(/Run/); // `ideaseek status` output

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
