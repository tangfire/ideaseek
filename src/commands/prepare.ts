import type { Command } from 'commander';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { runCli } from '../cli/runner.js';
import { performScan } from './inputs.js';
import { action, assertConfigUsable, jsonLine } from './shared.js';

/**
 * `ideaseek prepare` (docs/MODES.md Analysis 档位准备管线):
 * runs the read-only incremental material preparation pipeline in one command:
 *   1. scan (update input-manifest.json)
 *   2. ingest (incremental PDF/LaTeX parsing)
 *   3. data describe (profile dataset files into dataset-card.json when present)
 *   4. extract + synthesize (when model credentials or --harness are available, unless --skip-model)
 *   5. assessment (rebuild/reuse ResearchMaterialAssessment readiness report)
 *
 * Original papers/, datasets/ and comparisons/upstream/ remain untouched; only
 * knowledge/ and research artifacts are updated, and unchanged inputs reuse
 * existing artifacts by content hash.
 */

interface StepOutcome {
  step: string;
  status: 'ran' | 'skipped' | 'failed';
  detail: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function registerPrepareCommand(program: Command): void {
  program
    .command('prepare')
    .description(
      'run the Analysis read-only preparation pipeline (scan → ingest → data describe → extract/synthesize → assessment)',
    )
    .option('--skip-model', 'skip model-backed extract/synthesize steps (deterministic prep only)')
    .option('--harness <kind>', 'model harness for extract/synthesize: fake | dsh')
    .option('--question <text>', 'research question for the assessment step')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { skipModel?: boolean; harness?: string; question?: string; json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }

        const steps: StepOutcome[] = [];
        const logStep = (line: string) => {
          if (!opts.json) process.stdout.write(`${line}\n`);
        };

        // 1. Scan inputs (incremental hash reuse).
        const scan = await performScan(root);
        steps.push({
          step: 'scan',
          status: 'ran',
          detail: `${scan.files} file(s), reused ${scan.reusedHashes} hash(es)`,
        });
        logStep(`prepare [1/5] scan: ${scan.files} file(s) (reused ${scan.reusedHashes} hash(es))`);

        // 2. Ingest PDFs / LaTeX sources incrementally.
        const ingestRes = await runCli(['ingest', '--json'], { timeoutMs: 180_000 });
        if (ingestRes.code === 0) {
          steps.push({ step: 'ingest', status: 'ran', detail: 'incremental parse complete' });
          logStep('prepare [2/5] ingest: incremental parse complete');
        } else {
          steps.push({
            step: 'ingest',
            status: 'failed',
            detail: (ingestRes.stderr || ingestRes.stdout).trim().slice(0, 200),
          });
          logStep('prepare [2/5] ingest: partial/failed (see assessment gaps)');
        }

        // 3. Profile datasets if any data files or readonlyDatasets are configured.
        let hasDatasetInput = false;
        let parsedCount = 0;
        let cardCount = 0;
        const rt = await ProjectRuntime.open({ cwd: root, recover: false });
        try {
          assertConfigUsable(rt.configLoad);
          parsedCount = (await rt.db.listArtifactsByKind('parsed-paper')).length;
          cardCount = (await rt.db.listArtifactsByKind('papercard')).length;
          hasDatasetInput =
            rt.config.inputs.readonlyDatasets.length > 0 ||
            (await fileExists(join(root, 'knowledge', 'input-manifest.json')));
        } finally {
          await rt.close();
        }

        if (hasDatasetInput) {
          const dataRes = await runCli(['data', 'describe', '--json'], { timeoutMs: 120_000 });
          if (dataRes.code === 0) {
            steps.push({ step: 'data-describe', status: 'ran', detail: 'dataset card updated' });
            logStep('prepare [3/5] data describe: dataset profile updated');
          } else {
            steps.push({
              step: 'data-describe',
              status: 'failed',
              detail: (dataRes.stderr || dataRes.stdout).trim().slice(0, 200),
            });
            logStep('prepare [3/5] data describe: failed (check dataset format)');
          }
        } else {
          steps.push({ step: 'data-describe', status: 'skipped', detail: 'no dataset inputs' });
          logStep('prepare [3/5] data describe: skipped (no datasets found)');
        }

        // 4. Model-backed extract & synthesize (only when requested or credentials exist).
        const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
        const modelHarness =
          opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : null);
        if (opts.skipModel || !modelHarness) {
          const reason = opts.skipModel
            ? '--skip-model set'
            : 'no DEEPSEEK_API_KEY configured (pass --harness or run /models setup)';
          steps.push({ step: 'extract+synthesize', status: 'skipped', detail: reason });
          logStep(`prepare [4/5] extract/synthesize: skipped (${reason})`);
        } else if (parsedCount === 0) {
          steps.push({
            step: 'extract+synthesize',
            status: 'skipped',
            detail: 'no parsed papers yet',
          });
          logStep('prepare [4/5] extract/synthesize: skipped (no parsed papers)');
        } else {
          const extRes = await runCli(['extract', '--harness', modelHarness, '--json'], {
            timeoutMs: 300_000,
          });
          steps.push({
            step: 'extract',
            status: extRes.code === 0 ? 'ran' : 'failed',
            detail:
              extRes.code === 0
                ? 'PaperCards synced'
                : (extRes.stderr || extRes.stdout).trim().slice(0, 200),
          });
          const synthRes = await runCli(['synthesize', '--harness', modelHarness, '--json'], {
            timeoutMs: 300_000,
          });
          steps.push({
            step: 'synthesize',
            status: synthRes.code === 0 ? 'ran' : 'failed',
            detail:
              synthRes.code === 0
                ? 'topic synthesis & research map synced'
                : (synthRes.stderr || synthRes.stdout).trim().slice(0, 200),
          });
          logStep(
            `prepare [4/5] extract=${extRes.code === 0 ? 'ok' : 'failed'} · synthesize=${synthRes.code === 0 ? 'ok' : 'failed'} (${parsedCount} parsed, ${cardCount} prior cards)`,
          );
        }

        // 5. Rebuild/reuse ResearchMaterialAssessment.
        const { loadOrBuildAssessment } = await import('../knowledge/assessment.js');
        const { assessment, reused } = await loadOrBuildAssessment(root, {
          question: opts.question,
        });
        const blocking = assessment.gaps.filter((g) => g.priority === 'blocking');
        steps.push({
          step: 'assessment',
          status: 'ran',
          detail: `${assessment.verdict} (blocking=${blocking.length}, reused=${reused})`,
        });

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              steps,
              verdict: assessment.verdict,
              reused,
              sufficientFor: assessment.sufficientFor,
              blockingGaps: blocking.length,
              totalGaps: assessment.gaps.length,
              assessment,
            }),
          );
          return blocking.length > 0 ? 2 : 0;
        }

        logStep(
          `prepare [5/5] assessment: ${assessment.verdict.toUpperCase()} · protocol=${assessment.sufficientFor.protocolDesign ? 'OK' : 'BLOCKED'} · smoke=${assessment.sufficientFor.smokeQuick ? 'OK' : 'BLOCKED'} (${blocking.length} blocking, ${assessment.gaps.length} total gap(s))`,
        );
        for (const item of blocking.slice(0, 6)) {
          process.stdout.write(`  [BLOCKING] ${item.id}: ${item.reason}\n`);
          process.stdout.write(`             next: ${item.fillIn}\n`);
        }
        if (blocking.length === 0) {
          process.stdout.write(
            'next: materials ready — ideaseek mode research (or ideaseek protocol propose)\n',
          );
        } else {
          process.stdout.write(
            'next: clear the BLOCKING gaps above, then rerun ideaseek prepare\n',
          );
        }
        return blocking.length > 0 ? 2 : 0;
      }),
    );
}
