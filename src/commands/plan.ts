import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { evaluateComparisonGateForProject } from '../comparison/worktree-stamp.js';
import { listWorkspaces } from '../idea/workspace.js';
import { probeCapacity } from '../runtime/capacity.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek plan` — dry-run planning (PRODUCT_REQUIREMENTS P0, GAPS #2).
 * Aggregates inputs, task volume, comparison gate state, idea limits,
 * slices, model route, resource estimates, approval nodes and blockers
 * WITHOUT creating a run, task or agent session. Every number that is not
 * read from persisted state is flagged as an estimate with its heuristic.
 */

interface InputManifestSummary {
  files?: { role?: string; ext?: string; bytes?: number; relPath?: string }[];
  generatedAt?: number;
}

interface PlanEstimate {
  label: string;
  value: string | number;
  basis: string;
  estimate: boolean;
}

async function readInputManifest(root: string): Promise<InputManifestSummary | null> {
  try {
    return JSON.parse(
      await readFile(join(root, 'knowledge', 'input-manifest.json'), 'utf8'),
    ) as InputManifestSummary;
  } catch {
    return null;
  }
}

export function registerPlanCommand(program: Command): void {
  program
    .command('plan')
    .description(
      'dry-run: show inputs, task volume, gate state, resources, approvals and blockers — starts nothing',
    )
    .option('--question <text>', 'research question to display (not persisted)')
    .option('--run <runId>', 'include progress of an existing run')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { question?: string; run?: string; json?: boolean }) => {
        const { findProjectRoot, projectPaths } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const { loadConfig } = await import('../config/config.js');
        const configLoad = await loadConfig(projectPaths(root));
        const config = configLoad.resolved;

        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root });
        try {
          // --- inputs (persisted facts).
          const manifest = await readInputManifest(root);
          const indexed = (await runtime.db.listIndexedPapers()).length;
          const files = manifest?.files ?? [];
          const paperFiles = files.filter((f) => f.role === 'paper' || f.ext === '.pdf');
          const totalBytes = files.reduce((sum, f) => sum + (f.bytes ?? 0), 0);

          // --- comparisons + gate preview.
          const methods = await runtime.db.listComparisons({});
          const gate = await evaluateComparisonGateForProject(root, runtime.db);

          // --- ideas + slices.
          const ideas = await listWorkspaces(root);
          const readyIdeas = ideas.filter((idea) => idea.status === 'SMOKE_TESTED');
          const slices = await runtime.db.listSlices();
          const slicesByScale: Record<string, number> = {};
          for (const slice of slices) {
            slicesByScale[slice.scale] = (slicesByScale[slice.scale] ?? 0) + 1;
          }

          // --- protocol + approvals (guided default).
          let protocolId: string | null = null;
          let protocolLocked = false;
          let protocolResourceEstimate: string | null = null;
          try {
            const artifacts = await runtime.db.listArtifactsByKind('protocol-proposal');
            const chosen = artifacts[artifacts.length - 1];
            if (chosen) {
              const proposal = JSON.parse(
                await runtime.store.readFinalText(chosen.contentHash),
              ) as { protocolId?: unknown; resourceEstimate?: { value?: unknown } };
              if (typeof proposal.protocolId === 'string') {
                protocolId = proposal.protocolId;
                protocolLocked = (await runtime.db.getProtocolLock(protocolId)) !== null;
              }
              if (typeof proposal.resourceEstimate?.value === 'string') {
                protocolResourceEstimate = proposal.resourceEstimate.value;
              }
            }
          } catch {
            // no proposal yet
          }
          const autonomyMode = config.policy.autonomyMode;
          const approvalNodes = [
            {
              node: 'protocol-lock',
              state: protocolLocked
                ? 'locked'
                : protocolId
                  ? 'pending-user-confirmation'
                  : 'no-proposal',
            },
            {
              node: 'required-comparison-exclusions',
              state:
                gate.skipped.length > 0
                  ? `${gate.skipped.length} excluded (reasoned)`
                  : 'none-excluded',
            },
            {
              node: 'idea-budget',
              state: `${autonomyMode}: ideaLimit=${config.research.ideaLimit}`,
            },
            { node: 'handoff-delivery', state: 'HANDOFF_READY requires --confirm' },
          ];

          // --- resources (live probe) + estimates (heuristics, flagged).
          const probe = await probeCapacity(root);
          const estimates: PlanEstimate[] = [
            {
              label: 'paper-extraction-tokens',
              value: Math.round(paperFiles.length * 8000),
              basis: `${paperFiles.length} paper file(s) × ~8k tokens/page-avg heuristic; not a provider quote`,
              estimate: true,
            },
            {
              label: 'model-cost-ceiling',
              value: config.resources.maxModelCost,
              basis: 'config resources.max_model_cost (budget ceiling, not a prediction)',
              estimate: false,
            },
            {
              label: 'gpu-hours-ceiling',
              value: config.resources.maxGpuHours,
              basis: 'config resources.max_gpu_hours (budget ceiling, not a prediction)',
              estimate: false,
            },
          ];
          if (protocolResourceEstimate) {
            estimates.push({
              label: 'protocol-gpu-estimate',
              value: protocolResourceEstimate,
              basis: 'protocol proposal resourceEstimate (agent-inference, quoted as recorded)',
              estimate: true,
            });
          }

          // --- optional existing-run progress (still starts nothing).
          let runBlock: Record<string, unknown> | null = null;
          if (opts.run) {
            const run = await runtime.db.getRun(opts.run);
            if (!run) throw new IdeaseekError('RUN_NOT_FOUND', `run ${opts.run} not found`);
            const tasks = await runtime.db.listTasks(run.runId);
            const counts: Record<string, number> = {};
            for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
            runBlock = {
              runId: run.runId,
              status: run.status,
              phase: run.phase,
              remaining: (counts.queued ?? 0) + (counts.leased ?? 0) + (counts.running ?? 0),
              counts,
            };
          }

          const blockers: string[] = [];
          for (const error of configLoad.errors) blockers.push(`config: ${error}`);
          for (const blocking of gate.blocking) {
            blockers.push(`comparison gate: ${blocking.methodId} is ${blocking.status}`);
          }
          if (!protocolId) blockers.push('no protocol proposal yet (protocol propose)');
          else if (!protocolLocked) blockers.push('protocol proposal not confirmed/locked');

          const plan = {
            question: opts.question ?? config.research.question ?? null,
            // With no --question the displayed text IS the configured one, so
            // it is persisted by definition. The old comparison
            // (`(opts.question ?? '') === config.research.question`) was false
            // in exactly that case and told every user that their saved
            // question was unsaved.
            questionPersisted:
              opts.question === undefined || opts.question === config.research.question,
            mode: config.research.mode,
            autonomyMode,
            inputs: {
              manifestFiles: files.length,
              paperFiles: paperFiles.length,
              indexedPapers: indexed,
              totalBytes,
              manifestGeneratedAt: manifest?.generatedAt ?? null,
            },
            comparisons: {
              total: methods.length,
              gateOk: gate.ok,
              passed: gate.passed.length,
              skipped: gate.skipped.length,
              blocking: gate.blocking,
            },
            ideas: {
              total: ideas.length,
              readyForExperiment: readyIdeas.length,
              limit: config.research.ideaLimit,
            },
            slices: { total: slices.length, byScale: slicesByScale },
            model: {
              route: config.runtime.modelRoute,
              dshPinned: true,
              credentialsPresent: Boolean(process.env.DEEPSEEK_API_KEY),
            },
            resources: {
              gpus: probe.gpus.length,
              freeMemGiB: probe.freeMemGiB,
              cpuCores: probe.cpuCores,
              diskFreeGiB: probe.diskFreeGiB,
              maxParallelIdeas: config.resources.maxParallelIdeas,
            },
            estimates,
            approvalNodes,
            blockers,
            run: runBlock,
            startedNothing: true,
          };

          if (opts.json) {
            process.stdout.write(jsonLine(plan));
            return 0;
          }
          process.stdout.write(`plan (dry-run — nothing started)\n`);
          process.stdout.write(
            `  question: ${plan.question ?? '(unset)'}${plan.question ? (plan.questionPersisted ? '' : ' (来自 --question，未写入配置；用 ideaseek setup --question 持久化)') : ''}\n`,
          );
          process.stdout.write(
            `  inputs: ${plan.inputs.paperFiles} paper file(s), ${plan.inputs.indexedPapers} indexed, ${(plan.inputs.totalBytes / 1024 / 1024).toFixed(1)} MiB manifest\n`,
          );
          process.stdout.write(
            `  comparisons: ${plan.comparisons.total} registered · gate ${plan.comparisons.gateOk ? 'PASS' : 'FAIL'}\n`,
          );
          for (const blocking of plan.comparisons.blocking) {
            process.stdout.write(`    BLOCK ${blocking.methodId}: ${blocking.status}\n`);
          }
          process.stdout.write(
            `  ideas: ${plan.ideas.total} workspace(s) · ${plan.ideas.readyForExperiment} ready · limit ${plan.ideas.limit}\n`,
          );
          process.stdout.write(
            `  slices: ${plan.slices.total} (${
              Object.entries(plan.slices.byScale)
                .map(([k, v]) => `${k}:${v}`)
                .join(' ') || 'none'
            })\n`,
          );
          process.stdout.write(
            `  model: route=${plan.model.route} · credentials ${plan.model.credentialsPresent ? 'present' : 'MISSING'}\n`,
          );
          process.stdout.write(
            `  host: ${plan.resources.gpus} GPU · ${plan.resources.cpuCores} cores · ${plan.resources.freeMemGiB} GiB free · disk ${plan.resources.diskFreeGiB ?? '?'} GiB\n`,
          );
          process.stdout.write('  estimates:\n');
          for (const est of plan.estimates) {
            process.stdout.write(
              `    ${est.label}: ${est.value}${est.estimate ? ' (estimate)' : ''} — ${est.basis}\n`,
            );
          }
          process.stdout.write('  approvals (guided):\n');
          for (const node of plan.approvalNodes) {
            process.stdout.write(`    ${node.node}: ${node.state}\n`);
          }
          if (plan.blockers.length > 0) {
            process.stdout.write('  blockers:\n');
            for (const blocker of plan.blockers) process.stdout.write(`    ! ${blocker}\n`);
          } else {
            process.stdout.write('  blockers: none\n');
          }
          if (runBlock) {
            process.stdout.write(
              `  run ${runBlock.runId}: ${runBlock.status} · ${String(runBlock.remaining)} remaining\n`,
            );
          }
          process.stdout.write('next: ideaseek next   (plan never starts work by itself)\n');
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
