import { IdeaseekError } from '../core/errors.js';

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
  | 'finalize-handoff';

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
  'finalize-handoff',
]);

const MUTATIONS: ReadonlySet<string> = new Set<MutationAction>(['start-experiment', 'write-code']);

export function isProtectedAction(action: AutonomyAction): boolean {
  return PROTECTED.has(action);
}

/**
 * Pure mode/action matrix.
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
  opts: { confirmed?: boolean } = {},
): AutonomyCheck {
  const confirmed = opts.confirmed === true;

  if (mode === 'review-only') {
    if (MUTATIONS.has(action) || action === 'finalize-handoff') {
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
  opts: { confirmed?: boolean } = {},
): AutonomyCheck {
  const check = checkAutonomy(mode, action, opts);
  if (!check.allowed) {
    throw new IdeaseekError('USER_INPUT_REQUIRED', check.reason ?? 'action not allowed', {
      mode,
      action,
    });
  }
  return check;
}

export interface DecisionInput {
  action: AutonomyAction;
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
 */
export function assertMetricsMatchProtocol(
  specMetrics: { name: string }[],
  protocolMetrics: { name: string }[],
): void {
  if (protocolMetrics.length === 0) return;
  const specNames = new Set(specMetrics.map((m) => m.name));
  const missing = protocolMetrics.map((m) => m.name).filter((name) => !specNames.has(name));
  if (missing.length > 0) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `protocol primary/secondary metrics missing from the experiment spec: ${missing.join(', ')} — ` +
        'align config/train.json with the locked protocol (metrics may not change silently)',
      { missing },
    );
  }
}
