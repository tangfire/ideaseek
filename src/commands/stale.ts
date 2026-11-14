import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek stale` — unified increment-update difference preview
 * (docs/PRODUCT_REQUIREMENTS: 数据集/论文/comparison 的增量更新有差异预览，
 * 用户知道哪些下游结果会失效). Instead of discovering staleness one
 * command at a time (plan/fairness/matrix/check/analysis/novelty/review/
 * claim-audit each re-check at use time), this re-derives every hash-
 * pinned artifact against CURRENT inputs and lists, per row: status,
 * what it invalidates downstream, and the recovery command. Read-only;
 * exit 2 when anything is stale/unconfirmed (scriptable), 0 otherwise.
 */

export type StaleStatus = 'current' | 'stale' | 'missing' | 'unconfirmed';

export interface StaleRow {
  id: string;
  scope: 'project' | 'idea';
  status: StaleStatus;
  /** What changed / why it is not current. */
  detail: string;
  /** Downstream results that would silently be built on old inputs. */
  invalidates: string[];
  recovery: string;
}

export function staleExitCode(rows: StaleRow[]): number {
  // Only STALE rows invalidate existing downstream results (the preview's
  // contract). `unconfirmed` is a next-step hint, not an invalidation.
  return rows.some((row) => row.status === 'stale') ? 2 : 0;
}

export function registerStaleCommand(program: Command): void {
  program
    .command('stale')
    .description(
      'difference preview: which persisted results are stale against current inputs (and what they invalidate)',
    )
    .option(
      '--idea <ideaId>',
      'also check idea-scoped artifacts (check/analysis/novelty/review/claim-audit)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { idea?: string; json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here — run: ideaseek init',
          );
        }
        const rows: StaleRow[] = [];
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');

        // ---- project-scoped hash-pinned artifacts ----
        const planIds = opts.idea ? [opts.idea] : await ideaIds(root);
        for (const ideaId of planIds) {
          rows.push(await planRow(root, ideaId));
          rows.push(await fairnessRow(root, ideaId));
        }
        rows.push(await matrixRow(root));
        rows.push(await protocolRow(root));
        rows.push(...(await comparisonWorktreeRows(root)));
        const inputs = await inputsRow(root);
        if (inputs) rows.push(inputs);

        // ---- idea-scoped downstream results ----
        for (const ideaId of opts.idea ? [opts.idea] : planIds) {
          rows.push(await checkReportRow(root, ideaId));
          rows.push(await analysisRow(root, ideaId));
          rows.push(await noveltyRow(root, ideaId));
          rows.push(await reviewRow(root, ideaId));
          rows.push(await claimAuditRow(root, ideaId));
        }

        const stale = rows.filter((row) => row.status === 'stale').length;
        const unconfirmed = rows.filter((row) => row.status === 'unconfirmed').length;
        const missing = rows.filter((row) => row.status === 'missing').length;
        const current = rows.filter((row) => row.status === 'current').length;

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              rows,
              summary: { stale, unconfirmed, missing, current, total: rows.length },
            }),
          );
          return staleExitCode(rows);
        }
        process.stdout.write(
          `stale preview: ${current} current · ${stale} stale · ${unconfirmed} unconfirmed · ${missing} missing\n`,
        );
        for (const row of rows) {
          const mark =
            row.status === 'current'
              ? 'ok  '
              : row.status === 'missing'
                ? '—   '
                : row.status === 'unconfirmed'
                  ? 'UNCF'
                  : 'STALE';
          process.stdout.write(`  ${mark} [${row.id}] ${row.detail}\n`);
          if (row.status !== 'current') {
            if (row.invalidates.length > 0) {
              process.stdout.write(`         invalidates: ${row.invalidates.join('; ')}\n`);
            }
            process.stdout.write(`         next: ${row.recovery}\n`);
          }
        }
        if (stale === 0) {
          process.stdout.write('nothing stale — downstream results match current inputs\n');
        }
        void readFile;
        void join;
        return staleExitCode(rows);
      }),
    );
}

async function ideaIds(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = join(root, 'ideas');
  const ids: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    ids.push(entry.name);
  }
  return ids.sort();
}

/**
 * Project-scoped raw-input drift row (docs/MODES.md「不禁止写入，但侦测写入」):
 * papers/datasets/comparison upstreams vs the hashes `scan` recorded. Only an
 * agent session or a manual edit can move these, and the point of the row is
 * that downstream conclusions stop being verifiable — not that the write is
 * illegal. No manifest yet means nothing recorded to compare, so no row.
 */
async function inputsRow(root: string): Promise<StaleRow | null> {
  const { detectInputDrift, driftConsequences, hasInputDrift } =
    await import('../knowledge/input-drift.js');
  const report = await detectInputDrift(root);
  if (!report.hasBaseline) return null;
  if (!hasInputDrift(report)) {
    return {
      id: 'inputs',
      scope: 'project',
      status: 'current',
      detail: `${report.checked} 个原始输入与已记录 hash 一致（roots ${report.roots.join(',')}）`,
      invalidates: [],
      recovery: '无需操作',
    };
  }
  const counts = new Map<string, number>();
  for (const file of report.drifted) counts.set(file.change, (counts.get(file.change) ?? 0) + 1);
  const listed = (['modified', 'removed', 'added'] as const)
    .filter((change) => counts.get(change))
    .map((change) => `${change}=${counts.get(change)}`)
    .join(', ');
  const heads = report.drifted.slice(0, 3).map((file) => file.relPath);
  return {
    id: 'inputs',
    scope: 'project',
    status: 'stale',
    detail: `原始输入与已记录 hash 不一致 (${listed}): ${heads.join(', ')}${
      report.drifted.length > heads.length ? ' …' : ''
    }`,
    invalidates: driftConsequences(report.drifted),
    recovery: 'ideaseek scan（记录新基线）→ ideaseek stale 复查 → 重跑受影响结果',
  };
}

async function planRow(root: string, ideaId: string): Promise<StaleRow> {
  const id = `full-plan:${ideaId}`;
  const invalidates = ['ideaseek full approve', 'ideaseek full run'];
  const recovery = `ideaseek full plan --idea ${ideaId} (then fairness/approve as prompted)`;
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let stored: { inputHash?: unknown; approval?: unknown; readiness?: { ready?: unknown } } | null =
    null;
  try {
    stored = JSON.parse(
      await readFile(join(root, 'knowledge', `full-plan-${ideaId}.json`), 'utf8'),
    );
  } catch {
    stored = null;
  }
  if (!stored) {
    return {
      id,
      scope: 'idea',
      status: 'missing',
      detail: 'no full plan built yet',
      invalidates,
      recovery,
    };
  }
  const { buildFullPlan } = await import('../full/plan.js');
  const fresh = await buildFullPlan(root, ideaId);
  if (stored.inputHash !== fresh.inputHash) {
    return {
      id,
      scope: 'idea',
      status: 'stale',
      detail: 'project state changed since the plan was written',
      invalidates,
      recovery,
    };
  }
  if (!stored.approval) {
    return {
      id,
      scope: 'idea',
      status: 'unconfirmed',
      detail: 'plan is fresh but not approved yet',
      invalidates,
      recovery: `ideaseek full approve --idea ${ideaId} --confirm`,
    };
  }
  return {
    id,
    scope: 'idea',
    status: 'current',
    detail: 'approved and fresh',
    invalidates: [],
    recovery,
  };
}

async function fairnessRow(root: string, ideaId: string): Promise<StaleRow> {
  const id = `fairness:${ideaId}`;
  const invalidates = ['ideaseek full plan readiness', 'ideaseek full run'];
  const recovery = `ideaseek full fairness --idea ${ideaId} (review, then --confirm)`;
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let stored: { inputHash?: unknown; confirmed?: unknown } | null = null;
  try {
    stored = JSON.parse(await readFile(join(root, 'knowledge', `fairness-${ideaId}.json`), 'utf8'));
  } catch {
    stored = null;
  }
  if (!stored) {
    return {
      id,
      scope: 'idea',
      status: 'missing',
      detail: 'no fairness lock built yet',
      invalidates,
      recovery,
    };
  }
  const { buildFairnessLock } = await import('../full/fairness.js');
  const fresh = await buildFairnessLock(root, ideaId);
  if (stored.inputHash !== fresh.inputHash) {
    return {
      id,
      scope: 'idea',
      status: 'stale',
      detail: 'comparison/protocol state changed since the lock was confirmed',
      invalidates,
      recovery,
    };
  }
  if (!stored.confirmed) {
    return {
      id,
      scope: 'idea',
      status: 'unconfirmed',
      detail: 'lock is fresh but not confirmed',
      invalidates,
      recovery,
    };
  }
  return {
    id,
    scope: 'idea',
    status: 'current',
    detail: 'confirmed and fresh',
    invalidates: [],
    recovery,
  };
}

async function matrixRow(root: string): Promise<StaleRow> {
  const id = 'comparison-matrix';
  const invalidates = ['ideaseek comparison matrix --confirm', 'comparison planner proposal reuse'];
  const recovery = 'ideaseek comparison matrix (rebuild, review, then --confirm)';
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let stored: { inputHash?: unknown } | null = null;
  try {
    stored = JSON.parse(await readFile(join(root, 'knowledge', 'comparison-matrix.json'), 'utf8'));
  } catch {
    stored = null;
  }
  if (!stored) {
    return {
      id,
      scope: 'project',
      status: 'missing',
      detail: 'no comparison matrix built yet',
      invalidates,
      recovery: 'ideaseek comparison matrix',
    };
  }
  const { buildComparisonMatrix } = await import('../comparison/matrix.js');
  const fresh = await buildComparisonMatrix(root);
  if (stored.inputHash !== fresh.inputHash) {
    return {
      id,
      scope: 'project',
      status: 'stale',
      detail: 'comparison candidates/state changed since the matrix was written',
      invalidates,
      recovery,
    };
  }
  return {
    id,
    scope: 'project',
    status: 'current',
    detail: 'matches current candidates',
    invalidates: [],
    recovery,
  };
}

async function protocolRow(root: string): Promise<StaleRow> {
  const id = 'protocol-proposal';
  const invalidates = ['ideaseek confirm protocol', 'full plan protocol lock'];
  const recovery = 'ideaseek protocol propose (then ideaseek confirm protocol)';
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const artifacts = await runtime.db.listArtifactsByKind('protocol-proposal');
    const latest = artifacts[artifacts.length - 1];
    if (!latest) {
      return {
        id,
        scope: 'project',
        status: 'missing',
        detail: 'no protocol proposal yet',
        invalidates,
        recovery,
      };
    }
    const { buildProtocolInput, PROTOCOL_PROMPT_VERSION } =
      await import('../experiment/protocol-synth.js');
    const { loadCompactCards } = await import('../knowledge/cards.js');
    const { loadDatasetProfile, loadProtocolEvidence } =
      await import('../worker/protocol-handlers.js');
    const { sha256OfJson } = await import('../core/hash.js');
    const cards = await loadCompactCards(runtime);
    const evidence = await loadProtocolEvidence(runtime);
    const input = buildProtocolInput({
      question: runtime.config.research.question,
      cards,
      datasetProfile: await loadDatasetProfile(runtime),
      tables: evidence.tables,
      comparisons: evidence.comparisons,
    });
    const inputHash = await sha256OfJson({ inputs: input, generator: PROTOCOL_PROMPT_VERSION });
    if (latest.meta.inputHash !== inputHash) {
      return {
        id,
        scope: 'project',
        status: 'stale',
        detail: 'cards/dataset profile/question changed since the proposal was generated',
        invalidates,
        recovery,
      };
    }
    return {
      id,
      scope: 'project',
      status: 'current',
      detail: 'proposal matches current inputs (confirm to lock)',
      invalidates: [],
      recovery,
    };
  } finally {
    await runtime.close();
  }
}

async function checkReportRow(root: string, ideaId: string): Promise<StaleRow> {
  const id = `check-report:${ideaId}`;
  const invalidates = ['ideaseek idea experiment', 'handoff gate'];
  const recovery = `ideaseek idea check ${ideaId}`;
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let report: { outcome?: unknown; version?: unknown; codeHash?: unknown } | null = null;
  try {
    report = JSON.parse(
      await readFile(join(root, 'ideas', ideaId, 'experiments', 'check-report.json'), 'utf8'),
    );
  } catch {
    report = null;
  }
  if (!report) {
    return {
      id,
      scope: 'idea',
      status: 'missing',
      detail: 'never checked (or workspace missing)',
      invalidates,
      recovery,
    };
  }
  const { loadWorkspaceMeta } = await import('../idea/workspace.js');
  const { hashIdeaSource } = await import('../idea/workspace.js');
  const meta = await loadWorkspaceMeta(root, ideaId);
  const codeHash = await hashIdeaSource(root, ideaId);
  if (report.outcome !== 'passed') {
    return {
      id,
      scope: 'idea',
      status: 'stale',
      detail: `last check outcome is ${String(report.outcome)}`,
      invalidates,
      recovery,
    };
  }
  if (report.version !== meta.currentVersion || report.codeHash !== codeHash) {
    return {
      id,
      scope: 'idea',
      status: 'stale',
      detail: 'idea version or code changed since the passing check',
      invalidates,
      recovery,
    };
  }
  return {
    id,
    scope: 'idea',
    status: 'current',
    detail: 'passing and current',
    invalidates: [],
    recovery,
  };
}

async function analysisRow(root: string, ideaId: string): Promise<StaleRow> {
  const id = `analysis:${ideaId}`;
  const invalidates = ['handoff verdict', 'result-to-claim context'];
  const recovery = `ideaseek idea analyze ${ideaId}`;
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let analysis: { ideaVersion?: unknown; codeHash?: unknown; verdict?: unknown } | null = null;
  try {
    analysis = JSON.parse(
      await readFile(join(root, 'ideas', ideaId, 'experiments', 'analysis.json'), 'utf8'),
    );
  } catch {
    analysis = null;
  }
  if (!analysis) {
    return {
      id,
      scope: 'idea',
      status: 'missing',
      detail: 'no analysis yet',
      invalidates,
      recovery,
    };
  }
  const { loadWorkspaceMeta, hashIdeaSource } = await import('../idea/workspace.js');
  const meta = await loadWorkspaceMeta(root, ideaId);
  const codeHash = await hashIdeaSource(root, ideaId);
  if (analysis.ideaVersion !== meta.currentVersion || analysis.codeHash !== codeHash) {
    return {
      id,
      scope: 'idea',
      status: 'stale',
      detail: 'idea version or code changed since the analysis (verdict may not hold)',
      invalidates,
      recovery,
    };
  }
  return {
    id,
    scope: 'idea',
    status: 'current',
    detail: `verdict ${String(analysis.verdict)} is current`,
    invalidates: [],
    recovery,
  };
}

async function comparisonWorktreeRows(root: string): Promise<StaleRow[]> {
  const { checkWorktreeStaleness } = await import('../comparison/worktree-stamp.js');
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  const rows: StaleRow[] = [];
  try {
    const methods = await runtime.db.listComparisons({});
    for (const method of methods) {
      const outcome = await checkWorktreeStaleness(root, method.methodId);
      if (outcome.state === 'no-stamp') continue;
      if (outcome.state === 'stale') {
        rows.push({
          id: `comparison-worktree:${method.methodId}`,
          scope: 'project',
          status: 'stale',
          detail: `worktree modified since passing smoke test (${outcome.recordedHash.slice(0, 16)}…)`,
          invalidates: ['comparison gate', 'idea experiment', 'handoff gate'],
          recovery: `ideaseek comparison smoke ${method.methodId}`,
        });
      } else {
        rows.push({
          id: `comparison-worktree:${method.methodId}`,
          scope: 'project',
          status: 'current',
          detail: 'worktree matches passing smoke stamp',
          invalidates: [],
          recovery: `ideaseek comparison smoke ${method.methodId}`,
        });
      }
    }
  } finally {
    await runtime.close();
  }
  return rows;
}

async function currentIdeaCardHash(root: string, ideaId: string): Promise<string | null> {
  try {
    const { loadIdeaCard } = await import('../idea/workspace.js');
    const { sha256Of } = await import('../core/hash.js');
    const { stableJson } = await import('../experiment/spec.js');
    const card = await loadIdeaCard(root, ideaId);
    return sha256Of(stableJson(card));
  } catch {
    return null;
  }
}

async function noveltyRow(root: string, ideaId: string): Promise<StaleRow> {
  const id = `novelty:${ideaId}`;
  const invalidates = ['novelty gate (ABANDON blocks runs)'];
  const recovery = `ideaseek idea novelty ${ideaId}`;
  const { readNoveltyReport } = await import('../idea/novelty.js');
  const { loadWorkspaceMeta } = await import('../idea/workspace.js');
  const report = await readNoveltyReport(root, ideaId).catch(() => null);
  if (!report) {
    return {
      id,
      scope: 'idea',
      status: 'missing',
      detail: 'no novelty report yet',
      invalidates,
      recovery,
    };
  }
  const meta = await loadWorkspaceMeta(root, ideaId);
  if (report.cardVersion !== meta.currentVersion) {
    return {
      id,
      scope: 'idea',
      status: 'stale',
      detail: `card v${report.cardVersion} vs current v${meta.currentVersion}`,
      invalidates,
      recovery,
    };
  }
  if (report.cardHash) {
    const liveHash = await currentIdeaCardHash(root, ideaId);
    if (liveHash && liveHash !== report.cardHash) {
      return {
        id,
        scope: 'idea',
        status: 'stale',
        detail: 'idea.json content changed since novelty check',
        invalidates,
        recovery,
      };
    }
  }
  return {
    id,
    scope: 'idea',
    status: 'current',
    detail: 'current card version',
    invalidates: [],
    recovery,
  };
}

async function reviewRow(root: string, ideaId: string): Promise<StaleRow> {
  const id = `review:${ideaId}`;
  const invalidates = ['independent review gate (failing current review blocks runs)'];
  const recovery = `ideaseek idea review ${ideaId}`;
  const { readLatestIdeaReview } = await import('../idea/gates.js');
  const { loadWorkspaceMeta } = await import('../idea/workspace.js');
  const review = await readLatestIdeaReview(root, ideaId).catch(() => null);
  if (!review) {
    return {
      id,
      scope: 'idea',
      status: 'missing',
      detail: 'no independent review yet',
      invalidates,
      recovery,
    };
  }
  const meta = await loadWorkspaceMeta(root, ideaId);
  if (review.target.cardVersion !== meta.currentVersion) {
    return {
      id,
      scope: 'idea',
      status: 'stale',
      detail: `review targets card v${String(review.target.cardVersion)} vs current v${meta.currentVersion}`,
      invalidates,
      recovery,
    };
  }
  const cardInput = review.inputs.find((entry) => entry.kind === 'ideacard');
  if (cardInput) {
    const { sha256OfFile } = await import('../core/hash.js');
    const { join } = await import('node:path');
    const liveSha = await sha256OfFile(join(root, 'ideas', ideaId, 'idea.json')).catch(() => null);
    if (liveSha && liveSha !== cardInput.sha256) {
      return {
        id,
        scope: 'idea',
        status: 'stale',
        detail: `idea.json content changed since review v${review.version}`,
        invalidates,
        recovery,
      };
    }
  }
  return {
    id,
    scope: 'idea',
    status: 'current',
    detail: `review v${review.version} targets the current card`,
    invalidates: [],
    recovery,
  };
}

async function claimAuditRow(root: string, ideaId: string): Promise<StaleRow> {
  const id = `claim-audit:${ideaId}`;
  const invalidates = ['handoff delivery (a current FAIL blocks it)'];
  const recovery = `ideaseek idea claim-audit ${ideaId}`;
  const { readClaimAudit } = await import('../idea/claim-audit.js');
  const { loadWorkspaceMeta } = await import('../idea/workspace.js');
  const audit = await readClaimAudit(root, ideaId).catch(() => null);
  if (!audit) {
    return {
      id,
      scope: 'idea',
      status: 'missing',
      detail: 'no claim audit yet',
      invalidates,
      recovery,
    };
  }
  const meta = await loadWorkspaceMeta(root, ideaId);
  if (audit.cardVersion !== meta.currentVersion) {
    return {
      id,
      scope: 'idea',
      status: 'stale',
      detail: `audit v${audit.cardVersion} vs current card v${meta.currentVersion}`,
      invalidates,
      recovery,
    };
  }
  if (audit.cardHash) {
    const liveHash = await currentIdeaCardHash(root, ideaId);
    if (liveHash && liveHash !== audit.cardHash) {
      return {
        id,
        scope: 'idea',
        status: 'stale',
        detail: 'idea.json content changed since claim audit',
        invalidates,
        recovery,
      };
    }
  }
  return {
    id,
    scope: 'idea',
    status: 'current',
    detail: `verdict ${audit.verdict} on current card`,
    invalidates: [],
    recovery,
  };
}
