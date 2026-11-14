import { IdeaseekError } from '../core/errors.js';
import {
  MODE_PERMISSIONS,
  SESSION_MODES,
  AGENT_ENTRY_HINT,
  buildSessionSummary,
  parseSessionMode,
  readSessionMode,
  writeSessionMode,
  type SessionMode,
  type SessionSummary,
} from './mode.js';

export interface ModeSwitchResult {
  changed: boolean;
  previous: SessionMode;
  current: SessionMode;
  decisionSeq: number | null;
  firstPermission: string;
  summary: SessionSummary;
}

/**
 * Shared application use-case for switching `research` ↔ `analysis` tiers
 * (ADR-006). Used by both `ideaseek mode` CLI and TUI `Shift+Tab` / `/mode`.
 */
export async function executeSessionModeSwitch(
  root: string,
  target: string,
  opts: { force?: boolean } = {},
): Promise<ModeSwitchResult> {
  if (target === 'agent') {
    throw new IdeaseekError('INVALID_ARGUMENT', AGENT_ENTRY_HINT);
  }
  const requested = parseSessionMode(target);
  if (!requested) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `mode must be one of: ${SESSION_MODES.join(' | ')} (use --strategy for auto|starter|standard|research)`,
    );
  }
  const previous = await readSessionMode(root);
  if (requested === previous) {
    const summary = await buildSessionSummary(root);
    return {
      changed: false,
      previous,
      current: previous,
      decisionSeq: null,
      firstPermission: MODE_PERMISSIONS[previous][0] ?? '',
      summary,
    };
  }

  await writeSessionMode(root, requested, { force: opts.force === true });

  const { parseAutonomyMode, recordDecision } = await import('../workflow/autonomy.js');
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  let decisionSeq: number | null = null;
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const autonomy = parseAutonomyMode(runtime.config.policy.autonomyMode);
    const decision = await recordDecision(runtime.db, runtime.project.id, {
      action: 'change-session-mode',
      target: `${previous} → ${requested}`,
      mode: autonomy,
      reason: 'ideaseek mode',
    });
    decisionSeq = decision?.seq ?? null;
  } finally {
    await runtime.close();
  }

  const summary = await buildSessionSummary(root);
  return {
    changed: true,
    previous,
    current: requested,
    decisionSeq,
    firstPermission: MODE_PERMISSIONS[requested][0] ?? '',
    summary,
  };
}
