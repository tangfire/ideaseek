import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { action, jsonLine } from './shared.js';
import { IdeaseekError } from '../core/errors.js';
import { projectPaths } from '../config/paths.js';
import { loadConfig } from '../config/config.js';
import { saveUserCredential } from '../models/setup.js';
import { loadUserCredentials } from '../core/env.js';
import { pushProject, readStatus, type CloudTarget } from '../cloud/push.js';
import { discardQueue, cloudDirs, loadState, saveState, EMPTY_STATE } from '../cloud/buffer.js';
import { ProjectRuntime } from '../workflow/runtime.js';

/**
 * `ideaseek cloud` (M2 切片 4): CLI 接线——link/push/status/reset/discard。
 *
 * 纪律：
 * - `link` 只存引用（`env:NAME`），真实 token 经 `saveUserCredential` 落用户级凭据文件，
 *   research.yaml 里永远不出现密钥值。
 * - `push` 读 research.yaml 的 `cloud:` 段取 site + tokenRef，解析凭据后调用 `pushProject`，
 *   绝不回显 token。
 * - `status` 只读本地状态（游标/队列/熔断），一个字节不出网。
 * - `reset` 清空熔断状态（`state.stop = null`），不丢缓冲也不动游标——给人一次重试机会。
 * - `discard` 清空缓冲+游标+熔断——destructive，用于熔断后彻底重来。
 */

export function registerCloudCommand(program: Command): void {
  const cloud = program
    .command('cloud')
    .description('sync project to IdeaSeek Cloud (link / push / status / reset / discard)');

  cloud
    .command('link')
    .description('link this project to a cloud target (site + credential reference)')
    .argument('<site>', 'cloud site URL (e.g. https://demo.qoder.site)')
    .argument('<token-name>', 'credential name (env:NAME) where the sync token is stored')
    .option('--token <value>', 'save this token value under the given name (interactive setup)')
    .action(
      action(async (site: string, tokenName: string, opts: { token?: string }) => {
        if (!site.startsWith('http://') && !site.startsWith('https://')) {
          throw new IdeaseekError('INVALID_ARGUMENT', 'site must start with http:// or https://');
        }
        if (!tokenName.startsWith('env:')) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            'token-name must be a credential reference like env:IDEASEEK_CLOUD_SYNC_TOKEN',
          );
        }
        const envName = tokenName.slice(4);
        if (opts.token) {
          await saveUserCredential(envName, opts.token);
          process.stdout.write(`saved credential ${envName}\n`);
        }
        const paths = projectPaths(process.cwd());
        const raw = await readFile(paths.configFile, 'utf8').catch(() => null);
        if (!raw) {
          throw new IdeaseekError('INVALID_STATE', 'no research.yaml — run ideaseek init first');
        }
        const yaml = JSON.parse(raw) as Record<string, unknown>;
        yaml.cloud = { site, tokenRef: tokenName };
        const { writeFileAtomic } = await import('../core/atomic.js');
        await writeFileAtomic(paths.configFile, JSON.stringify(yaml, null, 2) + '\n');
        process.stdout.write(`linked to ${site} (credential ${tokenName})\n`);
        return 0;
      }),
    );

  cloud
    .command('push')
    .description('push project state to the cloud (dry-run: project only, send nothing)')
    .option('--dry-run', 'project and count, but do not write queue or open socket')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { dryRun?: boolean; json?: boolean }) => {
        loadUserCredentials();
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          const paths = projectPaths(process.cwd());
          const config = await loadConfig(paths);
          const cloudSection = (config.resolved as unknown as Record<string, unknown>).cloud as
            { site: string; tokenRef: string } | undefined;
          if (!cloudSection) {
            throw new IdeaseekError(
              'INVALID_STATE',
              'no cloud section in research.yaml — run ideaseek cloud link first',
            );
          }
          const target: CloudTarget = { site: cloudSection.site, tokenRef: cloudSection.tokenRef };
          const token = resolveTokenValue(target.tokenRef);
          if (!token) {
            throw new IdeaseekError(
              'AUTH_REQUIRED',
              `credential ${target.tokenRef} not found — run ideaseek cloud link --token <value>`,
            );
          }
          const report = await pushProject(runtime, target, {
            site: target.site,
            token,
            dryRun: opts.dryRun,
          });
          if (opts.json) {
            process.stdout.write(jsonLine(report));
          } else {
            process.stdout.write(formatPushReport(report));
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  cloud
    .command('status')
    .description('show local sync status (cursors, queue, stop reason) — no network')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        loadUserCredentials();
        const paths = projectPaths(process.cwd());
        const config = await loadConfig(paths);
        const cloudSection = (config.resolved as unknown as Record<string, unknown>).cloud as
          { site: string; tokenRef: string } | undefined;
        const linked = cloudSection
          ? { site: cloudSection.site, tokenRef: cloudSection.tokenRef }
          : { site: null, tokenRef: null };
        const tokenPresent = linked.tokenRef ? Boolean(resolveTokenValue(linked.tokenRef)) : false;
        const status = await readStatus(paths.researchDir, linked, tokenPresent);
        if (opts.json) {
          process.stdout.write(jsonLine(status));
        } else {
          process.stdout.write(formatStatusReport(status));
        }
        return 0;
      }),
    );

  cloud
    .command('reset')
    .description('clear the terminal stop state (allows retry after circuit breaker)')
    .action(
      action(async () => {
        const paths = projectPaths(process.cwd());
        const dirs = cloudDirs(paths.researchDir);
        const state = await loadState(dirs);
        if (!state.stop) {
          process.stdout.write('no stop state to reset\n');
          return 0;
        }
        const cleared = state.stop;
        await saveState(dirs, { ...state, stop: null });
        process.stdout.write(`cleared stop: ${cleared.kind} (${cleared.detail})\n`);
        return 0;
      }),
    );

  cloud
    .command('discard')
    .description('discard all queued batches and reset cursors to 0 (destructive)')
    .action(
      action(async () => {
        const paths = projectPaths(process.cwd());
        const dirs = cloudDirs(paths.researchDir);
        const result = await discardQueue(dirs);
        await saveState(dirs, EMPTY_STATE);
        process.stdout.write(
          `discarded ${result.discarded} batch(es), cursors reset to 0 (next push replays from start)\n`,
        );
        return 0;
      }),
    );
}

function resolveTokenValue(tokenRef: string): string | null {
  if (!tokenRef.startsWith('env:')) return null;
  const name = tokenRef.slice(4);
  return process.env[name] ?? null;
}

function formatPushReport(report: {
  projected: number;
  enqueued: number;
  sent: number;
  accepted: number;
  replayed: number;
  queuedRemaining: number;
  bytesSent: number;
  eventsSent: number;
  dryRun: boolean;
  stopped: { kind: string; detail: string } | null;
  expired: number;
}): string {
  const lines: string[] = [];
  if (report.dryRun) {
    lines.push('dry run (no writes, no network)');
    lines.push(`  projected: ${report.projected} batch(es)`);
    lines.push(`  bytes: ${report.bytesSent}`);
    lines.push(`  events: ${report.eventsSent}`);
  } else {
    lines.push('push complete');
    lines.push(`  projected: ${report.projected}, enqueued: ${report.enqueued}`);
    lines.push(
      `  sent: ${report.sent} (accepted: ${report.accepted}, replayed: ${report.replayed})`,
    );
    lines.push(`  bytes: ${report.bytesSent}, events: ${report.eventsSent}`);
    lines.push(`  queued remaining: ${report.queuedRemaining}`);
    if (report.expired > 0) lines.push(`  expired: ${report.expired} batch(es) moved to dropped/`);
    if (report.stopped) {
      lines.push(`  stopped: ${report.stopped.kind} — ${report.stopped.detail}`);
    }
  }
  return lines.join('\n') + '\n';
}

function formatStatusReport(status: {
  linked: boolean;
  site: string | null;
  tokenRef: string | null;
  tokenPresent: boolean;
  cursors: Record<string, number>;
  queued: number;
  unreadable: number;
  lastOkAt: number | null;
  stop: { kind: string; detail: string; attempts: number } | null;
  dropped: number;
  backoff: { baseMs: number; capMs: number; maxAttempts: number };
  retentionMs: number;
}): string {
  const lines: string[] = [];
  lines.push('cloud status');
  lines.push(`  linked: ${status.linked}`);
  if (status.linked) {
    lines.push(`  site: ${status.site}`);
    lines.push(`  token: ${status.tokenPresent ? 'present' : 'missing'}`);
  }
  lines.push(`  cursors: ${Object.keys(status.cursors).length} run(s)`);
  for (const [runId, seq] of Object.entries(status.cursors)) {
    lines.push(`    ${runId}: ${seq}`);
  }
  lines.push(`  queued: ${status.queued} batch(es)`);
  if (status.unreadable > 0) lines.push(`  unreadable: ${status.unreadable} file(s) (bad JSON)`);
  if (status.lastOkAt) {
    lines.push(`  last success: ${new Date(status.lastOkAt).toISOString()}`);
  }
  if (status.stop) {
    lines.push(`  stopped: ${status.stop.kind} (${status.stop.attempts} attempt(s))`);
    lines.push(`    ${status.stop.detail}`);
  }
  if (status.dropped > 0) lines.push(`  dropped: ${status.dropped} batch(es) in archive`);
  lines.push(
    `  backoff: ${status.backoff.baseMs}ms → ${status.backoff.capMs}ms (max ${status.backoff.maxAttempts})`,
  );
  lines.push(`  retention: ${status.retentionMs / (24 * 60 * 60 * 1000)} days`);
  return lines.join('\n') + '\n';
}
