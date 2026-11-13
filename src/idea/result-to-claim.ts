import { IdeaseekError } from '../core/errors.js';
import { writeFileAtomic } from '../core/atomic.js';

/**
 * result-to-claim (docs/FULL_RESEARCH_MODE.md 图表与论文: 论文 claim 必须
 * 经过 result-to-claim…): DETERMINISTIC derivation of what the full-run
 * results actually support — idea full-scale metrics vs the best
 * required-comparison full-scale value per metric, direction-adjusted,
 * bound to specHash evidence and the locked protocol's supportCriteria
 * (cited verbatim, never parsed into invented thresholds).
 *
 * Honest by design: missing full-run evidence yields `insufficient`
 * claims with recovery gaps, never a supported verdict. The output feeds
 * claim/citation/integrity audit and the independent reviewer; it never
 * writes idea/protocol/metric state.
 */

export const RESULT_TO_CLAIM_SCHEMA = 'result-to-claim-v1';

export type ClaimSupport = 'supported' | 'not-supported' | 'insufficient';

export interface ClaimEvidence {
  specId: string;
  specHash: string | null;
  role: 'idea' | 'baseline';
  metric: string;
  value: number;
}

export interface DerivedClaim {
  claimId: string;
  statement: string;
  support: ClaimSupport;
  metric: string;
  direction: 'higher' | 'lower';
  ideaValue: number | null;
  baselineValue: number | null;
  delta: number | null;
  evidence: ClaimEvidence[];
  /** Locked-protocol support criteria cited verbatim (not re-parsed). */
  protocolCriteria: string[];
}

export interface ResultToClaim {
  contract: typeof RESULT_TO_CLAIM_SCHEMA;
  ideaId: string;
  generatedAt: number;
  /** plan inputHash of the full-run this derivation consumes (when known). */
  planInputHash: string | null;
  claims: DerivedClaim[];
  /** Everything missing for a stronger verdict — never papered over. */
  gaps: string[];
}

interface ReportItem {
  kind: 'comparison' | 'idea';
  id: string;
  specId: string;
  status: string;
  metrics: { name: string; value: number }[];
}

function adjustDelta(idea: number, baseline: number, direction: 'higher' | 'lower'): number {
  return direction === 'higher' ? idea - baseline : baseline - idea;
}

export async function runResultToClaim(root: string, ideaId: string): Promise<ResultToClaim> {
  const { loadIdeaCard } = await import('./workspace.js');
  const card = await loadIdeaCard(root, ideaId);
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const gaps: string[] = [];
    const claims: DerivedClaim[] = [];

    // Latest full-run report for THIS idea (content-addressed artifacts).
    const reports = await runtime.db.listArtifactsByKind('full-run-report');
    let report: { planInputHash?: unknown; items?: unknown } | null = null;
    for (const artifact of reports) {
      if ((artifact.meta as { ideaId?: unknown } | null)?.ideaId !== ideaId) continue;
      try {
        report = JSON.parse(await runtime.store.readFinalText(artifact.contentHash)) as {
          planInputHash?: unknown;
          items?: unknown;
        };
      } catch {
        continue;
      }
    }
    if (!report) {
      gaps.push(
        `no full-run report for ${ideaId} — run: ideaseek full run --idea ${ideaId} --confirm (after plan+approve)`,
      );
    }

    const items: ReportItem[] = Array.isArray(report?.items)
      ? (report.items as ReportItem[]).filter(
          (item) =>
            item &&
            typeof item.specId === 'string' &&
            (item.status === 'succeeded' || item.status === 'skipped'),
        )
      : [];

    // Registry cross-check (integrity): the report must agree with the
    // unified registry — a claimed success with no row is a gap, not a claim.
    const byRole: { idea: ReportItem[]; comparison: ReportItem[] } = { idea: [], comparison: [] };
    const evidenceBySpec = new Map<string, ClaimEvidence[]>();
    for (const item of items) {
      const doc = await runtime.db.getExperiment(item.specId);
      if (!doc || doc.status !== 'succeeded' || !doc.result) {
        gaps.push(
          `report lists ${item.specId} as ${item.status} but the registry has no succeeded result — rerun full or rebuild the report`,
        );
        continue;
      }
      const registryMetrics = (
        (doc.result as { metrics?: { name?: unknown; value?: unknown }[] }).metrics ?? []
      ).filter(
        (m): m is { name: string; value: number } =>
          typeof m.name === 'string' && typeof m.value === 'number',
      );
      if (registryMetrics.length === 0) {
        gaps.push(`${item.specId} succeeded but recorded no metrics — cannot ground a claim`);
        continue;
      }
      const normalized: ReportItem = { ...item, metrics: registryMetrics };
      byRole[item.kind === 'idea' ? 'idea' : 'comparison'].push(normalized);
      evidenceBySpec.set(
        item.specId,
        registryMetrics.map((m) => ({
          specId: item.specId,
          specHash: doc.specHash ?? null,
          role: item.kind === 'idea' ? ('idea' as const) : ('baseline' as const),
          metric: m.name,
          value: m.value,
        })),
      );
    }

    // Locked protocol: primary metric + support criteria (cited verbatim).
    const locks = await runtime.db.listProtocolLocks();
    const protocol = locks.length > 0 ? locks[locks.length - 1]! : null;
    const protocolRecord = protocol?.record as
      { primaryMetrics?: unknown; supportCriteria?: unknown } | undefined;
    const primaries = Array.isArray(protocolRecord?.primaryMetrics)
      ? (protocolRecord.primaryMetrics as { name?: unknown; direction?: unknown }[])
          .filter((m) => typeof m?.name === 'string')
          .map((m) => ({
            name: m.name as string,
            direction: m.direction === 'lower' ? ('lower' as const) : ('higher' as const),
          }))
      : [];
    const supportCriteria = Array.isArray(protocolRecord?.supportCriteria)
      ? (protocolRecord.supportCriteria as unknown[]).filter(
          (c): c is string => typeof c === 'string',
        )
      : [];
    if (primaries.length === 0) {
      gaps.push('no locked protocol primary metric — run: ideaseek confirm protocol');
    }

    if (byRole.idea.length === 0 && items.length > 0) {
      gaps.push(
        'full-run report has no succeeded idea item — the final idea never ran to completion',
      );
    }
    if (byRole.comparison.length === 0 && items.length > 0) {
      gaps.push('full-run report has no succeeded comparison items — no baseline to claim against');
    }

    // Derive one claim per primary metric (fallback: idea metrics when the
    // protocol is absent — still honestly gated by the gaps above).
    const ideaMetrics = byRole.idea[0]?.metrics ?? [];
    const metricNames =
      primaries.length > 0 ? primaries.map((p) => p.name) : ideaMetrics.map((m) => m.name);
    for (const name of metricNames) {
      const direction = primaries.find((p) => p.name === name)?.direction ?? ('higher' as const);
      const ideaEntry = ideaMetrics.find((m) => m.name === name) ?? null;
      const baselineValues = byRole.comparison
        .map((item) => item.metrics.find((m) => m.name === name)?.value)
        .filter((v): v is number => typeof v === 'number');
      const baselineValue =
        baselineValues.length === 0
          ? null
          : direction === 'higher'
            ? Math.max(...baselineValues)
            : Math.min(...baselineValues);

      const evidence: ClaimEvidence[] = [];
      if (ideaEntry && byRole.idea[0]) {
        evidence.push(
          ...(evidenceBySpec.get(byRole.idea[0].specId)?.filter((e) => e.metric === name) ?? []),
        );
      }
      for (const item of byRole.comparison) {
        if (item.metrics.some((m) => m.name === name)) {
          evidence.push(
            ...(evidenceBySpec.get(item.specId)?.filter((e) => e.metric === name) ?? []),
          );
        }
      }

      let support: ClaimSupport = 'insufficient';
      let delta: number | null = null;
      if (ideaEntry && baselineValue !== null) {
        delta = adjustDelta(ideaEntry.value, baselineValue, direction);
        support = delta > 0 ? 'supported' : 'not-supported';
      }
      const statement =
        ideaEntry === null
          ? `${card.hypothesis.statement} — no full-run idea value for ${name}`
          : baselineValue === null
            ? `${card.hypothesis.statement} — full-run ${name}=${ideaEntry.value} with no required-comparison baseline recorded`
            : `${card.hypothesis.statement} — full-run ${name}: idea ${ideaEntry.value} vs best baseline ${baselineValue} (${support})`;
      claims.push({
        claimId: `claim-${name.replace(/[^\w]+/g, '-').toLowerCase()}`,
        statement,
        support,
        metric: name,
        direction,
        ideaValue: ideaEntry?.value ?? null,
        baselineValue,
        delta,
        evidence,
        protocolCriteria: supportCriteria,
      });
    }

    return {
      contract: RESULT_TO_CLAIM_SCHEMA,
      ideaId,
      generatedAt: Date.now(),
      planInputHash: typeof report?.planInputHash === 'string' ? report.planInputHash : null,
      claims,
      gaps,
    };
  } finally {
    await runtime.close();
  }
}

export function resultToClaimPath(root: string, ideaId: string): string {
  return `${root}/ideas/${ideaId}/experiments/result-to-claim.json`.replace(/\\/g, '/');
}

export async function writeResultToClaim(root: string, claim: ResultToClaim): Promise<string> {
  const { join } = await import('node:path');
  const { ensureDir } = await import('../core/atomic.js');
  const path = resultToClaimPath(root, claim.ideaId);
  await ensureDir(join(root, 'ideas', claim.ideaId, 'experiments'));
  await writeFileAtomic(path, `${JSON.stringify(claim, null, 2)}\n`);
  return path;
}

/** Throws when called on an unknown idea (CLI convenience). */
export function assertDerivable(result: ResultToClaim): void {
  if (result.claims.length === 0 && result.gaps.length > 0) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `result-to-claim has no derivable claims: ${result.gaps.join('; ')}`,
      { gaps: result.gaps },
    );
  }
}
