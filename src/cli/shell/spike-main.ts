import { startShellSpike } from './spike.js';

// Platform smoke hook: with IDEASEEK_TTY_FAKE=1 (piped stdin from a
// harness), shim the raw-mode surface so the REAL ink input path runs —
// used to validate PowerShell/WSL launch without allocating a PTY.
// The production REPL only enters Ink when both stdio streams are TTY.
if (process.env.IDEASEEK_TTY_FAKE === '1') {
  const stdin = process.stdin as unknown as {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
    ref?: () => void;
    unref?: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
}

/**
 * Manual spike runner: `pnpm shell:spike` in a real terminal
 * (Windows PowerShell / Windows Terminal / Linux TTY) to eyeball the
 * checklist — alternate screen, fixed panes, palette, keys, resize,
 * Ctrl-C/D and background event refresh.
 */
startShellSpike([
  'IdeaSeek Ink shell spike (ADR-010)',
  'alt-screen · fixed header/activity/input/footer · live / palette',
]).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  },
);
