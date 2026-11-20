import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// setup.sh 必须自举 worker/python 的解析依赖（pypdf/pdfplumber）：
// 缺了它，全新安装后第一次 `ideaseek ingest` 就以 PARSER_MISSING 全量
// 失败——node 栈装好了，核心链路却一步都走不动。
function extractWorkerDepsOk(): string {
  const src = readFileSync(join(process.cwd(), 'setup.sh'), 'utf8');
  const m = src.match(/^worker_deps_ok\(\) \{[\s\S]*?^\}/m);
  if (!m) throw new Error('worker_deps_ok() not found in setup.sh');
  return m[0];
}

function makeVenv(name: string, pythonExitCode: number | null): string {
  const venv = join(mkdtempSync(join(tmpdir(), 'ideaseek-venv-')), name);
  if (pythonExitCode === null) return venv; // venv 不存在
  mkdirSync(join(venv, 'bin'), { recursive: true });
  const py = join(venv, 'bin', 'python');
  // env bash：Windows git-bash 内 /bin/bash 未必可解析，env 在两侧都能找到。
  writeFileSync(py, `#!/usr/bin/env bash\nexit ${pythonExitCode}\n`);
  chmodSync(py, 0o755);
  return venv;
}

// Windows 没有 /bin/bash（git-bash 走 PATH）；此前 ENOENT 被 catch 成
// exit 1，恰好让"应失败"的用例假绿、"应就绪"的用例误报——按平台解析
// bash，两侧都拿不到时整组诚实跳过。
function bashBin(): string {
  return process.platform === 'win32' ? 'bash' : '/bin/bash';
}
function hasBash(): boolean {
  try {
    execFileSync(bashBin(), ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runDepsOk(venv: string): number {
  try {
    execFileSync(bashBin(), ['-c', `${extractWorkerDepsOk()}\nworker_deps_ok '${venv}'`], {
      stdio: 'ignore',
    });
    return 0;
  } catch {
    return 1;
  }
}

describe.skipIf(!hasBash())('setup.sh worker_deps_ok', () => {
  it('is ready when the venv python imports pypdf and pdfplumber', () => {
    expect(runDepsOk(makeVenv('ok', 0))).toBe(0);
  });

  it('is not ready when imports fail (pypdf missing)', () => {
    expect(runDepsOk(makeVenv('broken', 1))).toBe(1);
  });

  it('is not ready when the venv does not exist yet', () => {
    expect(runDepsOk(makeVenv('absent', null))).toBe(1);
  });

  it('setup.sh installs requirements.txt and fails loudly with the manual command', () => {
    const src = readFileSync(join(process.cwd(), 'setup.sh'), 'utf8');
    expect(src).toContain('worker/python/requirements.txt');
    expect(src).toContain('python3 -m venv .venv');
    // 自举失败必须终止，而不是带着坏环境继续到 pnpm build（"装完了但用不了"）
    const branch = src.match(/fail "python worker dependency install failed"[\s\S]{0,400}?exit 1/);
    expect(branch).toBeTruthy();
  });
});
