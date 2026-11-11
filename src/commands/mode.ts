import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek mode [research-mode]` — show or change the research mode
 * (auto | starter | standard | research). Changing it is a protected
 * policy action: guided mode needs --confirm and every accepted change
 * records a Decision/Event (running tasks keep their run snapshot).
 */

const RESEARCH_MODES = ['auto', 'starter', 'standard', 'research'] as const;

async function readResearchMode(root: string): Promise<string> {
  const { projectPaths } = await import('../config/paths.js');
  const { loadConfig } = await import('../config/config.js');
  const config = await loadConfig(projectPaths(root));
  return config.resolved.research.mode;
}

export function registerModeCommand(program: Command): void {
  program
    .command('mode')
    .description('show or change the research mode (guided changes need --confirm)')
    .argument('[mode]', `one of: ${RESEARCH_MODES.join(' | ')}`)
    .option('--confirm', 'guided-mode confirmation for the protected change')
    .option('--json', 'machine-readable output')
    .action(
      action(async (mode: string | undefined, opts: { confirm?: boolean; json?: boolean }) => {
        const { findProjectRoot, projectPaths } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const current = await readResearchMode(root);

        if (!mode) {
          const { loadConfig } = await import('../config/config.js');
          const config = await loadConfig(projectPaths(root));
          const autonomy = config.resolved.policy.autonomyMode;
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                researchMode: current,
                autonomyMode: autonomy,
                allowed: RESEARCH_MODES,
                policy: 'guided: protected changes need --confirm and record a Decision/Event',
              }),
            );
            return 0;
          }
          process.stdout.write(
            `research mode: ${current} (allowed: ${RESEARCH_MODES.join(' | ')})\n`,
          );
          process.stdout.write(`autonomy: ${autonomy}\n`);
          process.stdout.write(
            'change: ideaseek mode <mode> --confirm   (records a Decision/Event)\n',
          );
          return 0;
        }

        if (!(RESEARCH_MODES as readonly string[]).includes(mode)) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `mode must be one of: ${RESEARCH_MODES.join(' | ')}`,
          );
        }
        if (mode === current) {
          if (opts.json) process.stdout.write(jsonLine({ researchMode: current, changed: false }));
          else process.stdout.write(`research mode already ${current}\n`);
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
            reason: 'ideaseek mode',
          });
          decisionSeq = decision?.seq ?? null;
        } finally {
          await runtime.close();
        }
        if (opts.json) {
          process.stdout.write(jsonLine({ researchMode: mode, changed: true, decisionSeq }));
        } else {
          process.stdout.write(`research mode: ${current} → ${mode}\n`);
          process.stdout.write(
            decisionSeq
              ? `  decision recorded (event #${decisionSeq}); running tasks keep their snapshot\n`
              : '  decision not recorded (no run exists yet); running tasks keep their snapshot\n',
          );
        }
        return 0;
      }),
    );
}
