import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek mode [research|agent]` (docs/MODES.md): shows the current
 * session mode, project and permission summary; a target switches the
 * Research/Agent session mode. Switching is a session-scoped policy view —
 * explicit by nature, so no --confirm — but it always records a
 * Decision/Event when a run exists (never silent) and never starts a
 * second run. `--strategy` changes the project research strategy
 * (auto|starter|standard|research), which stays a protected guided action.
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
  opts: { json?: boolean },
): Promise<number> {
  const {
    parseSessionMode,
    readSessionMode,
    writeSessionMode,
    buildSessionSummary,
    MODE_PERMISSIONS,
  } = await import('../session/mode.js');
  const requested = parseSessionMode(target);
  if (!requested) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `mode must be one of: research | agent (use --strategy for ${RESEARCH_MODES.join('|')})`,
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

  await writeSessionMode(root, requested);

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
    .description('show mode, project and permissions; switch the Research/Agent session mode')
    .argument('[target]', 'session mode: research | agent')
    .option('--strategy <mode>', `project research strategy: ${RESEARCH_MODES.join(' | ')}`)
    .option('--confirm', 'guided confirmation for the protected strategy change')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          target: string | undefined,
          opts: { strategy?: string; confirm?: boolean; json?: boolean },
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
              'switch: ideaseek mode research|agent · strategy: ideaseek mode --strategy <mode> --confirm\n',
            );
            return 0;
          }

          return switchSessionMode(root, target, opts);
        },
      ),
    );
}
