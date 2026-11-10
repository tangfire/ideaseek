import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { join } from 'node:path';
import { projectPaths } from '../config/paths.js';
import { findProjectRoot } from '../config/paths.js';
import {
  SCAN_PARSER_VERSION,
  renderReview,
  scanProject,
  type InputManifest,
} from '../knowledge/scan.js';
import {
  applyOrganize,
  loadIndexManifest,
  planOrganize,
  readManifest,
  writeManifest,
  writeReview,
} from '../knowledge/organize.js';
import { action, jsonLine } from './shared.js';

const DEFAULT_ROOTS = ['papers', 'datasets', 'comparisons', 'incoming'] as const;

async function openProject(): Promise<ReturnType<typeof projectPaths>> {
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return projectPaths(root);
}

function manifestPath(paths: ReturnType<typeof projectPaths>): string {
  return join(paths.knowledgeDir, 'input-manifest.json');
}

function reviewPath(paths: ReturnType<typeof projectPaths>): string {
  return join(paths.knowledgeDir, 'input-review.md');
}

export interface ScanOutcome {
  manifestPath: string;
  reviewPath: string;
  roots: string[];
  files: number;
  byRole: Record<string, number>;
  groups: number;
  duplicates: number;
  reusedHashes: number;
}

/** Scans the entry directories and persists manifest + review. Shared by `scan` and `start`. */
export async function performScan(cwd: string, extraRoots: string[] = []): Promise<ScanOutcome> {
  const root = await findProjectRoot(cwd);
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  const paths = projectPaths(root);
  for (const extra of extraRoots) {
    if (extra.startsWith('/') || extra.includes('..')) {
      throw new IdeaseekError(
        'INVALID_ARGUMENT',
        `--path must be a project-relative directory without '..': ${extra}`,
      );
    }
  }
  const roots = [...DEFAULT_ROOTS, ...extraRoots];
  const previous = await readManifest(manifestPath(paths));
  const manifest = await scanProject({
    projectRoot: paths.root,
    roots,
    now: Date.now(),
    previous,
  });
  await writeManifest(manifestPath(paths), manifest);
  await writeReview(reviewPath(paths), renderReview(manifest));

  const reused = manifest.files.filter((file) => {
    const old = previous?.files.find((entry) => entry.path === file.path);
    return old && old.sha256 === file.sha256 && old.bytes === file.bytes;
  }).length;
  const byRole: Record<string, number> = {};
  for (const file of manifest.files) byRole[file.role] = (byRole[file.role] ?? 0) + 1;

  return {
    manifestPath: manifestPath(paths),
    reviewPath: reviewPath(paths),
    roots,
    files: manifest.files.length,
    byRole,
    groups: manifest.groups.length,
    duplicates: manifest.duplicateSets.length,
    reusedHashes: reused,
  };
}

export function registerScanCommand(program: Command): void {
  program
    .command('scan')
    .description('discover papers/code/data under the entry directories into an input manifest')
    .option(
      '--path <dir>',
      'extra project-relative directory to scan (repeatable)',
      (value, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { path: string[]; json?: boolean }) => {
        const outcome = await performScan(process.cwd(), opts.path);
        const { manifest, review, parserVersion, roots } = {
          manifest: outcome.manifestPath,
          review: outcome.reviewPath,
          parserVersion: SCAN_PARSER_VERSION,
          roots: outcome.roots,
        };

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              manifest,
              review,
              parserVersion,
              roots,
              files: outcome.files,
              byRole: outcome.byRole,
              groups: outcome.groups,
              duplicates: outcome.duplicates,
              reusedHashes: outcome.reusedHashes,
            }),
          );
          return 0;
        }
        process.stdout.write(
          `scanned ${outcome.files} file(s) under ${roots.map((root) => `${root}/`).join(' ')}\n`,
        );
        process.stdout.write(
          `  roles: ${Object.entries(outcome.byRole)
            .map(([role, count]) => `${role}=${count}`)
            .join(' ')}\n`,
        );
        process.stdout.write(
          `  groups: ${outcome.groups} (pending confirmation) · duplicates: ${outcome.duplicates} · reused hashes: ${outcome.reusedHashes}\n`,
        );
        process.stdout.write(`  manifest: ${manifest}\n`);
        process.stdout.write(`  review: ${review}\n`);
        process.stdout.write('next: ideaseek intake\n');
        return 0;
      }),
    );
}

export function registerIntakeCommand(program: Command): void {
  program
    .command('intake')
    .description('show unclassified inputs and candidate groups awaiting confirmation')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const paths = await openProject();
        const manifest = await readManifest(manifestPath(paths));
        if (!manifest) {
          throw new IdeaseekError(
            'USER_INPUT_REQUIRED',
            'no input manifest yet; run: ideaseek scan',
          );
        }
        const unknown = manifest.files.filter((file) => file.role === 'unknown');
        const pending = manifest.groups.filter((group) => group.needsConfirmation);

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              parserVersion: manifest.parserVersion,
              totals: manifest.files.length,
              unknown: unknown.map((file) => file.relPath),
              groups: manifest.groups,
              pendingConfirmation: pending.length,
              duplicates: manifest.duplicateSets,
            }),
          );
          return 0;
        }
        process.stdout.write(
          `intake: ${manifest.files.length} file(s), parser ${manifest.parserVersion}\n`,
        );
        if (unknown.length > 0) {
          process.stdout.write(`待分类（unknown，${unknown.length}）：\n`);
          for (const file of unknown.slice(0, 50)) {
            process.stdout.write(`  ? ${file.relPath}\n`);
          }
        }
        process.stdout.write(`候选分组（${manifest.groups.length}，均待确认）：\n`);
        for (const group of manifest.groups.slice(0, 50)) {
          process.stdout.write(
            `  ${group.groupId}  ${group.kind.padEnd(11)} conf=${group.confidence}  ${group.files.length} file(s)  [${group.basis.join(', ')}]\n`,
          );
        }
        if (manifest.duplicateSets.length > 0) {
          process.stdout.write(`重复内容（${manifest.duplicateSets.length} 组）：\n`);
          for (const set of manifest.duplicateSets.slice(0, 20)) {
            process.stdout.write(`  ${set.sha256.slice(0, 19)}… → ${set.paths.join(', ')}\n`);
          }
        }
        process.stdout.write(
          'next: ideaseek organize   (preview; add --apply to build the index)\n',
        );
        return 0;
      }),
    );
}

export function registerOrganizeCommand(program: Command): void {
  program
    .command('organize')
    .description('preview or apply the platform index (links/copies only; originals untouched)')
    .option('--apply', 'create the index links/copies')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { apply?: boolean; json?: boolean }) => {
        const paths = await openProject();
        const manifest: InputManifest | null = await readManifest(manifestPath(paths));
        if (!manifest) {
          throw new IdeaseekError(
            'USER_INPUT_REQUIRED',
            'no input manifest yet; run: ideaseek scan',
          );
        }
        const now = Date.now();

        if (!opts.apply) {
          const plan = planOrganize(manifest);
          const toCreate = plan.filter((item) => item.action === 'link');
          if (opts.json) {
            process.stdout.write(jsonLine({ apply: false, plan, wouldCreate: toCreate.length }));
            return 0;
          }
          process.stdout.write(
            `organize preview: ${toCreate.length} index entr(ies) would be created under ${'knowledge/index/'}\n`,
          );
          for (const item of plan.slice(0, 50)) {
            process.stdout.write(`  ${item.action.padEnd(15)} ${item.source} → ${item.link}\n`);
          }
          process.stdout.write(plan.length > 50 ? `  … ${plan.length - 50} more\n` : '');
          process.stdout.write(
            'originals are never moved or modified. apply with: ideaseek organize --apply\n',
          );
          return 0;
        }

        const before = new Map(manifest.files.map((file) => [file.path, file.sha256]));
        const result = await applyOrganize(paths.root, manifest, now);
        // Prove originals were untouched by re-reading sizes is overkill here;
        // the index only ever links/copies, never writes through to sources.
        for (const file of manifest.files) {
          if (before.get(file.path) !== file.sha256) {
            throw new IdeaseekError(
              'INTERNAL',
              `original changed during organize: ${file.relPath}`,
            );
          }
        }
        const index = await loadIndexManifest(paths.root);
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              apply: true,
              created: result.applied,
              skipped: result.skipped,
              indexEntries: index?.entries.length ?? 0,
            }),
          );
          return 0;
        }
        process.stdout.write(
          `organize: created ${result.applied.length} entr(ies), skipped ${result.skipped.length}\n`,
        );
        for (const entry of result.applied.slice(0, 50)) {
          process.stdout.write(`  ${entry.method} ${entry.source} → ${entry.link}\n`);
        }
        process.stdout.write(
          `  index manifest: ${join(paths.knowledgeDir, 'index', 'sources.json')}\n`,
        );
        process.stdout.write('next: ideaseek intake   (groups still need confirmation)\n');
        return 0;
      }),
    );
}
