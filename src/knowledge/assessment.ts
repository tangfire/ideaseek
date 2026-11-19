import { sha256Of, sha256OfFile } from '../core/hash.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import { stableJson } from '../experiment/spec.js';

/**
 * ResearchMaterialAssessment (docs/FULL_RESEARCH_MODE.md 研究材料缺口评估,
 * PROGRESS 106): a deterministic readiness report over PERSISTED artifacts
 * — papers, PaperCards, research map, mechanism graph, dataset card,
 * slices, comparison registry, protocol proposal, ideas and capacity.
 *
 * Every gap carries: priority (blocking/recommended/optional), reason,
 * evidence (the observed counts/paths), confidence, a copyable fill-in
 * command and an honest cost estimate; `blocks` says which stage it
 * prevents (protocolDesign vs smokeQuick). The report answers "是否足以
 * 开始协议设计和 smoke/quick 验证" without asking a model.
 *
 * Incremental reuse: contextHash covers the observed inputs (question +
 * counts + artifact content hashes); an unchanged context returns the
 * stored report instead of rebuilding (MODES.md 三模式协同: same inputs →
 * same artifact, no duplicate versions).
 */

export const ASSESSMENT_SCHEMA = 'research-material-assessment-v1';

export type GapPriority = 'blocking' | 'recommended' | 'optional';
export type AssessmentStage = 'protocolDesign' | 'smokeQuick';

export interface AssessmentGap {
  id: string;
  priority: GapPriority;
  area:
    | 'question'
    | 'papers'
    | 'paper-cards'
    | 'datasets'
    | 'labels'
    | 'slices'
    | 'comparisons'
    | 'protocol'
    | 'research-map'
    | 'ablations'
    | 'resources'
    | 'venue';
  /** Why the next phase needs this. */
  reason: string;
  /** Observed counts/paths this gap is based on. */
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
  /** Copyable command or directory to drop files into. */
  fillIn: string;
  /** Honest bounded cost (no invented numbers). */
  cost: string;
  /** Stages this gap blocks when missing. */
  blocks: AssessmentStage[];
}

export interface AssessmentCovered {
  area: string;
  detail: string;
}

export interface ResearchMaterialAssessment {
  contract: typeof ASSESSMENT_SCHEMA;
  generatedAt: number;
  /** Binds the observed inputs — unchanged context reuses the report. */
  contextHash: string;
  question: string;
  venue: string | null;
  verdict: 'ready' | 'gaps';
  sufficientFor: { protocolDesign: boolean; smokeQuick: boolean };
  stats: {
    papersDirFiles: number;
    parsedPapers: number;
    paperCards: number;
    researchMap: boolean;
    mechanismGraph: boolean;
    datasetCard: boolean;
    datasetLabelCandidates: number;
    slices: number;
    comparisons: number;
    requiredComparisons: number;
    comparisonGateOk: boolean | null;
    protocolProposal: 'none' | 'draft' | 'locked';
    protocolConfirmations: number;
    ideas: number;
    ablationPlans: number;
    venue: string | null;
    gpuCount: number | null;
    diskFreeGiB: number | null;
  };
  gaps: AssessmentGap[];
  covered: AssessmentCovered[];
  boundaries: string[];
}

function gap(partial: AssessmentGap): AssessmentGap {
  return partial;
}

/**
 * Builds the assessment from persisted state (read-only). Never throws
 * for missing pieces — they become gaps with recovery commands. The only
 * throw it adds is the structural gate on its OWN output (assertAgainstSchema
 * at the end): a report this module cannot even describe is a platform bug,
 * not a user gap.
 */
export async function buildResearchMaterialAssessment(
  root: string,
  opts: { question?: string; force?: boolean } = {},
): Promise<ResearchMaterialAssessment> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join, relative, sep } = await import('node:path');
  const { walk } = await import('./scan.js');
  const { loadConfig } = await import('../config/config.js');
  const { projectPaths } = await import('../config/paths.js');
  const config = (await loadConfig(projectPaths(root))).resolved;
  const question = (opts.question ?? config.research.question ?? '').trim();

  const gaps: AssessmentGap[] = [];
  const covered: AssessmentCovered[] = [];

  // ---- papers: files → parsed → PaperCards ----
  const papersDir = join(root, config.inputs.papersDir);
  const paperAbsFiles: string[] = [];
  await walk(papersDir, paperAbsFiles);
  const paperRelFiles = paperAbsFiles.map((abs) => relative(root, abs).split(sep).join('/'));
  const papersDirFiles = paperRelFiles.filter((name) =>
    /\.(pdf|md|txt|tex|bib)$/i.test(name),
  ).length;
  const ingestiblePaperRels = paperRelFiles.filter((name) => /\.(pdf|tex)$/i.test(name));

  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  let contextHashParts: string[] = [];
  try {
    const parsed = await runtime.db.listArtifactsByKind('parsed-paper');
    const cards = await runtime.db.listArtifactsByKind('papercard');
    const maps = await runtime.db.listArtifactsByKind('research-map');
    const proposals = await runtime.db.listArtifactsByKind('protocol-proposal');
    const locks = await runtime.db.listProtocolLocks();
    const comparisons = await runtime.db.listComparisons({});
    const slices = await runtime.db.listSlices();

    let gateOk: boolean | null = null;
    if (comparisons.some((method) => method.required)) {
      const { evaluateComparisonGateForProject } = await import('../comparison/worktree-stamp.js');
      gateOk = (await evaluateComparisonGateForProject(root, runtime.db)).ok;
    }

    // ---- dataset card + labels ----
    let datasetCard = false;
    let datasetLabelCandidates = 0;
    try {
      const card = JSON.parse(
        await readFile(join(root, 'knowledge', 'dataset-card.json'), 'utf8'),
      ) as { profiles?: { labelCandidates?: unknown[] }[] };
      datasetCard = true;
      const first = card.profiles?.[0];
      datasetLabelCandidates = Array.isArray(first?.labelCandidates)
        ? first.labelCandidates.length
        : 0;
    } catch {
      datasetCard = false;
    }

    // ---- ideas + ablation plans ----
    const ideaDirs = (await readdir(join(root, 'ideas'), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    let ablationPlans = 0;
    for (const ideaId of ideaDirs) {
      const exists = await readFile(
        join(root, 'ideas', ideaId, 'experiments', 'ablation-plan.json'),
        'utf8',
      )
        .then(() => true)
        .catch(() => false);
      if (exists) ablationPlans += 1;
    }

    // ---- venue (planning context) ----
    let venue: string | null = null;
    try {
      const manuscript = JSON.parse(
        await readFile(join(root, 'reports', 'paper', 'manuscript.json'), 'utf8'),
      ) as { manuscript?: { venue?: unknown } };
      if (typeof manuscript.manuscript?.venue === 'string') venue = manuscript.manuscript.venue;
    } catch {
      venue = null;
    }

    // ---- capacity (resources) ----
    const { probeCapacity } = await import('../runtime/capacity.js');
    const probe = await probeCapacity(root).catch(() => null);

    // ---- protocol state ----
    const protocolProposal = locks.length > 0 ? 'locked' : proposals.length > 0 ? 'draft' : 'none';
    const latestProposal = proposals[proposals.length - 1];
    let protocolConfirmations: string[] = [];
    if (latestProposal && protocolProposal !== 'locked') {
      try {
        const payload = JSON.parse(
          await runtime.store.readFinalText(latestProposal.contentHash),
        ) as { confirmations?: unknown };
        protocolConfirmations = Array.isArray(payload.confirmations)
          ? payload.confirmations.filter((c): c is string => typeof c === 'string')
          : [];
      } catch {
        protocolConfirmations = [];
      }
    }

    // ---- stats ----
    const stats: ResearchMaterialAssessment['stats'] = {
      papersDirFiles,
      parsedPapers: parsed.length,
      paperCards: cards.length,
      researchMap: maps.length > 0,
      mechanismGraph: await readFile(join(root, 'knowledge', 'mechanism-graph.json'))
        .then(() => true)
        .catch(() => false),
      datasetCard,
      datasetLabelCandidates,
      slices: slices.length,
      comparisons: comparisons.length,
      requiredComparisons: comparisons.filter((method) => method.required).length,
      comparisonGateOk: gateOk,
      protocolProposal,
      protocolConfirmations: protocolConfirmations.length,
      ideas: ideaDirs.length,
      ablationPlans,
      venue,
      gpuCount: probe ? probe.gpus.length : null,
      diskFreeGiB: probe?.diskFreeGiB ?? null,
    };

    // ---- gaps: question ----
    if (!question && ideaDirs.length === 0) {
      // fillIn must ADVANCE the state: plan --question is a documented
      // dry-run ("not persisted"), so advising it left the blocker exactly
      // where it was (Journey A walkthrough looped on it).
      gaps.push(
        gap({
          id: 'question-missing',
          priority: 'blocking',
          area: 'question',
          reason: 'protocol design starts from a research question; none is configured',
          evidence: ['research.question is empty', `ideas: ${ideaDirs.length}`],
          confidence: 'high',
          fillIn: 'ideaseek setup --question "your research question"',
          cost: 'instant (config only)',
          blocks: ['protocolDesign', 'smokeQuick'],
        }),
      );
    } else if (question) {
      covered.push({ area: 'question', detail: question.slice(0, 160) });
    }

    // ---- gaps: papers pipeline ----
    if (papersDirFiles === 0 && parsed.length === 0 && cards.length === 0) {
      gaps.push(
        gap({
          id: 'no-papers',
          priority: 'blocking',
          area: 'papers',
          reason: 'protocol design needs at least one paper as evidence',
          evidence: [
            `${config.inputs.papersDir}: ${papersDirFiles} document(s)`,
            'parsed: 0',
            'PaperCards: 0',
          ],
          confidence: 'high',
          fillIn: 'drop PDFs into papers/ then: ideaseek scan && ideaseek ingest',
          cost: 'minutes per paper (local parse, no GPU)',
          blocks: ['protocolDesign', 'smokeQuick'],
        }),
      );
    } else if (parsed.length === 0) {
      gaps.push(
        gap({
          id: 'papers-not-parsed',
          priority: 'blocking',
          area: 'papers',
          reason: 'documents exist but none are parsed — no evidence to ground a protocol',
          evidence: [`${config.inputs.papersDir}: ${papersDirFiles} document(s)`, 'parsed: 0'],
          confidence: 'high',
          fillIn: 'ideaseek ingest',
          cost: 'minutes per paper (local parse, no GPU)',
          blocks: ['protocolDesign', 'smokeQuick'],
        }),
      );
    } else if (cards.length === 0) {
      gaps.push(
        gap({
          id: 'no-papercards',
          priority: 'blocking',
          area: 'paper-cards',
          reason: 'parsed papers are not yet structured into PaperCards (claims/evidence)',
          evidence: [`parsed: ${parsed.length}`, 'PaperCards: 0'],
          confidence: 'high',
          fillIn: 'ideaseek extract',
          cost: 'one model call per paper (bounded, uses configured route)',
          blocks: ['protocolDesign', 'smokeQuick'],
        }),
      );
    } else {
      covered.push({
        area: 'papers',
        detail: `${cards.length} PaperCard(s) from ${parsed.length} parsed paper(s)`,
      });
      // Detect newly added papers in papers/ or newly parsed papers lacking PaperCards
      // so Analysis does not call the corpus complete after new materials drop in.
      let unparsedCount = 0;
      if (ingestiblePaperRels.length > 0) {
        const parsedSources = new Set<string>();
        const parsedSourceHashes = new Set<string>();
        for (const artifact of parsed) {
          try {
            const payload = JSON.parse(await runtime.store.readFinalText(artifact.contentHash)) as {
              source?: unknown;
              sourceHash?: unknown;
            };
            if (typeof payload.source === 'string') parsedSources.add(payload.source);
            if (typeof payload.sourceHash === 'string') parsedSourceHashes.add(payload.sourceHash);
          } catch {
            continue;
          }
        }
        const manifestHashes = new Map<string, string>();
        try {
          const manifestRaw = JSON.parse(
            await readFile(join(root, 'knowledge', 'input-manifest.json'), 'utf8'),
          ) as { files?: { relPath?: unknown; sha256?: unknown }[] };
          for (const entry of manifestRaw.files ?? []) {
            if (typeof entry.relPath === 'string' && typeof entry.sha256 === 'string') {
              manifestHashes.set(entry.relPath, entry.sha256);
            }
          }
        } catch {
          // no manifest yet — fall back to path matching
        }
        for (const rel of ingestiblePaperRels) {
          const hash = manifestHashes.get(rel);
          if (parsedSources.has(rel)) continue;
          if (hash && parsedSourceHashes.has(hash)) continue;
          unparsedCount += 1;
        }
      }
      if (unparsedCount > 0) {
        gaps.push(
          gap({
            id: 'papers-unparsed-new',
            priority: 'recommended',
            area: 'papers',
            reason: `${unparsedCount} paper(s) in ${config.inputs.papersDir} are not yet parsed into the index`,
            evidence: [
              `ingestible files: ${ingestiblePaperRels.length}`,
              `parsed: ${parsed.length}`,
              `unparsed: ${unparsedCount}`,
            ],
            confidence: 'high',
            fillIn: 'ideaseek ingest',
            cost: 'minutes per paper (local parse, no GPU)',
            blocks: [],
          }),
        );
      }
      if (parsed.length > cards.length) {
        const unextracted = parsed.length - cards.length;
        gaps.push(
          gap({
            id: 'papers-unextracted-new',
            priority: 'recommended',
            area: 'paper-cards',
            reason: `${unextracted} parsed paper(s) do not yet have structured PaperCards`,
            evidence: [`parsed: ${parsed.length}`, `PaperCards: ${cards.length}`],
            confidence: 'high',
            fillIn: 'ideaseek extract',
            cost: 'one model call per paper (bounded, uses configured route)',
            blocks: [],
          }),
        );
      }
    }

    // ---- gaps: data ----
    if (!datasetCard && slices.length === 0 && papersDirFiles >= 0) {
      const datasetsPopulated = await readdir(join(root, config.inputs.datasetsDir))
        .then((names) => names.length > 0)
        .catch(() => false);
      if (!datasetsPopulated) {
        gaps.push(
          gap({
            id: 'no-dataset',
            priority: 'blocking',
            area: 'datasets',
            reason: 'no dataset registered or profiled — split/labels/metrics cannot be grounded',
            evidence: [
              `${config.inputs.datasetsDir}: empty`,
              'knowledge/dataset-card.json: missing',
              `slices: ${slices.length}`,
            ],
            confidence: 'high',
            fillIn:
              'ideaseek datasets discover → datasets authorize <id> --grant → datasets acquire <id> ' +
              '→ datasets link <id> --path <file>; or put data into datasets/ yourself then ' +
              'ideaseek scan && ideaseek data describe',
            cost: 'minutes (local profiling, no GPU)',
            blocks: ['protocolDesign', 'smokeQuick'],
          }),
        );
      } else if (!datasetCard) {
        gaps.push(
          gap({
            id: 'dataset-not-profiled',
            priority: 'blocking',
            area: 'datasets',
            reason: 'dataset files exist but were not profiled (fields/labels/splits unknown)',
            evidence: [
              `${config.inputs.datasetsDir}: populated`,
              'knowledge/dataset-card.json: missing',
            ],
            confidence: 'high',
            fillIn: 'ideaseek data describe',
            cost: 'minutes (local profiling, no GPU)',
            blocks: ['protocolDesign', 'smokeQuick'],
          }),
        );
      }
    }
    if (datasetCard && datasetLabelCandidates === 0) {
      gaps.push(
        gap({
          id: 'no-label-candidates',
          priority: 'recommended',
          area: 'labels',
          reason:
            'dataset profile found no label candidates — label semantics need user confirmation',
          evidence: ['knowledge/dataset-card.json present', 'labelCandidates: 0'],
          confidence: 'high',
          fillIn:
            'ideaseek data describe --force (re-profile) or confirm labels in the protocol flow',
          cost: 'minutes (local)',
          blocks: [],
        }),
      );
    }
    if (datasetCard && slices.length === 0) {
      gaps.push(
        gap({
          id: 'no-slices',
          priority: 'blocking',
          area: 'slices',
          reason: 'no dataset slices yet — smoke/quick runs have nothing bounded to execute on',
          evidence: ['dataset card present', `slices: ${slices.length}`],
          confidence: 'high',
          fillIn: 'ideaseek data slices',
          cost: 'seconds (deterministic slicing)',
          blocks: ['smokeQuick'],
        }),
      );
    }
    if (datasetCard && slices.length > 0) {
      covered.push({ area: 'data', detail: `dataset card + ${slices.length} slice(s)` });
    }

    // ---- gaps: comparisons ----
    if (comparisons.length === 0) {
      gaps.push(
        gap({
          id: 'no-comparisons',
          priority: 'recommended',
          area: 'comparisons',
          reason:
            'no comparison methods registered — the idea-stage gate will block until some exist',
          evidence: ['comparison registry: 0 methods'],
          confidence: 'high',
          fillIn:
            'ideaseek comparison register <id> --repo <url>   (or ideaseek comparison import)',
          cost: 'minutes per method (clone + license check)',
          blocks: [],
        }),
      );
    } else {
      covered.push({
        area: 'comparisons',
        detail:
          `${comparisons.length} method(s), ${stats.requiredComparisons} required, ` +
          `gate ${gateOk === null ? 'n/a (no required)' : gateOk ? 'PASS' : 'FAIL'}`,
      });
    }

    // ---- gaps: protocol draft confirmations ----
    for (const [index, note] of protocolConfirmations.entries()) {
      gaps.push(
        gap({
          id: `protocol-confirmation-${index + 1}`,
          priority: 'recommended',
          area: 'protocol',
          reason: 'draft protocol has low-confidence items awaiting user confirmation',
          evidence: [note],
          confidence: 'high',
          fillIn: 'ideaseek confirm protocol   (review the confirmations list first)',
          cost: 'one review pass (no GPU)',
          blocks: [],
        }),
      );
    }

    // ---- gaps: research map / mechanisms (idea quality) ----
    if (!stats.researchMap) {
      gaps.push(
        gap({
          id: 'no-research-map',
          priority: 'recommended',
          area: 'research-map',
          reason: 'no research map — idea novelty/related-work checks lose their landscape context',
          evidence: ['research-map artifact: absent'],
          confidence: 'high',
          fillIn: 'ideaseek synthesize   (topic synthesis + research map)',
          cost: 'a few model calls (bounded)',
          blocks: [],
        }),
      );
    } else {
      covered.push({ area: 'research-map', detail: 'present' });
    }

    // ---- gaps: ablations (research-time) ----
    if (ideaDirs.length > 0 && ablationPlans < ideaDirs.length) {
      gaps.push(
        gap({
          id: 'ablation-plans-incomplete',
          priority: 'optional',
          area: 'ablations',
          reason: 'not every idea has an ablation plan yet (needed before mechanism claims)',
          evidence: [`${ablationPlans}/${ideaDirs.length} idea(s) with ablation-plan.json`],
          confidence: 'high',
          fillIn: 'ideaseek idea ablation-plan <ideaId>',
          cost: 'one model call per idea',
          blocks: [],
        }),
      );
    }

    // ---- gaps: resources ----
    if (!probe) {
      gaps.push(
        gap({
          id: 'capacity-unknown',
          priority: 'recommended',
          area: 'resources',
          reason: 'capacity probe failed — resource admission cannot be pre-checked',
          evidence: ['probeCapacity: unavailable'],
          confidence: 'medium',
          fillIn: 'ideaseek doctor',
          cost: 'instant',
          blocks: ['smokeQuick'],
        }),
      );
    } else if (probe.diskFreeGiB !== null && probe.diskFreeGiB < 5) {
      gaps.push(
        gap({
          id: 'disk-floor',
          priority: 'blocking',
          area: 'resources',
          reason: 'free disk below the 5 GiB admission floor — new experiment admission is paused',
          evidence: [`disk free: ${probe.diskFreeGiB} GiB`, 'floor: 5 GiB'],
          confidence: 'high',
          fillIn: 'free disk space (or ideaseek cleanup)',
          cost: 'instant',
          blocks: ['smokeQuick'],
        }),
      );
    } else {
      covered.push({
        area: 'resources',
        detail: `${probe.gpus.length} GPU(s), ${probe.freeMemGiB} GiB mem, ${probe.diskFreeGiB ?? '?'} GiB disk`,
      });
    }

    // ---- gaps: venue (optional planning context) ----
    if (!venue) {
      gaps.push(
        gap({
          id: 'no-venue',
          priority: 'optional',
          area: 'venue',
          reason: 'no target venue recorded — figure/length constraints stay unconstrained',
          evidence: ['reports/paper/manuscript.json: absent or venue-less'],
          confidence: 'high',
          fillIn: 'ideaseek paper plan   (records the venue as planning context)',
          cost: 'one model call',
          blocks: [],
        }),
      );
    } else {
      covered.push({ area: 'venue', detail: venue });
    }

    if (stats.protocolProposal === 'locked') {
      covered.push({ area: 'protocol', detail: 'locked' });
    } else if (stats.protocolProposal === 'draft') {
      covered.push({ area: 'protocol', detail: 'draft proposal awaiting confirm' });
    }
    if (stats.ideas > 0)
      covered.push({ area: 'ideas', detail: `${stats.ideas} idea workspace(s)` });

    // ---- verdict + sufficiency ----
    const blockingProtocol = gaps.filter(
      (g) => g.priority === 'blocking' && g.blocks.includes('protocolDesign'),
    );
    const blockingSmoke = gaps.filter(
      (g) => g.priority === 'blocking' && g.blocks.includes('smokeQuick'),
    );
    const sufficientFor = {
      protocolDesign: blockingProtocol.length === 0,
      smokeQuick: blockingSmoke.length === 0,
    };
    const verdict = blockingProtocol.length === 0 && blockingSmoke.length === 0 ? 'ready' : 'gaps';

    // ---- contextHash for incremental reuse ----
    const fileHashOrAbsent = async (filePath: string): Promise<string> =>
      sha256OfFile(filePath).catch(() => 'absent');
    const knowledgeFileHashes = await Promise.all([
      fileHashOrAbsent(join(root, 'knowledge', 'dataset-card.json')),
      fileHashOrAbsent(join(root, 'knowledge', 'research-map.md')),
      fileHashOrAbsent(join(root, 'knowledge', 'mechanism-graph.json')),
      fileHashOrAbsent(join(root, 'knowledge', 'input-manifest.json')),
    ]);
    // Bucket volatile free-disk telemetry to the 5 GiB floor predicate so
    // background OS disk activity does not falsely bust the reuse cache.
    const stableStats = {
      ...stats,
      diskFreeGiB:
        stats.diskFreeGiB === null ? null : stats.diskFreeGiB >= 5 ? 'above-floor' : 'below-floor',
    };
    contextHashParts = [
      question,
      JSON.stringify(stableStats),
      ...knowledgeFileHashes,
      ...cards.map((card) => card.contentHash).sort(),
      ...parsed.map((paper) => paper.contentHash).sort(),
      ...proposals.map((proposal) => proposal.contentHash).sort(),
      ...comparisons
        .map((method) => `${method.methodId}:${method.status}:${method.required}`)
        .sort(),
      ...locks.map((lock) => lock.protocolHash),
    ];
    const contextHash = sha256Of(
      stableJson({ schema: ASSESSMENT_SCHEMA, parts: contextHashParts }),
    );

    const assessment: ResearchMaterialAssessment = {
      contract: ASSESSMENT_SCHEMA,
      generatedAt: Date.now(),
      contextHash,
      question,
      venue,
      verdict,
      sufficientFor,
      stats,
      gaps,
      covered,
      boundaries: [
        'Deterministic over persisted artifacts only — no model output, no invented citations or prices.',
        'recommended gaps may be skipped (lower confidence later); blocking gaps stop the stages in `blocks`.',
        'Re-run after adding materials: only changed inputs rebuild (contextHash reuse).',
      ],
    };
    // Structural gate (JSON Schema authority) on the FRESH report. Every
    // consumer gets the object straight from here — `ask`, `next`, `prepare`,
    // the Analysis→Research mode gate, and both persistence sites
    // (loadOrBuildAssessment below and `ideaseek assessment --force`) — so
    // checking at the producer validates it before either file is written.
    // Abort rather than degrade: a report that lost `stats.protocolProposal`
    // or a gap without `blocks` would make those callers print `undefined`
    // and let the mode gate decide on a field it never read. This literal is
    // built by this module alone (no model in the loop), so a violation is a
    // platform bug, not missing user material: an empty gaps list, a `gaps`
    // verdict, a null venue or zero counts all stay schema-valid. The STORED
    // report is deliberately NOT gated — a foreign or older file falls
    // through to a rebuild (reuse rule in loadOrBuildAssessment), which is
    // the degradation callers rely on.
    assertAgainstSchema(ASSESSMENT_SCHEMA, assessment);
    return assessment;
  } finally {
    await runtime.close();
  }
}

/** Reuse rule (MODES.md 三模式协同): unchanged context → stored report. */
export async function loadOrBuildAssessment(
  root: string,
  opts: { question?: string } = {},
): Promise<{ assessment: ResearchMaterialAssessment; reused: boolean; path: string }> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const path = join(root, 'knowledge', 'research-material-assessment.json');
  const fresh = await buildResearchMaterialAssessment(root, opts);
  try {
    const stored = JSON.parse(await readFile(path, 'utf8')) as ResearchMaterialAssessment;
    if (stored.contract === ASSESSMENT_SCHEMA && stored.contextHash === fresh.contextHash) {
      return { assessment: stored, reused: true, path };
    }
  } catch {
    // no stored report — fall through to fresh
  }
  const { writeFileAtomic, ensureDir } = await import('../core/atomic.js');
  await ensureDir(join(root, 'knowledge'));
  await writeFileAtomic(path, `${JSON.stringify(fresh, null, 2)}\n`);
  return { assessment: fresh, reused: false, path };
}
