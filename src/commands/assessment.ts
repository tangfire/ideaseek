import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek assessment` (docs/FULL_RESEARCH_MODE.md 研究材料缺口评估,
 * PROGRESS 106): deterministic ResearchMaterialAssessment — what
 * materials exist, what is missing (blocking/recommended/optional with
 * reason/evidence/confidence/fill-in/cost), and whether protocol design
 * or smoke/quick can start. Reuses the stored report when the observed
 * inputs are unchanged (contextHash). Exit 2 while blocking gaps remain.
 */
export function registerAssessmentCommand(program: Command): void {
  program
    .command('assessment')
    .description(
      'research material gap report: blocking/recommended/optional gaps with evidence and next commands',
    )
    .option('--question <text>', 'override the research question for this assessment')
    .option('--force', 'rebuild even when the stored report matches current inputs')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { question?: string; force?: boolean; json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here — run: ideaseek init',
          );
        }
        const { loadOrBuildAssessment, buildResearchMaterialAssessment } =
          await import('../knowledge/assessment.js');
        const { assessment, reused, path } = opts.force
          ? {
              ...(await buildResearchMaterialAssessment(root, { question: opts.question }).then(
                async (fresh) => {
                  const { writeFileAtomic, ensureDir } = await import('../core/atomic.js');
                  const { join } = await import('node:path');
                  await ensureDir(join(root, 'knowledge'));
                  const file = join(root, 'knowledge', 'research-material-assessment.json');
                  await writeFileAtomic(file, `${JSON.stringify(fresh, null, 2)}\n`);
                  return { assessment: fresh, reused: false, path: file };
                },
              )),
            }
          : await loadOrBuildAssessment(root, { question: opts.question });

        const blocking = assessment.gaps.filter((g) => g.priority === 'blocking');
        const recommended = assessment.gaps.filter((g) => g.priority === 'recommended');
        const optional = assessment.gaps.filter((g) => g.priority === 'optional');

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              path,
              reused,
              verdict: assessment.verdict,
              sufficientFor: assessment.sufficientFor,
              counts: {
                blocking: blocking.length,
                recommended: recommended.length,
                optional: optional.length,
              },
              assessment,
            }),
          );
          return blocking.length > 0 ? 2 : 0;
        }

        process.stdout.write(
          `research material assessment: ${assessment.verdict.toUpperCase()}` +
            `${reused ? ' (reused — inputs unchanged)' : ''}\n`,
        );
        process.stdout.write(
          `  sufficient for protocol design: ${assessment.sufficientFor.protocolDesign ? 'YES' : 'NO'}` +
            ` · for smoke/quick: ${assessment.sufficientFor.smokeQuick ? 'YES' : 'NO'}\n`,
        );
        process.stdout.write(
          `  inputs: ${assessment.stats.paperCards} PaperCard(s) · ${assessment.stats.parsedPapers} parsed · ` +
            `dataset card ${assessment.stats.datasetCard ? 'yes' : 'no'} · ${assessment.stats.slices} slice(s) · ` +
            `${assessment.stats.comparisons} comparison(s) · protocol ${assessment.stats.protocolProposal} · ` +
            `${assessment.stats.ideas} idea(s)\n`,
        );
        if (assessment.question) {
          process.stdout.write(`  question: ${assessment.question.slice(0, 140)}\n`);
        }
        for (const group of [
          ['BLOCKING', blocking],
          ['recommended', recommended],
          ['optional', optional],
        ] as const) {
          for (const item of group[1]) {
            process.stdout.write(`  [${group[0]}] ${item.id} (${item.area}): ${item.reason}\n`);
            process.stdout.write(`          evidence: ${item.evidence.join(' | ')}\n`);
            process.stdout.write(`          fill in : ${item.fillIn}\n`);
            process.stdout.write(
              `          cost    : ${item.cost} · confidence ${item.confidence}\n`,
            );
            if (item.blocks.length > 0) {
              process.stdout.write(`          blocks  : ${item.blocks.join(', ')}\n`);
            }
          }
        }
        if (assessment.covered.length > 0) {
          process.stdout.write('  covered:\n');
          for (const item of assessment.covered) {
            process.stdout.write(`    ✓ ${item.area}: ${item.detail}\n`);
          }
        }
        process.stdout.write('  file: knowledge/research-material-assessment.json\n');
        process.stdout.write(
          blocking.length > 0
            ? 'next: clear the BLOCKING gaps above, then rerun ideaseek assessment\n'
            : recommended.length > 0
              ? 'next: recommended gaps can wait — ideaseek mode research (Analysis → Research) when ready\n'
              : 'next: ideaseek protocol propose   (materials sufficient to start protocol design)\n',
        );
        return blocking.length > 0 ? 2 : 0;
      }),
    );
}
