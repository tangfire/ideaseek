import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Session mode (docs/MODES.md): the current session runs either as
 * `research` (default — the scientific workflow) or `agent` (bounded
 * engineering work inside the same project context). The mode is persisted
 * per project in `.research/session.json` so the REPL and its non-interactive
 * relay agree; switching never starts a second run. Tool availability for
 * agent mode rides on the DSH capability profile — this module only owns the
 * mode state, permission summary and audit-friendly rendering.
 */

export type SessionMode = 'research' | 'analysis' | 'agent';

export const SESSION_MODES: readonly SessionMode[] = ['research', 'analysis', 'agent'];

export function parseSessionMode(raw: unknown): SessionMode | null {
  return typeof raw === 'string' && (SESSION_MODES as readonly string[]).includes(raw)
    ? (raw as SessionMode)
    : null;
}

export function sessionModeFile(root: string): string {
  return join(root, '.research', 'session.json');
}

/** Reads the persisted mode (default `research`; a corrupt file is ignored). */
export async function readSessionMode(root: string): Promise<SessionMode> {
  try {
    const parsed = JSON.parse(await readFile(sessionModeFile(root), 'utf8')) as { mode?: unknown };
    return parseSessionMode(parsed.mode) ?? 'research';
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

/** Permission summary per mode — what this session may and may not do. */
export const MODE_PERMISSIONS: Record<SessionMode, readonly string[]> = {
  research: [
    'read-only inputs: papers/, datasets/, comparisons/upstream are never modified',
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
  agent: [
    'may edit project code/config and run bounded tests inside the project root',
    'never touches papers/, datasets/, comparisons/upstream, locked protocols or committed results',
    'scientific changes still go through Research Decision/Approval (protected rules unchanged)',
    'tools: DSH Agent session under the capability profile — path/network/credential policy applies',
  ],
};

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
