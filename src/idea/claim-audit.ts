import { writeFileAtomic } from '../core/atomic.js';
import { locateQuote } from '../knowledge/checker.js';

/**
 * Idea claim/citation audit (Phase 4.5C, ARIS paper-claim-audit +
 * citation-crosscheck): DETERMINISTIC verification of what an IdeaCard
 * asserts against what IdeaSeek actually holds — every paperEvidence
 * quote must be locatable in the indexed paper it cites (NFKC-normalized
 * search, page reported), and every nearestComparison methodId must be a
 * registered comparison. Unresolvable refs are `unverified` (honest),
 * locatability failures are `missing` → overall FAIL. Strict by design:
 * an audit that cannot find the evidence says so. A current FAIL blocks
 * the handoff delivery (same layer as experiment-audit).
 */

export const CLAIM_AUDIT_SCHEMA = 'evidence-audit-v1';

export type ClaimAuditVerdict = 'pass' | 'warn' | 'fail';

export type EvidenceCheckVerdict = 'found' | 'missing' | 'unverified';

export interface EvidenceCheck {
  kind: 'paper-evidence' | 'nearest-comparison' | 'full-run-result';
  ref: string;
  verdict: EvidenceCheckVerdict;
  detail: string;
  page: number | null;
}

export interface EvidenceAudit {
  contract: typeof CLAIM_AUDIT_SCHEMA;
  ideaId: string;
  cardVersion: number;
  generatedAt: number;
  verdict: ClaimAuditVerdict;
  checks: EvidenceCheck[];
  stats: { found: number; missing: number; unverified: number };
}

interface ParsedPaperPayload {
  source: string;
  sourceHash: string;
  pages?: { page: number; text: string }[];
}

async function loadIndexedPapers(
  root: string,
): Promise<{ byRef: Map<string, ParsedPaperPayload> }> {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const artifacts = await runtime.db.listArtifactsByKind('parsed-paper');
    const byRef = new Map<string, ParsedPaperPayload>();
    for (const artifact of artifacts) {
      try {
        const payload = JSON.parse(
          await runtime.store.readFinalText(artifact.contentHash),
        ) as ParsedPaperPayload;
        if (payload.sourceHash) byRef.set(payload.sourceHash, payload);
        if (payload.source) {
          byRef.set(payload.source, payload);
          const base = payload.source.split(/[\\/]/).pop();
          if (base) byRef.set(base, payload);
        }
      } catch {
        continue; // unreadable artifact → refs stay unverified
      }
    }
    return { byRef };
  } finally {
    await runtime.close();
  }
}

export async function runClaimAudit(root: string, ideaId: string): Promise<EvidenceAudit> {
  const { loadIdeaCard, loadWorkspaceMeta } = await import('./workspace.js');
  const card = await loadIdeaCard(root, ideaId);
  const meta = await loadWorkspaceMeta(root, ideaId);

  const { byRef } = await loadIndexedPapers(root);
  const checks: EvidenceCheck[] = [];

  for (const evidence of card.paperEvidence) {
    const ref = evidence.paperRef;
    const paper = byRef.get(ref) ?? byRef.get(ref.split(/[\\/]/).pop() ?? ref) ?? null;
    if (!paper || !Array.isArray(paper.pages) || paper.pages.length === 0) {
      checks.push({
        kind: 'paper-evidence',
        ref,
        verdict: 'unverified',
        detail: 'no indexed paper matches this reference (ingest it first)',
        page: null,
      });
      continue;
    }
    const located = locateQuote(evidence.evidence, paper.pages, null);
    checks.push({
      kind: 'paper-evidence',
      ref,
      verdict: located.found ? 'found' : 'missing',
      detail: located.found
        ? `evidence located in ${paper.source}`
        : `evidence quote not found in ${paper.source} — the card cites text the paper does not contain`,
      page: located.page,
    });
  }

  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const registered = new Set((await runtime.db.listComparisons()).map((doc) => doc.methodId));
    for (const comparison of card.nearestComparisons) {
      checks.push({
        kind: 'nearest-comparison',
        ref: comparison.methodId,
        verdict: registered.has(comparison.methodId) ? 'found' : 'missing',
        detail: registered.has(comparison.methodId)
          ? 'comparison is registered'
          : `comparison "${comparison.methodId}" is cited but not registered — import or drop it`,
        page: null,
      });
    }

    // Full-run integrity: every item the full-run report claims must have
    // a succeeded registry row (report ↔ registry agreement — the audit
    // that consumes full-run results instead of ignoring them).
    const reports = await runtime.db.listArtifactsByKind('full-run-report');
    let latestReport: { items?: unknown } | null = null;
    for (const artifact of reports) {
      if ((artifact.meta as { ideaId?: unknown } | null)?.ideaId !== ideaId) continue;
      try {
        latestReport = JSON.parse(await runtime.store.readFinalText(artifact.contentHash)) as {
          items?: unknown;
        };
      } catch {
        continue;
      }
    }
    // Only when a full-run report EXISTS: pre-full-run audits keep their
    // original card-evidence semantics (absence is not a defect — the
    // recovery hint lives in `idea result-to-claim` gaps instead).
    if (latestReport) {
      const items = Array.isArray(latestReport.items)
        ? (latestReport.items as { specId?: unknown; status?: unknown }[])
        : [];
      for (const item of items) {
        if (typeof item.specId !== 'string') continue;
        const doc = await runtime.db.getExperiment(item.specId);
        const ok = Boolean(doc && doc.status === 'succeeded' && doc.result);
        checks.push({
          kind: 'full-run-result',
          ref: item.specId,
          verdict: ok ? 'found' : 'missing',
          detail: ok
            ? `full-run report item backed by a succeeded registry result (specHash ${String(doc?.specHash).slice(0, 19)}…)`
            : `full-run report lists ${item.specId} as ${String(item.status)} but the registry has no succeeded result — rerun full or discard the stale report`,
          page: null,
        });
      }
      if (items.length === 0) {
        checks.push({
          kind: 'full-run-result',
          ref: 'full-run-report',
          verdict: 'unverified',
          detail: 'full-run report contains no items',
          page: null,
        });
      }
    }
  } finally {
    await runtime.close();
  }

  const stats = {
    found: checks.filter((check) => check.verdict === 'found').length,
    missing: checks.filter((check) => check.verdict === 'missing').length,
    unverified: checks.filter((check) => check.verdict === 'unverified').length,
  };
  const verdict: ClaimAuditVerdict =
    stats.missing > 0 ? 'fail' : stats.unverified > 0 ? 'warn' : 'pass';

  return {
    contract: CLAIM_AUDIT_SCHEMA,
    ideaId,
    cardVersion: meta.currentVersion,
    generatedAt: Date.now(),
    verdict,
    checks,
    stats,
  };
}

export function claimAuditPath(root: string, ideaId: string): string {
  return `${root.replace(/[\\/]+$/, '')}/ideas/${ideaId}/evidence-audit.json`;
}

export async function writeClaimAudit(root: string, audit: EvidenceAudit): Promise<string> {
  const path = claimAuditPath(root, audit.ideaId);
  await writeFileAtomic(path, `${JSON.stringify(audit, null, 2)}\n`);
  return path;
}

export async function readClaimAudit(root: string, ideaId: string): Promise<EvidenceAudit | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const audit = JSON.parse(await readFile(claimAuditPath(root, ideaId), 'utf8')) as EvidenceAudit;
    if (audit.contract !== CLAIM_AUDIT_SCHEMA || audit.ideaId !== ideaId) return null;
    return audit;
  } catch {
    return null;
  }
}
