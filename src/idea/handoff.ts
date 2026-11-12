import * as os from 'node:os';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { runRepairCommand } from '../comparison/repair.js';
import { evaluateComparisonGate, type ComparisonGateDb } from '../comparison/gate.js';
import type { ExperimentSpec } from '../experiment/spec.js';
import { collectAnalysisInput } from './analyze.js';
import { analyzeIdea, type IdeaAnalysis } from './analysis.js';
import { hashIdeaSource, ideaDir, loadIdeaCard, loadWorkspaceMeta } from './workspace.js';
import { currentExperimentAuditVerdict, readLatestExperimentAudit } from './gates.js';
import { readClaimAudit } from './claim-audit.js';
import { probeCapacity } from '../runtime/capacity.js';

/**
 * Handoff reproduction package (plan §E / DATA_SCALE_POLICY 分级置信度):
 * everything the user needs to run FULL-scale experiments themselves —
 * full-data config, split manifest, environment lock, exact commands,
 * resource advice, provenance, known risks and reproducibility.md.
 * IdeaSeek never runs full training; the HANDOFF_READY gate decides whether
 * the evidence package is strong enough to recommend that investment.
 */

export type HandoffLevel = 'EXPLORATORY' | 'PROMISING' | 'HANDOFF_READY';

export interface HandoffGate {
  level: HandoffLevel;
  handoffReady: boolean;
  blockers: string[];
}

export interface HandoffLevelInput {
  analysisVerdict: IdeaAnalysis['verdict'];
  scalesRun: string[];
  seedsCount: number;
  comparisonGateOk: boolean;
  /** Current experiment-audit verdict (FAIL blocks delivery; WARN alerts). */
  auditVerdict?: 'PASS' | 'WARN' | 'FAIL' | null;
  auditSummary?: string;
  /** Current idea claim/citation audit (FAIL = unciteable card evidence). */
  evidenceAuditVerdict?: 'pass' | 'warn' | 'fail' | null;
}

/**
 * Level ladder (docs/DATA_SCALE_POLICY): rejected/invalid runs never earn a
 * package; supported + multi-seed + multi-scale + comparison gate ⇒
 * HANDOFF_READY; everything else is PROMISING at best.
 */
export function computeHandoffLevel(input: HandoffLevelInput): HandoffGate {
  const blockers: string[] = [];
  if (input.analysisVerdict === 'rejected' || input.analysisVerdict === 'invalid-run') {
    return {
      level: 'EXPLORATORY',
      handoffReady: false,
      blockers: [`analysis verdict is ${input.analysisVerdict} — no handoff package`],
    };
  }
  if (input.analysisVerdict !== 'supported') {
    blockers.push(`analysis verdict is ${input.analysisVerdict} (need supported)`);
  }
  if (input.seedsCount < 2) blockers.push(`seeds ${input.seedsCount} < 2`);
  if (input.scalesRun.length < 2) {
    blockers.push(
      `scales [${input.scalesRun.join(',') || 'none'}] — need smoke AND quick/standard`,
    );
  }
  if (!input.comparisonGateOk) blockers.push('required comparison gate FAILED');
  // ARIS experiment-audit: a FAIL never ships as HANDOFF_READY; WARN stays
  // visible in the package without blocking (audit is advisory-but-honest).
  if (input.auditVerdict === 'FAIL') {
    blockers.push(`experiment-audit FAIL${input.auditSummary ? `: ${input.auditSummary}` : ''}`);
  }
  if (input.evidenceAuditVerdict === 'fail') {
    blockers.push(
      'evidence audit FAIL: card evidence is not locatable in the cited sources ' +
        '(rerun ideaseek idea claim-audit)',
    );
  }

  const handoffReady = blockers.length === 0;
  return {
    level: handoffReady ? 'HANDOFF_READY' : 'PROMISING',
    handoffReady,
    blockers,
  };
}

export interface IdeaHandoffResult {
  gate: HandoffGate;
  dir: string;
  files: string[];
  analysisVerdict: IdeaAnalysis['verdict'];
}

interface HandoffDb extends Omit<ComparisonGateDb, 'listComparisons'> {
  /** Broad filter (all methods) — structurally satisfies the gate's need. */
  listComparisons(filter?: {
    required?: boolean;
  }): Promise<{ methodId: string; status: string; record: Record<string, unknown> }[]>;
  listSlices(): Promise<
    {
      sliceId: string;
      scale: string;
      datasetSnapshotId: string;
      record: Record<string, unknown>;
    }[]
  >;
  getExperiment(specId: string): Promise<{
    specId: string;
    specHash: string;
    spec: Record<string, unknown>;
    result: Record<string, unknown> | null;
  } | null>;
}

/**
 * Builds the full package under ideas/<id>/handoff/. Refuses rejected or
 * invalid-run ideas; records the gate (level + blockers) in handoff.json.
 */
export async function buildIdeaHandoff(
  projectRoot: string,
  ideaId: string,
  db: HandoffDb,
): Promise<IdeaHandoffResult> {
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  const card = await loadIdeaCard(projectRoot, ideaId);
  const workspace = ideaDir(projectRoot, ideaId);
  const { readFile } = await import('node:fs/promises');

  // Gate 1: current passing check report (the package cites this code state).
  interface CheckReportShape {
    outcome?: string;
    version?: number;
    codeHash?: string | null;
  }
  let report: CheckReportShape | null = null;
  try {
    report = JSON.parse(
      await readFile(join(workspace, 'experiments', 'check-report.json'), 'utf8'),
    ) as CheckReportShape;
  } catch {
    report = null;
  }
  const codeHash = await hashIdeaSource(projectRoot, ideaId);
  if (!report || report.outcome !== 'passed') {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `idea ${ideaId} has no passing check report — run: ideaseek idea check ${ideaId}`,
    );
  }
  if (report.version !== meta.currentVersion || report.codeHash !== codeHash) {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `check report is stale — rerun: ideaseek idea check ${ideaId} before handoff`,
    );
  }

  // Gate 2: analysis exists (run it if missing — deterministic and cheap).
  let analysis: IdeaAnalysis;
  try {
    analysis = JSON.parse(
      await readFile(join(workspace, 'experiments', 'analysis.json'), 'utf8'),
    ) as IdeaAnalysis;
    if (analysis.ideaVersion !== meta.currentVersion || analysis.codeHash !== codeHash) {
      const fresh = await analyzeIdea(await collectAnalysisInput(projectRoot, ideaId, db));
      analysis = fresh;
    }
  } catch {
    analysis = analyzeIdea(await collectAnalysisInput(projectRoot, ideaId, db));
  }

  if (analysis.verdict === 'rejected' || analysis.verdict === 'invalid-run') {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `idea ${ideaId} verdict is ${analysis.verdict} — no handoff package until the idea is revised ` +
        `(ideaseek idea set-status ${ideaId} NEEDS_REVISION --reason "...")`,
      { verdict: analysis.verdict },
    );
  }

  // Gate 3: required comparisons.
  const comparisonGate = await evaluateComparisonGate(db);

  // Gate 4: coverage ladder.
  const succeededScales = new Set<string>();
  const { readdir } = await import('node:fs/promises');
  const expDir = join(workspace, 'experiments');
  for (const name of await readdir(expDir).catch(() => [] as string[])) {
    if (!name.endsWith('.json') || name.startsWith('analysis') || name === 'check-report.json') {
      continue;
    }
    try {
      const mirror = JSON.parse(await readFile(join(expDir, name), 'utf8')) as {
        spec?: ExperimentSpec;
        result?: { status?: string };
      };
      if (mirror.spec && mirror.result?.status === 'succeeded') {
        const note = (mirror.spec.environment.notes ?? []).find((n) => n.startsWith('scale:'));
        if (note) succeededScales.add(note.slice('scale:'.length));
      }
    } catch {
      continue;
    }
  }
  const audit = await readLatestExperimentAudit(projectRoot, ideaId);
  const currentAudit = currentExperimentAuditVerdict(audit, {
    ideaId,
    cardVersion: meta.currentVersion,
  });
  const evidenceAudit = await readClaimAudit(projectRoot, ideaId);
  const currentEvidence =
    evidenceAudit && evidenceAudit.cardVersion === meta.currentVersion ? evidenceAudit : null;
  const gate = computeHandoffLevel({
    analysisVerdict: analysis.verdict,
    scalesRun: [...succeededScales].sort(),
    seedsCount: analysis.coverage.seeds,
    comparisonGateOk: comparisonGate.ok,
    auditVerdict: currentAudit.verdict,
    auditSummary: currentAudit.summary,
    evidenceAuditVerdict: currentEvidence?.verdict ?? null,
  });

  // --- assemble the package.
  const dir = join(workspace, 'handoff');
  await ensureDir(dir);
  const files: string[] = [];
  const write = async (name: string, content: string): Promise<void> => {
    await writeFileAtomic(join(dir, name), content);
    files.push(name);
  };

  const mainDoc = await db.getExperiment(`idea-${ideaId}`);
  const mainSpec = (mainDoc?.spec ?? null) as ExperimentSpec | null;
  const inputManifest = await readJsonIfExists<{
    inputs?: { path: string; sha256: string }[];
  }>(join(workspace, 'data', 'manifest.json'));
  const slices = await db.listSlices();
  const comparisons = await collectComparisonProvenance(
    db,
    card.nearestComparisons.map((c) => c.methodId),
  );

  // 1) full-data config (yaml).
  const fullConfig = {
    project: { ideaId, ideaVersion: meta.currentVersion, hypothesis: card.hypothesis.statement },
    scale: 'full',
    data: {
      path: mainSpec?.dataSnapshotId ?? 'synthetic:idea-workspace',
      inputs: inputManifest?.inputs ?? [],
      note: 'full-data run uses the user dataset at its native scale; verify against the protocol',
    },
    seeds: mainSpec?.seeds ?? [42],
    metrics: mainSpec?.metrics ?? [],
    command: (mainSpec?.command ?? ['python', 'src/train.py']).map((part) =>
      String(part).replace(/ --scale \w+$/, ''),
    ),
    resources: mainSpec?.resources ?? {},
    budget: mainSpec?.budget ?? {},
    protocolId: mainSpec?.protocolId ?? null,
    generatedAt: Date.now(),
    generatedBy: 'ideaseek idea handoff',
  };
  await write('full-data-config.yaml', yamlStringify(fullConfig, { lineWidth: 100 }));

  // 2) split manifest.
  const splitManifest = {
    ideaId,
    ideaVersion: meta.currentVersion,
    inputs: inputManifest?.inputs ?? [],
    registeredSlices: slices.map((slice) => ({
      sliceId: slice.sliceId,
      scale: slice.scale,
      outputHash: (slice.record as { outputHash?: unknown }).outputHash ?? null,
      datasetSnapshotId: slice.datasetSnapshotId,
    })),
    fullSplitPolicy:
      'Use the dataset native train/test split exactly as recorded in the protocol; ' +
      'never re-split on a whim — any deviation must be recorded as a new protocol version.',
    seeds: mainSpec?.seeds ?? [42],
    generatedAt: Date.now(),
  };
  await write('full-split-manifest.json', `${JSON.stringify(splitManifest, null, 2)}\n`);

  // 3) environment lock (pip freeze, bounded; fallback to interpreter info).
  const freeze = await runRepairCommand(
    ['python', '-m', 'pip', 'freeze', '--disable-pip-version-check'],
    workspace,
    30_000,
  );
  const lockHeader = [
    `# environment lock — idea ${ideaId} v${meta.currentVersion}`,
    `# generated: ${new Date().toISOString()}`,
    `# interpreter: python (platform ${os.type()} ${os.release()}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 1024 ** 3)} GiB RAM)`,
    freeze.exitCode === 0
      ? '# source: pip freeze (best effort; verify in your own venv)'
      : `# pip freeze unavailable (exit ${freeze.exitCode}) — recreate from config/train.json`,
    '',
  ].join('\n');
  await write(
    'environment.lock.txt',
    lockHeader + (freeze.exitCode === 0 ? `${freeze.out.trim()}\n` : ''),
  );

  // 4) exact commands (user-run; IdeaSeek never executes full training).
  const trainEntry = (mainSpec?.command ?? ['python', 'src/train.py'])
    .filter((part) => part !== '--scale' && part !== 'smoke' && part !== 'quick')
    .join(' ');
  const commands = [
    `# FULL-SCALE commands for idea ${ideaId} — run these YOURSELF (IdeaSeek does not)`,
    `${trainEntry} --scale full    # full-data training`,
    'python src/check_metrics.py     # verify metric implementation',
    'python src/smoke.py             # sanity re-check before the long run',
    '',
  ].join('\n');
  await write('commands.txt', commands);

  // 5) resource advice (live probe + declared requests).
  const probe = await probeCapacity(projectRoot);
  const advice = {
    declaredRequest: mainSpec?.resources ?? {},
    budget: mainSpec?.budget ?? {},
    hostAtGeneration: {
      gpus: probe.gpus.map((g) => ({
        index: g.index,
        freeMiB: g.memFreeMiB,
        totalMiB: g.memTotalMiB,
      })),
      cpuCores: probe.cpuCores,
      freeMemGiB: probe.freeMemGiB,
      diskFreeGiB: probe.diskFreeGiB,
    },
    advice:
      (mainSpec?.resources as { gpus?: number } | null)?.gpus &&
      (mainSpec?.resources as { gpus: number }).gpus > 0
        ? 'GPU run: start with a single GPU and the declared memory request; scale out only after the first full run completes.'
        : 'CPU-only declared request; move to GPU only if the code actually needs it.',
    note: 'capacity snapshot is advisory — re-check with ideaseek capacity before launching.',
  };
  await write('resources.json', `${JSON.stringify(advice, null, 2)}\n`);

  // 6) provenance.
  const provenance = {
    ideaId,
    ideaVersion: meta.currentVersion,
    codeHash,
    checkReportHash: report.codeHash ?? null,
    specId: mainDoc?.specId ?? null,
    specHash: mainDoc?.specHash ?? null,
    protocolId: mainSpec?.protocolId ?? null,
    dataSnapshotId: mainSpec?.dataSnapshotId ?? null,
    comparisons,
    analysis: {
      verdict: analysis.verdict,
      failureClass: analysis.failureClass,
      generatedAt: analysis.generatedAt,
    },
    inputs: inputManifest?.inputs ?? [],
    generatedAt: Date.now(),
  };
  await write('provenance.json', `${JSON.stringify(provenance, null, 2)}\n`);

  // 7) known risks.
  const risks = [
    `# Known risks — idea ${ideaId} v${meta.currentVersion}`,
    '',
    '## Declared risks (IdeaCard)',
    ...card.risks.map((risk) => `- ${risk}`),
    '',
    '## Stated novelty uncertainty (IdeaCard)',
    `- ${card.novelty.uncertainty}`,
    '',
    '## Boundary conditions',
    ...card.boundaryConditions.map((item) => `- ${item}`),
    '',
    '## Failures observed during quick/smoke (kept, never deleted)',
    ...(analysis.failures.length > 0
      ? analysis.failures.map(
          (failure) => `- ${failure.specId}: ${failure.category ?? '?'} → ${failure.class}`,
        )
      : ['- none recorded']),
    '',
    '## Handoff gate blockers',
    ...(gate.blockers.length > 0 ? gate.blockers.map((b) => `- ${b}`) : ['- none']),
    '',
  ].join('\n');
  await write('known-risks.md', risks);

  // 8) reproducibility.md.
  const repro = [
    `# Reproducibility — idea ${ideaId} v${meta.currentVersion}`,
    '',
    `- level: **${gate.level}** (handoffReady: ${gate.handoffReady})`,
    '- ladder: EXPLORATORY < PROMISING < HANDOFF_READY (docs/DATA_SCALE_POLICY)',
    `- code hash: \`${codeHash ?? 'none'}\``,
    `- analysis verdict: ${analysis.verdict} (failure class: ${analysis.failureClass})`,
    `- protocol: ${mainSpec?.protocolId ?? 'none'}`,
    `- dataset snapshot: ${mainSpec?.dataSnapshotId ?? 'none'}`,
    '',
    '## What IdeaSeek ran (and what it did NOT)',
    '',
    '- Ran: quick/standard smoke checks, bounded experiments, ablations — all recorded above.',
    '- Did NOT run: full-scale training. commands.txt is for YOU to execute.',
    '- Original papers/, datasets/ and comparisons/ upstream were never modified.',
    '',
    '## Steps to reproduce at full scale',
    '',
    '1. Create a fresh venv and install from `environment.lock.txt` (or your own pinned set).',
    '2. Point `full-data-config.yaml` at your dataset; verify splits via `full-split-manifest.json`.',
    '3. Run the commands in `commands.txt` with the seeds listed in the config.',
    '4. Compare metrics against the protocol; record deviations — do not silently retune.',
    '5. Cite `provenance.json` (code hash + inputs) in any report of the results.',
    '',
    '## Verification checklist',
    '',
    '- [ ] environment.lock.txt installs cleanly',
    '- [ ] full-split-manifest.json matches the dataset you actually used',
    '- [ ] metrics match the protocol definitions',
    '- [ ] seeds and budgets match full-data-config.yaml',
    '',
  ].join('\n');
  await write('reproducibility.md', repro);

  // 9) gate record.
  await write(
    'handoff.json',
    `${JSON.stringify(
      {
        ideaId,
        ideaVersion: meta.currentVersion,
        level: gate.level,
        handoffReady: gate.handoffReady,
        blockers: gate.blockers,
        analysisVerdict: analysis.verdict,
        comparisonGateOk: comparisonGate.ok,
        files: [...files, 'handoff.json'].sort(),
        generatedAt: Date.now(),
        boundaries: [
          'IdeaSeek did not run full-scale training; commands.txt is user-run',
          'original inputs were read-only; derived slices are regenerable',
        ],
      },
      null,
      2,
    )}\n`,
  );
  files.push('handoff.json');

  return { gate, dir, files, analysisVerdict: analysis.verdict };
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function collectComparisonProvenance(
  db: HandoffDb,
  methodIds: string[],
): Promise<{ methodId: string; status: string; commit: string | null; license: string | null }[]> {
  // listComparisons with required:false returns everything; filter here.
  const all = await db.listComparisons({ required: false });
  const out: { methodId: string; status: string; commit: string | null; license: string | null }[] =
    [];
  for (const id of methodIds) {
    const method = all.find((entry) => entry.methodId === id);
    if (!method) {
      out.push({ methodId: id, status: 'not-registered', commit: null, license: null });
      continue;
    }
    const repo = (method.record.repo ?? {}) as { commit?: string; license?: string | null };
    out.push({
      methodId: id,
      status: method.status,
      commit: repo.commit ?? null,
      license: repo.license ?? null,
    });
  }
  return out;
}
