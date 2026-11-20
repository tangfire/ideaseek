import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// setup.sh 的 ensure_persistent_path 必须只按 rc 内容决定是否写
// ~/.bashrc：进程 PATH 里"有"该目录不等于新 shell 能解析到——nvm 在
// 新 shell 启动时把自带 node 插到 /usr/local/bin 前面，旧逻辑据此早退、
// 永不写 rc，doctor 就永远报 node 版本错（I9）。
function extractEnsurePath(): string {
  const src = readFileSync(join(process.cwd(), 'setup.sh'), 'utf8');
  const m = src.match(/^ensure_persistent_path\(\) \{[\s\S]*?^\}/m);
  if (!m) throw new Error('ensure_persistent_path() not found in setup.sh');
  return m[0];
}

// Windows 上没有 /bin/bash（git-bash 走 PATH 解析）。关键：runEnsure 必须
// 用假 PATH 覆盖子进程环境（这正是被测场景），而 Windows spawn 按子进程
// PATH 找可执行文件——所以先在父环境里解析成绝对路径，子进程 PATH 怎么
// 覆盖都不影响；两侧都解析不到时整组诚实跳过。
function resolveBash(): string | null {
  try {
    const probe = process.platform === 'win32' ? ['where', 'bash'] : ['which', 'bash'];
    const out = execFileSync(probe[0]!, [probe[1]!], { encoding: 'utf8', env: process.env });
    return (
      out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? null
    );
  } catch {
    return null;
  }
}
const BASH = resolveBash();

function runEnsure(dir: string, pathValue: string, rcInitial = ''): string {
  const home = mkdtempSync(join(tmpdir(), 'ideaseek-setup-home-'));
  const rc = join(home, '.bashrc');
  writeFileSync(rc, rcInitial);
  execFileSync(BASH!, ['-c', `${extractEnsurePath()}\nensure_persistent_path '${dir}'\n`], {
    env: { ...process.env, HOME: home, PATH: pathValue },
  });
  return readFileSync(rc, 'utf8');
}

describe.skipIf(!BASH)('setup.sh ensure_persistent_path', () => {
  const shadowedDir = '/usr/local/bin';
  // 模拟服务器实况：nvm 的 node 目录在前、/usr/local/bin 在后（进程 PATH
  // 里"有"该目录，但新 shell 解析 node 时会被 nvm 抢先）。
  const shadowedPath = `/root/.nvm/versions/node/v22.23.2/bin:${shadowedDir}:/usr/bin:/bin`;

  it('persists a dir that is already in the process PATH but shadowed (I9)', () => {
    const rc = runEnsure(shadowedDir, shadowedPath);
    expect(rc).toContain(`export PATH="${shadowedDir}:$PATH"`);
  });

  it('persists a dir missing from the process PATH', () => {
    const rc = runEnsure('/opt/ideaseek/bin', '/usr/bin:/bin');
    expect(rc).toContain('export PATH="/opt/ideaseek/bin:$PATH"');
  });

  it('is idempotent across repeated runs', () => {
    const dir = '/usr/local/bin';
    const first = runEnsure(dir, `/root/.nvm/bin:${dir}:/usr/bin:/bin`);
    const second = runEnsure(dir, `/root/.nvm/bin:${dir}:/usr/bin:/bin`, first);
    expect(second.match(new RegExp(`export PATH="${dir}:`, 'g'))).toHaveLength(1);
  });

  it('does not duplicate a line already present in rc', () => {
    const dir = '/usr/local/bin';
    const seeded = `export PATH="${dir}:$PATH"\n`;
    const rc = runEnsure(dir, `/root/.nvm/bin:${dir}:/usr/bin:/bin`, seeded);
    expect(rc.match(new RegExp(`export PATH="${dir}:`, 'g'))).toHaveLength(1);
  });
});
