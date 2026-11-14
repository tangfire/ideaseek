import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Session tiers (docs/MODES.md): the research conversation runs either as
 * `research` (default — the scientific workflow) or `analysis` (read-only
 * material preparation). Agent is *not* a tier: `ideaseek agent` / `/agent`
 * starts a general DSH coding session inside the same project, on DSH's own
 * `workspace-write` + ask preset. What protects the science is not a directory
 * ban nobody enforced, but the drift detection in knowledge/input-drift.ts.
 *
 * The tier is persisted per project in `.research/session.json` so the REPL and
 * its non-interactive relay agree; switching never starts a second run. Tool
 * availability rides on the DSH capability profile — this module owns the tier
 * state, permission summary and audit-friendly rendering.
 */

export type SessionMode = 'research' | 'analysis';

export const SESSION_MODES: readonly SessionMode[] = ['research', 'analysis'];

/** Older session files persisted `agent` as a mode. A coding conversation is
 * not a permission tier (and its history lives in knowledge/agent-sessions.json),
 * so the marker falls back to the science tier rather than erroring on read. */
const LEGACY_TIER_FALLBACK: ReadonlyMap<string, SessionMode> = new Map([['agent', 'research']]);

export function parseSessionMode(raw: unknown): SessionMode | null {
  return typeof raw === 'string' && (SESSION_MODES as readonly string[]).includes(raw)
    ? (raw as SessionMode)
    : null;
}

/** Guidance for someone who asks for the old `mode agent` (an entry, not a tier). */
export const AGENT_ENTRY_HINT =
  'agent 不是权限档位而是入口：ideaseek agent "<指令>"（TUI 里 /agent <指令>）。' +
  '科研档位保持不变；它跑 DSH 自带 workspace-write + ask 预设，回合末会侦测原始输入漂移。';

export function sessionModeFile(root: string): string {
  return join(root, '.research', 'session.json');
}

/** Reads the persisted tier (default `research`; a corrupt file is ignored). */
export async function readSessionMode(root: string): Promise<SessionMode> {
  try {
    const parsed = JSON.parse(await readFile(sessionModeFile(root), 'utf8')) as { mode?: unknown };
    const raw = parsed.mode;
    return parseSessionMode(raw) ?? LEGACY_TIER_FALLBACK.get(String(raw)) ?? 'research';
  } catch {
    return 'research';
  }
}

/** Crash-safe write: temp file + rename inside the project's .research/. */
export async function writeSessionMode(
  root: string,
  mode: SessionMode,
  opts: { force?: boolean } = {},
): Promise<void> {
  // Analysis → Research preparation gate (PROGRESS 84): the switch is
  // refused while blocking material gaps remain; --force records an
  // auditable override at the call site. Every switcher (mode CLI,
  // interactive --mode, TUI /mode) funnels through here.
  if (mode === 'research') {
    const current = await readSessionMode(root).catch(() => 'research' as SessionMode);
    if (current === 'analysis' && !opts.force) {
      const { loadOrBuildAssessment } = await import('../knowledge/assessment.js');
      const { assessment } = await loadOrBuildAssessment(root);
      const blocking = assessment.gaps.filter(
        (item) => item.priority === 'blocking' && item.blocks.includes('protocolDesign'),
      );
      if (blocking.length > 0) {
        const { IdeaseekError } = await import('../core/errors.js');
        throw new IdeaseekError(
          'USER_INPUT_REQUIRED',
          'Analysis → Research blocked by material gaps: ' +
            blocking.map((item) => `${item.id} (${item.fillIn})`).join('; ') +
            ' — clear them, or override with: ideaseek mode research --force',
          { gaps: blocking.map((item) => item.id) },
        );
      }
    }
  }
  const file = sessionModeFile(root);
  await mkdir(join(root, '.research'), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ mode, updatedAt: Date.now() }, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** Permission summary per tier — what this session may and may not do. */
export const MODE_PERMISSIONS: Record<SessionMode, readonly string[]> = {
  research: [
    'the science pipeline treats papers/, datasets/, comparisons/upstream as read-only inputs',
    'protected science (metrics/data/comparisons/hypothesis) always needs explicit confirmation',
    'experiments pass protocol lock + comparison gate + capacity admission first',
    'tools: research capability profile — project read + knowledge search only',
  ],
  analysis: [
    'read-only preparation: papers/datasets/comparisons are inputs, never modified',
    'may build knowledge artifacts: PaperCards, research map, dataset card, assessment',
    'cannot lock protocols, start experiments, change the comparison list or write research code',
    'gaps report via ideaseek assessment; switching to research requires no blocking gaps (--force to override)',
  ],
};

/**
 * What the general agent entry actually runs on. Not a tier — shown by
 * `/agent` and `mode` so nobody has to guess whether it can touch their data:
 * the answer is yes, and the turn ends by reporting what moved.
 */
export const AGENT_ENTRY_PERMISSIONS: readonly string[] = [
  'DSH preset workspace-write + ask: project read/write, restricted shell, test tools',
  'every tool call is asked; non-TTY and --deny-tools reject (never auto-approve)',
  'no directory ban: editing papers/, datasets/ or comparisons/upstream is allowed',
  'what protects the science: the turn ends by hashing those anchors against the scan baseline',
  'committed results, locked protocols and handoffs stay append-only',
];

export interface SessionSummary {
  mode: SessionMode;
  project: string;
  root: string;
  autonomy: string;
  strategy: string;
  permissions: readonly string[];
}

/** Gathers mode + project + permission summary from persisted state. */
export async function buildSessionSummary(root: string): Promise<SessionSummary> {
  const { loadConfig } = await import('../config/config.js');
  const { projectPaths } = await import('../config/paths.js');
  const config = await loadConfig(projectPaths(root));
  const mode = await readSessionMode(root);
  return {
    mode,
    project: config.resolved.project.name,
    root,
    autonomy: config.resolved.policy.autonomyMode,
    strategy: config.resolved.research.mode,
    permissions: MODE_PERMISSIONS[mode],
  };
}

/** Human-readable summary lines (shared by `mode` and `open`). */
export function renderSessionSummary(summary: SessionSummary): string[] {
  return [
    `session mode : ${summary.mode}`,
    `project      : ${summary.project} (${summary.root})`,
    `autonomy     : ${summary.autonomy} · research strategy: ${summary.strategy}`,
    'permissions  :',
    ...summary.permissions.map((line) => `  · ${line}`),
  ];
}
