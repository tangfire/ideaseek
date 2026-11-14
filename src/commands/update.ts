import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek version` / `ideaseek update` (docs/PACKAGING.md 更新与回滚):
 * version prints the CLI version plus the install-manifest facts (the
 * runtime half of version validation); update is the source-linked
 * upgrade path — rebuild with the pinned TypeScript, then refresh the
 * install manifest via scripts/install.mjs (idempotent). Fetching new
 * code stays the user's explicit step (`git pull` or a new release
 * tarball); update never touches the network or the git state.
 */

function repoRoot(): string {
  // dist/commands/update.js → repo root (source-linked installs run the
  // same file from the checkout, so this resolves either way).
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function readPackage(root: string): { version: string; name: string } {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version?: string;
    name?: string;
  };
  return { version: pkg.version ?? '0.0.0', name: pkg.name ?? 'ideaseek' };
}

function findManifest(root: string): Record<string, unknown> | null {
  const candidates = [
    process.env.IDEASEEK_PREFIX ? join(process.env.IDEASEEK_PREFIX, 'install-manifest.json') : null,
    join(process.cwd(), 'install-manifest.json'),
    join(root, 'install-manifest.json'),
    join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.ideaseek', 'install-manifest.json'),
  ].filter((path): path is string => Boolean(path));
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function registerUpdateCommands(program: Command): void {
  program
    .command('version')
    .description('print CLI version, runtime and install-manifest facts (no changes)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const root = repoRoot();
        const pkg = readPackage(root);
        const manifest = findManifest(root);
        const payload = {
          version: pkg.version,
          name: pkg.name,
          node: process.version,
          install: manifest
            ? {
                version: manifest.version ?? null,
                fingerprint: manifest.fingerprint ?? null,
                sourceRoot: manifest.sourceRoot ?? null,
                installedAt: manifest.installedAt ?? null,
              }
            : null,
        };
        if (opts.json) {
          process.stdout.write(jsonLine(payload));
          return 0;
        }
        process.stdout.write(`${pkg.name} ${pkg.version} (node ${process.version})\n`);
        if (manifest) {
          process.stdout.write(
            `  installed: ${String(manifest.version)} @ ${String(manifest.sourceRoot)} ` +
              `(${String(manifest.fingerprint)})\n`,
          );
          const drift = manifest.version !== pkg.version;
          if (drift) {
            process.stdout.write(
              `  note: installed manifest says ${String(manifest.version)} but this CLI is ${pkg.version} — run: ideaseek update\n`,
            );
          }
        } else {
          process.stdout.write('  installed: no manifest found (running from checkout?)\n');
        }
        return 0;
      }),
    );

  program
    .command('update')
    .description(
      'rebuild and refresh the source-linked install (idempotent; never pulls git or touches the network)',
    )
    .option('--prefix <dir>', 'install prefix (default: scripts/install.mjs default)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { prefix?: string; json?: boolean }) => {
        const root = repoRoot();
        const before = readPackage(root);

        // Rebuild with the pinned TypeScript (same invocation as the
        // test global-setup — no package-manager binary on PATH needed).
        const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
        if (!existsSync(tsc)) {
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                ok: false,
                error: 'typescript not installed — run: pnpm install',
              }),
            );
            return 1;
          }
          process.stderr.write('update failed: typescript not installed\nnext: pnpm install\n');
          return 1;
        }
        // Source checkouts share the cross-session build lock via
        // scripts/build.mjs (parallel tsc runs tear dist); packed
        // layouts ship only dist/ and fall back to raw tsc.
        const lockedBuild = join(root, 'scripts', 'build.mjs');
        const build = existsSync(lockedBuild)
          ? spawnSync(process.execPath, [lockedBuild], { cwd: root, encoding: 'utf8' })
          : spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], {
              cwd: root,
              encoding: 'utf8',
            });
        if (build.status !== 0) {
          const detail = (build.stderr || build.stdout || '').slice(-600);
          if (opts.json) {
            process.stdout.write(jsonLine({ ok: false, error: 'build failed', detail }));
            return 1;
          }
          process.stderr.write(`update failed: build failed\n${detail}\n`);
          return 1;
        }

        // Refresh the install manifest (idempotent by design).
        const installArgs = [join(root, 'scripts', 'install.mjs'), '--json'];
        if (opts.prefix) installArgs.push('--prefix', opts.prefix);
        const install = spawnSync(process.execPath, installArgs, {
          cwd: root,
          encoding: 'utf8',
        });
        const installOut = (install.stdout ?? '').trim();
        let installReport: Record<string, unknown> | null = null;
        try {
          installReport = JSON.parse(installOut) as Record<string, unknown>;
        } catch {
          installReport = null;
        }
        if (install.status !== 0 || !installReport?.ok) {
          const detail = installOut || (install.stderr ?? '').trim();
          if (opts.json) {
            process.stdout.write(jsonLine({ ok: false, error: 'install refresh failed', detail }));
            return 1;
          }
          process.stderr.write(`update failed: install refresh failed\n${detail}\n`);
          return 1;
        }

        const after = readPackage(root);
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ok: true,
              from: before.version,
              to: after.version,
              build: 'ok',
              install: installReport,
            }),
          );
          return 0;
        }
        process.stdout.write(
          `updated ${before.version} → ${after.version} (build ok, install manifest refreshed)\n`,
        );
        process.stdout.write(`  launcher: ${String(installReport.launcherPath ?? 'n/a')}\n`);
        process.stdout.write(
          'next: ideaseek version   (fetch new code first with git pull or a release tarball)\n',
        );
        return 0;
      }),
    );
}
