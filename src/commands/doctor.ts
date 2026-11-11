import type { Command } from 'commander';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DSH_SDK_VERSION } from '../dsh/dsh-adapter.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  embeddingCacheDir,
  installEmbeddingStack,
  probeEmbeddingEnvironment,
} from '../retrieval/embeddings.js';
import { IdeaseekError } from '../core/errors.js';
import { findProjectRoot } from '../config/paths.js';
import { detectEnvironment, type EnvironmentReport } from '../runtime/detect.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { action, jsonLine } from './shared.js';

type Level = 'ok' | 'warn' | 'error' | 'info';

interface Check {
  level: Level;
  name: string;
  detail: string;
}

const MARK: Record<Level, string> = { ok: '✓', warn: '⚠', error: '✗', info: '·' };

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('check configuration, project state and host environment (read-only)')
    .option('--json', 'machine-readable output')
    .option('--install-embeddings', 'install the pinned local embedding stack (network)')
    .action(
      action(async (opts: { json?: boolean; installEmbeddings?: boolean }) => {
        const cwd = process.cwd();
        const root = await findProjectRoot(cwd);
        const checks: Check[] = [];
        let runtime: ProjectRuntime | null = null;
        let env: EnvironmentReport | null = null;

        if (!root) {
          checks.push({
            level: 'warn',
            name: 'project',
            detail: 'no .research/ found here; run: ideaseek init',
          });
        } else {
          checks.push({ level: 'ok', name: 'project', detail: root });
          try {
            runtime = await ProjectRuntime.open({ cwd });
            const { configLoad, recovery } = runtime;
            for (const error of configLoad.errors) {
              checks.push({ level: 'error', name: 'config', detail: error });
            }
            for (const warning of configLoad.warnings) {
              checks.push({ level: 'warn', name: 'config', detail: warning });
            }
            for (const note of configLoad.migrationNotes) {
              checks.push({ level: 'info', name: 'config', detail: note });
            }
            if (configLoad.errors.length === 0 && configLoad.warnings.length === 0) {
              checks.push({
                level: 'ok',
                name: 'config',
                detail: `${configLoad.path} (v${configLoad.resolved.configVersion})`,
              });
            }

            // User-level config: strict validation; credential references
            // resolve by NAME only (never values).
            try {
              const { loadUserConfig, resolveCredentialPresence } =
                await import('../config/user-config.js');
              const user = await loadUserConfig();
              for (const error of user.errors) {
                checks.push({ level: 'error', name: 'user-config', detail: error });
              }
              if (user.errors.length === 0) {
                const presence = resolveCredentialPresence(user.config.models.credentialRef);
                checks.push({
                  level: presence.presence === 'missing' ? 'warn' : 'ok',
                  name: 'user-config',
                  detail:
                    `${user.path} (${user.existed ? 'loaded' : 'defaults'}) · ` +
                    `credentialRef=${presence.ref ?? 'none'} [${presence.presence}]`,
                });
              }
            } catch (error) {
              checks.push({
                level: 'warn',
                name: 'user-config',
                detail: `unreadable: ${(error as Error).message}`,
              });
            }

            for (const dir of [
              'papers',
              'datasets',
              'comparisons',
              'incoming',
              'knowledge',
              'ideas',
              'reports',
            ]) {
              try {
                const info = await stat(join(root, dir));
                checks.push(
                  info.isDirectory()
                    ? { level: 'ok', name: `dir:${dir}`, detail: 'present' }
                    : {
                        level: 'warn',
                        name: `dir:${dir}`,
                        detail: 'exists but is not a directory',
                      },
                );
              } catch {
                checks.push({
                  level: 'warn',
                  name: `dir:${dir}`,
                  detail: 'missing (run ideaseek init)',
                });
              }
            }
            const run = await runtime.db.getLatestRun(runtime.project.id);
            checks.push({
              level: 'info',
              name: 'workflow',
              detail: run ? `latest run ${run.runId} is ${run.status}` : 'no runs yet',
            });
            if (
              recovery.reclaimedLeases.length ||
              recovery.resumedCommits.length ||
              recovery.abandonedCommits.length ||
              recovery.stoppedWorkers.length
            ) {
              checks.push({
                level: 'warn',
                name: 'recovery',
                detail: `repaired on open: reclaimed=${recovery.reclaimedLeases.length} resumed=${recovery.resumedCommits.length} requeued=${recovery.abandonedCommits.length} stoppedWorkers=${recovery.stoppedWorkers.length}`,
              });
            } else {
              checks.push({ level: 'ok', name: 'recovery', detail: 'no repairs needed on open' });
            }
          } catch (error) {
            if (error instanceof IdeaseekError && error.code === 'NOT_INITIALIZED') {
              checks.push({ level: 'warn', name: 'project', detail: error.message });
            } else {
              throw error;
            }
          }
        }

        env = await detectEnvironment(root ?? cwd);
        checks.push({
          level: env.node.supported ? 'ok' : 'error',
          name: 'node',
          detail: `v${env.node.version} (required ${env.node.required})`,
        });
        checks.push({
          level: env.python.available ? 'ok' : 'warn',
          name: 'python',
          detail: env.python.available
            ? `v${env.python.version} (needed by Phase 2+ workers)`
            : 'not found (needed by Phase 2+ workers; install Python 3)',
        });
        const hasContainer =
          env.containerRuntimes.docker.available || env.containerRuntimes.podman.available;
        checks.push({
          level: hasContainer ? 'ok' : 'warn',
          name: 'container',
          detail: hasContainer
            ? [
                env.containerRuntimes.docker.available
                  ? `docker ${env.containerRuntimes.docker.version}`
                  : null,
                env.containerRuntimes.podman.available
                  ? `podman ${env.containerRuntimes.podman.version}`
                  : null,
              ]
                .filter(Boolean)
                .join(', ')
            : 'no docker/podman on PATH (needed for isolated experiments in Phase 4+)',
        });
        checks.push({
          level: env.gpu.nvidiaSmi.available ? 'ok' : 'info',
          name: 'gpu',
          detail: env.gpu.nvidiaSmi.available
            ? `${env.gpu.devices.length} device(s)${env.gpu.cudaVersion ? `, CUDA ${env.gpu.cudaVersion}` : ''}: ${env.gpu.devices.join('; ')}`
            : 'nvidia-smi not found (no GPU visible; Phase 0 does not need one)',
        });
        if (env.disk.freeBytes !== null) {
          const critical = env.disk.freeBytes < 200 * 1024 * 1024;
          checks.push({
            level: critical ? 'error' : 'ok',
            name: 'disk',
            detail: `${fmtBytes(env.disk.freeBytes)} free of ${fmtBytes(env.disk.totalBytes)} at project root`,
          });
        } else {
          checks.push({ level: 'warn', name: 'disk', detail: 'could not stat filesystem' });
        }
        if (opts.installEmbeddings) {
          try {
            const install = await installEmbeddingStack({
              knowledgeDir: root ? join(root, 'knowledge') : join(cwd, 'knowledge'),
              modelId: runtime?.config.runtime.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
            });
            checks.push({
              level: 'ok',
              name: 'embeddings-install',
              detail: `installed ${install.manifest.model} (${install.manifest.license}, ${install.manifest.fingerprint.slice(0, 19)}…) at ${install.manifest.cacheDir}${install.createdVenv ? ' [venv created]' : ''}${install.pipInstalled ? ' [pip ok]' : ''}`,
            });
          } catch (error) {
            checks.push({
              level: 'error',
              name: 'embeddings-install',
              detail: `${(error as Error).message} — BM25/FTS fallback stays active`,
            });
          }
        }
        const apiKeySet = Boolean(process.env.DEEPSEEK_API_KEY);
        const embCache = embeddingCacheDir();
        const embModel = runtime?.config.runtime.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
        try {
          const embProbe = await probeEmbeddingEnvironment(embCache, embModel);
          let embDetail: string;
          if (!embProbe.packageInstalled) {
            embDetail =
              'fastembed not installed — search uses BM25/FTS only (ideaseek setup --install-embeddings)';
            checks.push({ level: 'warn', name: 'embeddings', detail: embDetail });
          } else if (!embProbe.modelCached) {
            embDetail = `fastembed ${embProbe.fastembedVersion} ok; model ${embProbe.model} not cached (ideaseek setup --install-embeddings)`;
            checks.push({ level: 'warn', name: 'embeddings', detail: embDetail });
          } else {
            embDetail = `fastembed ${embProbe.fastembedVersion} · ${embProbe.model} cached (${embProbe.license}, ${(embProbe.fingerprint ?? '').slice(0, 19)}…) at ${embProbe.cacheDir}`;
            checks.push({ level: 'ok', name: 'embeddings', detail: embDetail });
          }
        } catch (error) {
          checks.push({
            level: 'warn',
            name: 'embeddings',
            detail: `embedding probe failed (${(error as Error).message.slice(0, 80)}): BM25/FTS only`,
          });
        }
        try {
          const modelManifest = JSON.parse(
            await readFile(join(root ?? cwd, 'knowledge', 'embedding-model.json'), 'utf8'),
          ) as { model: string; license: string; fingerprint: string };
          checks.push({
            level: 'info',
            name: 'embedding-model',
            detail: `recorded ${modelManifest.model} · ${modelManifest.license} · ${modelManifest.fingerprint.slice(0, 19)}…`,
          });
        } catch {
          // manifest written on first successful install/embed
        }
        checks.push({
          level: apiKeySet ? 'ok' : 'info',
          name: 'credentials',
          detail: apiKeySet
            ? 'env DEEPSEEK_API_KEY is set (value never read or printed by IdeaSeek)'
            : 'env DEEPSEEK_API_KEY not set — required only for real model runs, not for demo/fake tasks',
        });
        try {
          // runtime-lock.json pins the DSH version of this IdeaSeek install
          // (dist/commands → repo root), not of the user's project.
          const here = dirname(fileURLToPath(import.meta.url));
          const lockPath = join(here, '..', '..', 'runtime-lock.json');
          const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
            dsh: { commit: string; gitDescribe: string };
          };
          checks.push({
            level: 'ok',
            name: 'dsh',
            detail: `pinned ${lock.dsh.commit.slice(0, 12)} (${lock.dsh.gitDescribe}) · sdk ${DSH_SDK_VERSION} · capability patch generated on first harness task`,
          });
        } catch {
          checks.push({
            level: 'warn',
            name: 'dsh',
            detail: 'runtime-lock.json missing or unreadable (DSH version not pinned)',
          });
        }

        const errors = checks.filter((check) => check.level === 'error');
        const exitCode = errors.length === 0 ? 0 : 2;

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              root,
              environment: env,
              checks,
              ok: errors.length === 0,
              exitCode,
            }),
          );
          return exitCode;
        }

        process.stdout.write('ideaseek doctor\n');
        for (const check of checks) {
          process.stdout.write(`  ${MARK[check.level]} ${check.name.padEnd(14)} ${check.detail}\n`);
        }
        const summary = `ok=${checks.filter((c) => c.level === 'ok').length} warn=${checks.filter((c) => c.level === 'warn').length} error=${errors.length}`;
        process.stdout.write(`  ${summary}\n`);
        if (errors.length > 0) {
          process.stdout.write('next: fix the ✗ items above, then re-run ideaseek doctor\n');
        }
        return exitCode;
      }),
    );
}
