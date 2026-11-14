import type { Command } from 'commander';
import { join, relative } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { findProjectRoot } from '../config/paths.js';
import { stringify } from 'yaml';
import { importComparisonRepo } from '../comparison/importer.js';
import { buildCandidates, extractRepoUrls } from '../comparison/discover.js';
import {
  evaluateComparisonGateForProject,
  hashWorktreeDir,
  writeSmokeWorktreeStamp,
} from '../comparison/worktree-stamp.js';
import { buildEntrySuggestions } from '../comparison/entry-suggest.js';
import { assertWorktree } from '../comparison/repair.js';
import { analyzeRepository } from '../knowledge/repository.js';
import {
  assertEffectiveAutonomy,
  parseAutonomyMode,
  recordDecision,
} from '../workflow/autonomy.js';
import {
  COMPARISON_TRANSITIONS,
  REASON_REQUIRED,
  assertTransition,
  validateComparisonMethod,
  type ComparisonMethod,
  type ComparisonStatus,
  type ReproductionBlueprint,
} from '../comparison/types.js';

import { action, jsonLine } from './shared.js';

async function openRuntime(root: string) {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  return ProjectRuntime.open({ cwd: root });
}

async function openRoot(): Promise<string> {
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

/** DB is authoritative; this keeps the human-readable export in sync. */
export async function exportMethodYaml(root: string, method: ComparisonMethod): Promise<string> {
  const dir = join(root, 'comparisons', method.methodId);
  await ensureDir(dir);
  const path = join(dir, 'method.yaml');
  await writeFileAtomic(path, stringify(method, { lineWidth: 100 }));
  return path;
}

function toMethod(record: Record<string, unknown>): ComparisonMethod {
  return record as unknown as ComparisonMethod;
}

export function registerComparisonCommand(program: Command): void {
  const comparison = program
    .command('comparison')
    .description('comparison methods: import, inspect, transition and smoke-test');

  comparison
    .command('import')
    .description(
      'anonymous-clone a public repo into comparisons/<id> with upstream/worktree isolation',
    )
    .argument('<methodId>', 'kebab-case method id')
    .argument(
      '[url]',
      'public HTTPS git URL (credentials are never provided; defaults to the registered --repo url)',
    )
    .option('--branch <branch>', 'branch/tag to shallow-clone')
    .option('--reference-only', 'register as reference-only (default is required for the gate)')
    .option(
      '--paper <ref>',
      'paper reference (repeatable)',
      (value, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option('--source <kind>', 'user | official-code | paper-reimplementation', 'official-code')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          methodId: string,
          url: string | undefined,
          opts: {
            branch?: string;
            referenceOnly?: boolean;
            paper?: string[];
            source?: string;
            json?: boolean;
          },
        ) => {
          const root = await openRoot();
          if (!['user', 'official-code', 'paper-reimplementation'].includes(opts.source ?? '')) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              '--source must be user | official-code | paper-reimplementation',
            );
          }
          const rt = await openRuntime(root);
          let existing: Awaited<ReturnType<typeof rt.db.getComparison>> = null;
          try {
            existing = await rt.db.getComparison(methodId);
          } finally {
            await rt.close();
          }
          const cloneUrl = url ?? (existing?.record.repo as { url?: unknown } | undefined)?.url;
          if (typeof cloneUrl !== 'string' || !cloneUrl) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              'no repository url: pass one or register first (ideaseek comparison register <id> --repo <url>)',
            );
          }
          // Status discipline: a registered candidate/accepted record advances
          // through its legal hops to source-resolved; later-stage methods must
          // be moved back explicitly via set-status (no silent re-imports).
          if (existing && !['candidate', 'accepted', 'source-resolved'].includes(existing.status)) {
            throw new IdeaseekError(
              'INVALID_STATE',
              `cannot import ${methodId} from status ${existing.status}; use: ideaseek comparison set-status ${methodId} source-resolved`,
            );
          }
          const imported = await importComparisonRepo(root, {
            methodDir: `comparisons/${methodId}`,
            url: cloneUrl,
            branch: opts.branch,
          });
          const now = Date.now();
          const history: ComparisonMethod['history'] = existing
            ? [...((existing.record.history as ComparisonMethod['history']) ?? [])]
            : [];
          const from: ComparisonStatus = (existing?.status as ComparisonStatus) ?? 'candidate';
          // Record the legal hops a fresh/registered method walks on import.
          if (from === 'candidate') {
            history.push({
              at: now,
              from: 'candidate',
              to: 'accepted',
              reason: 'import approved',
            });
            history.push({
              at: now,
              from: 'accepted',
              to: 'source-resolved',
              reason: 'imported with upstream + worktree',
            });
          } else if (from === 'accepted') {
            history.push({
              at: now,
              from: 'accepted',
              to: 'source-resolved',
              reason: 'imported with upstream + worktree',
            });
          }
          const existingMethod = existing ? toMethod(existing.record) : null;
          const method: ComparisonMethod = {
            methodId,
            paperRefs: [...new Set([...(existingMethod?.paperRefs ?? []), ...(opts.paper ?? [])])],
            required: existingMethod?.required ?? opts.referenceOnly !== true,
            sourceKind:
              existingMethod?.sourceKind ?? (opts.source as ComparisonMethod['sourceKind']),
            repo: {
              url: cloneUrl,
              branch: opts.branch ?? existingMethod?.repo?.branch,
              commit: imported.commit,
              license: imported.license,
              licenseKind: imported.licenseKind,
              clonedAt: now,
            },
            status: 'source-resolved',
            statusReason: 'imported with upstream + worktree isolation',
            notes: [
              ...new Set([
                ...(existingMethod?.notes ?? []),
                'cloned anonymously; upstream is read-only, edits go to worktree/',
              ]),
            ],
            history,
            createdAt: existingMethod?.createdAt ?? now,
            updatedAt: now,
          };
          const errors = validateComparisonMethod(method);
          if (!errors.ok) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              `invalid method: ${errors.errors.join('; ')}`,
            );
          }
          const record = method as unknown as Record<string, unknown>;
          const rt2 = await openRuntime(root);
          try {
            await rt2.db.upsertComparison({
              methodId,
              status: method.status,
              required: method.required,
              record,
              updatedAt: now,
            });
          } finally {
            await rt2.close();
          }
          const yamlPath = await exportMethodYaml(root, method);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                methodId,
                status: method.status,
                commit: imported.commit,
                license: imported.license,
                licenseKind: imported.licenseKind,
                upstream: imported.upstreamDir,
                worktree: imported.worktreeDir,
                methodYaml: yamlPath,
              }),
            );
          } else {
            process.stdout.write(
              `imported ${methodId} @ ${imported.commit.slice(0, 10)} (${method.sourceKind}${method.required ? ', required' : ', reference-only'})\n`,
            );
            process.stdout.write(`  upstream: ${imported.upstreamDir} (read-only)\n`);
            process.stdout.write(`  worktree: ${imported.worktreeDir} (edits go here)\n`);
            process.stdout.write(
              `  license: ${imported.license ?? 'none found'} (${imported.licenseKind})\n`,
            );
            process.stdout.write(`  method: ${yamlPath}\n`);
            process.stdout.write('next: ideaseek comparison smoke ' + methodId + '\n');
          }
          return 0;
        },
      ),
    );

  comparison
    .command('register')
    .description('register a candidate method without cloning (from discovery or user input)')
    .argument('<methodId>', 'kebab-case method id')
    .option('--repo <url>', 'recorded repository url (cloned later by comparison import)')
    .option(
      '--paper <ref>',
      'paper reference (repeatable)',
      (value, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option('--source <kind>', 'user | official-code | paper-reimplementation', 'official-code')
    .option('--reference-only', 'reference-only (default is required for the gate)')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          methodId: string,
          opts: {
            repo?: string;
            paper?: string[];
            source?: string;
            referenceOnly?: boolean;
            json?: boolean;
          },
        ) => {
          const root = await openRoot();
          if (!['user', 'official-code', 'paper-reimplementation'].includes(opts.source ?? '')) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              '--source must be user | official-code | paper-reimplementation',
            );
          }
          const now = Date.now();
          const method: ComparisonMethod = {
            methodId,
            paperRefs: opts.paper ?? [],
            required: opts.referenceOnly !== true,
            sourceKind: opts.source as ComparisonMethod['sourceKind'],
            ...(opts.repo ? { repo: { url: opts.repo } } : {}),
            status: 'candidate',
            notes: ['registered without clone; next: comparison import ' + methodId],
            createdAt: now,
            updatedAt: now,
          };
          const errors = validateComparisonMethod(method);
          if (!errors.ok) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              `invalid method: ${errors.errors.join('; ')}`,
            );
          }
          const rt = await openRuntime(root);
          try {
            const existingDoc = await rt.db.getComparison(methodId);
            if (existingDoc) {
              throw new IdeaseekError(
                'ALREADY_INITIALIZED',
                `comparison ${methodId} already registered (status ${existingDoc.status})`,
              );
            }
            await rt.db.upsertComparison({
              methodId,
              status: method.status,
              required: method.required,
              record: method as unknown as Record<string, unknown>,
              updatedAt: now,
            });
          } finally {
            await rt.close();
          }
          const yamlPath = await exportMethodYaml(root, method);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                methodId,
                status: method.status,
                required: method.required,
                repo: opts.repo ?? null,
                methodYaml: yamlPath,
              }),
            );
          } else {
            process.stdout.write(
              `registered ${methodId} (candidate${method.required ? ', required' : ', reference-only'})\n`,
            );
            process.stdout.write(`  method: ${yamlPath}\n`);
            process.stdout.write(
              `next: ideaseek comparison import ${methodId}${opts.repo ? '' : ' <url>'}\n`,
            );
          }
          return 0;
        },
      ),
    );

  comparison
    .command('discover')
    .description('scan indexed papers for repository urls (deterministic official-code candidates)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const root = await openRoot();
        const rt = await openRuntime(root);
        let mentions: Awaited<ReturnType<typeof rt.db.findRepoUrlMentions>>;
        try {
          mentions = await rt.db.findRepoUrlMentions();
          // Most conference papers publish code as a hyperlink, not as literal
          // text: the URL lives in a PDF link annotation, so a text scan finds
          // nothing. The parser already extracts those into the artifact.
          const known = new Set(mentions.map((mention) => `${mention.url}`));
          for (const artifact of await rt.db.listArtifactsByKind('parsed-paper')) {
            let payload: {
              source?: string;
              sourceHash?: string;
              pages?: { page?: number; links?: string[] }[];
            };
            try {
              payload = JSON.parse(
                await rt.store.readFinalText(artifact.contentHash),
              ) as typeof payload;
            } catch {
              continue;
            }
            for (const page of payload.pages ?? []) {
              for (const url of extractRepoUrls((page.links ?? []).join(' '))) {
                if (known.has(url)) continue;
                known.add(url);
                mentions.push({
                  paperKey: payload.sourceHash ?? '',
                  source: payload.source ?? '',
                  page: Number(page.page) || 0,
                  url,
                });
              }
            }
          }
        } finally {
          await rt.close();
        }
        const candidates = buildCandidates(mentions);
        const payload = {
          generatedAt: Date.now(),
          mentionCount: mentions.length,
          candidates,
        };
        const outPath = join(root, 'knowledge', 'comparison-candidates.json');
        await ensureDir(join(root, 'knowledge'));
        await writeFileAtomic(outPath, `${JSON.stringify(payload, null, 2)}\n`);
        if (opts.json) {
          process.stdout.write(jsonLine(payload));
          return 0;
        }
        if (candidates.length === 0) {
          process.stdout.write(
            'no repository urls found in indexed papers (run ideaseek ingest first)\n',
          );
          process.stdout.write(`  candidates: ${outPath}\n`);
          return 0;
        }
        process.stdout.write(
          `${candidates.length} candidate repo(s) from ${mentions.length} mention(s):\n`,
        );
        for (const candidate of candidates.slice(0, 20)) {
          process.stdout.write(
            `  ${candidate.repoUrl}  papers=${candidate.paperRefs.length} mentions=${candidate.mentions}\n`,
          );
        }
        process.stdout.write(`  candidates: ${outPath}\n`);
        process.stdout.write(
          'next: ideaseek comparison register <id> --repo <url> --paper <ref>\n',
        );
        return 0;
      }),
    );

  comparison
    .command('list')
    .description('list registered comparison methods')
    .option('--required', 'only required methods')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { required?: boolean; json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const methods = await runtime.db.listComparisons(
            opts.required === undefined ? {} : { required: opts.required },
          );
          if (opts.json) {
            process.stdout.write(jsonLine({ methods }));
            return 0;
          }
          if (methods.length === 0) {
            process.stdout.write(
              'no comparison methods registered (ideaseek comparison import <id> <url>)\n',
            );
            return 0;
          }
          process.stdout.write(`${methods.length} comparison method(s):\n`);
          for (const method of methods) {
            const record = toMethod(method.record);
            process.stdout.write(
              `  ${method.methodId}  ${method.status.padEnd(16)} ${method.required ? 'required' : 'reference-only'}  ${record.sourceKind ?? '?'}${record.repo?.commit ? `  @ ${String(record.repo.commit).slice(0, 10)}` : ''}\n`,
            );
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  comparison
    .command('matrix')
    .description(
      'build the reviewable comparison matrix (required/reference-only/excluded/blocked) from persisted evidence',
    )
    .option('--confirm', 'apply the reviewed matrix to the registry and stamp it')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { confirm?: boolean; json?: boolean }) => {
        const root = await openRoot();
        const { buildComparisonMatrix, assertMatrixApprovable, applyComparisonMatrix } =
          await import('../comparison/matrix.js');
        const { readFile } = await import('node:fs/promises');
        const path = join(root, 'knowledge', 'comparison-matrix.json');
        await ensureDir(join(root, 'knowledge'));

        const fresh = await buildComparisonMatrix(root);
        let stored: typeof fresh | null = null;
        try {
          stored = JSON.parse(await readFile(path, 'utf8')) as typeof fresh;
        } catch {
          stored = null;
        }
        // State unchanged → keep the reviewed file as-is: the researcher
        // may have edited classifications, and a rebuild would clobber them.
        const stateCurrent = stored !== null && stored.inputHash === fresh.inputHash;

        if (!opts.confirm) {
          if (!stateCurrent) {
            if (stored) {
              process.stdout.write(
                'note: project state changed — previous matrix and its edits are superseded\n',
              );
            }
            await writeFileAtomic(path, `${JSON.stringify(fresh, null, 2)}\n`);
          }
          const shown = stateCurrent ? stored! : fresh;
          if (opts.json) {
            process.stdout.write(jsonLine({ path, inputHash: shown.inputHash, matrix: shown }));
            return 0;
          }
          const registeredCount = shown.entries.filter((e) => e.origin === 'registered').length;
          process.stdout.write(
            `comparison matrix: ${shown.blockers.length === 0 ? 'READY to confirm' : 'NOT READY'} ` +
              `(${shown.entries.length} entries · ${registeredCount} registered · ${shown.entries.length - registeredCount} paper-card-only)\n`,
          );
          process.stdout.write(
            `  context: venue=${shown.context.venue ?? 'none'} · corpus cards=${shown.context.corpusPaperCards} · ` +
              `research map=${shown.context.researchMapPresent ? 'yes' : 'no'} · questions=${shown.context.questions.length}\n`,
          );
          for (const blocker of shown.blockers) {
            process.stdout.write(`  blocker: ${blocker}\n`);
          }
          for (const entry of shown.entries.slice(0, 20)) {
            process.stdout.write(
              `  ${entry.methodId.padEnd(20)} ${entry.classification.padEnd(15)} ${entry.rationale.slice(0, 90)}\n`,
            );
          }
          if (shown.entries.length > 20) {
            process.stdout.write(`  … ${shown.entries.length - 20} more in the file\n`);
          }
          process.stdout.write('  file: knowledge/comparison-matrix.json\n');
          process.stdout.write(
            shown.blockers.length === 0
              ? 'next: review/edit classifications in the file, then ideaseek comparison matrix --confirm\n'
              : 'next: clear the blockers above, then rerun ideaseek comparison matrix\n',
          );
          return 0;
        }

        // Confirm: the reviewed (possibly edited) matrix must still match
        // current state, then apply classifications and stamp it.
        if (!stored) {
          throw new IdeaseekError(
            'USER_INPUT_REQUIRED',
            'no comparison matrix — run: ideaseek comparison matrix',
          );
        }
        assertMatrixApprovable(stored, fresh.inputHash);

        const runtime = await openRuntime(root);
        try {
          const mode = parseAutonomyMode(runtime.config.policy.autonomyMode);
          // Structural confirm: --confirm IS the guided confirmation; the
          // protected action records the Decision (never silent).
          const check = await assertEffectiveAutonomy(
            root,
            runtime.config.policy.autonomyMode,
            'change-required-comparison',
            { confirmed: true },
          );
          const { applied } = await applyComparisonMatrix(root, stored);
          const now = Date.now();
          const stamped = {
            ...stored,
            confirmed: { at: now, mode, inputHash: stored.inputHash, applied },
          };
          await writeFileAtomic(path, `${JSON.stringify(stamped, null, 2)}\n`);

          let decisionSeq: number | null = null;
          if (check.needsDecision) {
            const decision = await recordDecision(runtime.db, runtime.project.id, {
              action: 'change-required-comparison',
              target: `comparison matrix (${stored.entries.length} entries, ${applied.length} applied)`,
              mode,
            });
            decisionSeq = decision?.seq ?? null;
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                confirmed: true,
                mode,
                decisionSeq,
                inputHash: stored.inputHash,
                applied,
                path,
              }),
            );
            return 0;
          }
          process.stdout.write(
            `comparison matrix CONFIRMED [${mode}] (${stored.inputHash.slice(0, 12)}…, ` +
              `${stored.entries.length} entries)\n`,
          );
          process.stdout.write(`  applied: ${applied.length} registry change(s)\n`);
          for (const change of applied) {
            process.stdout.write(`    ${change}\n`);
          }
          if (decisionSeq !== null) {
            process.stdout.write(`  decision recorded (event #${decisionSeq})\n`);
          }
          process.stdout.write(
            'next: ideaseek comparison gate   (required flags now drive the gate)\n',
          );
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  comparison
    .command('blueprint')
    .description(
      'author a reproduction blueprint from the papers (the input `baseline reproduce` needs)',
    )
    .argument('<methodId>', 'comparison method id')
    .option(
      '--harness <kind>',
      'agent harness: fake | dsh (default: dsh when a key is configured, else fake with a warning)',
    )
    .option('--force', 're-author even when a current blueprint exists')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (methodId: string, opts: { harness?: string; force?: boolean; json?: boolean }) => {
          const root = await openRoot();
          const shared = await import('./shared.js');
          const runtime = await (
            await import('../workflow/runtime.js')
          ).ProjectRuntime.open({
            cwd: root,
            harness: shared.buildHarness(shared.resolveHarnessKind(opts.harness)),
          });
          try {
            shared.assertConfigUsable(runtime.configLoad);
            const doc = await runtime.db.getComparison(methodId);
            if (!doc) {
              throw new IdeaseekError('TASK_NOT_FOUND', `comparison ${methodId} not found`);
            }
            const method = toMethod(doc.record);
            if (method.sourceKind !== 'paper-reimplementation') {
              throw new IdeaseekError(
                'INVALID_STATE',
                `blueprint authoring is for paper-reimplementation methods; ${methodId} is "${method.sourceKind}" — import its official code instead`,
              );
            }

            const { loadCompactCards } = await import('../knowledge/cards.js');
            const cards = await loadCompactCards(runtime);
            const grounded = method.paperRefs.length > 0 ? cards : [];
            if (method.paperRefs.length === 0) {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                `${methodId} has no paperRefs — a reimplementation must cite papers: ideaseek comparison register ${methodId} --source paper-reimplementation --paper <ref>`,
              );
            }

            // The protocol is read from the artifact store like every other
            // consumer. This used to open knowledge/protocol-lock.json, a file
            // nothing ever wrote, so authoring always concluded "no protocol is
            // locked" and proposed metric names that reproduce then refused.
            const { readLockedProtocol, protocolMetricNames } =
              await import('../experiment/protocol-source.js');
            const { readFile } = await import('node:fs/promises');
            const stored = await readLockedProtocol(runtime);
            const protocol = stored
              ? { primaryMetrics: stored.primaryMetrics, splitRules: stored.splitRules }
              : null;
            const requiredMetricNames = protocolMetricNames(stored);
            let corpus: {
              samples: number;
              domainAxis: string | null;
              domains: string[];
              classes: number;
            } | null = null;
            try {
              const measured = JSON.parse(
                await readFile(join(root, 'knowledge', 'image-profiles.json'), 'utf8'),
              ) as {
                profiles?: {
                  samples: number;
                  grouping: { column: string | null; values: { name: string }[] };
                  classes: { distinct: number };
                }[];
              };
              const first = measured.profiles?.[0];
              if (first) {
                corpus = {
                  samples: first.samples,
                  domainAxis: first.grouping.column,
                  domains: first.grouping.values.map((value) => value.name),
                  classes: first.classes.distinct,
                };
              }
            } catch {
              // Not profiled yet: the data interface becomes an assumption.
            }

            const { authorBlueprint, describeBlueprint } =
              await import('../comparison/blueprint-author.js');
            const {
              blueprintMetricNames,
              checkMetricFeasibility,
              metricIdentifier,
              validateReproductionBlueprint,
            } = await import('../comparison/reproduce.js');
            const runId =
              (await runtime.db.getLatestRun(runtime.project.id))?.runId ?? `blueprint-${methodId}`;
            const evidenceBase = {
              methodId,
              question: runtime.config.research.question,
              papers: grounded.map((card) => ({
                source: card.source,
                title: card.title,
                topClaims: card.topClaims,
              })),
              protocol,
              corpus,
            };
            let blueprint: Awaited<ReturnType<typeof authorBlueprint>>['blueprint'];
            let contextHash = '';
            let correction: string | undefined;
            // Two authoring turns maximum. The second one sees exactly why the
            // first was refused, so a retry changes the input instead of
            // sampling the same response twice.
            for (let attempt = 1; ; attempt += 1) {
              const authored = await authorBlueprint({
                harness: runtime.harness!,
                evidence: { ...evidenceBase, correction },
                runId,
                now: Date.now(),
              });
              blueprint = authored.blueprint;
              contextHash = authored.contextHash;

              const problems: string[] = [];
              const validation = validateReproductionBlueprint(blueprint, {
                methodId,
                paperRefs: method.paperRefs,
              });
              if (!validation.ok) problems.push(...validation.errors);

              // Checked at authoring time, not at reproduce time: a plan that
              // reports the protocol's metrics under other names cannot answer
              // the protocol no matter what it later computes.
              const feasibility = checkMetricFeasibility(
                requiredMetricNames,
                blueprintMetricNames(blueprint),
              );
              if (feasibility.status === 'blocked') {
                problems.push(
                  `algorithm.metrics must cover the locked protocol metrics — the protocol ` +
                    `measures [${requiredMetricNames.map((name) => metricIdentifier(name)).join(', ')}] ` +
                    `but the plan offers [${blueprintMetricNames(blueprint).join(', ')}]; use ` +
                    `those identifiers exactly (additional metrics are allowed, and the ` +
                    `protocol's trailing parenthetical text is a definition, not part of the name)`,
                );
              } else if (feasibility.status === 'partial') {
                process.stderr.write(
                  `feasibility: blueprint covers ${feasibility.covered.length}/` +
                    `${requiredMetricNames.length} protocol metrics — missing ` +
                    `[${feasibility.uncovered.join(', ')}]\n`,
                );
              }

              // Parse the implementation before persisting it. A blueprint whose
              // code cannot compile is not a plan; leaving it in place only moves
              // the failure into a later reproduce run.
              const implementation = blueprint.algorithm?.source;
              if (implementation && implementation.trim()) {
                const { writeFile: writeTmp, mkdtemp, rm } = await import('node:fs/promises');
                const { tmpdir } = await import('node:os');
                const { checkPythonSyntax } = await import('../knowledge/materialize.js');
                const scratch = await mkdtemp(join(tmpdir(), 'ideaseek-bp-syntax-'));
                const probe = join(scratch, 'algorithm.py');
                try {
                  await writeTmp(probe, implementation, 'utf8');
                  const syntax = await checkPythonSyntax(probe);
                  if (!syntax.ok) {
                    problems.push(
                      `the inline algorithm in algorithm.source does not compile: ` +
                        `line ${syntax.line}: ${syntax.message}`,
                    );
                  }
                } finally {
                  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
                }
              }

              if (problems.length === 0) break;
              if (attempt >= 2) {
                throw new IdeaseekError(
                  'INVALID_ARTIFACT',
                  `authored blueprint is not usable after ${attempt} attempts: ` +
                    `${problems.join('; ')} — nothing was written`,
                  { errors: problems },
                );
              }
              correction = `the previous blueprint was refused:\n- ${problems.join('\n- ')}`;
              process.stderr.write(
                `blueprint refused on attempt ${attempt}: ${problems[0]}\nretrying with that feedback\n`,
              );
            }

            const dir = join(root, 'comparisons', methodId);
            await ensureDir(dir);
            const path = join(dir, 'blueprint.json');
            await writeFileAtomic(path, `${JSON.stringify(blueprint, null, 2)}\n`);

            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  methodId,
                  path: relative(root, path).replace(/\\/g, '/'),
                  contextHash,
                  confidence: blueprint.confidence,
                  paperExplicit: blueprint.paperExplicit.length,
                  assumptions: blueprint.assumptions.length,
                  missingDetails: blueprint.missingDetails.length,
                }),
              );
              return 0;
            }
            process.stdout.write(`blueprint authored for ${methodId}\n`);
            process.stdout.write(`  ${describeBlueprint(blueprint).split('\n').join('\n  ')}\n`);
            process.stdout.write(
              `  file: ${relative(root, path).replace(/\\/g, '/')} (review it before reproducing)\n`,
            );
            process.stdout.write(
              'next: ideaseek baseline reproduce --method <id> --data <path>\n' +
                'boundary: a reimplementation is not official code; assumptions and missing details stay recorded\n',
            );
            return 0;
          } finally {
            await runtime.close();
          }
        },
      ),
    );

  comparison
    .command('implement')
    .description(
      'generate the reproduction program from the blueprint, compile-check it, and write it into the worktree',
    )
    .argument('<methodId>', 'comparison method id')
    .option(
      '--harness <kind>',
      'agent harness: fake | dsh (default: dsh when a key is configured, else fake with a warning)',
    )
    .option('--data <path>', 'data path the checks will be handed, passed to the generator')
    .option('--force', 'regenerate over an existing implementation')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          methodId: string,
          opts: { harness?: string; data?: string; force?: boolean; json?: boolean },
        ) => {
          const root = await openRoot();
          const shared = await import('./shared.js');
          const runtime = await (
            await import('../workflow/runtime.js')
          ).ProjectRuntime.open({
            cwd: root,
            harness: shared.buildHarness(shared.resolveHarnessKind(opts.harness)),
          });
          try {
            shared.assertConfigUsable(runtime.configLoad);
            const doc = await runtime.db.getComparison(methodId);
            if (!doc) {
              throw new IdeaseekError('TASK_NOT_FOUND', `comparison ${methodId} not found`);
            }
            const { readFile } = await import('node:fs/promises');
            const blueprintPath = join(root, 'comparisons', methodId, 'blueprint.json');
            let blueprintValue: unknown;
            try {
              blueprintValue = JSON.parse(await readFile(blueprintPath, 'utf8'));
            } catch {
              throw new IdeaseekError(
                'FILE_NOT_FOUND',
                `no blueprint for ${methodId}: ${relative(root, blueprintPath).replace(/\\/g, '/')} — run: ideaseek comparison blueprint ${methodId}`,
              );
            }
            const { validateReproductionBlueprint } = await import('../comparison/reproduce.js');
            const method = toMethod(doc.record);
            const validation = validateReproductionBlueprint(blueprintValue, {
              methodId,
              paperRefs: method.paperRefs,
            });
            if (!validation.ok) {
              throw new IdeaseekError(
                'INVALID_ARTIFACT',
                `blueprint is not usable: ${validation.errors.join('; ')} — fix it with: ideaseek comparison blueprint ${methodId} --force`,
              );
            }
            const blueprint = blueprintValue as ReproductionBlueprint;

            const worktreeDir = join(root, 'comparisons', methodId, 'worktree');
            const target = join(worktreeDir, 'reproduce.py');
            const existing = await readFile(target, 'utf8').catch(() => null);
            if (existing?.trim() && !opts.force) {
              throw new IdeaseekError(
                'ALREADY_COMMITTED',
                `${relative(root, target).replace(/\\/g, '/')} already has an implementation — pass --force to replace it`,
              );
            }

            const { authorImplementation } = await import('../comparison/implement-author.js');
            const runId =
              (await runtime.db.getLatestRun(runtime.project.id))?.runId ?? `implement-${methodId}`;
            const { writeFile: writeTmp, mkdtemp, rm } = await import('node:fs/promises');
            const { tmpdir } = await import('node:os');
            const { checkPythonSyntax } = await import('../knowledge/materialize.js');
            let authored: Awaited<ReturnType<typeof authorImplementation>>;
            let correction: string | undefined;
            // Same shape as the blueprint gate: one retry that is told why the
            // first attempt was refused. Two unparseable programs in a row came
            // out of this call earlier today, and the only remedy then was a
            // human rerunning the command — which pays for the model call again
            // with no new information.
            for (let attempt = 1; ; attempt += 1) {
              authored = await authorImplementation({
                harness: runtime.harness!,
                blueprint,
                dataPath: opts.data ?? null,
                runId,
                now: Date.now(),
                correction,
              });

              // Compile before writing: an unparseable program in the worktree
              // only fails later, after a venv and a clone have been paid for.
              const scratch = await mkdtemp(join(tmpdir(), 'ideaseek-implement-'));
              let syntaxError: string | null = null;
              try {
                await writeTmp(join(scratch, 'reproduce.py'), authored.source, 'utf8');
                const syntax = await checkPythonSyntax(join(scratch, 'reproduce.py'));
                if (!syntax.ok) {
                  syntaxError =
                    `line ${syntax.line}: ${syntax.message} ` +
                    `(the program you returned is ${authored.lines} lines long)`;
                }
              } finally {
                await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
              }

              if (!syntaxError) break;
              if (attempt >= 2) {
                throw new IdeaseekError(
                  'INVALID_ARTIFACT',
                  `authored implementation does not compile after ${attempt} attempts ` +
                    `(${syntaxError}) — nothing was written; ` +
                    'rerun with --force, and set IDEASEEK_IMPLEMENT_DEBUG to keep the raw response',
                );
              }
              correction =
                `the program from the previous attempt was refused because it does not ` +
                `compile: ${syntaxError}. Return a complete program that parses: check that ` +
                `every bracket, quote and indentation level is closed, and do not truncate ` +
                `the middle of the file.`;
              process.stderr.write(
                `implementation refused on attempt ${attempt}: does not compile (${syntaxError})\n` +
                  'retrying with that feedback\n',
              );
            }

            await ensureDir(worktreeDir);
            await writeFileAtomic(target, authored.source);

            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  methodId,
                  path: relative(root, target).replace(/\\/g, '/'),
                  lines: authored.lines,
                  origin: authored.origin,
                  contextHash: authored.contextHash,
                }),
              );
              return 0;
            }
            process.stdout.write(
              `implementation written: ${relative(root, target).replace(/\\/g, '/')} ` +
                `(${authored.lines} lines, ${authored.origin}, compiles)\n`,
            );
            process.stdout.write(
              `next: ideaseek baseline reproduce --method ${methodId}` +
                `${opts.data ? ` --data ${opts.data}` : ' --data <path>'}\n`,
            );
            return 0;
          } finally {
            await runtime.close();
          }
        },
      ),
    );

  comparison
    .command('plan')
    .description(
      'run the Comparison Planner agent (recent literature, venue, benchmark evidence) → reviewable matrix proposal',
    )
    .option(
      '--harness <kind>',
      'agent harness: fake | dsh (default: dsh when a key is configured, else fake with a warning)',
    )
    .option('--enqueue-only', 'enqueue the comparison.plan task without executing')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { harness?: string; enqueueOnly?: boolean; json?: boolean }) => {
        const root = await openRoot();
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const shared = await import('./shared.js');
        const runtime = await ProjectRuntime.open({
          cwd: root,
          harness: shared.buildHarness(shared.resolveHarnessKind(opts.harness)),
        });
        try {
          shared.assertConfigUsable(runtime.configLoad);
          const { buildPlannerContext, plannerContextHash } =
            await import('../comparison/planner.js');
          const context = await buildPlannerContext(root);
          if (context.candidates.length === 0) {
            throw new IdeaseekError(
              'USER_INPUT_REQUIRED',
              'planner has no candidates — register a method or create idea cards first',
            );
          }
          const contextHash = plannerContextHash(context);

          // Incremental: a current proposal for this exact context short-circuits.
          for (const artifact of await runtime.db.listArtifactsByKind(
            'comparison-matrix-proposal',
          )) {
            if (artifact.meta.contextHash === contextHash) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    action: 'proposal-current',
                    contextHash,
                    candidates: context.candidates.length,
                    literature: context.literature.length,
                    indexNote: context.indexNote,
                  }),
                );
              } else {
                process.stdout.write(
                  `comparison plan: proposal is current for ${context.candidates.length} candidate(s) ` +
                    `(${context.literature.length} literature source(s); ${context.indexNote})\n`,
                );
                process.stdout.write(
                  'next: ideaseek comparison matrix   (review, then --confirm)\n',
                );
              }
              return 0;
            }
          }

          const { ensureActiveRun } = await import('./ingest.js');
          const { runId } = await ensureActiveRun(runtime);
          const { created } = await runtime.db.enqueueTask({
            runId,
            type: 'comparison.plan',
            phase: 'DEMO',
            payload: { contextHash },
            dependsOn: [],
            idempotencyKey: `cplan:${contextHash.slice(7, 19)}:v1`,
            maxAttempts: runtime.config.runtime.maxAttempts,
          });

          if (opts.enqueueOnly) {
            if (opts.json) {
              process.stdout.write(jsonLine({ runId, enqueued: created, contextHash }));
            } else {
              process.stdout.write(
                `comparison plan: ${created ? '1 task enqueued' : 'task already queued'} in run ${runId}\n`,
              );
              process.stdout.write('next: ideaseek worker\n');
            }
            return 0;
          }

          const { exit } = await shared.runWorkerInteractive(runtime, runId, {
            kind: 'inline',
            handlers: shared.buildHandlers(),
            onLog: (message: string) => process.stderr.write(`  · ${message}\n`),
          });
          const finalRun = await runtime.db.getRun(runId);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                runId,
                status: finalRun?.status,
                exitReason: exit.reason,
                contextHash,
                candidates: context.candidates.length,
                literature: context.literature.length,
              }),
            );
          } else {
            process.stdout.write(
              `comparison plan → ${exit.reason} in run ${runId} ` +
                `(${context.candidates.length} candidate(s), ${context.literature.length} source(s))\n`,
            );
            process.stdout.write('next: ideaseek comparison matrix   (review, then --confirm)\n');
          }
          switch (exit.reason) {
            case 'completed':
              return 0;
            case 'failed':
              return 1;
            case 'blocked':
              return 2;
            case 'canceled':
              return 4;
            default:
              return 0;
          }
        } finally {
          await runtime.close();
        }
      }),
    );

  comparison
    .command('gate')
    .description(
      'required-comparison gate: every required method needs a runnable result before idea generation',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const gate = await evaluateComparisonGateForProject(root, runtime.db);
          const { ok, required, passed, skipped, blocking, note } = gate;
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                ok,
                required,
                passed,
                skipped,
                blocking,
                note,
              }),
            );
            return ok ? 0 : 2;
          }
          if (required === 0) {
            process.stdout.write(
              'gate: no required comparisons registered (ideaseek comparison import <id> <url>)\n',
            );
            return 0;
          }
          process.stdout.write(
            `gate: ${passed.length}/${required} required method(s) runnable` +
              (skipped.length > 0 ? ` · ${skipped.length} excluded` : '') +
              (blocking.length > 0 ? ` · ${blocking.length} blocking` : '') +
              '\n',
          );
          for (const entry of passed) {
            process.stdout.write(
              `  PASS  ${entry.methodId}  ${entry.status}` +
                `${entry.via === 'experiment' ? ' (experiment result)' : ''}` +
                `${entry.algorithmModified ? ' (algorithm-modified, revised method)' : ''}\n`,
            );
          }
          for (const entry of skipped) {
            process.stdout.write(
              `  SKIP  ${entry.methodId}  excluded (${entry.reason ?? 'no reason'})\n`,
            );
          }
          for (const entry of blocking) {
            process.stdout.write(`  FAIL  ${entry.methodId}  ${entry.status}\n`);
            process.stdout.write(`        next: ${entry.hint}\n`);
          }
          if (ok) {
            process.stdout.write('gate PASSED: all required comparisons have runnable results\n');
          } else {
            process.stdout.write(
              'gate FAILED: idea generation stays blocked until every required method passes or is explicitly excluded\n',
            );
          }
          return ok ? 0 : 2;
        } finally {
          await runtime.close();
        }
      }),
    );

  comparison
    .command('set-status')
    .description('transition a method through the comparison state machine')
    .argument('<methodId>', 'method id')
    .argument('<status>', 'target status')
    .option('--reason <text>', 'required for excluded/blocked/partial')
    .option('--confirm', 'guided-mode confirmation for protected changes (Decision/Event recorded)')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          methodId: string,
          status: string,
          opts: { reason?: string; confirm?: boolean; json?: boolean },
        ) => {
          const root = await openRoot();
          if (!(status in COMPARISON_TRANSITIONS)) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              `unknown status "${status}" (valid: ${Object.keys(COMPARISON_TRANSITIONS).join(', ')})`,
            );
          }
          const runtime = await openRuntime(root);
          try {
            const before = await runtime.db.getComparison(methodId);
            if (!before) {
              throw new IdeaseekError('TASK_NOT_FOUND', `comparison ${methodId} not found`);
            }
            // State-machine rule first: reason-required statuses fail fast
            // before any policy confirmation is considered.
            if (
              REASON_REQUIRED.includes(status as ComparisonStatus) &&
              !(opts.reason && opts.reason.trim())
            ) {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                `status ${status} requires --reason (no silent skips; docs: EXCLUDED 必须有用户或配置原因)`,
                { status },
              );
            }
            // Protected change: excluding a REQUIRED method needs the mode's
            // approval and always leaves a Decision/Event (AUTONOMY_POLICY).
            let decision: { seq: number } | null = null;
            if (status === 'excluded' && before.required) {
              const mode = parseAutonomyMode(runtime.config.policy.autonomyMode);
              const check = await assertEffectiveAutonomy(
                root,
                mode,
                'change-required-comparison',
                { confirmed: opts.confirm },
              );
              if (check.needsDecision) {
                decision = await recordDecision(runtime.db, runtime.project.id, {
                  action: 'change-required-comparison',
                  target: methodId,
                  mode,
                  reason: opts.reason ?? undefined,
                });
              }
            }
            const after = await runtime.db.transitionComparison(methodId, status, opts.reason);
            // Keep the directory export in sync with the authoritative record.
            await exportMethodYaml(root, toMethod(after.record));
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  methodId,
                  from: before.status,
                  to: after.status,
                  reason: opts.reason ?? null,
                  decisionSeq: decision?.seq ?? null,
                }),
              );
            } else {
              process.stdout.write(
                `${methodId}: ${before.status} → ${after.status}${opts.reason ? ` (${opts.reason})` : ''}\n`,
              );
              if (decision) process.stdout.write(`  decision recorded (event #${decision.seq})\n`);
              else if (status === 'excluded' && before.required) {
                process.stdout.write('  decision not recorded (no run exists yet)\n');
              }
            }
            return 0;
          } finally {
            await runtime.close();
          }
        },
      ),
    );

  comparison
    .command('smoke')
    .description('run the method smoke command inside its worktree (isolation test)')
    .argument('<methodId>', 'method id')
    .option('--timeout <ms>', 'bound on the smoke command', (value) => Number(value))
    .option('--json', 'machine-readable output')
    .action(
      action(async (methodId: string, opts: { timeout?: number; json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const doc = await runtime.db.getComparison(methodId);
          if (!doc) throw new IdeaseekError('TASK_NOT_FOUND', `comparison ${methodId} not found`);
          const method = toMethod(doc.record);
          const worktreeDir = join(root, 'comparisons', methodId, 'worktree');
          const entryConfigured =
            (Array.isArray(method.entry) && method.entry.length > 0) ||
            (typeof method.entry === 'string' && method.entry.trim().length > 0);
          const command: string[] = !entryConfigured
            ? ['python', '--version'] // placeholder: proves nothing about the method
            : Array.isArray(method.entry)
              ? method.entry
              : String(method.entry).trim().split(/\s+/);
          const timeoutMs = Number.isFinite(opts.timeout) ? (opts.timeout as number) : 120_000;

          // Reuse the shared bounded runner (same path as baseline repair) —
          // commands never hand-roll subprocess handling (ADR-006).
          const { runRepairCommand, writeRepairLog } = await import('../comparison/repair.js');
          const { mergeRunEnv } = await import('../experiment/run-env.js');
          const outcome = await runRepairCommand(
            command,
            worktreeDir,
            timeoutMs,
            await mergeRunEnv(root),
          );
          const durationMs = outcome.durationMs;
          const passed = outcome.exitCode === 0 && !outcome.timedOut;
          const tail = outcome.out.slice(-1500);
          const logPath = `.research/logs/smoke-${methodId}.log`;
          await writeRepairLog(
            root,
            `smoke-${methodId}.log`,
            command,
            outcome.exitCode,
            outcome.out,
          );

          const smoke = {
            passed,
            at: Date.now(),
            durationMs,
            tail,
            command,
          };
          // Enforce the state machine on smoke outcomes: a pass advances to
          // smoke-tested only when the graph allows it (e.g. from implemented/
          // repairing; a fresh source-resolved import keeps its status with the
          // smoke evidence recorded). A failing re-smoke of a tested method
          // falls back to repairing; anything else keeps its status (failure is
          // recorded in smoke/statusReason without a silent skip).
          const from = method.status as ComparisonStatus;
          const to: ComparisonStatus = passed
            ? COMPARISON_TRANSITIONS[from].includes('smoke-tested')
              ? 'smoke-tested'
              : from
            : from === 'smoke-tested'
              ? 'repairing'
              : from;
          const failReason = `smoke failed (exit ${outcome.exitCode}); log: ${logPath}`;
          if (to !== from) {
            assertTransition(from, to, passed ? undefined : failReason);
          }
          const now = Date.now();
          const history = Array.isArray(method.history) ? [...method.history] : [];
          if (to !== from) {
            history.push({ at: now, from, to, reason: passed ? null : failReason });
          }
          const record: ComparisonMethod = {
            ...method,
            smoke,
            status: to,
            statusReason: passed ? (to === from ? method.statusReason : undefined) : failReason,
            history,
            updatedAt: now,
          };
          const validation = validateComparisonMethod(record);
          if (!validation.ok) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              `smoke produced invalid method record: ${validation.errors.join('; ')}`,
            );
          }
          const updated = {
            ...doc,
            status: record.status,
            record: record as unknown as Record<string, unknown>,
            updatedAt: record.updatedAt,
          };
          await runtime.db.upsertComparison(updated);
          await exportMethodYaml(root, record);
          if (passed) {
            const worktreeHash = await hashWorktreeDir(worktreeDir);
            if (worktreeHash) {
              await writeSmokeWorktreeStamp(root, methodId, worktreeHash, smoke.at);
            }
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                methodId,
                passed,
                exitCode: outcome.exitCode,
                durationMs,
                status: record.status,
                logPath,
                entryConfigured,
              }),
            );
          } else {
            process.stdout.write(
              `smoke ${methodId}: ${passed ? 'PASSED' : 'FAILED'} (exit ${outcome.exitCode}, ${durationMs}ms) → status ${record.status}\n`,
            );
            process.stdout.write(`  log: ${logPath}\n`);
            if (!entryConfigured) {
              process.stdout.write(
                `  note: no entry configured — placeholder ran; next: ideaseek comparison suggest-entry ${methodId}\n`,
              );
            }
          }
          return passed ? 0 : 1;
        } finally {
          await runtime.close();
        }
      }),
    );

  comparison
    .command('suggest-entry')
    .description(
      'analyze the method worktree and suggest bounded smoke entry commands (never runs them)',
    )
    .argument('<methodId>', 'comparison method id')
    .option('--apply <n>', 'persist suggestion #n as the method entry', (value) => Number(value))
    .option('--json', 'machine-readable output')
    .action(
      action(async (methodId: string, opts: { apply?: number; json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const doc = await runtime.db.getComparison(methodId);
          if (!doc) {
            throw new IdeaseekError('TASK_NOT_FOUND', `comparison ${methodId} not found`);
          }
          const method = toMethod(doc.record);
          const worktreeDir = join(root, 'comparisons', methodId, 'worktree');
          await assertWorktree(worktreeDir);

          // Read-only analysis of the isolated worktree (Codebase Analyst).
          const understanding = await analyzeRepository(worktreeDir, {
            projectRoot: root,
          });
          const suggestions = buildEntrySuggestions(understanding);
          const currentEntry = Array.isArray(method.entry)
            ? method.entry
            : typeof method.entry === 'string' && method.entry.trim()
              ? method.entry.trim().split(/\s+/)
              : null;

          if (opts.apply !== undefined) {
            const index = opts.apply;
            if (!Number.isInteger(index) || index < 1 || index > suggestions.length) {
              throw new IdeaseekError(
                'INVALID_ARGUMENT',
                suggestions.length === 0
                  ? 'no entry suggestions discovered in the worktree; set one explicitly with: ideaseek baseline repair --method <id> --entry "..."'
                  : `--apply must be 1..${suggestions.length}`,
              );
            }
            const picked = suggestions[index - 1]!;
            const updated: ComparisonMethod = {
              ...method,
              entry: picked.argv,
              updatedAt: Date.now(),
            };
            await runtime.db.upsertComparison({
              methodId,
              status: updated.status,
              required: updated.required,
              record: updated as unknown as Record<string, unknown>,
              updatedAt: updated.updatedAt,
            });
            await exportMethodYaml(root, updated);
            if (opts.json) {
              process.stdout.write(jsonLine({ methodId, applied: picked, entryConfigured: true }));
            } else {
              process.stdout.write(`applied entry to ${methodId}: ${picked.argv.join(' ')}\n`);
              process.stdout.write(`  verifies: ${picked.verifies}\n`);
              process.stdout.write(`next: ideaseek comparison smoke ${methodId}\n`);
            }
            return 0;
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                methodId,
                worktree: worktreeDir,
                snapshotHash: understanding.source.snapshotHash,
                currentEntry,
                needsConfirmation: understanding.needsConfirmation,
                suggestions,
              }),
            );
            return 0;
          }
          process.stdout.write(
            `entry suggestions for ${methodId} (worktree analyzed; nothing runs without --apply):\n`,
          );
          if (suggestions.length === 0) {
            process.stdout.write(
              '  (none discovered — set one explicitly: ideaseek baseline repair --method <id> --entry "...")\n',
            );
          }
          suggestions.forEach((suggestion, index) => {
            process.stdout.write(
              `  [${index + 1}] ${suggestion.kind.padEnd(5)} ${suggestion.path}  conf=${suggestion.confidence.toFixed(2)}\n`,
            );
            process.stdout.write(`      → ${suggestion.argv.join(' ')}\n`);
            process.stdout.write(`      verifies: ${suggestion.verifies}\n`);
          });
          process.stdout.write(
            `current entry: ${currentEntry ? currentEntry.join(' ') : '(none — smoke runs the python --version placeholder)'}\n`,
          );
          process.stdout.write(
            `next: ideaseek comparison suggest-entry ${methodId} --apply <n>   (persists; then ideaseek comparison smoke ${methodId})\n`,
          );
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
