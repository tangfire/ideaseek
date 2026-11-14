import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShellEngine, toEngineKey } from '../src/cli/shell/engine.js';
import { buildHeaderLines } from '../src/cli/shell/session.js';
import { WarmAgentHost } from '../src/dsh/session.js';
import { writeSessionFocus } from '../src/session/mode.js';
import { executeSessionModeSwitch } from '../src/session/switch.js';
import { createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

describe('In-process mode switch and header build (no cold child spawns)', () => {
  it('switches research <-> analysis in-process, enforces gate and records Decision', async () => {
    const dir = await makeProjectDir('fast-mode');
    try {
      const runtime = await openRuntime(dir);
      try {
        await createDemoRun(runtime, 'test question');
      } finally {
        await runtime.close();
      }
      const toAnalysis = await executeSessionModeSwitch(dir, 'analysis');
      expect(toAnalysis.changed).toBe(true);
      expect(toAnalysis.previous).toBe('research');
      expect(toAnalysis.current).toBe('analysis');
      expect(toAnalysis.decisionSeq).toBeTypeOf('number');

      // Analysis → Research blocked by missing material gaps unless forced.
      await expect(executeSessionModeSwitch(dir, 'research')).rejects.toThrow(
        /blocked by material gaps/,
      );
      const forced = await executeSessionModeSwitch(dir, 'research', { force: true });
      expect(forced.changed).toBe(true);
      expect(forced.current).toBe('research');

      await expect(executeSessionModeSwitch(dir, 'agent')).rejects.toThrow(/不是权限档位/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('builds project and non-project headers directly from persisted state', async () => {
    const prevCwd = process.cwd();
    const emptyDir = await mkdtemp(join(tmpdir(), 'ideaseek-general-hdr-'));
    const projectDir = await makeProjectDir('hdr-proj');
    try {
      process.chdir(emptyDir);
      const general = await buildHeaderLines();
      expect(general.tone).toBe('warn');
      expect(general.lines[0]).toContain('GENERAL');

      process.chdir(projectDir);
      const runtime = await openRuntime(projectDir);
      try {
        await createDemoRun(runtime, 'Why does FedAvg drift?');
      } finally {
        await runtime.close();
      }
      const proj = await buildHeaderLines();
      expect(proj.lines[0]).toContain('hdr-proj · RESEARCH');
      expect(proj.lines[1]).toContain('Why does FedAvg drift?');

      await writeSessionFocus(projectDir, 'coding');
      const coding = await buildHeaderLines();
      expect(coding.lines[0]).toContain('hdr-proj · CODING');
    } finally {
      process.chdir(prevCwd);
      await rm(emptyDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('WarmAgentHost and Alt+M mouse selection toggle', () => {
  it('supports idempotent close/abort on WarmAgentHost', async () => {
    const host = new WarmAgentHost();
    await expect(host.close()).resolves.toBeUndefined();
    await expect(host.abort()).resolves.toBeUndefined();
  });

  it('maps Alt+M to toggleMouse without inserting characters', () => {
    const engine = new ShellEngine();
    expect(toEngineKey('m', { meta: true })).toEqual({ name: 'toggleMouse' });
    expect(toEngineKey('\x1bm', {})).toEqual({ name: 'toggleMouse' });
    const snap = engine.handle({ name: 'toggleMouse' });
    expect(snap.toggleMouse).toBe(true);
    expect(snap.line).toBe('');
  });
});
