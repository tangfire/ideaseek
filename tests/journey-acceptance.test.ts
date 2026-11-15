import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, REPO_ROOT } from './helpers.js';

/**
 * USER_JOURNEY_ACCEPTANCE — automated acceptance for the journeys that
 * run entirely on local CLI (A, B, C, E). Journeys D/F/G/H depend on
 * full-run pipelines, backup/restore tooling or real research outcomes
 * and are tracked as their own PROGRESS items; this suite pins the
 * product rule at the top of the doc: every step tells the user the
 * state, the next command, and never leaks a secret.
 */

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function assertNoSecret(...blobs: string[]): void {
  for (const blob of blobs) {
    expect(blob).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(blob).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  }
}

describe('Journey A — first use from an empty directory', () => {
  it('version, doctor, idempotent init, start with a copyable next', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'journey-a-'));

    // 安装确认版本（source-built channel until npm publish lands）
    const version = await runCli(dir, ['--version']);
    expect(version.code).toBe(0);
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(version.stdout.trim()).toContain(pkg.version);

    // doctor 人话说明缺少什么，不打印 secret
    const doctor = await runCli(dir, ['doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('no .research/');
    expect(doctor.stdout).toContain('ideaseek init');
    assertNoSecret(doctor.stdout, doctor.stderr);

    // init 幂等，不覆盖已有文件
    const init1 = await runCli(dir, ['init']);
    expect(init1.code).toBe(0);
    expect(init1.stdout).toContain('next:');
    const init2 = await runCli(dir, ['init']);
    expect(init2.code).toBe(0);
    expect(init2.stdout).toContain('already initialized');

    // start 发现空项目并给出最小输入提示 + 下一条可复制命令
    const start = await runCli(dir, ['start']);
    expect(start.code).toBe(0);
    expect(start.stdout).toContain('0 file(s)');
    expect(start.stdout).toMatch(/papers\/|datasets\//);
    // The bootstrap must not route an empty project into the fake-worker demo
    // pipeline; it points at whatever the material assessment says is missing.
    expect(start.stdout).not.toMatch(/next: ideaseek run\b/);
    expect(start.stdout).toMatch(/next: ideaseek /);
    assertNoSecret(start.stdout, start.stderr);
  }, 180_000);
});

describe('Journey B — model configuration', () => {
  it('shows the four tiers and a fully redacted --json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'journey-b-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);

    const list = await runCli(dir, ['models', 'list']);
    expect(list.code).toBe(0);
    for (const tier of ['fast', 'balanced', 'deep', 'deterministic']) {
      expect(list.stdout).toContain(tier);
    }
    // Credential presence only — never the value.
    expect(list.stdout).toContain('presence');
    assertNoSecret(list.stdout, list.stderr);

    const json = await runCli(dir, ['models', 'list', '--json']);
    expect(json.code).toBe(0);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    assertNoSecret(json.stdout, json.stderr);
    // No raw key material fields in the payload.
    expect(json.stdout).not.toMatch(/"apiKey"|"key"\s*:\s*"sk-/);
  }, 120_000);
});

describe('Journey C — inputs, scan, intake, plan', () => {
  it('groups inputs, finds duplicates, never moves originals, plans with counts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'journey-c-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);

    // 用户放入材料，不需要理解内部契约
    await writeFile(join(dir, 'papers', 'alpha.pdf'), '%PDF-1.4 alpha');
    await writeFile(join(dir, 'papers', 'alpha-copy.pdf'), '%PDF-1.4 alpha'); // duplicate bytes
    await mkdir(join(dir, 'datasets', 'd1'), { recursive: true });
    await writeFile(join(dir, 'datasets', 'd1', 'train.csv'), 'a,b\n1,2\n');
    await mkdir(join(dir, 'comparisons', 'method-a'), { recursive: true });
    await writeFile(join(dir, 'comparisons', 'method-a', 'README.md'), '# method a');
    await writeFile(join(dir, 'incoming', 'mystery.xyz'), '???');
    const original = await readFile(join(dir, 'papers', 'alpha.pdf'), 'utf8');

    const scan = await runCli(dir, ['scan']);
    expect(scan.code).toBe(0);

    // 扫描按论文/数据/代码/歧义分组 + 识别重复 + 原始文件不移动
    const intake = await runCli(dir, ['intake']);
    expect(intake.code).toBe(0);
    expect(intake.stdout).toContain('paper');
    expect(intake.stdout).toContain('dataset');
    expect(intake.stdout).toContain('待分类');
    expect(intake.stdout).toContain('重复内容');
    expect(await readFile(join(dir, 'papers', 'alpha.pdf'), 'utf8')).toBe(original);

    // plan dry-run 给出论文数/数据集/comparison/idea 上限/估算，且不启动任何东西
    const plan = await runCli(dir, ['plan', '--question', 'journey c question', '--json']);
    expect(plan.code).toBe(0);
    const payload = JSON.parse(plan.stdout) as {
      question: string;
      inputs: { paperFiles: number; manifestFiles: number };
      comparisons: { total: number };
      ideas: { limit: number };
      model: { route: string };
    };
    expect(payload.inputs.paperFiles).toBeGreaterThanOrEqual(2);
    expect(payload.inputs.manifestFiles).toBeGreaterThan(0);
    // Comparison registry count is displayed (0 before any register/import —
    // the bullet is that the plan SHOWS it, not that methods exist yet).
    expect(typeof payload.comparisons.total).toBe('number');
    expect(payload.ideas.limit).toBeGreaterThan(0);
    expect(payload.model.route).toBeTruthy();
    assertNoSecret(plan.stdout, plan.stderr);
  }, 180_000);
});

describe('Journey E — natural language over a run', () => {
  it('answers status queries and turns high-impact asks into pending decisions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'journey-e-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    // A run must exist for state queries (enqueue-only is enough).
    const run = await runCli(dir, ['run', '--question', 'journey e question', '--enqueue-only']);
    expect(run.code, run.stdout + run.stderr).toBe(0);

    // 查询类自然语言直接回答并引用状态
    const query = await runCli(dir, ['ask', '项目状态是什么']);
    expect(query.code).toBe(0);
    expect(query.stdout.trim().length).toBeGreaterThan(0);
    assertNoSecret(query.stdout, query.stderr);

    // 高影响请求 → 待审批 Decision，绝不执行
    const high = await runCli(dir, ['ask', '优先验证 idea-001']);
    const combined = high.stdout + high.stderr;
    expect(combined).toMatch(/pending|Decision|审批/i);
    // 不是静默执行：没有 idea 状态被改动的迹象
    const ideas = await runCli(dir, ['idea', 'list']);
    expect(ideas.stdout).not.toContain('idea-001');
    assertNoSecret(combined);
  }, 180_000);
});
