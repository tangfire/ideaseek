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
