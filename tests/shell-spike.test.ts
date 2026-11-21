import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ShellEngine,
  classifyPointer,
  interactiveRenderer,
  type EngineKey,
} from '../src/cli/shell/engine.js';
import { startShellSpike, toEngineKey } from '../src/cli/shell/spike.js';

/**
 * Ink spike conformance (ADR-010): engine keyboard/palette rules are pure
 * unit tests; the spike view runs on fake stdin/stdout streams proving
 * alternate screen enter/exit, fixed layout, visible input, live palette,
 * background event refresh, Ctrl-D exit — and that plain/non-TTY/FORCE_TTY
 * routing never selects the Ink renderer (plain/json paths stay TUI-free).
 */

function key(name: string, extra: Partial<EngineKey> = {}): EngineKey {
  return { name, ...extra };
}

describe('ShellEngine (pure keyboard/palette rules)', () => {
  it('keeps typed input visible and edits around the cursor', () => {
    const engine = new ShellEngine();
    let snap = engine.handle({ sequence: 'sta' });
    expect(snap.line).toBe('sta');
    expect(snap.cursor).toBe(3);
    snap = engine.handle(key('backspace'));
    expect(snap.line).toBe('st');
    snap = engine.handle({ sequence: 'atus' });
    expect(snap.line).toBe('status');
    snap = engine.handle(key('left'));
    snap = engine.handle(key('left'));
    snap = engine.handle({ sequence: 'X' });
    expect(snap.line).toBe('statXus');
    expect(snap.cursor).toBe(5);
  });

  it('Delete edits at end-of-line while retaining forward-delete in the middle', () => {
    const engine = new ShellEngine();
    engine.handle({ sequence: 'abc' });
    expect(engine.handle(key('delete')).line).toBe('ab');
    engine.handle(key('home'));
    expect(engine.handle(key('delete')).line).toBe('b');
  });

  it('Delete removes the character at the cursor without dismissing the palette', () => {
    const engine = new ShellEngine();
    engine.handle({ sequence: '/status' });
    engine.handle(key('left'));
    const mapped = toEngineKey('\x1b[3~', { escape: true });
    const snap = engine.handle(mapped);
    expect(snap.line).toBe('/statu');
    expect(snap.paletteOpen).toBe(true);
  });

  it('opens and filters the palette while typing a slash word', () => {
    const engine = new ShellEngine();
    let snap = engine.handle({ sequence: '/' });
    expect(snap.paletteOpen).toBe(true);
    expect(snap.paletteItems.length).toBeGreaterThan(10);
    snap = engine.handle({ sequence: 'st' });
    expect(snap.paletteItems).toEqual(['/status']);
    // A space closes filtering (arguments mode).
    engine.handle({ sequence: ' ' });
    const afterSpace = engine.handle({ sequence: 'x' });
    expect(afterSpace.paletteOpen).toBe(false);
  });

  it('Tab completes a unique prefix; multiple matches share a prefix', () => {
    const engine = new ShellEngine();
    engine.handle({ sequence: '/' });
    engine.handle({ sequence: 'sta' });
    let snap = engine.handle(key('tab'));
    expect(snap.line).toBe('/status');
    expect(snap.paletteOpen).toBe(true);

    const engine2 = new ShellEngine();
    engine2.handle({ sequence: '/r' });
    snap = engine2.handle(key('tab'));
    expect(snap.line.startsWith('/r')).toBe(true);
    expect(snap.line.length).toBeLessThan('/resume'.length + 1);
    expect(snap.paletteItems.length).toBeGreaterThan(1);
  });

  it('arrows move the palette selection into the input; Esc clears both', () => {
    const engine = new ShellEngine();
    engine.handle({ sequence: '/' });
    let snap = engine.handle(key('down'));
    expect(snap.paletteIndex).toBe(1);
    expect(snap.line).toBe(snap.paletteItems[1]);
    snap = engine.handle(key('up'));
    expect(snap.paletteIndex).toBe(0);
    snap = engine.handle(key('escape'));
    expect(snap.paletteOpen).toBe(false);
    expect(snap.line).toBe('');
  });

  it('Enter submits the line; bare "/" keeps the menu open', () => {
    const engine = new ShellEngine();
    engine.handle({ sequence: '/status' });
    let snap = engine.handle(key('return'));
    expect(snap.submit).toBe('/status');
    expect(snap.paletteOpen).toBe(false);

    const engine2 = new ShellEngine();
    engine2.handle({ sequence: '/' });
    snap = engine2.handle(key('return'));
    expect(snap.submit).toBe('/');
    expect(snap.paletteOpen).toBe(true);

    const engine3 = new ShellEngine();
    snap = engine3.handle(key('return'));
    expect(snap.submit).toBeNull();
  });

  it('↑/↓ walk submitted input once the palette is closed', () => {
    const engine = new ShellEngine();
    for (const entry of ['/status', '/papers', '/models setup deepseek']) {
      for (const ch of entry) engine.handle({ sequence: ch });
      engine.handle(key('return'));
    }

    let snap = engine.handle(key('up'));
    expect(snap.line).toBe('/models setup deepseek');
    snap = engine.handle(key('up'));
    expect(snap.line).toBe('/papers');
    snap = engine.handle(key('up'));
    expect(snap.line).toBe('/status');
    // Oldest entry stays; ↓ walks forward again.
    snap = engine.handle(key('up'));
    expect(snap.line).toBe('/status');
    snap = engine.handle(key('down'));
    expect(snap.line).toBe('/papers');
  }, 60_000);

  it('↓ past the newest entry restores the line being typed', () => {
    const engine = new ShellEngine();
    for (const ch of '/status') engine.handle({ sequence: ch });
    engine.handle(key('return'));
    for (const ch of '/next') engine.handle({ sequence: ch });

    engine.handle(key('up')); // recall /status, draft kept
    const snap = engine.handle(key('down'));
    expect(snap.line).toBe('/next');
    // Consecutive duplicates are stored once.
    for (const ch of '/status') engine.handle({ sequence: ch });
    engine.handle(key('return'));
    for (const ch of '/status') engine.handle({ sequence: ch });
    engine.handle(key('return'));
    expect(engine.handle(key('up')).line).toBe('/status');
  }, 60_000);

  it('Tab on an empty line reveals the command list', () => {
    const engine = new ShellEngine();
    const snap = engine.handle(key('tab'));
    expect(snap.paletteOpen).toBe(true);
    expect(snap.paletteItems.length).toBeGreaterThan(10);
    expect(snap.line).toBe('');
  }, 60_000);

  it('Ctrl-C clears text first, then hints; Ctrl-D on empty line is EOF', () => {
    const engine = new ShellEngine();
    engine.handle({ sequence: 'abc' });
    let snap = engine.handle(key('c', { ctrl: true }));
    expect(snap.line).toBe('');
    expect(snap.interrupt).toBe(false);
    snap = engine.handle(key('c', { ctrl: true }));
    expect(snap.interrupt).toBe(true);

    const engine2 = new ShellEngine();
    snap = engine2.handle(key('d', { ctrl: true }));
    expect(snap.eof).toBe(true);
    engine2.handle({ sequence: 'x' });
    snap = engine2.handle(key('d', { ctrl: true }));
    expect(snap.eof).toBe(false); // non-empty Ctrl-D edits, never exits
  });

  it('PageUp/PageDown request pane scroll deltas', () => {
    const engine = new ShellEngine();
    expect(engine.handle(key('pageup')).scrollDelta).toBe(1);
    expect(engine.handle(key('pagedown')).scrollDelta).toBe(-1);
    expect(engine.handle({ sequence: 'a' }).scrollDelta).toBe(0);
  });

  it('SGR mouse wheel scrolls history; clicks never type into the line', () => {
    // Both raw and ESC-stripped forms (Ink drops one leading ESC).
    expect(toEngineKey('\x1b[<64;10;5M', {})).toEqual({ name: 'wheelup' });
    expect(toEngineKey('[<65;10;5M', {})).toEqual({ name: 'wheeldown' });
    const engine = new ShellEngine();
    expect(engine.handle({ name: 'wheelup' }).wheelDelta).toBe(1);
    expect(engine.handle({ name: 'wheeldown' }).wheelDelta).toBe(-1);
    // Button press/release reports are swallowed — without this they fell
    // through to the paste branch and typed `[<0;10;5M` into the input.
    engine.handle({ sequence: 'x' });
    const click = engine.handle(toEngineKey('\x1b[<0;10;5M', {}));
    expect(click.line).toBe('x');
    expect(click.wheelDelta).toBe(0);
    const release = engine.handle(toEngineKey('\x1b[<0;10;5m', {}));
    expect(release.line).toBe('x');
  });

  it('classifies pointer encodings and refuses to type terminal answers', () => {
    // Degraded ink tokenization (ESC stripped and/or "[" dropped) must still
    // be recognized as pointer input — those forms fell into the paste branch
    // and typed garbage into the composer, and into the hidden key buffer.
    expect(classifyPointer('\x1b[<0;10;5M')).toBe('pointer');
    expect(classifyPointer('[<0;10;5M')).toBe('pointer');
    expect(classifyPointer('<0;10;5M')).toBe('pointer');
    expect(classifyPointer('\x1b[<64;10;5M')).toBe('wheel');
    expect(classifyPointer('\x1b[M   ')).toBe('pointer'); // X10 click
    expect(classifyPointer('plain typing')).toBeNull();

    // Unrecognized terminal answers and X10 never become typed text.
    expect(toEngineKey('\x1b[10;20R', {})).toEqual({ name: 'unknown' }); // cursor report
    expect(toEngineKey('\x1b[M   ', {})).toEqual({ name: 'unknown' });
    expect(toEngineKey('<0;10;5M', {})).toEqual({ name: 'unknown' });
    // Real typing is untouched.
    expect(toEngineKey('hello', {})).toEqual({ sequence: 'hello' });
  });
});

describe('interactive renderer routing (checkpoint: no TUI on plain/non-TTY)', () => {
  it('selects Ink only for a real interactive TTY', () => {
    expect(interactiveRenderer({ isTTY: true, plain: false, forceTty: false })).toBe('ink');
    expect(interactiveRenderer({ isTTY: false, plain: false, forceTty: false })).toBe('classic');
    expect(interactiveRenderer({ isTTY: false, plain: false, forceTty: true })).toBe('classic');
    expect(interactiveRenderer({ isTTY: true, plain: true, forceTty: false })).toBe('classic');
    expect(interactiveRenderer({ isTTY: true, plain: false, forceTty: true })).toBe('classic');
  });

  it('maps ink key events onto engine keys', () => {
    expect(toEngineKey('', { return: true })).toEqual({ name: 'return' });
    expect(toEngineKey('', { escape: true })).toEqual({ name: 'escape' });
    expect(toEngineKey('\t', {})).toEqual({ name: 'tab' });
    expect(toEngineKey('', { upArrow: true })).toEqual({ name: 'up' });
    expect(toEngineKey('\x03', { ctrl: true })).toEqual({ name: 'c', ctrl: true });
    expect(toEngineKey('\x04', { ctrl: true })).toEqual({ name: 'd', ctrl: true });
    expect(toEngineKey('a', {})).toEqual({ sequence: 'a' });
    expect(toEngineKey('\x1b[3~', { escape: true })).toEqual({ name: 'delete' });
    expect(toEngineKey('', { delete: true })).toEqual({ name: 'delete' });
    expect(toEngineKey('', { shift: true, tab: true })).toEqual({ name: 'shiftTab' });
    expect(toEngineKey('\x1b[Z', { escape: true })).toEqual({ name: 'shiftTab' });
  });
});

describe('spike cross-process driver (built dist, real child spawn)', () => {
  it('spawns the built shell and passes the full checklist', async () => {
    const { execFile } = await import('node:child_process');
    const { join: joinPath } = await import('node:path');
    const { REPO_ROOT } = await import('./helpers.js');
    const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [joinPath(REPO_ROOT, 'scripts', 'spike-drive.mjs')],
        { cwd: REPO_ROOT, timeout: 90_000 },
        (error, stdout, stderr) =>
          resolve({
            code:
              error && typeof (error as { code?: number }).code === 'number'
                ? (error as { code: number }).code
                : 0,
            stdout,
            stderr,
          }),
      );
    });
    // execFile errors carry the exit code on non-zero; normalize:
    expect(out.stdout + out.stderr).toContain('PASS spike-drive');
    expect(out.code).toBe(0);
  }, 120_000);
});

describe('Ink spike view (fake streams)', () => {
  function startCapture(): {
    stdout: PassThrough;
    stdin: PassThrough;
    output: () => string;
    done: Promise<number>;
    write: (data: string) => void;
  } {
    process.env.IDEASEEK_TTY_ROWS = '40';
    process.env.IDEASEEK_TTY_COLS = '100';
    const stdout = new PassThrough() as PassThrough & { isTTY: boolean };
    // ink renders incrementally only for TTY-like stdout; fake it so state
    // updates (events, palette) produce new frames on the stream.
    stdout.isTTY = true;
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: (mode: boolean) => void;
    };
    // ink6 demands a raw-capable stdin; fake the TTY surface so the real
    // input parser runs against our byte stream (PTY-equivalent coverage).
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    // ink's useInput ref/unrefs the stream (keep-alive) — PassThrough lacks it.
    (stdin as unknown as { ref: () => void }).ref = () => {};
    (stdin as unknown as { unref: () => void }).unref = () => {};
    let buffer = '';
    stdout.on('data', (chunk) => (buffer += String(chunk)));
    const done = startShellSpike(['header-alpha', 'header-beta'], {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
    }).finally(() => {
      delete process.env.IDEASEEK_TTY_ROWS;
      delete process.env.IDEASEEK_TTY_COLS;
    });
    return {
      stdout,
      stdin,
      output: () => buffer,
      done,
      write: (data) => stdin.write(data),
    };
  }

  async function waitFor(output: () => string, pattern: RegExp, timeoutMs = 8_000): Promise<void> {
    const started = Date.now();
    while (!pattern.test(output())) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timeout waiting for ${pattern}; output:\n${output().slice(-1500)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  it('enters the alternate screen, renders the fixed layout and restores on exit', async () => {
    const cap = startCapture();
    await waitFor(cap.output, /header-alpha/);
    expect(cap.output()).toContain('header-beta');
    expect(cap.output()).toContain('ideaseek ›');
    expect(cap.output()).toContain('Tab complete');
    expect(cap.output()).toContain('\x1b[?1049h'); // alternate screen ON

    // Background events keep refreshing while idle.
    await waitFor(cap.output, /background event #/);

    // Ctrl-D exits; the primary screen is restored.
    // Ctrl-C on an empty line surfaces the hint (engine interrupt).
    cap.write('\x03');
    await waitFor(cap.output, /Ctrl-C: use Ctrl-D/);

    // Resize re-renders without crashing (env-fixed rows re-read).
    (cap.stdout as unknown as { emit(event: string): void }).emit('resize');
    await waitFor(cap.output, /ideaseek ›/);
    cap.write('\x04');
    const code = await cap.done;
    expect(code).toBe(0);
    expect(cap.output()).toContain('\x1b[?1049l'); // alternate screen OFF
  }, 30_000);

  it('shows typed input, filters the palette with keys and echoes a submit', async () => {
    const cap = startCapture();
    await waitFor(cap.output, /ideaseek ›/);

    cap.write('/');
    await waitFor(cap.output, /> \/help/);
    cap.write('st');
    await waitFor(cap.output, /ideaseek › \/st/);
    expect(cap.output()).toContain('/status');

    // Down arrow selects and fills the input.
    cap.write('\x1b[B');
    await waitFor(cap.output, /> \/status/);

    // Enter submits the selected command (spike echo).
    cap.write('\r');
    await waitFor(cap.output, /would run: \/status/);

    // Esc on a fresh '/' palette clears input (classic contract).
    cap.write('/');
    await waitFor(cap.output, /\/quit/);
    cap.write('\x1b');
    // Lone ESC resolves after ink pending-escape flush; Ctrl-D on its
    // heels would be parsed as one escape sequence.
    await new Promise((resolve) => setTimeout(resolve, 400));
    cap.write('\x04');
    const code = await cap.done;
    expect(code).toBe(0);
  }, 30_000);
});
