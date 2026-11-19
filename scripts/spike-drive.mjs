#!/usr/bin/env node
/**
 * Cross-process spike driver: spawns the built Ink shell with piped stdio
 * (IDEASEEK_TTY_FAKE=1), feeds keys ONE CHUNK AT A TIME — a real terminal
 * delivers keystrokes individually, while a piped file would batch them into
 * one chunk that ink's keypress parser treats as paste — and asserts the
 * full checklist: alt-screen enter/exit, layout, palette filter, arrow
 * selection, submit echo, Ctrl-C hint, and a clean /quit exit.
 *
 * Run directly (Windows), under PowerShell, or under WSL Linux node.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spike = join(root, 'dist', 'cli', 'shell', 'spike-main.js');

const child = spawn(process.execPath, [spike], {
  cwd: root,
  env: {
    ...process.env,
    IDEASEEK_TTY_FAKE: '1',
    IDEASEEK_TTY_ROWS: '40',
    IDEASEEK_TTY_COLS: '100',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '';
let err = '';
child.stdout.on('data', (chunk) => (out += String(chunk)));
child.stderr.on('data', (chunk) => (err += String(chunk)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// One chunk per key event: a real terminal delivers keystrokes
// individually; batching "/quit\r" would parse as a single paste.
const keys = ['/', 'st', '\x1b[B', '\r', '\x03', '\r', '/quit', '\r'];

const exited = new Promise((resolve) => child.on('close', (code) => resolve(code ?? -1)));
(async () => {
  // First import of ink over a network/cross-OS filesystem can take many
  // seconds (drvfs); wait for the mount before feeding keys.
  await sleep(Number(process.env.SPIKE_MOUNT_MS ?? 600));
  for (const key of keys) {
    const before = out.length;
    child.stdin.write(key);
    // Wait for the child to consume the key (it repaints on every meaningful
    // keystroke) before sending the next one. A fixed sleep is not enough
    // under parallel-test load: the child's event loop can block long enough
    // for two chunks to coalesce into a single paste.
    const started = Date.now();
    // Full-suite load can starve the child's event loop for seconds; the
    // cap is the coalescing window (two chunks = one paste = lost /quit).
    // Observed failing at 800ms on a 201-file gate while isolated runs
    // never approach it — the cap only binds in the pathological case.
    while (out.length === before && Date.now() - started < 2_000) {
      await sleep(40);
    }
    await sleep(60);
  }
  const code = await Promise.race([
    exited,
    sleep(Number(process.env.SPIKE_EXIT_MS ?? 25_000)).then(() => 'TIMEOUT'),
  ]);
  const checks = {
    exit0: code === 0,
    altEnter: out.includes('\x1b[?1049h'),
    altExit: out.includes('\x1b[?1049l'),
    header: out.includes('IdeaSeek Ink shell spike'),
    input: out.includes('ideaseek ›'),
    palette: out.includes('/status'),
    submitEcho: out.includes('would run: /status'),
    ctrlCHint: out.includes('Ctrl-C: use Ctrl-D'),
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (failed.length > 0) {
    process.stdout.write(`FAIL ${failed.join(',')} (exit=${code})\n`);
    if (err.trim()) process.stdout.write(`stderr: ${err.slice(0, 500)}\n`);
    process.stdout.write(`tail: ${JSON.stringify(out.slice(-400))}\n`);
    process.exit(1);
  }
  process.stdout.write('PASS spike-drive: all checks green\n');
  process.exit(0);
})();
