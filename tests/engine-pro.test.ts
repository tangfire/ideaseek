import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShellEngine, toEngineKey } from '../src/cli/shell/engine.js';
import {
  filterMentions,
  getSlashArgSuggestions,
  scanWorkspaceMentions,
} from '../src/cli/shell/mentions.js';
import { formatStatusTelemetry, readLiveStatusSnapshot } from '../src/cli/shell/status-bar.js';
import { makeProjectDir, openRuntime, createDemoRun } from './helpers.js';

describe('Composer Pro: multi-line, paste collapse, @-mentions, arg-completion, Ctrl+R', () => {
  it('supports Shift+Enter / Ctrl+J multi-line editing and vertical navigation', () => {
    const engine = new ShellEngine();
    engine.handle({ sequence: 'line one' });
    engine.handle(toEngineKey('\x1b\r', {})); // Alt+Enter → newline
    engine.handle({ sequence: 'line two' });
    let snap = engine.handle({ name: 'up' });
    expect(snap.cursor).toBe('line one'.length); // moved onto first line
    snap = engine.handle({ name: 'return' });
    expect(snap.submit).toBe('line one\nline two');
    expect(snap.line).toBe('');
  });

  it('collapses large multi-line pastes into a token and expands on submit', () => {
    const engine = new ShellEngine();
    const bigPaste = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
    const afterPaste = engine.handle({ sequence: bigPaste });
    expect(afterPaste.line).toContain('[Pasted #1 · 5 lines]');
    const submitted = engine.handle({ name: 'return' });
    expect(submitted.submit).toBe(bigPaste);
  });

  it('completes @mentions mid-sentence without discarding surrounding text', () => {
    const engine = new ShellEngine();
    engine.setMentions([
      {
        kind: 'mention',
        value: '@papers/fedbn.pdf',
        label: '@papers/fedbn.pdf',
        description: 'papers file',
      },
      {
        kind: 'mention',
        value: '@comparisons/rethinkfl',
        label: '@comparisons/rethinkfl/',
        description: 'comparisons directory',
      },
    ]);
    engine.handle({ sequence: 'summarize @fed' });
    const palette = engine.handle({ sequence: '' });
    expect(palette.paletteOpen).toBe(true);
    expect(palette.paletteMode).toBe('mention');
    expect(palette.paletteItems).toEqual(['@papers/fedbn.pdf']);

    const completed = engine.handle({ name: 'tab' });
    expect(completed.line).toBe('summarize @papers/fedbn.pdf ');
    expect(completed.paletteOpen).toBe(false);
  });

  it('suggests slash sub-arguments without hijacking exact Enter submission', () => {
    const engine = new ShellEngine();
    engine.handle({ sequence: '/mode ' });
    const open = engine.handle({ sequence: '' });
    expect(open.paletteOpen).toBe(true);
    expect(open.paletteMode).toBe('arg');
    expect(open.paletteItems).toContain('analysis');

    // Typing exact option closes arg suggestion and Enter submits directly.
    engine.handle({ sequence: 'analysis' });
    const submitted = engine.handle({ name: 'return' });
    expect(submitted.submit).toBe('/mode analysis');
  });

  it('supports Ctrl+R reverse history search and word movement', () => {
    const engine = new ShellEngine();
    engine.handle({ sequence: '/status' });
    engine.handle({ name: 'return' });
    engine.handle({ sequence: '/papers' });
    engine.handle({ name: 'return' });

    engine.handle({ name: 'r', ctrl: true });
    let snap = engine.handle({ sequence: 'sta' });
    expect(snap.historySearch?.match).toBe('/status');
    snap = engine.handle({ name: 'right' });
    expect(snap.historySearch).toBeNull();
    expect(snap.line).toBe('/status');

    snap = engine.handle({ name: 'wordleft' });
    expect(snap.cursor).toBe(0);
    snap = engine.handle({ name: 'wordright' });
    expect(snap.cursor).toBe('/status'.length);
  });
});

describe('Workspace mentions & live statusline snapshot', () => {
  it('scans project research folders and ranks fuzzy queries cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-mentions-'));
    try {
      await mkdir(join(dir, 'papers'), { recursive: true });
      await mkdir(join(dir, 'comparisons', 'rethinkfl'), { recursive: true });
      await writeFile(join(dir, 'papers', 'pacs-survey.pdf'), 'pdf', 'utf8');
      const items = await scanWorkspaceMentions(dir);
      expect(items.some((i) => i.value === '@papers/pacs-survey.pdf')).toBe(true);
      expect(items.some((i) => i.value === '@comparisons/rethinkfl')).toBe(true);
      const filtered = filterMentions(items, '@rethink');
      expect(filtered[0]?.value).toBe('@comparisons/rethinkfl');
      expect(getSlashArgSuggestions('/models', 'pro')[0]?.value).toBe('providers');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads live status telemetry in-process and formats compact progress bars', async () => {
    const dir = await makeProjectDir('live-status');
    try {
      const runtime = await openRuntime(dir);
      try {
        await createDemoRun(runtime, 'test question');
      } finally {
        await runtime.close();
      }
      const snap = await readLiveStatusSnapshot(dir);
      expect(snap).not.toBeNull();
      expect(snap!.project).toBe('live-status');
      expect(snap!.tasksTotal).toBeGreaterThan(0);
      const formatted = formatStatusTelemetry(snap, 48);
      expect(formatted).toContain(`0/${snap!.tasksTotal}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
