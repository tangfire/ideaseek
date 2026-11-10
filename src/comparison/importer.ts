import { spawn } from 'node:child_process';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { classifyLicense, type LicenseKind } from './discover.js';

export interface GitResult {
  code: number;
  out: string;
}

/**
 * Runs git with NO credential prompts (anonymous public clones only):
 * GIT_TERMINAL_PROMPT=0 rejects interactive auth instead of hanging, and no
 * token/ssh-agent material is ever supplied by IdeaSeek.
 */
export async function runGit(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, {
        cwd: opts.cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
          GIT_CONFIG_NOSYSTEM: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new IdeaseekError('ENV_UNSUPPORTED', `git not available: ${(error as Error).message}`),
      );
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk) => (out += String(chunk)));
    child.stderr?.on('data', (chunk) => (out += String(chunk)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new IdeaseekError('NETWORK_BLOCKED', `git ${args[0]} timed out`));
    }, opts.timeoutMs ?? 120_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new IdeaseekError('ENV_UNSUPPORTED', `git unavailable: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

export async function gitHeadCommit(repoDir: string): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd: repoDir, timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `cannot read HEAD of ${repoDir}: ${result.out.slice(0, 200)}`,
    );
  }
  return result.out.trim();
}

async function readLicense(repoDir: string): Promise<string | null> {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
    try {
      await access(join(repoDir, name));
      const head = (await readFile(join(repoDir, name), 'utf8')).slice(0, 120).replace(/\s+/g, ' ');
      return head.trim();
    } catch {
      continue;
    }
  }
  return null;
}

export interface ImportRepoInput {
  /** Project-relative comparison root, e.g. comparisons/method-a. */
  methodDir: string;
  /** Public HTTPS URL or local path (file:// or plain path for fixtures). */
  url: string;
  branch?: string;
}

export interface ImportRepoResult {
  upstreamDir: string;
  worktreeDir: string;
  commit: string;
  license: string | null;
  licenseKind: LicenseKind;
  remoteUrl: string;
}

/**
 * Imports a comparison repository with upstream/worktree isolation
 * (docs: 原始 upstream 只读；修改只发生在 worktree):
 * - shallow anonymous clone into <methodDir>/upstream (never rewritten),
 * - a linked worktree at <methodDir>/worktree for all future edits.
 * Re-import refuses to overwrite an existing upstream (idempotent callers
 * check first); no credentials are ever passed.
 */
export async function importComparisonRepo(
  projectRoot: string,
  input: ImportRepoInput,
): Promise<ImportRepoResult> {
  const methodDir = join(projectRoot, ...input.methodDir.split('/'));
  const upstreamDir = join(methodDir, 'upstream');
  const worktreeDir = join(methodDir, 'worktree');

  try {
    await stat(upstreamDir);
    throw new IdeaseekError(
      'ALREADY_INITIALIZED',
      `upstream already exists for ${input.methodDir} (re-import refused; remove it manually to replace)`,
    );
  } catch (error) {
    if (error instanceof IdeaseekError) throw error;
    // does not exist → proceed
  }

  await mkdir(methodDir, { recursive: true });
  const cloneArgs = ['clone', '--depth', '1'];
  if (input.branch) cloneArgs.push('--branch', input.branch);
  cloneArgs.push(input.url, upstreamDir);
  const clone = await runGit(cloneArgs, { timeoutMs: 300_000 });
  if (clone.code !== 0) {
    throw new IdeaseekError('NETWORK_BLOCKED', `anonymous clone failed: ${clone.out.slice(-400)}`, {
      url: input.url,
    });
  }

  const commit = await gitHeadCommit(upstreamDir);
  const license = await readLicense(upstreamDir);
  const licenseKind = classifyLicense(license);

  const worktree = await runGit(['worktree', 'add', worktreeDir, 'HEAD'], {
    cwd: upstreamDir,
    timeoutMs: 60_000,
  });
  if (worktree.code !== 0) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `worktree creation failed: ${worktree.out.slice(-300)}`,
    );
  }

  return { upstreamDir, worktreeDir, commit, license, licenseKind, remoteUrl: input.url };
}

/** Verifies upstream was not modified (read-only contract helper for tests). */
export async function upstreamHeadIntact(
  upstreamDir: string,
  expectedCommit: string,
): Promise<boolean> {
  try {
    const head = await gitHeadCommit(upstreamDir);
    const dirty = await runGit(['status', '--porcelain'], { cwd: upstreamDir, timeoutMs: 30_000 });
    return head === expectedCommit && dirty.out.trim() === '';
  } catch {
    return false;
  }
}
