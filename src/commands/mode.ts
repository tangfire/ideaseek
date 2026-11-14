import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';
import { SESSION_MODES } from '../session/mode.js';

/**
 * `ideaseek mode [research|analysis]` (docs/MODES.md): shows the current
 * research tier, project and permission summary; a target switches the tier.
 * Switching is a session-scoped policy view — explicit by nature, so no
 * --confirm — but it always records a Decision/Event when a run exists (never
 * silent) and never starts a second run. `agent` is no longer a target: it is
 * the general DSH coding entry (`ideaseek agent`), so the old spelling routes
 * there instead of silently changing tiers. `--strategy` changes the project
 * research strategy (auto|starter|standard|research), which stays a protected
 * guided action.
 */

const RESEARCH_MODES = ['auto', 'starter', 'standard', 'research'] as const;

async function requireRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

async function changeStrategy(
  root: string,
  mode: string,
  opts: { confirm?: boolean; json?: boolean },
): Promise<number> {
  const { loadConfig } = await import('../config/config.js');
  const { projectPaths } = await import('../config/paths.js');
  const config = await loadConfig(projectPaths(root));
  const current = config.resolved.research.mode;

  if (!(RESEARCH_MODES as readonly string[]).includes(mode)) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `strategy must be one of: ${RESEARCH_MODES.join(' | ')}`,
    );
  }
  if (mode === current) {
    if (opts.json) process.stdout.write(jsonLine({ strategy: current, changed: false }));
    else process.stdout.write(`research strategy already ${mode}\n`);
    return 0;
  }

  // Protected policy change: same discipline as model route switches.
  const { assertAutonomy, parseAutonomyMode, recordDecision } =
    await import('../workflow/autonomy.js');
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root });
  let decisionSeq: number | null = null;
  try {
    const autonomy = parseAutonomyMode(runtime.config.policy.autonomyMode);
    assertAutonomy(autonomy, 'change-research-mode', { confirmed: opts.confirm });
    const { readFile, writeFile } = await import('node:fs/promises');
    const configPath = projectPaths(root).configFile;
    const raw = await readFile(configPath, 'utf8');
    if (!/^\s*mode:.*$/m.test(raw)) {
      throw new IdeaseekError('INVALID_STATE', 'research.yaml has no research.mode key');
    }
    await writeFile(configPath, raw.replace(/^(\s*mode:).*$/m, `$1 ${mode}`), 'utf8');
    const decision = await recordDecision(runtime.db, runtime.project.id, {
      action: 'change-research-mode',
      target: `${current} → ${mode}`,
      mode: autonomy,
      reason: 'ideaseek mode --strategy',
    });
    decisionSeq = decision?.seq ?? null;
  } finally {
    await runtime.close();
  }
  if (opts.json) {
    process.stdout.write(jsonLine({ strategy: mode, changed: true, decisionSeq }));
  } else {
    process.stdout.write(`research strategy: ${current} → ${mode}\n`);
    process.stdout.write(
      decisionSeq
        ? `  decision recorded (event #${decisionSeq}); running tasks keep their snapshot\n`
        : '  decision not recorded (no run exists yet); running tasks keep their snapshot\n',
    );
  }
  return 0;
}

async function switchSessionMode(
  root: string,
  target: string,
  opts: { json?: boolean; force?: boolean },
): Promise<number> {
  const {
    parseSessionMode,
    readSessionMode,
    writeSessionMode,
    buildSessionSummary,
    MODE_PERMISSIONS,
    SESSION_MODES,
    AGENT_ENTRY_HINT,
  } = await import('../session/mode.js');
  if (target === 'agent') {
    // The old third tier was never enforceable and never was a permission
    // tier; point at the entry instead of silently switching tiers.
    throw new IdeaseekError('INVALID_ARGUMENT', AGENT_ENTRY_HINT);
  }
  // `coding` and `ask` are the textual spelling of Shift+Tab's third
  // position: they switch the conversation FOCUS, not the tier, and record no
  // Decision because they grant nothing (the turns they produce are audited).
  if (target === 'coding' || target === 'ask') {
    const { readSessionFocus, writeSessionFocus, readSessionMode } =
      await import('../session/mode.js');
    const focus = target === 'coding' ? 'coding' : 'ask';
    const current = await readSessionFocus(root);
    if (current === focus) {
      if (opts.json) process.stdout.write(jsonLine({ focus, changed: false }));
      else process.stdout.write(`session focus already ${focus}\n`);
      return 0;
    }
    await writeSessionFocus(root, focus);
    if (opts.json) {
      process.stdout.write(
        jsonLine({ focus, changed: true, sessionMode: await readSessionMode(root) }),
      );
    } else {
      process.stdout.write(`session focus: ${current} → ${focus}\n`);
      process.stdout.write(
        focus === 'coding'
          ? '  每行输入都是一轮 DSH coding 会话；权限档位不变，回合仍受审计与漂移侦测\n'
          : '  普通句子回到 ideaseek ask；权限档位不变\n',
      );
    }
    return 0;
  }

  const requested = parseSessionMode(target);
  if (!requested) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `mode must be one of: ${SESSION_MODES.join(' | ')} (use --strategy for ${RESEARCH_MODES.join('|')})`,
    );
  }
  const current = await readSessionMode(root);

  if (requested === current) {
    if (opts.json) {
      const summary = await buildSessionSummary(root);
      process.stdout.write(jsonLine({ ...summary, sessionMode: current, changed: false }));
    } else {
      // One confirmation line; the full summary is one `ideaseek mode` away.
      process.stdout.write(`session mode already ${current}\n`);
    }
    return 0;
  }

  await writeSessionMode(root, requested, { force: opts.force === true });

  // Audit only: an explicit /mode is confirmation enough, but the switch is
  // recorded whenever a run exists (decisions are run-bound).
  const { parseAutonomyMode, recordDecision } = await import('../workflow/autonomy.js');
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  let decisionSeq: number | null = null;
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const autonomy = parseAutonomyMode(runtime.config.policy.autonomyMode);
    const decision = await recordDecision(runtime.db, runtime.project.id, {
      action: 'change-session-mode',
      target: `${current} → ${requested}`,
      mode: autonomy,
      reason: 'ideaseek mode',
    });
    decisionSeq = decision?.seq ?? null;
  } finally {
    await runtime.close();
  }

  if (opts.json) {
    const next = await buildSessionSummary(root);
    process.stdout.write(jsonLine({ ...next, sessionMode: next.mode, changed: true, decisionSeq }));
  } else {
    // Concise by design: migration + audit event + one-line permission
    // recap. The full project/autonomy/permission summary stays one
    // `ideaseek mode` away — a switch must not wall the activity pane.
    process.stdout.write(`session mode: ${current} → ${requested}\n`);
    process.stdout.write(
      decisionSeq
        ? `  decision recorded (event #${decisionSeq}); no second run was started\n`
        : '  decision not recorded (no run exists yet); no second run was started\n',
    );
    process.stdout.write(`  ${MODE_PERMISSIONS[requested][0]}\n`);
  }
  return 0;
}

export function registerModeCommand(program: Command): void {
  program
    .command('mode')
    .description('show the research tier, project and permissions; switch between tiers')
    .argument('[target]', `research tier: ${SESSION_MODES.join(' | ')}`)
    .option('--strategy <mode>', `project research strategy: ${RESEARCH_MODES.join(' | ')}`)
    .option('--force', 'override the Analysis to Research preparation gate (records a Decision)')
    .option('--confirm', 'guided confirmation for the protected strategy change')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          target: string | undefined,
          opts: { strategy?: string; confirm?: boolean; json?: boolean; force?: boolean },
        ) => {
          const root = await requireRoot();

          if (opts.strategy) return changeStrategy(root, opts.strategy, opts);

          if (!target) {
            const { buildSessionSummary, renderSessionSummary } =
              await import('../session/mode.js');
            const summary = await buildSessionSummary(root);
            if (opts.json) {
              process.stdout.write(jsonLine({ ...summary, sessionMode: summary.mode }));
              return 0;
            }
            for (const line of renderSessionSummary(summary)) process.stdout.write(`${line}\n`);
            process.stdout.write(
              `switch: ideaseek mode ${SESSION_MODES.join('|')} · strategy: ideaseek mode --strategy <mode> --confirm
coding entry (not a tier): ideaseek agent "<指令>" — DSH workspace-write + ask, drift reported per turn
`,
            );
            return 0;
          }

          return switchSessionMode(root, target, opts);
        },
      ),
    );
}
