import { IdeaseekError } from '../core/errors.js';
import { metricIdentifier } from '../core/metric-id.js';

/**
 * Automation policy (docs/AUTONOMY_POLICY.md): guided (default) automates
 * low-risk work and pauses at protected scientific decisions; autonomous
 * proceeds but must record a Decision/Event for every protected action;
 * review-only never writes code or starts experiments. Agents can never
 * silently change primary metrics, data usage, required comparisons or
 * scientific hypotheses — those four are ProtectedAction in every mode.
 */

export type AutonomyMode = 'guided' | 'autonomous' | 'review-only';

export const AUTONOMY_MODES: readonly AutonomyMode[] = ['guided', 'autonomous', 'review-only'];

export type ProtectedAction =
  | 'change-primary-metric'
  | 'change-data-usage'
  | 'change-required-comparison'
  | 'change-hypothesis'
  | 'change-model-route'
  | 'change-research-mode'
  | 'lock-protocol'
  | 'finalize-handoff'
  | 'full-research'
  | 'lock-fairness';

/** Actions that write code or launch runs (blocked outright in review-only). */
export type MutationAction = 'start-experiment' | 'write-code';

export type AutonomyAction = ProtectedAction | MutationAction;

export interface AutonomyCheck {
  allowed: boolean;
  /** A Decision/Event must be recorded when the action proceeds. */
  needsDecision: boolean;
  /** Set when the action requires explicit confirmation in this mode. */
  needsConfirm: boolean;
  reason?: string;
}

export function parseAutonomyMode(raw: unknown): AutonomyMode {
  if (typeof raw === 'string' && (AUTONOMY_MODES as readonly string[]).includes(raw)) {
    return raw as AutonomyMode;
  }
  return 'guided';
}

/** Reads the configured mode from research.yaml (defaults to guided). */
export async function getAutonomyMode(projectRoot: string): Promise<AutonomyMode> {
  try {
    const { projectPaths } = await import('../config/paths.js');
    const { loadConfig } = await import('../config/config.js');
    const loaded = await loadConfig(projectPaths(projectRoot));
    return parseAutonomyMode(loaded.resolved.policy.autonomyMode);
  } catch {
    return 'guided';
  }
}

const PROTECTED: ReadonlySet<string> = new Set<ProtectedAction>([
  'change-primary-metric',
  'change-data-usage',
  'change-required-comparison',
  'change-hypothesis',
  'change-model-route',
  'change-research-mode',
  'lock-protocol',
  'finalize-handoff',
  'full-research',
  'lock-fairness',
]);

const MUTATIONS: ReadonlySet<string> = new Set<MutationAction>(['start-experiment', 'write-code']);

/** Actions disallowed while the interactive/project tier is `analysis` (read-only prep). */
const ANALYSIS_BLOCKED: ReadonlySet<string> = new Set<AutonomyAction>([
  'write-code',
  'start-experiment',
  'lock-protocol',
  'lock-fairness',
  'finalize-handoff',
  'full-research',
  'change-required-comparison',
  'change-hypothesis',
  'change-primary-metric',
  'change-data-usage',
]);

export function isProtectedAction(action: AutonomyAction): boolean {
  return PROTECTED.has(action);
}

/**
 * Pure mode/action matrix.
 * - analysis session tier: read-only preparation — blocks scientific writes,
 *   protocol/fairness locks, comparison/hypothesis/metric/data changes, and
 *   experiments/handoffs regardless of policy.autonomy_mode.
 * - review-only: mutations blocked; protected analysis-adjacent actions that
 *   do not write code/runs are still allowed only when not mutations
 *   (finalize-handoff writes a package → blocked too: analysis only).
 * - guided (default): mutations allowed (smoke/quick are low-risk per
 *   policy); protected actions need explicit confirmation.
 * - autonomous: everything allowed; protected actions still need a recorded
 *   Decision/Event (never silent).
 */
export function checkAutonomy(
  mode: AutonomyMode,
  action: AutonomyAction,
  opts: { confirmed?: boolean; sessionMode?: 'research' | 'analysis' } = {},
): AutonomyCheck {
  const confirmed = opts.confirmed === true;

  if (opts.sessionMode === 'analysis' && ANALYSIS_BLOCKED.has(action)) {
    return {
      allowed: false,
      needsDecision: false,
      needsConfirm: false,
      reason: `analysis mode is read-only preparation and refuses "${action}" — complete material prep then switch to research: ideaseek mode research`,
    };
  }

  if (mode === 'review-only') {
    if (
      MUTATIONS.has(action) ||
      action === 'lock-protocol' ||
      action === 'finalize-handoff' ||
      action === 'full-research' ||
      action === 'lock-fairness'
    ) {
      return {
        allowed: false,
        needsDecision: false,
        needsConfirm: false,
        reason: `review-only mode refuses "${action}": analysis only — no code writes, experiments or deliveries (switch policy.autonomy_mode to continue)`,
      };
    }
    // Protected analysis actions (none currently reach here) stay read-only.
    return { allowed: true, needsDecision: false, needsConfirm: false };
  }

  if (PROTECTED.has(action)) {
    if (mode === 'guided' && !confirmed) {
      return {
        allowed: false,
        needsDecision: false,
        needsConfirm: true,
        reason: `guided mode requires explicit confirmation for "${action}" — rerun with --confirm (a Decision/Event will be recorded)`,
      };
    }
    return { allowed: true, needsDecision: true, needsConfirm: false };
  }

  // Mutations in guided/autonomous: allowed (quick/smoke automation);
  // autonomous additionally records a decision for audit.
  return {
    allowed: true,
    needsDecision: mode === 'autonomous',
    needsConfirm: false,
  };
}

/** Throws USER_INPUT_REQUIRED when the mode forbids the action. */
export function assertAutonomy(
  mode: AutonomyMode,
  action: AutonomyAction,
  opts: { confirmed?: boolean; sessionMode?: 'research' | 'analysis' } = {},
): AutonomyCheck {
  const check = checkAutonomy(mode, action, opts);
  if (!check.allowed) {
    throw new IdeaseekError('USER_INPUT_REQUIRED', check.reason ?? 'action not allowed', {
      mode,
      sessionMode: opts.sessionMode ?? 'research',
      action,
    });
  }
  return check;
}

/** Checks BOTH the project's SessionMode (`analysis` read-only prep) and AutonomyMode. */
export async function checkEffectiveAutonomy(
  projectRoot: string,
  configMode: unknown,
  action: AutonomyAction,
  opts: { confirmed?: boolean } = {},
): Promise<AutonomyCheck> {
  let sessionMode: 'research' | 'analysis' = 'research';
  try {
    const { readSessionMode } = await import('../session/mode.js');
    sessionMode = await readSessionMode(projectRoot);
  } catch {
    sessionMode = 'research';
  }
  return checkAutonomy(parseAutonomyMode(configMode), action, {
    ...opts,
    sessionMode,
  });
}

/** Enforces BOTH SessionMode (`analysis` read-only prep) and AutonomyMode. */
export async function assertEffectiveAutonomy(
  projectRoot: string,
  configMode: unknown,
  action: AutonomyAction,
  opts: { confirmed?: boolean } = {},
): Promise<AutonomyCheck> {
  let sessionMode: 'research' | 'analysis' = 'research';
  try {
    const { readSessionMode } = await import('../session/mode.js');
    sessionMode = await readSessionMode(projectRoot);
  } catch {
    sessionMode = 'research';
  }
  return assertAutonomy(parseAutonomyMode(configMode), action, {
    ...opts,
    sessionMode,
  });
}

/** Audit-only actions: recorded as Decisions but not gated by checkAutonomy. */
export type AuditAction = AutonomyAction | 'change-session-mode';

export interface DecisionInput {
  action: AuditAction;
  target: string;
  mode: AutonomyMode;
  reason?: string;
  /** Defaults: confirmed (user) or auto (autonomous); pending-approval for NL requests. */
  status?: 'confirmed' | 'auto' | 'pending-approval';
}

export interface DecisionDb {
  getLatestRun(projectId: string): Promise<{ runId: string } | null>;
  appendEvent(event: {
    runId: string;
    phase: string;
    objectId: string | null;
    role: string | null;
    eventType: string;
    summary: string;
    status: string | null;
  }): Promise<{ seq: number }>;
}

/**
 * Persists a Decision/Event bound to the latest run (docs/TERMINAL_UX:
 * 批准动作写入 Decision/Event). Returns null when no run exists yet —
 * decisions are run-bound; callers surface that instead of losing them.
 */
export async function recordDecision(
  db: DecisionDb,
  projectId: string,
  input: DecisionInput,
): Promise<{ seq: number } | null> {
  const run = await db.getLatestRun(projectId);
  if (!run) return null;
  const confirmed = input.mode !== 'autonomous';
  return db.appendEvent({
    runId: run.runId,
    phase: 'DECISION',
    objectId: null,
    role: confirmed ? 'user' : 'system',
    eventType: 'decision',
    summary:
      `${input.action}: ${input.target} [${input.mode}]` +
      (input.reason ? ` — ${input.reason}` : ''),
    status: input.status ?? (confirmed ? 'confirmed' : 'auto'),
  });
}

/**
 * Primary-metric guard: when a protocol exists, every protocol metric must
 * still appear in the experiment spec — a silent 主指标 change is refused
 * in every mode (re-lock the protocol to change metrics deliberately).
 *
 * Matched by metric identity, not by string equality on the recorded name.
 * Protocol names carry their measurement definition as prose ("… (held-out
 * domain value, all samples, %)"), which the spec has no way to reproduce
 * verbatim; the first real `idea experiment` on FDG was refused for exactly
 * that reason with a message that named a metric the config did declare.
 *
 * `metricIdentifier` and not `metricKey`: the comparison side needs the
 * looser key because a model writes result dict keys by ear, but this is a
 * guard, and folding case and punctuation would let `accuracy` answer for
 * `Accuracy` or two differently-defined `top1_acc (…)` variants stand in for
 * each other. Dropping or swapping a metric still fails here.
 */
export function assertMetricsMatchProtocol(
  specMetrics: { name: string }[],
  protocolMetrics: { name: string }[],
): void {
  if (protocolMetrics.length === 0) return;
  const specNames = new Set(specMetrics.map((metric) => metricIdentifier(metric.name)));
  const missing = protocolMetrics
    .map((metric) => metric.name)
    .filter((name) => !specNames.has(metricIdentifier(name)));
  if (missing.length > 0) {
    // Both vocabularies have to be on the page. The two names usually come from
    // two different model calls — the ideation round wrote the card's prose
    // metric, the protocol call wrote an identifier — so a message that quotes
    // only one side asks the reader to guess what "align" means. When the spec
    // does declare something that reads like the protocol metric, say so: the
    // honest answer is then "the card and the protocol disagree on the name",
    // which is a re-lock or a card revision, not a config edit.
    const declared = specMetrics.map((metric) => metricIdentifier(metric.name));
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `protocol primary/secondary metrics missing from the experiment spec: ${missing.map(metricIdentifier).join(', ')} — ` +
        `the spec declares [${declared.join(', ') || 'nothing'}]. ` +
        'Either the card names this metric differently from the locked protocol ' +
        '(map the names with evidence: ideaseek idea align-metrics <ideaId> --apply) ' +
        'or the metric was dropped from the experiment (add it to config/train.json). ' +
        'Metrics may not change silently.',
      { missing, declared },
    );
  }
}
