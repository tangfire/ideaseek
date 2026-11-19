import { mkdtempSync, symlinkSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram, helpGroupsOf } from '../src/cli.js';

/**
 * The command surface is the product's navigability. Sixty-one commands in
 * registration order is a list, not a map, and the failure mode as the tool
 * grows is a new command appearing under "其他" or not appearing at all.
 */
describe('help grouping', () => {
  it('assigns every top-level command to a real group', () => {
    const program = buildProgram();
    const ungrouped = program.commands
      .map((command) => ({ name: command.name(), group: helpGroupsOf().get(command.name()) }))
      .filter((entry) => entry.group === undefined || entry.group === '其他');
    expect(ungrouped.map((entry) => entry.name)).toEqual([]);
  });

  it('lists no command that does not exist', () => {
    const program = buildProgram();
    const names = new Set(program.commands.map((command) => command.name()));
    const stale = [...helpGroupsOf().keys()].filter((name) => !names.has(name));
    expect(stale).toEqual([]);
  });

  it('help shows the journey groups and the product description', () => {
    const help = buildProgram().helpInformation();
    for (const title of ['开始与配置', '读懂已有输入', '想法与推进', '运行、观察与恢复']) {
      expect(help).toContain(title);
    }
    expect(help).not.toContain('Phase 0');
    expect(help).not.toContain('demo pipeline');
  });
});

it('answers the natural guess `idea status` with the workspace view', () => {
  // The lifecycle status is the most-asked question about an idea, and the
  // obvious verb was refused while `show` held the answer.
  const idea = buildProgram().commands.find((command) => command.name() === 'idea');
  const show = idea?.commands.find((command) => command.name() === 'show');
  expect(show?.aliases()).toContain('status');
});

describe('installed entry point (symlinked global command)', () => {
  // Honest reporting: Windows without developer mode cannot create file
  // symlinks (EPERM) — skip visibly instead of passing vacuously. Linux,
  // where the product ships and the bug was found, always runs it.
  const symlinkSupport = (() => {
    try {
      const dir = mkdtempSync(join(tmpdir(), 'sl-probe-'));
      symlinkSync(process.execPath, join(dir, 'probe'));
      unlinkSync(join(dir, 'probe'));
      rmdirSync(dir);
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!symlinkSupport)(
    'runs through a symlink: argv[1] link path vs resolved import.meta.url',
    async () => {
      // npm link / ln -s hands node the LINK path while import.meta.url is the
      // resolved file. The old raw string compare made every symlinked install
      // silently no-op on Linux (modules load, warning prints, exit 0, zero
      // output — the server acceptance finding). IDEASEEK_CLI must be OFF here:
      // that env var is the test-only bypass which hid the bug.
      const { mkdtemp, symlink } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join: joinPath } = await import('node:path');
      const { spawn } = await import('node:child_process');
      const { CLI_BIN } = await import('./helpers.js');

      const dir = await mkdtemp(joinPath(tmpdir(), 'ideaseek-symlink-'));
      const link = joinPath(dir, 'ideaseek');
      await symlink(CLI_BIN, link);
      const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [link, ...args], {
            env: { ...process.env, IDEASEEK_CLI: undefined },
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => (stdout += String(chunk)));
          child.stderr.on('data', (chunk) => (stderr += String(chunk)));
          child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
        });

      const help = await run(['--help']);
      expect(help.code, help.stderr).toBe(0);
      expect(help.stdout).toContain('Usage:');
      expect(help.stdout.length).toBeGreaterThan(200);

      // Bare invocation down a pipe: the line-mode door message, not silence.
      const bare = await run([]);
      expect(bare.code, bare.stderr).toBe(0);
      expect(bare.stdout).toContain('no command given');
    },
    60_000,
  );
});
