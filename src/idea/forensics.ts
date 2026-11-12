import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of, sha256OfFile } from '../core/hash.js';
import { writeFileAtomic } from '../core/atomic.js';
import { stableJson, type ExperimentSpec, type RunResult } from '../experiment/spec.js';
import { renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';
import type { IdeaCard } from './card.js';
import type { IdeaAnalysis } from './analysis.js';
import type { ExperimentAudit } from './audit.js';
import type { EvidenceAudit } from './claim-audit.js';

/**
 * Integrity forensics (Phase 4.5C, ARIS integrity-forensics): an adversarial
 * sweep over an idea's PERSISTED experiment evidence that checks result
 * selection, failure hiding, protocol/metric/seed/data/code drift, claim
 * evidence sufficiency and anomalous result narratives — then turns the
 * findings into a typed policy gate (BLOCK / WARN / NO_NEW_BLOCKER) for the
 * handoff delivery.
 *
 * Build-vs-reuse gate (ADR-007):
 * 1. DSH public capability? No — DSH only runs agents; the sweep is a
 *    deterministic科研 quality gate over IdeaSeek state.
 * 2. ARIS skill available? Yes — vendored `integrity-forensics` (thin
 *    launcher over pinned Anti-Autoresearch + forensics_gate.py). Its
 *    upstream clone/Codex sweep targets papers and needs network + an
 *    external adjudicator, which IdeaSeek's offline contract cannot require;
 *    its DOCTRINE is reused verbatim: adversarial span-anchored findings,
 *    the auditor PROPOSES and a rules-only reporter adjudicates, verdict →
 *    policy mapping (HARD→BLOCK, soft→WARN, clean→NO_NEW_BLOCKER — never an
 *    acquittal), findings are immutable and waivers are first-class.
 * 3. Adapter reuse: the vendored skill body is rendered into the harness
 *    instruction (same pattern as experiment-audit); the policy vocabulary
 *    and ledger semantics match `forensics_gate.py`.
 * 4. Gap = persistence + structured contract: findings live in an IdeaSeek
 *    workspace artifact bound by inputHash/stateDigest, surface as a
 *    RunEvent and a DECISION on waiver, and gate `idea handoff`. No second
 *    agent loop, no second task database, no parallel audit state source —
 *    this file is the ONLY forensics state, and it is a projection of
 *    artifacts IdeaSeek already owns.
 *
 * The deterministic sweep always runs (ADR-003); the optional model pass
 * only PROPOSES extra findings on top of the deterministic ledger — the
 * policy is recomputed from the merged findings, so a model can never
 * soften or drop a deterministic finding.
 */

export const FORENSICS_SCHEMA = 'integrity-forensics-v1';

export type ForensicsPolicy = 'BLOCK' | 'WARN' | 'NO_NEW_BLOCKER';

export const FORENSICS_FAMILIES = [
  'result-selection',
  'failure-hiding',
  'drift',
  'claim-evidence',
  'anomalous-narrative',
  'coverage',
] as const;

export type ForensicsFamily = (typeof FORENSICS_FAMILIES)[number];

export type ForensicsSeverity = 'critical' | 'major' | 'minor';

export interface ForensicsFinding {
  /** Stable check id (deterministic) or `model:<id>` (proposed by the pass). */
  id: string;
  family: ForensicsFamily;
  severity: ForensicsSeverity;
  source: 'deterministic' | 'model';
  detail: string;
  /** Where the sweep looked: artifact field path (ARIS file:line discipline). */
  evidence: string;
}

export interface ForensicsWaiver {
  findingId: string;
  reason: string;
  waivedAt: number;
  /** DECISION event seq; null when no run exists yet (waiver still recorded). */
  decisionSeq: number | null;
}

export interface ForensicsCoverage {
  /** Checks actually evaluated against present evidence. */
  checksRun: string[];
  /** Checks skipped because their input was absent (honest incompleteness). */
  checksDeferred: string[];
  modelPass: 'ran' | 'skipped-no-evidence';
}

export interface IntegrityForensics {
  contract: typeof FORENSICS_SCHEMA;
  ideaId: string;
  cardVersion: number;
  /** sha over contract + skill + idea + cardVersion + evidenceDigest. */
  inputHash: string;
  skill: { name: string; sha256: string };
  generatedAt: number;
  harnessRuntime: string | null;
  model: string | null;
  /** Digest of the full bundle the sweep (and model pass) saw. */
  evidenceDigest: string;
  /** Filesystem fingerprint the handoff recomputes to detect staleness. */
  stateDigest: string;
  findings: ForensicsFinding[];
  /** Append-only: waivers survive re-sweeps; original findings never change. */
  waivers: ForensicsWaiver[];
  /** Display only — every consumer recomputes via computeForensicsPolicy. */
  policy: ForensicsPolicy;
  summary: string;
  coverage: ForensicsCoverage;
}

// --- evidence bundle -------------------------------------------------------

export interface ForensicsMirror {
  /** Workspace-relative file name under experiments/. */
  file: string;
  spec: ExperimentSpec;
  result: RunResult | null;
}

export interface ForensicsBundle {
  ideaId: string;
  currentVersion: number;
  codeHash: string | null;
  stateDigest: string;
  card: IdeaCard;
  mirrors: ForensicsMirror[];
  analysis: IdeaAnalysis | null;
  experimentAudit: ExperimentAudit | null;
  claimAudit: EvidenceAudit | null;
  /** Current stored plan (seeds contract only — projection for stability). */
  plan: { ideaVersion: number; seeds: number[] } | null;
  currentProtocolId: string | null;
}

export interface ForensicsRuntime {
  db: {
    listArtifactsByKind(
      kind: string,
    ): Promise<{ contentHash: string; meta: Record<string, unknown> }[]>;
  };
  store: { readFinalText(hash: string): Promise<string> };
}

/** Mirror files of THIS idea only — excludes `idea-foo-bar-*` prefix collisions. */
function mirrorFileNameMatches(name: string, ideaId: string): boolean {
  return new RegExp(`^idea-${ideaId}-(v\\d+|abl-).*\\.json$`).test(name);
}

async function readMirrors(root: string, ideaId: string): Promise<ForensicsMirror[]> {
  const dir = join(root, 'ideas', ideaId, 'experiments');
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(dir).catch(() => [] as string[]);
  const mirrors: ForensicsMirror[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || !mirrorFileNameMatches(name, ideaId)) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
        spec?: ExperimentSpec;
        result?: RunResult;
      };
      if (parsed.spec) {
        mirrors.push({ file: name, spec: parsed.spec, result: parsed.result ?? null });
      }
    } catch {
      continue; // unreadable mirror stays out of the sweep (honest: not evidence)
    }
  }
  mirrors.sort((a, b) => a.spec.version - b.spec.version || a.file.localeCompare(b.file));
  return mirrors;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Filesystem-only fingerprint of the evidence the deterministic checks read
 * (card, mirrors, analysis, audits, code hash, card version). The handoff
 * recomputes it WITHOUT a runtime — a sweep whose inputs moved after it ran
 * reads as stale and fails closed (ARIS `fresh` doctrine), never as a pass.
 * Plan/protocol artifacts live in the store, not on this path; their drift
 * checks are bound at sweep time via evidenceDigest instead.
 */
export async function computeForensicsStateDigest(
  root: string,
  ideaId: string,
  currentVersion: number,
): Promise<string> {
  const base = join(root, 'ideas', ideaId);
  const shaOrNull = async (path: string): Promise<string | null> => {
    try {
      return await sha256OfFile(path);
    } catch {
      return null;
    }
  };
  const { hashIdeaSource } = await import('./workspace.js');
  const mirrors = await readMirrors(root, ideaId);
  const mirrorShas: [string, string][] = [];
  for (const mirror of mirrors) {
    const sha = await shaOrNull(join(base, 'experiments', mirror.file));
    if (sha) mirrorShas.push([mirror.file, sha]);
  }
  return sha256Of(
    stableJson({
      ideaId,
      currentVersion,
      cardSha: await shaOrNull(join(base, 'idea.json')),
      codeHash: await hashIdeaSource(root, ideaId),
      mirrors: mirrorShas,
      analysisSha: await shaOrNull(join(base, 'experiments', 'analysis.json')),
      experimentAuditSha: await shaOrNull(join(base, 'experiments', 'audit.json')),
      claimAuditSha: await shaOrNull(join(base, 'evidence-audit.json')),
    }),
  );
}

export async function collectForensicsBundle(
  root: string,
  ideaId: string,
  runtime: ForensicsRuntime,
): Promise<ForensicsBundle> {
  const { hashIdeaSource, loadIdeaCard, loadWorkspaceMeta } = await import('./workspace.js');
  const { readAudit } = await import('./audit.js');
  const { readClaimAudit } = await import('./claim-audit.js');
  const { loadStoredPlan } = await import('../experiment/plan.js');

  const meta = await loadWorkspaceMeta(root, ideaId);
  const card = await loadIdeaCard(root, ideaId);
  const mirrors = await readMirrors(root, ideaId);
  const analysis = await readJsonOrNull<IdeaAnalysis>(
    join(root, 'ideas', ideaId, 'experiments', 'analysis.json'),
  );

  let plan: ForensicsBundle['plan'] = null;
  try {
    const stored = await loadStoredPlan(runtime, ideaId);
    if (stored) {
      const seeds = Array.isArray(stored.plan?.seeds)
        ? stored.plan.seeds.filter((s): s is number => typeof s === 'number' && Number.isInteger(s))
        : [];
      plan = { ideaVersion: stored.ideaVersion, seeds };
    }
  } catch {
    plan = null; // unreadable plan artifact counts as absent
  }

  let currentProtocolId: string | null = null;
  try {
    const proposals = await runtime.db.listArtifactsByKind('protocol-proposal');
    const chosen = proposals[proposals.length - 1];
    if (chosen) {
      const payload = JSON.parse(await runtime.store.readFinalText(chosen.contentHash)) as {
        protocolId?: unknown;
      };
      if (typeof payload.protocolId === 'string') currentProtocolId = payload.protocolId;
    }
  } catch {
    currentProtocolId = null;
  }

  const stateDigest = await computeForensicsStateDigest(root, ideaId, meta.currentVersion);
  return {
    ideaId,
    currentVersion: meta.currentVersion,
    codeHash: await hashIdeaSource(root, ideaId),
    stateDigest,
    card,
    mirrors,
    analysis,
    experimentAudit: await readAudit(root, ideaId),
    claimAudit: await readClaimAudit(root, ideaId),
    plan,
    currentProtocolId,
  };
}

/** Digest of the bundle the sweep/model pass saw (reuse + provenance). */
export function forensicsEvidenceDigest(bundle: ForensicsBundle): string {
  return sha256Of(stableJson(bundle));
}

// --- deterministic sweep ---------------------------------------------------

export interface SweepResult {
  findings: ForensicsFinding[];
  checksRun: string[];
  checksDeferred: string[];
}

const SCOPE_LANGUAGE =
  /\b(comprehensive|extensive|definitive|definitively|conclusive|conclusively|state[- ]of[- ]the[- ]art|proves?|guarantees?)\b/i;

function noteValue(spec: ExperimentSpec, prefix: string): string | null {
  return (spec.environment.notes ?? []).find((n) => n.startsWith(prefix)) ?? null;
}

/**
 * The deterministic ledger (ADR-003): every check is pure over the bundle,
 * one stable finding id per check, evidence = field path. A check whose
 * input is absent is DEFERRED, not silently passed — the coverage block
 * records exactly what ran (ARIS observability honesty).
 */
export function sweepDeterministic(bundle: ForensicsBundle): SweepResult {
  const findings: ForensicsFinding[] = [];
  const checksRun: string[] = [];
  const checksDeferred: string[] = [];
  const push = (
    id: string,
    family: ForensicsFamily,
    severity: ForensicsSeverity,
    detail: string,
    evidence: string,
  ): void => {
    findings.push({ id, family, severity, source: 'deterministic', detail, evidence });
  };
  const evalOrDefer = (id: string, applicable: boolean, evaluate: () => void): void => {
    if (applicable) {
      checksRun.push(id);
      evaluate();
    } else {
      checksDeferred.push(id);
    }
  };

  const analysis = bundle.analysis;
  const mainMirrors = bundle.mirrors.filter((m) => m.spec.specId === `idea-${bundle.ideaId}`);
  const latestMain = mainMirrors[mainMirrors.length - 1] ?? null;
  const succeededMirrors = bundle.mirrors.filter((m) => m.result?.status === 'succeeded');
  const failedMirrors = bundle.mirrors.filter(
    (m) => m.result !== null && m.result.status !== 'succeeded',
  );

  // --- coverage: an empty sweep must say so, never imply a clean bill.
  evalOrDefer('coverage:no-evidence', true, () => {
    if (bundle.mirrors.length === 0) {
      push(
        'coverage:no-evidence',
        'coverage',
        'minor',
        'no experiment evidence recorded — the sweep had nothing to inspect (model pass skipped)',
        'mirrors',
      );
    }
  });
  evalOrDefer('coverage:no-analysis', bundle.mirrors.length > 0, () => {
    if (analysis === null) {
      push(
        'coverage:no-analysis',
        'coverage',
        'minor',
        'experiments exist but experiments/analysis.json does not — result-selection, ' +
          'failure-hiding and narrative checks are deferred until ideaseek idea analyze',
        'experiments/analysis.json',
      );
    }
  });

  // --- result selection: does the narrative include the newest recorded runs?
  evalOrDefer('result-selection:stale-analysis', analysis !== null, () => {
    if (!analysis) return;
    const newer = bundle.mirrors.filter(
      (m) => m.result !== null && m.result.finishedAt > analysis.generatedAt,
    );
    if (newer.length > 0) {
      push(
        'result-selection:stale-analysis',
        'result-selection',
        'major',
        `analysis was generated before ${newer.length} recorded run(s) ` +
          `(${newer.map((m) => m.file).join(', ')}) — newer results are absent from the narrative; ` +
          'rerun ideaseek idea analyze before reporting',
        'experiments/analysis.json:generatedAt',
      );
    }
  });

  // --- failure hiding: every recorded failure must survive into the analysis.
  evalOrDefer('failure-hiding:unlisted-failure', analysis !== null, () => {
    if (!analysis) return;
    const listed = new Set(analysis.failures.map((f) => f.specId));
    const hidden = failedMirrors.filter((m) => !listed.has(m.spec.specId));
    if (hidden.length > 0) {
      push(
        'failure-hiding:unlisted-failure',
        'failure-hiding',
        'major',
        `failed run(s) recorded in mirrors but absent from the analysis failure record: ` +
          hidden
            .map((m) => `${m.file} (${m.result?.failure?.category ?? m.result?.status})`)
            .join(', '),
        'experiments/analysis.json:failures',
      );
    }
  });

  // --- drift: the results must still describe the code/card/plan/protocol/data
  //         they claim to describe.
  evalOrDefer('drift:code-version', bundle.codeHash !== null && latestMain !== null, () => {
    if (!bundle.codeHash || !latestMain) return;
    const runNote = noteValue(latestMain.spec, 'idea-code:');
    const analysisMismatch = analysis?.codeHash != null && analysis.codeHash !== bundle.codeHash;
    const runMismatch = runNote !== null && runNote !== `idea-code:${bundle.codeHash}`;
    if (runMismatch || analysisMismatch) {
      push(
        'drift:code-version',
        'drift',
        'major',
        `recorded results were produced by different code than the current workspace ` +
          `(run note: ${runNote ?? 'absent'}, analysis: ${analysis?.codeHash ?? 'absent'}, ` +
          `current: ${bundle.codeHash})`,
        'experiments/analysis.json:codeHash',
      );
    }
  });
  evalOrDefer('drift:card-version', latestMain !== null, () => {
    if (!latestMain) return;
    const runNote = noteValue(latestMain.spec, 'idea-v:');
    const runVersion = runNote ? Number(runNote.slice('idea-v:'.length)) : NaN;
    if (Number.isFinite(runVersion) && runVersion !== bundle.currentVersion) {
      push(
        'drift:card-version',
        'drift',
        'major',
        `latest recorded run was built for card v${runVersion} but the workspace is ` +
          `v${bundle.currentVersion} — results predate the current idea`,
        'experiments/mirrors:spec.environment.notes',
      );
    }
  });
  evalOrDefer(
    'drift:undeclared-metric',
    succeededMirrors.some((m) => (m.result?.metrics.length ?? 0) > 0),
    () => {
      const offenders = succeededMirrors.filter((m) => {
        const declared = new Set((m.spec.metrics ?? []).map((metric) => metric.name));
        return (m.result?.metrics ?? []).some((metric) => !declared.has(metric.name));
      });
      if (offenders.length > 0) {
        push(
          'drift:undeclared-metric',
          'drift',
          'major',
          `succeeded result(s) report metric(s) the spec never declared: ` +
            offenders.map((m) => m.file).join(', ') +
            ' — verify the metrics were not swapped after the run',
          'experiments/mirrors:result.metrics',
        );
      }
    },
  );
  evalOrDefer('drift:missing-primary-metric', succeededMirrors.length > 0, () => {
    const primaryOf = (spec: ExperimentSpec): string | null => spec.metrics[0]?.name ?? null;
    const offenders = succeededMirrors.filter((m) => {
      const primary = primaryOf(m.spec);
      if (!primary) return false;
      return !(m.result?.metrics ?? []).some((metric) => metric.name === primary);
    });
    if (offenders.length > 0) {
      push(
        'drift:missing-primary-metric',
        'drift',
        'major',
        `succeeded result(s) missing the spec's primary metric: ` +
          offenders.map((m) => m.file).join(', '),
        'experiments/mirrors:result.metrics',
      );
    }
  });
  evalOrDefer(
    'drift:seed-contract',
    bundle.plan !== null &&
      bundle.plan.ideaVersion === bundle.currentVersion &&
      latestMain !== null &&
      latestMain.result?.status === 'succeeded',
    () => {
      if (!bundle.plan || !latestMain) return;
      const runSeeds = latestMain.spec.seeds ?? [];
      const planSeeds = bundle.plan.seeds;
      if (
        planSeeds.length > 0 &&
        (runSeeds.length !== planSeeds.length || runSeeds.some((seed, i) => seed !== planSeeds[i]))
      ) {
        push(
          'drift:seed-contract',
          'drift',
          'major',
          `latest run used seeds [${runSeeds.join(', ')}] but the current experiment plan ` +
            `declares [${planSeeds.join(', ')}] — the run does not satisfy the plan's ` +
            'reproducibility contract',
          'plan.seeds',
        );
      }
    },
  );
  evalOrDefer(
    'drift:protocol',
    latestMain !== null &&
      typeof latestMain.spec.protocolId === 'string' &&
      bundle.currentProtocolId !== null,
    () => {
      if (!latestMain || !bundle.currentProtocolId) return;
      if (latestMain.spec.protocolId !== bundle.currentProtocolId) {
        push(
          'drift:protocol',
          'drift',
          'major',
          `latest run is bound to protocol ${String(latestMain.spec.protocolId)} but the ` +
            `current locked protocol is ${bundle.currentProtocolId} — results predate the ` +
            'protocol change',
          'experiments/mirrors:spec.protocolId',
        );
      }
    },
  );

  // --- claim evidence: claims must stand on recorded, non-contradicted results.
  // One check over the current experiment-audit claim impacts; it emits the
  // blocked (major) or weakened (minor) finding id when either applies.
  const audit = bundle.experimentAudit;
  const auditCurrent = audit !== null && audit.cardVersion === bundle.currentVersion;
  evalOrDefer('claim-evidence:audit-claims', auditCurrent, () => {
    if (!audit) return;
    const blocked = audit.claims.filter((claim) => claim.impact === 'block');
    const weakened = audit.claims.filter((claim) => claim.impact === 'weaken');
    if (blocked.length > 0) {
      push(
        'claim-evidence:audit-blocked-claims',
        'claim-evidence',
        'major',
        `experiment-audit marks claim(s) ${blocked.map((c) => c.id).join(', ')} as blocked — ` +
          'the recorded evidence does not support them',
        'experiments/audit.json:claims',
      );
    } else if (weakened.length > 0) {
      push(
        'claim-evidence:audit-weakened-claims',
        'claim-evidence',
        'minor',
        `experiment-audit weakens claim(s) ${weakened.map((c) => c.id).join(', ')} — narrow ` +
          'the wording or add evidence before delivery',
        'experiments/audit.json:claims',
      );
    }
  });
  evalOrDefer('claim-evidence:unsupported-verdict', analysis !== null, () => {
    if (!analysis) return;
    if (analysis.verdict === 'supported') {
      const gaps = analysis.coverage.missing.length > 0;
      const noDelta = !(analysis.primaryDelta !== null && analysis.primaryDelta > 0);
      if (gaps || noDelta) {
        push(
          'claim-evidence:unsupported-verdict',
          'claim-evidence',
          'critical',
          `analysis says "supported" but the evidence does not: ` +
            (gaps
              ? `coverage gaps remain (${analysis.coverage.missing.join('; ')})`
              : 'no positive primary delta against a baseline') +
            ' — the claim outruns its evidence',
          'experiments/analysis.json:verdict',
        );
      }
    }
  });

  // --- anomalous narrative: perfect scores and scope language over gaps.
  evalOrDefer(
    'anomalous-narrative:perfect-score',
    latestMain !== null && latestMain.result?.status === 'succeeded',
    () => {
      if (!latestMain || !latestMain.result) return;
      const primary = latestMain.spec.metrics[0];
      if (!primary) return;
      const value = latestMain.result.metrics.find((m) => m.name === primary.name)?.value;
      if (value === undefined) return;
      const perfect =
        (primary.direction === 'higher' && value >= 1) ||
        (primary.direction === 'lower' && value <= 0);
      if (perfect) {
        push(
          'anomalous-narrative:perfect-score',
          'anomalous-narrative',
          'major',
          `primary metric "${primary.name}"=${value} is a perfect score under direction ` +
            `"${primary.direction}" — verify against raw outputs before narrating it ` +
            '(self-normalization / proxy-target failure mode)',
          'experiments/mirrors:result.metrics',
        );
      }
    },
  );
  evalOrDefer('anomalous-narrative:overstated-scope', analysis !== null, () => {
    if (!analysis) return;
    const gaps =
      analysis.coverage.missing.length > 0 ||
      analysis.coverage.seeds < 2 ||
      analysis.coverage.scales.length < 2 ||
      analysis.failures.length > 0;
    if (!gaps) return;
    const narrative = [
      bundle.card.hypothesis.statement,
      bundle.card.novelty.claim,
      ...analysis.reasons,
    ].join(' ');
    const match = SCOPE_LANGUAGE.exec(narrative);
    if (match) {
      push(
        'anomalous-narrative:overstated-scope',
        'anomalous-narrative',
        'major',
        `narrative language "${match[0]}" exceeds the recorded evidence ` +
          `(seeds=${analysis.coverage.seeds}, scales=${analysis.coverage.scales.length}, ` +
          `failures=${analysis.failures.length}, gaps=${analysis.coverage.missing.length})`,
        'card.hypothesis.statement',
      );
    }
  });

  return { findings, checksRun, checksDeferred };
}

// --- policy (the rules-only reporter) --------------------------------------

/**
 * The ONE deterministic decision function — written artifacts store it for
 * display, but every consumer RECOMPUTES from findings + waivers (editing a
 * stored `policy` field must change nothing, ARIS forensics_gate `_decide`).
 *
 *   any open critical            → BLOCK
 *   any open finding             → WARN
 *   everything waived / nothing  → NO_NEW_BLOCKER   (never PASS / acquittal)
 */
export function computeForensicsPolicy(
  findings: ForensicsFinding[],
  waivers: ForensicsWaiver[],
): ForensicsPolicy {
  const waived = new Set(waivers.map((waiver) => waiver.findingId));
  const open = findings.filter((finding) => !waived.has(finding.id));
  if (open.some((finding) => finding.severity === 'critical')) return 'BLOCK';
  if (open.length > 0) return 'WARN';
  return 'NO_NEW_BLOCKER';
}

export function summarizeFindings(findings: ForensicsFinding[]): string {
  if (findings.length === 0) {
    return 'no findings in the evidence at hand — a sweep raises flags; it never acquits';
  }
  const bySeverity = (severity: ForensicsSeverity): string[] =>
    findings.filter((f) => f.severity === severity).map((f) => f.id);
  const parts: string[] = [];
  for (const severity of ['critical', 'major', 'minor'] as const) {
    const ids = bySeverity(severity);
    if (ids.length > 0) parts.push(`${ids.length} ${severity}: ${ids.join(', ')}`);
  }
  return `${findings.length} finding(s) — ${parts.join('; ')}`;
}

// --- harness request + output contract -------------------------------------

const OUTPUT_CONTRACT = `
# IdeaSeek output contract (${FORENSICS_SCHEMA})

Reply with ONE JSON object and nothing else:

{"ideaId": "...", "cardVersion": <number>,
 "findings": [{"id": "...",
   "family": "result-selection|failure-hiding|drift|claim-evidence|anomalous-narrative|coverage",
   "severity": "critical|major|minor",
   "detail": "...",
   "evidence": "<artifact field path you examined, e.g. experiments/analysis.json:verdict>"}],
 "summary": "..."}

Rules:
- ideaId and cardVersion MUST echo the inputs.
- findings may be [] — propose nothing when nothing is suspicious.
- Every finding MUST cite a field path that exists in the bundle (never
  invent paths); ids must be unique; detail and summary non-empty.
- You PROPOSE findings only. The deterministic reporter computes the
  policy from the merged ledger — do not output a verdict, and do not
  re-propose the deterministic findings listed above.
- No prose, no markdown fence, no commentary outside the JSON object.
`.trim();

export interface ForensicsRequest {
  instruction: string;
  inputHash: string;
  idempotencyKey: string;
  evidenceDigest: string;
}

export function buildForensicsRequest(
  skill: LoadedArisSkill,
  context: {
    ideaId: string;
    cardVersion: number;
    bundle: ForensicsBundle;
    evidenceDigest: string;
    sweep: SweepResult;
  },
): ForensicsRequest {
  const inputHash = sha256Of(
    stableJson({
      contract: FORENSICS_SCHEMA,
      skillSha256: skill.sha256,
      ideaId: context.ideaId,
      cardVersion: context.cardVersion,
      evidenceDigest: context.evidenceDigest,
    }),
  );
  const instruction = [
    renderArisSkill(skill, {
      arguments: `IdeaSeek idea ${context.ideaId} integrity forensics (card v${context.cardVersion})`,
    }),
    '',
    '---',
    '',
    '## IdeaSeek adapter framing (thin wrapper)',
    '',
    'The ARIS launcher mechanics above target a paper-side pinned',
    'Anti-Autoresearch clone; they do NOT apply here. Run the same',
    'integrity-forensics DOCTRINE against the persisted IdeaSeek evidence',
    'bundle below: adversarial sweep, span-anchored findings with field-path',
    'evidence, auditor PROPOSES only — a deterministic reporter computes the',
    'policy. Checks to run (beyond the deterministic ledger): result',
    'selection, failure hiding, protocol/metric/seed/data/code drift, claim',
    'evidence sufficiency, anomalous result narratives.',
    '',
    'Deterministic findings already computed (do NOT re-propose):',
    JSON.stringify(context.sweep.findings, null, 2),
    '',
    'Checks already run by the deterministic sweep:',
    [...context.sweep.checksRun, ...context.sweep.checksDeferred].join(', '),
    '',
    '---',
    '',
    OUTPUT_CONTRACT,
    '',
    `Evidence bundle (digest ${context.evidenceDigest}) — the only input you may audit:`,
    JSON.stringify(context.bundle, null, 2),
  ].join('\n');
  return {
    instruction,
    inputHash,
    idempotencyKey: `idea-forensics:${inputHash}`,
    evidenceDigest: context.evidenceDigest,
  };
}

// --- output validation / parsing -------------------------------------------

export interface ForensicsValidation {
  ok: boolean;
  errors: string[];
}

export function validateForensicsOutput(
  value: unknown,
  expected: { ideaId: string; cardVersion: number },
): ForensicsValidation {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['forensics output must be a JSON object'] };
  }
  const record = value as Record<string, unknown>;
  if (record.ideaId !== expected.ideaId) errors.push(`ideaId must be "${expected.ideaId}"`);
  if (record.cardVersion !== expected.cardVersion) {
    errors.push(`cardVersion must be ${expected.cardVersion}`);
  }
  const findings = record.findings;
  if (!Array.isArray(findings)) {
    errors.push('findings must be an array (may be empty)');
  } else {
    const seen = new Set<string>();
    for (const [i, entry] of findings.entries()) {
      const item = entry as Partial<ForensicsFinding>;
      const where = `findings[${i}]`;
      if (typeof item?.id !== 'string' || !item.id.trim()) {
        errors.push(`${where}.id must be a non-empty string`);
      } else if (seen.has(item.id)) {
        errors.push(`${where}.id "${item.id}" is duplicated`);
      } else {
        seen.add(item.id);
      }
      if (!FORENSICS_FAMILIES.includes(item?.family as ForensicsFamily)) {
        errors.push(`${where}.family must be one of ${FORENSICS_FAMILIES.join('|')}`);
      }
      if (!['critical', 'major', 'minor'].includes(String(item?.severity))) {
        errors.push(`${where}.severity must be critical|major|minor`);
      }
      if (typeof item?.detail !== 'string' || !item.detail.trim()) {
        errors.push(`${where}.detail must be a non-empty string`);
      }
      if (typeof item?.evidence !== 'string' || !item.evidence.trim()) {
        errors.push(`${where}.evidence must cite where you looked (field path)`);
      }
    }
  }
  if (typeof record.summary !== 'string' || !record.summary.trim()) {
    errors.push('summary must be a non-empty string');
  }
  return { ok: errors.length === 0, errors };
}

export interface ParseMeta {
  inputHash: string;
  skill: { name: string; sha256: string };
  harnessRuntime: string;
  model: string | null;
  evidenceDigest: string;
  stateDigest: string;
  sweep: SweepResult;
  waivers: ForensicsWaiver[];
  cardVersion: number;
}

function assemble(
  ideaId: string,
  meta: ParseMeta,
  modelFindings: ForensicsFinding[],
  modelPass: ForensicsCoverage['modelPass'],
  model: string | null,
  harnessRuntime: string | null,
): IntegrityForensics {
  const findings = [...meta.sweep.findings, ...modelFindings];
  return {
    contract: FORENSICS_SCHEMA,
    ideaId,
    cardVersion: meta.cardVersion,
    inputHash: meta.inputHash,
    skill: meta.skill,
    generatedAt: Date.now(),
    harnessRuntime,
    model,
    evidenceDigest: meta.evidenceDigest,
    stateDigest: meta.stateDigest,
    findings,
    // Append-only: waivers from a previous sweep of the same idea carry over;
    // a waiver for a vanished finding stays recorded (it just gates nothing).
    waivers: meta.waivers,
    policy: computeForensicsPolicy(findings, meta.waivers),
    summary: summarizeFindings(findings),
    coverage: { ...meta.sweep, modelPass },
  };
}

/** Artifact for a sweep with no model pass (no evidence to review). */
export function forensicsWithoutModel(ideaId: string, meta: ParseMeta): IntegrityForensics {
  return assemble(ideaId, meta, [], 'skipped-no-evidence', null, null);
}

export function parseForensicsOutput(
  output: string,
  expected: { ideaId: string; cardVersion: number },
  meta: ParseMeta,
): IntegrityForensics {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `integrity-forensics output is not JSON: ${output.slice(0, 160)}`,
    );
  }
  const validation = validateForensicsOutput(parsed, expected);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `integrity-forensics output failed validation: ${validation.errors.slice(0, 4).join('; ')}`,
    );
  }
  const record = parsed as {
    findings: ForensicsFinding[];
    summary: string;
  };
  const modelFindings: ForensicsFinding[] = record.findings.map((finding) => ({
    ...finding,
    id: `model:${finding.id}`,
    source: 'model' as const,
  }));
  return assemble(expected.ideaId, meta, modelFindings, 'ran', meta.model, meta.harnessRuntime);
}

// --- persistence ------------------------------------------------------------

export function forensicsPath(root: string, ideaId: string): string {
  return join(root, 'ideas', ideaId, 'experiments', 'forensics.json');
}

/** Reads the persisted sweep; wrong contract/idea → null. */
export async function readForensics(
  root: string,
  ideaId: string,
): Promise<IntegrityForensics | null> {
  try {
    const forensics = JSON.parse(
      await readFile(forensicsPath(root, ideaId), 'utf8'),
    ) as IntegrityForensics;
    if (forensics.contract !== FORENSICS_SCHEMA || forensics.ideaId !== ideaId) return null;
    if (!Array.isArray(forensics.findings) || !Array.isArray(forensics.waivers)) return null;
    return forensics;
  } catch {
    return null;
  }
}

export async function writeForensics(root: string, forensics: IntegrityForensics): Promise<string> {
  const path = forensicsPath(root, forensics.ideaId);
  await writeFileAtomic(path, `${JSON.stringify(forensics, null, 2)}\n`);
  return path;
}

/**
 * Appends a waiver (the original finding snapshot is never modified) and
 * returns the updated sweep with a recomputed policy. Throws when the
 * finding is unknown or already waived — callers surface those as CLI
 * errors instead of silently double-recording.
 */
export function waiveFinding(
  forensics: IntegrityForensics,
  findingId: string,
  reason: string,
  decisionSeq: number | null,
): IntegrityForensics {
  const finding = forensics.findings.find((f) => f.id === findingId);
  if (!finding) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `no finding "${findingId}" in the current sweep (findings: ` +
        `${forensics.findings.map((f) => f.id).join(', ') || 'none'})`,
    );
  }
  if (forensics.waivers.some((w) => w.findingId === findingId)) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `finding "${findingId}" is already waived — a waiver is append-only and stands`,
    );
  }
  if (!reason.trim()) {
    throw new IdeaseekError('INVALID_ARGUMENT', '--reason is required for a waiver');
  }
  const waivers = [...forensics.waivers, { findingId, reason, waivedAt: Date.now(), decisionSeq }];
  return {
    ...forensics,
    waivers,
    policy: computeForensicsPolicy(forensics.findings, waivers),
    summary: summarizeFindings(forensics.findings),
  };
}
