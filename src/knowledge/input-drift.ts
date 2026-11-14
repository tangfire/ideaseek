import { stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { sha256OfFile } from '../core/hash.js';
import type { InputManifest, ManifestFile } from './scan.js';

/**
 * Input drift detection (docs/MODES.md「不禁止写入，但侦测写入」).
 *
 * A general-purpose DSH agent session may edit anything in the project, so the
 * integrity of research conclusions cannot come from blocking writes. It comes
 * from noticing them: `scan` recorded a content hash per input file, and this
 * module compares the recorded hashes against the disk. Papers, datasets and
 * comparison upstreams are the provenance anchors — every PaperCard, DatasetCard,
 * fairness lock and check-report cites their hashes, so a silent change here
 * makes those results unverifiable rather than merely outdated.
 *
 * Read-only by construction: it never rewrites the manifest (that is `scan`'s
 * job, and the user decides when the new reality becomes the baseline).
 */

/** Roots whose files are provenance anchors, not working material.
 * Note: real imported comparisons live under `comparisons/<methodId>/upstream`,
 * while some fixtures/legacy layouts use `comparisons/upstream`. Both are
 * matched whenever `comparisons/upstream` is in `roots`. */
export const DRIFT_ROOTS: readonly string[] = ['papers', 'datasets', 'comparisons/upstream'];

export type DriftChange = 'modified' | 'removed' | 'added';

export interface DriftFile {
  relPath: string;
  change: DriftChange;
  /** Hash recorded in the manifest (null for `added`). */
  recorded: string | null;
  /** Hash on disk now (null for `removed`). */
  current: string | null;
}

export interface InputDriftReport {
  roots: string[];
  /** Files whose recorded hash was confirmed against disk. */
  checked: number;
  /** Files scan could not hash (too large) or could not read now. */
  unchecked: number;
  drifted: DriftFile[];
  /** False when no manifest exists yet — nothing to compare against. */
  hasBaseline: boolean;
  manifestGeneratedAt: number | null;
}

export function isComparisonUpstreamPath(relPath: string): boolean {
  return (
    relPath === 'comparisons/upstream' ||
    relPath.startsWith('comparisons/upstream/') ||
    /^comparisons\/[^/]+\/upstream(?:\/|$)/.test(relPath)
  );
}

function underRoot(relPath: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    if (root === 'comparisons/upstream') return isComparisonUpstreamPath(relPath);
    return relPath === root || relPath.startsWith(`${root}/`);
  });
}

async function resolveDiskScanDirs(
  projectRoot: string,
  roots: readonly string[],
): Promise<string[]> {
  const dirs: string[] = [];
  for (const root of roots) {
    dirs.push(join(projectRoot, ...root.split('/')));
    if (root === 'comparisons/upstream') {
      const { readdir } = await import('node:fs/promises');
      const compDir = join(projectRoot, 'comparisons');
      const entries = await readdir(compDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (
          entry.name === 'upstream' ||
          entry.name === '_candidates' ||
          entry.name.startsWith('.')
        ) {
          continue;
        }
        dirs.push(join(compDir, entry.name, 'upstream'));
      }
    }
  }
  return dirs;
}

function absFor(projectRoot: string, relPath: string): string {
  return join(projectRoot, ...relPath.split('/'));
}

/**
 * Compares disk state against the recorded manifest. The size+mtime shortcut is
 * the same one `scanProject` uses to reuse hashes, so a clean tree costs no
 * hashing at all and the two agree on what "unchanged" means.
 */
export async function detectInputDrift(
  projectRoot: string,
  opts: { roots?: readonly string[]; manifest?: InputManifest | null } = {},
): Promise<InputDriftReport> {
  const roots = [...(opts.roots ?? DRIFT_ROOTS)];
  const manifest =
    opts.manifest !== undefined ? opts.manifest : await readInputManifest(projectRoot);

  if (!manifest) {
    return {
      roots,
      checked: 0,
      unchecked: 0,
      drifted: [],
      hasBaseline: false,
      manifestGeneratedAt: null,
    };
  }

  const drifted: DriftFile[] = [];
  let checked = 0;
  let unchecked = 0;

  const recorded = new Set<string>();
  for (const file of manifest.files) {
    if (!underRoot(file.relPath, roots)) continue;
    recorded.add(file.relPath);
    if (file.sha256 === null) {
      unchecked += 1;
      continue;
    }
    const outcome = await judgeFile(projectRoot, file);
    if (outcome === 'unreadable') {
      unchecked += 1;
      continue;
    }
    if (outcome === 'unchanged') {
      checked += 1;
      continue;
    }
    drifted.push(
      outcome === 'missing'
        ? { relPath: file.relPath, change: 'removed', recorded: file.sha256, current: null }
        : {
            relPath: file.relPath,
            change: 'modified',
            recorded: file.sha256,
            current: outcome,
          },
    );
  }

  // New files under an anchor root mean the manifest no longer describes the
  // inputs the downstream results were built from.
  const { walk } = await import('./scan.js');
  for (const absDir of await resolveDiskScanDirs(projectRoot, roots)) {
    const absFiles: string[] = [];
    await walk(absDir, absFiles);
    for (const abs of absFiles) {
      const relPath = relative(projectRoot, abs).split(sep).join('/');
      if (recorded.has(relPath)) continue;
      recorded.add(relPath);
      drifted.push({ relPath, change: 'added', recorded: null, current: null });
    }
  }

  drifted.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return {
    roots,
    checked,
    unchecked,
    drifted,
    hasBaseline: true,
    manifestGeneratedAt: manifest.generatedAt,
  };
}

/** Current hash, or a marker for the two non-drift outcomes. */
async function judgeFile(
  projectRoot: string,
  file: ManifestFile,
): Promise<'unchanged' | 'missing' | 'unreadable' | string> {
  const abs = absFor(projectRoot, file.relPath);
  let info;
  try {
    info = await stat(abs);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (!info.isFile()) return 'unreadable';
  if (file.bytes === info.size && file.mtimeMs === Math.floor(info.mtimeMs)) return 'unchanged';
  try {
    return await sha256OfFile(abs);
  } catch {
    return 'unreadable';
  }
}

export function hasInputDrift(report: InputDriftReport): boolean {
  return report.drifted.length > 0;
}

const CHANGE_WORD: Record<DriftChange, string> = {
  modified: 'modified',
  removed: 'deleted',
  added: 'new (never hashed)',
};

/** One line per changed file, capped so a bulk rewrite stays readable. */
export function renderDriftFiles(drifted: DriftFile[], limit = 8): string[] {
  const lines = drifted
    .slice(0, limit)
    .map((file) => `    · ${file.relPath} — ${CHANGE_WORD[file.change]}`);
  if (drifted.length > limit) {
    lines.push(`    · …${drifted.length - limit} more changed input file(s)`);
  }
  return lines;
}

/** What the changed inputs take down with them (docs/PROVENANCE_AND_CITATIONS.md). */
export function driftConsequences(drifted: DriftFile[]): string[] {
  const roots = new Set(drifted.map((file) => file.relPath.split('/')[0] ?? ''));
  const consequences: string[] = [];
  if (roots.has('papers')) {
    consequences.push('PaperCard/证据定位所引用的 hash 不再对应磁盘上的论文');
  }
  if (roots.has('datasets')) {
    consequences.push('DatasetCard、fairness lock 与按该数据训练的 RunResult 不再可复核');
  }
  if (drifted.some((file) => isComparisonUpstreamPath(file.relPath))) {
    consequences.push('comparison 复现结论所依赖的 upstream commit/内容已改变');
  }
  consequences.push('重跑 scan 后依赖 inputManifestHash 的 round/plan/check-report 会转为 stale');
  return consequences;
}

/** Human block for `ideaseek agent` and `ideaseek stale`; empty when clean. */
export function renderDriftReport(report: InputDriftReport): string[] {
  if (!report.hasBaseline) {
    return [
      'inputs: 无 input-manifest 基线（尚未 ideaseek scan），漂移未检查',
      '  next: ideaseek scan',
    ];
  }
  if (!hasInputDrift(report)) return [];
  return [
    `⚠ 原始输入漂移：${report.drifted.length} 个文件与已记录 hash 不一致` +
      `（${report.roots.join(', ')}）`,
    ...renderDriftFiles(report.drifted),
    '  后果：',
    ...driftConsequences(report.drifted).map((line) => `    · ${line}`),
    '  next: ideaseek scan（把现状记为新基线）→ ideaseek stale 复查 → 重跑受影响结果',
  ];
}

/** One compact line for RunEvent summaries (no blame attribution: the report
 * is a delta since the recorded baseline, whoever caused it). */
export function driftEventSummary(report: InputDriftReport): string {
  const byChange = new Map<DriftChange, number>();
  for (const file of report.drifted) {
    byChange.set(file.change, (byChange.get(file.change) ?? 0) + 1);
  }
  const parts = (['modified', 'removed', 'added'] as DriftChange[])
    .filter((change) => byChange.get(change))
    .map((change) => `${change}=${byChange.get(change)}`);
  return (
    `原始输入自基线起漂移: ${parts.join(' ')} ` +
    `(roots ${report.roots.join(',')}, ${report.checked} file(s) still hash-matched)`
  );
}

/** Reads knowledge/input-manifest.json; null when absent or unreadable. */
export async function readInputManifest(projectRoot: string): Promise<InputManifest | null> {
  const { projectPaths } = await import('../config/paths.js');
  const { readManifest } = await import('./organize.js');
  return readManifest(join(projectPaths(projectRoot).knowledgeDir, 'input-manifest.json'));
}
