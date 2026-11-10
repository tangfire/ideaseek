import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { IdeaseekError } from '../core/errors.js';
import {
  computeSpecHash,
  validateExperimentSpec,
  validateRunResult,
  type ExperimentSpec,
  type RunResult,
} from '../experiment/spec.js';
import type { ExperimentDoc } from '../workflow/db.js';
import { action, jsonLine } from './shared.js';

async function openRuntime(root: string) {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  return ProjectRuntime.open({ cwd: root });
}

async function openRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

async function readJsonFile(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new IdeaseekError('FILE_NOT_FOUND', `cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 12);
}

function metricSummary(doc: ExperimentDoc): string {
  if (!doc.result) return '';
  const metrics = Array.isArray(doc.result.metrics) ? doc.result.metrics : [];
  return metrics
    .slice(0, 3)
    .map((m) => {
      const entry = m as { name?: unknown; value?: unknown };
      return `${String(entry.name)}=${Number(entry.value).toFixed(4)}`;
    })
    .join(' ');
}

/**
 * `ideaseek experiment spec|result|list|show` — unified ExperimentSpec /
 * RunResult registry (docs/DATA_CONTRACTS.md, CLI_SPEC). Specs are validated
 * and content-hashed before persistence; results attach exactly once per
 * spec version (re-attach refuses — record a new version instead).
 */
export function registerExperimentCommand(program: Command): void {
  const experiment = program
    .command('experiment')
    .description('unified experiment specs and run results');

  experiment
    .command('spec')
    .description('validate, hash and record an ExperimentSpec from a JSON file')
    .argument('<file>', 'path to the spec JSON')
    .option('--json', 'machine-readable output')
    .action(
      action(async (file: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const value = await readJsonFile(file);
        const validation = validateExperimentSpec(value);
        if (!validation.ok) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `invalid experiment spec: ${validation.errors.join('; ')}`,
          );
        }
        const spec = value as ExperimentSpec;
        const specHash = computeSpecHash(spec);
        const runtime = await openRuntime(root);
        try {
          const existing = await runtime.db.getExperiment(spec.specId);
          await runtime.db.upsertExperiment({
            specId: spec.specId,
            version: spec.version,
            specHash,
            status: existing && existing.specHash === specHash ? existing.status : 'planned',
            spec: spec as unknown as Record<string, unknown>,
            // Identical-hash re-record keeps any attached result (handled in
            // upsert); a new hash/version starts planned with no result.
            result: existing && existing.specHash === specHash ? existing.result : null,
            updatedAt: Date.now(),
          });
          const after = await runtime.db.getExperiment(spec.specId);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                specId: spec.specId,
                version: spec.version,
                specHash,
                status: after?.status ?? 'planned',
                idempotent: existing?.specHash === specHash,
              }),
            );
          } else {
            process.stdout.write(
              `recorded ${spec.specId} v${spec.version} (${shortHash(specHash)}) status=${after?.status ?? 'planned'}\n`,
            );
            if (existing && existing.specHash === specHash) {
              process.stdout.write('  identical spec already recorded (idempotent)\n');
            } else if (existing) {
              process.stdout.write(`  replaced version ${existing.version} (hash changed)\n`);
            }
            process.stdout.write('next: run it, then ideaseek experiment result <file>\n');
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  experiment
    .command('result')
    .description('validate and attach a RunResult to its spec')
    .argument('<file>', 'path to the result JSON')
    .option('--json', 'machine-readable output')
    .action(
      action(async (file: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const value = await readJsonFile(file);
        const validation = validateRunResult(value);
        if (!validation.ok) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `invalid run result: ${validation.errors.join('; ')}`,
          );
        }
        const result = value as RunResult;
        const runtime = await openRuntime(root);
        try {
          const spec = await runtime.db.getExperiment(result.specId);
          if (!spec) {
            throw new IdeaseekError(
              'TASK_NOT_FOUND',
              `experiment ${result.specId} not found; record the spec first (ideaseek experiment spec <file>)`,
            );
          }
          const updated = await runtime.db.attachExperimentResult(
            result.specId,
            result as unknown as Record<string, unknown>,
            result.status,
          );
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                specId: result.specId,
                version: updated.version,
                status: updated.status,
                metrics: (result.metrics ?? []).map((m) => ({
                  name: m.name,
                  value: m.value,
                })),
              }),
            );
          } else {
            process.stdout.write(
              `result attached: ${result.specId} v${updated.version} → ${updated.status}\n`,
            );
            const summary = metricSummary(updated);
            if (summary) process.stdout.write(`  metrics: ${summary}\n`);
            if (result.failure) {
              process.stdout.write(
                `  failure: ${result.failure.category} - ${result.failure.summary}\n`,
              );
            }
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  experiment
    .command('list')
    .description('list recorded experiment specs and their statuses')
    .option('--status <status>', 'filter: planned | succeeded | failed | partial | invalid')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { status?: string; json?: boolean }) => {
        const root = await openRoot();
        const valid = ['planned', 'succeeded', 'failed', 'partial', 'invalid'];
        if (opts.status !== undefined && !valid.includes(opts.status)) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `--status must be one of ${valid.join(' | ')}`,
          );
        }
        const runtime = await openRuntime(root);
        try {
          const docs = await runtime.db.listExperiments(
            opts.status === undefined ? {} : { status: opts.status as ExperimentDoc['status'] },
          );
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                experiments: docs.map((doc) => ({
                  specId: doc.specId,
                  version: doc.version,
                  status: doc.status,
                  specHash: doc.specHash,
                  hasResult: doc.result !== null,
                  updatedAt: doc.updatedAt,
                })),
              }),
            );
            return 0;
          }
          if (docs.length === 0) {
            process.stdout.write('no experiments recorded (ideaseek experiment spec <file>)\n');
            return 0;
          }
          process.stdout.write(`${docs.length} experiment(s):\n`);
          for (const doc of docs) {
            const summary = metricSummary(doc);
            process.stdout.write(
              `  ${doc.specId}  v${doc.version}  ${doc.status.padEnd(10)}  ${summary}\n`,
            );
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  experiment
    .command('show')
    .description('show one experiment spec with its attached result')
    .argument('<specId>', 'spec id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (specId: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const doc = await runtime.db.getExperiment(specId);
          if (!doc) {
            throw new IdeaseekError('TASK_NOT_FOUND', `experiment ${specId} not found`);
          }
          if (opts.json) {
            process.stdout.write(jsonLine(doc));
          } else {
            process.stdout.write(
              `${doc.specId} v${doc.version} ${doc.status} (${shortHash(doc.specHash)})\n`,
            );
            const spec = doc.spec as { command?: unknown; comparisonIds?: unknown };
            if (Array.isArray(spec.command)) {
              process.stdout.write(`  command: ${spec.command.join(' ')}\n`);
            }
            if (Array.isArray(spec.comparisonIds)) {
              process.stdout.write(`  comparisons: ${spec.comparisonIds.join(', ')}\n`);
            }
            const summary = metricSummary(doc);
            if (summary) process.stdout.write(`  metrics: ${summary}\n`);
            if (doc.result) {
              const result = doc.result as { explanation?: string; failure?: { summary?: string } };
              if (result.explanation)
                process.stdout.write(`  explanation: ${result.explanation}\n`);
              if (result.failure?.summary) {
                process.stdout.write(`  failure: ${result.failure.summary}\n`);
              }
            }
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
