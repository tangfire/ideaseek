import { IdeaseekError } from '../core/errors.js';
import {
  HarnessBlockError,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessHealth,
  type HarnessTaskRequest,
  type HarnessTaskResult,
} from './adapter.js';
import { firstTextInput, textInputAt } from './adapter.js';

export interface FakeHarnessOptions {
  /** Tool-call summaries to report on successful results (audit tests). */
  toolCalls?: { tool: string; summary: string; ok: boolean }[];
  /** Fail the first N calls of a task with a normal error. */
  failTimes?: number;
  /** Block the first N calls with an external condition. */
  blockTimes?: number;
  block?: 'QUOTA_EXHAUSTED' | 'AUTH_REQUIRED' | 'NETWORK_BLOCKED';
  latencyMs?: number;
}

/**
 * Deterministic in-memory harness used by tests and Phase 0-style runs that
 * must exercise the workflow without any model or network. It honors the same
 * contract as the DSH adapter: idempotency keys, typed block errors and
 * secret-free event summaries.
 */

/**
 * Builds a validator-compliant PaperCard from the request inputs: everything
 * unknown stays "unknown", and the single claim quotes a real line of the
 * provided text so the deterministic Evidence Checker can verify it. The
 * platform stamps document_hash/paper_id in the extract handler.
 */
/**
 * Schema-aware deterministic outputs so workflow e2e (including synthesis)
 * runs end to end against the fake harness without a model.
 */
/** Test hook: IDEASEEK_FAKE_USAGE='{"inputTokens":1000,"outputTokens":200}'. */
function readFakeUsage(): { inputTokens: number; outputTokens: number; cost?: number } {
  const raw = process.env.IDEASEEK_FAKE_USAGE;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        inputTokens?: unknown;
        outputTokens?: unknown;
        cost?: unknown;
      };
      return {
        inputTokens: typeof parsed.inputTokens === 'number' ? parsed.inputTokens : 0,
        outputTokens: typeof parsed.outputTokens === 'number' ? parsed.outputTokens : 0,
        ...(typeof parsed.cost === 'number' ? { cost: parsed.cost } : {}),
      };
    } catch {
      // fall through to zeros — a bad hook value never invents spend
    }
  }
  return { inputTokens: 0, outputTokens: 0, cost: 0 };
}

/** Test hook + opts: tool calls the fake agent "makes" (emitted as live tool_call events). */
function readFakeToolCalls(
  optsToolCalls?: { tool: string; summary: string; ok: boolean }[],
): { tool: string; summary: string; ok: boolean }[] {
  const fromOpts = optsToolCalls ?? [];
  const raw = process.env.IDEASEEK_FAKE_TOOL_CALLS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return [
          ...fromOpts,
          ...parsed
            .filter(
              (item): item is { tool: string; summary: string; ok: boolean } =>
                !!item &&
                typeof item === 'object' &&
                typeof (item as { tool?: unknown }).tool === 'string',
            )
            .map((item) => ({
              tool: item.tool,
              summary: typeof item.summary === 'string' ? item.summary : '',
              ok: item.ok !== false,
            })),
        ];
      }
    } catch {
      // bad hook value → fall through to opts only (never invent calls)
    }
  }
  return fromOpts;
}

function readJsonContext(request: HarnessTaskRequest): Record<string, unknown> {
  const texts = request.inputs.filter((input) => input.kind === 'text');
  for (const input of [...texts].reverse()) {
    try {
      const value = JSON.parse(input.content) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Text/TSV inputs are normal; keep looking for a structured context.
    }
  }
  return {};
}

function buildFakeOutput(request: HarnessTaskRequest, call: number): string {
  if (request.outputSchema === 'topic-synthesis-v1') {
    return JSON.stringify({
      topic: 'fake topic synthesis',
      papers: [{ paperId: 'pending', title: 'unknown' }],
      methodLineage: ['fake lineage from verified cards'],
      keyFindings: [{ text: 'fake finding', source: 'fake.pdf', page: null, quote: null }],
      conflicts: [],
      mechanisms: [
        { name: 'fake-mechanism', principle: 'synthetic principle', conditions: 'unit tests' },
      ],
      openQuestions: ['none'],
    });
  }
  if (request.outputSchema === 'research-map-v1') {
    return JSON.stringify({
      landscape: 'fake research landscape produced by the fake harness',
      lineages: [{ name: 'fake-lineage', summary: 'synthetic summary' }],
      conflicts: [],
      gaps: ['none recorded'],
      citations: [{ source: 'fake.pdf', title: 'Fake Paper' }],
    });
  }
  if (request.outputSchema === 'protocol-proposal-v1') {
    const sourced = { source: 'agent-inference', confidence: 0.6 };
    return JSON.stringify({
      taskDefinition: { value: 'classify the research task from corpus', ...sourced },
      sampleUnit: { value: 'one sample row', ...sourced },
      labelSemantics: { value: 'unconfirmed semantics', source: 'user', confidence: 0.6 },
      splitRules: { value: ['70/15/15 split'], ...sourced },
      leakageChecks: ['no test-set feedback during iteration'],
      preprocessing: ['fit transforms on train only'],
      baselineEntries: [
        { methodId: 'baseline', entry: 'run baseline', source: 'code', confidence: 0.8 },
      ],
      primaryMetrics: [
        { name: 'accuracy', direction: 'higher', source: 'paper-evidence', confidence: 0.8 },
      ],
      secondaryMetrics: [],
      statisticalSummary: ['mean over 3 seeds'],
      smokeTest: { value: 'small slice run', ...sourced },
      resourceEstimate: { value: 'cpu-only estimate', ...sourced },
      ablations: ['w/o core component'],
      supportCriteria: ['primary metric beats baseline'],
      refuteCriteria: ['no gain across seeds'],
      invalidRunCriteria: ['metrics produced NaN'],
      stopConditions: ['budget exhausted'],
    });
  }
  if (request.outputSchema === 'supervisor-intent-v1') {
    // Test hook: raw override exercises greeting/sanitize/refusal paths.
    const override = process.env.IDEASEEK_FAKE_SUPERVISOR_OUTPUT;
    if (override != null) return override;
    // Deterministic supervisor stand-in: unclassified text becomes a pending
    // action (never an execution), so tests can assert the audit path.
    return JSON.stringify({
      kind: 'pending-action',
      answer: '',
      cliArgs: null,
      reason: 'fake-supervisor',
      summary: `supervisor classified: ${firstTextInput(request).slice(0, 120)}`,
    });
  }
  if (request.outputSchema === 'failure-classification-v1') {
    // Deterministic echo of the mechanical prior: e2e exercises the full
    // agent path (call → schema validation → accept) while producing the
    // same classification the keyword table computed.
    const context = readJsonContext(request) as { prior?: unknown };
    if (context.prior && typeof context.prior === 'object' && !Array.isArray(context.prior)) {
      return JSON.stringify(context.prior);
    }
    return JSON.stringify({ kind: 'unknown', summary: 'fake harness cannot read logs' });
  }
  if (request.outputSchema === 'run-strategy-v1') {
    // Echo the threshold prior: e2e exercises the full agent path while
    // producing exactly the tier the scale rule computed.
    const context = readJsonContext(request) as { prior?: unknown };
    const prior = typeof context.prior === 'string' ? context.prior : 'starter';
    return JSON.stringify({ strategy: prior });
  }
  if (request.outputSchema === 'next-advice-v1') {
    // Echo the ladder's current pick: e2e exercises build → validation →
    // persist → load while producing exactly the command the rules chose.
    const context = readJsonContext(request) as {
      current?: { command?: unknown; suggestion?: unknown };
    };
    const command = typeof context.current?.command === 'string' ? context.current.command : '';
    const suggestion =
      typeof context.current?.suggestion === 'string' ? context.current.suggestion : '';
    return JSON.stringify({
      command,
      suggestion,
      rationale: 'fake harness echo of the mechanical advice (synthetic)',
    });
  }
  if (request.outputSchema === 'idea-candidates-v1') {
    // Test hook: raw override exercises parse/validation failure paths.
    const override = process.env.IDEASEEK_FAKE_IDEA_OUTPUT;
    if (override != null) return override;
    return JSON.stringify({ candidates: [buildFakeIdeaCard()] });
  }
  if (request.outputSchema === 'dataset-candidates-v1') {
    const override = process.env.IDEASEEK_FAKE_DATASET_OUTPUT;
    if (override != null) return override;
    const context = readJsonContext(request) as {
      evidence?: { evidenceId?: string; name?: string; paperKey?: string | null }[];
    };
    const evidence = Array.isArray(context.evidence) ? context.evidence : [];
    return JSON.stringify({
      candidates: evidence.slice(0, 5).map((item) => ({
        name: item.name ?? 'unknown',
        task: 'fake-enriched task (deterministic provider)',
        unit: 'unknown',
        scale: null,
        license: { value: 'unknown', confidence: 0, note: 'not stated in the provided sources' },
        acquisition: 'unknown',
        restricted: false,
        size: 'unknown',
        url: null,
        indexId: null,
        instructions: 'unknown — deterministic provider does not infer access terms',
        relatedPapers: item.paperKey ? [item.paperKey] : [],
        evidenceIds: [item.evidenceId ?? 'ev-missing'],
        relevanceReason: 'grounded in the provided evidence for the research question',
        confidence: 0.6,
        confidenceBasis: ['deterministic provider enrichment grounded in one evidence record'],
        notes: ['fake harness'],
      })),
      notes: ['fake harness deterministic enrichment'],
    });
  }
  if (request.outputSchema === 'experiment-audit-v1') {
    const override = process.env.IDEASEEK_FAKE_AUDIT_OUTPUT;
    if (override != null) return override;
    const context = readJsonContext(request) as { ideaId?: string; cardVersion?: number };
    return JSON.stringify({
      ideaId: context.ideaId ?? 'unknown',
      cardVersion: context.cardVersion ?? 1,
      overallVerdict: 'PASS',
      overall: 'PASS',
      evalType: 'real_gt',
      checks: [
        {
          id: 'gt_provenance',
          status: 'PASS',
          details: 'metrics use recorded ground truth',
          evidence: 'experiment.result.metrics',
        },
        {
          id: 'score_normalization',
          status: 'PASS',
          details: 'raw scores are not self-normalized',
          evidence: 'plan.primaryMetric',
        },
        {
          id: 'result_existence',
          status: 'PASS',
          details: 'result metrics exist in the bundle',
          evidence: 'experiment.result.metrics',
        },
        {
          id: 'dead_code',
          status: 'PASS',
          details: 'configured metrics are exercised',
          evidence: 'experiment.spec.metrics',
        },
        {
          id: 'scope',
          status: 'PASS',
          details: 'quick-scale scope is stated honestly',
          evidence: 'experiment.spec.scale',
        },
      ],
      claims: [],
      summary: 'results are internally consistent with the recorded plan',
    });
  }
  if (request.outputSchema === 'integrity-forensics-v1') {
    const override = process.env.IDEASEEK_FAKE_FORENSICS_OUTPUT;
    if (override != null) return override;
    const context = readJsonContext(request) as { ideaId?: string; cardVersion?: number };
    return JSON.stringify({
      ideaId: context.ideaId ?? 'unknown',
      cardVersion: context.cardVersion ?? 1,
      findings: [],
      summary: 'fake forensics pass: no additional findings beyond the deterministic ledger',
    });
  }
  if (request.outputSchema === 'idea-review-v1') {
    const override = process.env.IDEASEEK_FAKE_REVIEW_OUTPUT;
    if (override != null) return override;
    const context = readJsonContext(request) as {
      ideaId?: string;
      cardVersion?: number;
      round?: number;
    };
    return JSON.stringify({
      ideaId: context.ideaId ?? 'unknown',
      cardVersion: context.cardVersion ?? 1,
      round: context.round ?? 1,
      score: 7,
      verdict: 'ready',
      summary: 'fake idea review: artifacts are consistent with the plan primary metric',
      weaknesses: [
        {
          severity: 'minor',
          detail: 'single seed — widen before claiming',
          minimumFix: 'run at least one additional seed',
        },
      ],
      questions: [],
    });
  }
  if (request.outputSchema === 'novelty-check-v1') {
    const override = process.env.IDEASEEK_FAKE_NOVELTY_OUTPUT;
    if (override != null) return override;
    const context = JSON.parse(textInputAt(request, 0) ?? '{}') as {
      ideaId?: string;
      cardVersion?: number;
      candidateRefs?: string[];
    };
    const refs = Array.isArray(context.candidateRefs) ? context.candidateRefs : [];
    const first = refs[0] ?? null;
    return JSON.stringify({
      ideaId: context.ideaId ?? 'unknown',
      cardVersion: context.cardVersion ?? 1,
      verdict: refs.length > 0 ? 'PROCEED_WITH_CAUTION' : 'PROCEED',
      score: refs.length > 0 ? 7 : 8,
      positioning: 'frame as a measurable reweighting improvement over the closest local candidate',
      claims: [
        {
          claim: 'calibration-error reweighting beats sample-count weighting',
          closestPaperRef: first,
          overlap: 'both reweight client contributions',
          delta: 'uses measured calibration error instead of sample counts',
        },
      ],
      patents: [],
      priorArtDegraded: true,
      notes: ['local index only: no web tools available for patent search'],
    });
  }
  if (request.outputSchema === 'ablation-plan-v1') {
    const override = process.env.IDEASEEK_FAKE_ABLATION_PLAN_OUTPUT;
    if (override != null) return override;
    const context = JSON.parse(textInputAt(request, 0) ?? '{}') as {
      ideaId?: string;
      cardVersion?: number;
    };
    const card = JSON.parse(textInputAt(request, 1) ?? '{}') as {
      componentNecessity?: { component?: string; role?: string }[];
      minimalExperiment?: { ablations?: string[] };
    };
    const entries: Record<string, unknown>[] = [];
    for (const component of card.componentNecessity ?? []) {
      if (component.role !== 'necessary-mechanism' || !component.component) continue;
      entries.push({
        name: `w/o ${component.component}`,
        kind: 'component',
        target: component.component,
        whatItTests: `whether ${component.component} carries the mechanism`,
        expectedOutcome: `removing ${component.component} degrades the primary metric`,
        // Deliberately AFTER the card ablation so tests can prove the plan
        // reorders the derived matrix (derive order puts components first).
        priority: 3,
      });
    }
    for (const [index, label] of (card.minimalExperiment?.ablations ?? []).entries()) {
      entries.push({
        name: label,
        kind: 'card-ablation',
        target: label,
        whatItTests: `the declared ablation "${label}"`,
        expectedOutcome: `removing ${label} removes the gain`,
        priority: index + 1,
      });
    }
    entries.push({
      name: 'learning-rate sensitivity',
      kind: 'hyperparameter',
      target: null,
      whatItTests: 'whether the gain survives lr variation',
      expectedOutcome: 'gain persists across lr ∈ {0.5x, 2x}',
      priority: 4,
    });
    return JSON.stringify({
      ideaId: context.ideaId ?? 'unknown',
      cardVersion: context.cardVersion ?? 1,
      entries,
      coverageAssessment:
        'component ablations discriminate the mechanism chain; hyperparameter entry guards robustness',
      unnecessary: [],
      suggestedOrder: entries.map((entry) => String(entry.name)),
      estimatedGpuMinutes: 10,
    });
  }
  if (request.outputSchema === 'experiment-plan-v1') {
    // Test hook: raw override exercises plan parse/validation failure paths.
    const override = process.env.IDEASEEK_FAKE_PLAN_OUTPUT;
    if (override != null) return override;
    return JSON.stringify(buildFakeExperimentPlan(request));
  }
  if (request.outputSchema === 'papercard-v1') {
    // Test hook: raw override exercises the papercard schema gate.
    const override = process.env.IDEASEEK_FAKE_PAPERCARD_OUTPUT;
    if (override != null) return override;
  }
  if (request.outputSchema === 'paper-figure-v1') {
    // Test hook: raw override exercises parse/validation failure paths.
    const override = process.env.IDEASEEK_FAKE_PAPER_FIGURE_OUTPUT;
    if (override != null) return override;
    const context = firstTextInput(request);
    const idLine =
      context
        .split('\n')
        .find((line) => line.startsWith('Figure ids from the stored paper plan')) ?? '';
    const listPart = idLine.includes(': none') ? '' : idLine.slice(idLine.lastIndexOf(': ') + 2);
    const ids =
      listPart.length > 0
        ? listPart
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : ['fig-1'];
    return JSON.stringify({
      style: 'publication',
      dpi: 300,
      format: 'pdf',
      figures: ids.map((id) => ({
        id,
        type: 'bar',
        title: `Fake ${id}`,
        caption: `Fake caption for ${id} grounded in persisted results.`,
        statistics: ['bar height = single fake metric value'],
        dataSources: [{ kind: 'context', ref: 'experiment-results' }],
        script:
          'import matplotlib.pyplot as plt' +
          String.fromCharCode(10) +
          'fig, ax = plt.subplots()' +
          String.fromCharCode(10) +
          "ax.bar(['fake'], [1.0])" +
          String.fromCharCode(10) +
          "fig.savefig('" +
          id +
          ".pdf')" +
          String.fromCharCode(10) +
          "fig.savefig('" +
          id +
          ".png')",
        latexInclude: '\\includegraphics{figures/' + id + '}',
        claims: ['The persisted results bear on the research question'],
      })),
      preservedExisting: [],
      manualRemaining: ['architecture diagram (manual)'],
      reviewerFeedback: {
        verdict: 'REVIEW_UNAVAILABLE',
        notes: ['no reviewer backend in the fake harness'],
      },
    });
  }
  if (request.outputSchema === 'page-visual-v1') {
    const override = process.env.IDEASEEK_FAKE_VISUAL_OUTPUT;
    if (override != null) return override;
    const imageCount = request.inputs.filter((input) => input.kind === 'image').length;
    return JSON.stringify({
      caption: 'A bar chart compares two methods on the locked split.',
      confidence: 0.82,
      uncertainty: 'axis labels are small but readable.',
      observations: ['one figure with two bars', 'y-axis is accuracy'],
      // Test hook: proves the image block actually reached the harness.
      imageInputsReceived: imageCount,
    });
  }
  if (request.outputSchema === 'synthesis-lead-v1') {
    const override = process.env.IDEASEEK_FAKE_CONSOLIDATE_OUTPUT;
    if (override != null) return override;
    const context = firstTextInput(request);
    const refsLine =
      context.split('\n').find((line) => line.startsWith('Input refs requiring a selection: ')) ??
      '';
    const refsPart = refsLine.slice('Input refs requiring a selection: '.length).trim();
    const refs =
      refsPart && refsPart !== '(none)'
        ? refsPart
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    const failureLine =
      context.split('\n').find((line) => line.startsWith('Failure opinions in context: ')) ??
      'Failure opinions in context: 0';
    const failureCount = Number(failureLine.split(':').pop()?.trim() ?? '0');
    const sourcesLine =
      context.split('\n').find((line) => line.startsWith('Allowed evidence sources: ')) ??
      'Allowed evidence sources: speculation';
    const cite =
      sourcesLine
        .slice('Allowed evidence sources: '.length)
        .split(',')
        .map((s) => s.trim())
        .find((s) => s && s !== 'speculation') ?? 'speculation';
    return JSON.stringify({
      contract: 'synthesis-lead-v1',
      selections: refs.map((ref) => ({
        ref,
        decision: 'advance',
        rationale: 'Persisted evidence supports continued investment.',
        evidence: [{ source: cite, location: 'context' }],
      })),
      mergedInto: [],
      retainedCompetingExplanations: ['lr schedule explains the gain (kept)'],
      retainedFailureOpinions:
        failureCount > 0
          ? Array.from(
              { length: failureCount },
              (_, i) => `failure opinion ${i + 1} retained from context`,
            )
          : [],
      recommendation:
        refs.length > 0
          ? 'Advance the top candidate into implementation.'
          : 'Create an ideation round first, then consolidate.',
    });
  }
  if (request.outputSchema === 'mechanism-analysis-v1') {
    const override = process.env.IDEASEEK_FAKE_MECH_OUTPUT;
    if (override != null) return override;
    const context = firstTextInput(request);
    const sourcesLine =
      context.split('\n').find((line) => line.startsWith('Allowed evidence sources: ')) ??
      'Allowed evidence sources: speculation';
    const sources = sourcesLine
      .slice('Allowed evidence sources: '.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const cite = sources.find((s) => s.startsWith('synthesis:')) ?? 'speculation';
    return JSON.stringify({
      contract: 'mechanism-analysis-v1',
      mechanisms: [
        {
          name: 'drift-aware reweighting',
          designPrinciple: 'compensate client drift before aggregation',
          conditions: ['label-skew partitions'],
          groundedIn: [{ source: cite, location: 'topic synthesis' }],
        },
      ],
      designPrinciples: [
        {
          principle: 'correct the objective where the mismatch originates',
          supportsMechanisms: ['drift-aware reweighting'],
        },
      ],
      contradictions: [],
      causalityStatement:
        'The evidence shows association under the locked protocol; causality is not established without the ablation.',
      correlationCaution: true,
    });
  }
  if (request.outputSchema === 'comparison-matrix-proposal-v1') {
    const override = process.env.IDEASEEK_FAKE_MATRIX_PLAN_OUTPUT;
    if (override != null) return override;
    const context = readJsonContext(request) as {
      candidates?: {
        methodId?: unknown;
        currentClassification?: unknown;
        currentRationale?: unknown;
      }[];
      literature?: { sourceId?: unknown }[];
    };
    const cite =
      Array.isArray(context.literature) && context.literature.length > 0
        ? String(context.literature[0]?.sourceId ?? '')
        : '';
    return JSON.stringify({
      contract: 'comparison-matrix-proposal-v1',
      entries: (Array.isArray(context.candidates) ? context.candidates : []).map((candidate) => ({
        methodId: String(candidate.methodId),
        classification: String(candidate.currentClassification ?? 'reference-only'),
        rationale: `planner review: ${String(candidate.currentRationale ?? '')}`.slice(0, 300),
        sources: cite ? [cite] : [],
        relevanceNote: 'fake planner (deterministic provider)',
      })),
      notes: ['fake harness planner'],
    });
  }
  if (request.outputSchema === 'idea-discuss-v1') {
    const override = process.env.IDEASEEK_FAKE_DISCUSS_OUTPUT;
    if (override != null) return override;
    const context = firstTextInput(request);
    const ideaLine =
      context.split('\n').find((line) => line.startsWith('Idea: ')) ?? 'Idea: unknown v1 []';
    // "Idea: <id> v<version> [STATUS]"
    const match = ideaLine.match(/^ Idea: (\S+) v(\d+)/) ?? ideaLine.match(/^Idea: (\S+) v(\d+)/);
    const ideaId = match ? match[1] : 'unknown';
    const cardVersion = match ? Number(match[2]) : 1;
    const sourcesLine =
      context.split('\n').find((line) => line.startsWith('Allowed evidence sources: ')) ??
      'Allowed evidence sources: speculation';
    const sources = sourcesLine
      .slice('Allowed evidence sources: '.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const cite = sources.find((s) => s !== 'speculation') ?? 'speculation';
    return JSON.stringify({
      contract: 'idea-discuss-v1',
      ideaId,
      cardVersion,
      position: 'contested',
      arguments: [
        {
          side: 'pro',
          statement: 'Persisted evidence supports the mechanism chain.',
          evidence: [{ source: cite, location: 'context' }],
          confidence: 0.7,
        },
        {
          side: 'con',
          statement: 'Baseline reproduction is still missing — impact is unproven.',
          evidence: [{ source: 'speculation', location: 'no reproduced baseline in context' }],
          confidence: 0.6,
        },
      ],
      openQuestions: ['Does the gain survive on the standard slice?'],
      recommendation: 'Reproduce the baseline before investing in the mechanism change.',
    });
  }
  if (request.outputSchema === 'idea-diagnosis-v1') {
    const override = process.env.IDEASEEK_FAKE_IMPROVE_OUTPUT;
    if (override != null) return override;
    const context = firstTextInput(request);
    const questionLine =
      context.split('\n').find((line) => line.startsWith('User question: ')) ?? 'User question: ';
    const seedLine = context.split('\n').find((line) => line.startsWith('Idea seed: ')) ?? '';
    const question = questionLine.slice('User question: '.length);
    // "Idea seed: <path> (rootHash <hash>)"
    const seedMatch =
      seedLine.match(/^ Idea seed: (\S+) \(rootHash (\S+)\)$/) ??
      seedLine.match(/^Idea seed: (\S+) \(rootHash (\S+)\)$/);
    const sourcePath = seedMatch ? seedMatch[1] : 'unknown';
    const sourceHash = seedMatch ? seedMatch[2] : 'unknown';
    return JSON.stringify({
      contract: 'idea-diagnosis-v1',
      question,
      source: { path: sourcePath, rootHash: sourceHash },
      baselineStatus: 'not_attempted',
      mechanismSummary:
        'Fake diagnosis: mechanism inferred from the registered seed files and persisted evidence.',
      failureCategories: ['insufficient_evidence'],
      findings: [
        {
          area: 'evidence',
          finding: 'No reproduced baseline is present in the persisted evidence yet.',
          evidence: [{ source: sourcePath, location: 'seed files' }],
        },
      ],
      routes: [
        {
          kind: 'engineering',
          summary: 'Reproduce the seed baseline on a smoke slice first.',
          expectedChange: 'A trustworthy reference number for later comparisons.',
          risks: 'Environment drift may block reproduction (baseline_unavailable).',
          discriminatingExperiment: 'Run the seed entry on the smoke slice and compare metrics.',
          stopConditions: ['baseline still unreproducible after two environment fixes'],
        },
      ],
    });
  }
  if (request.outputSchema === 'rebuttal-v1') {
    const override = process.env.IDEASEEK_FAKE_REBUTTAL_OUTPUT;
    if (override != null) return override;
    const context = firstTextInput(request);
    const specLine =
      context.split('\n').find((line) => line.startsWith('  - repro-')) ??
      '  - repro-fake [succeeded]';
    const specId = specLine.trim().split(' ')[0];
    return JSON.stringify({
      overallResponse:
        'The persisted evidence base addresses the concerns with locked-protocol results.',
      pointResponses: [
        {
          point: 'Evidence base may be insufficient',
          response: `Grounded in ${specId} under the persisted snapshot.`,
          evidence: [{ source: specId, location: 'result.metrics' }],
        },
      ],
      newEvidence: [],
      revisedClaims: [],
      reviewerFeedback: {
        verdict: 'REVIEW_UNAVAILABLE',
        notes: ['no reviewer backend in the fake harness'],
      },
    });
  }
  if (request.outputSchema === 'paper-slides-v1') {
    const override = process.env.IDEASEEK_FAKE_SLIDES_OUTPUT;
    if (override != null) return override;
    const context = firstTextInput(request);
    const venueLine =
      context.split('\n').find((line) => line.startsWith('Stored plan: venue=')) ?? '';
    const venueMatch = venueLine.match(/venue=(\S+)/);
    const venue = venueMatch ? venueMatch[1] : 'ICLR';
    const slides = [1, 2, 3].map((number) => ({
      number,
      title: number === 1 ? 'Title' : number === 2 ? 'Problem' : 'Main result',
      bullets: [`Bullet for slide ${number} grounded in context`],
      speakerNotes: `Notes for slide ${number}.`,
      claimSources: ['plan-claim-1'],
    }));
    return JSON.stringify({
      venue,
      talkType: 'conference',
      slideCount: 3,
      slides,
      talkScript: 'Word-for-word fake talk script grounded in the persisted results.',
      timeBudgetMinutes: 15,
      qaPrep: [
        {
          question: 'Is the comparison fair?',
          answer: 'Yes — locked protocol and registered baselines.',
          source: 'protocol',
        },
      ],
      reviewerFeedback: {
        verdict: 'REVIEW_UNAVAILABLE',
        notes: ['no reviewer backend in the fake harness'],
      },
    });
  }
  if (request.outputSchema === 'paper-talk-v1') {
    const override = process.env.IDEASEEK_FAKE_TALK_OUTPUT;
    if (override != null) return override;
    return JSON.stringify({
      readiness: 'draft',
      checklist: [
        {
          item: 'slides present',
          status: 'pass',
          detail: 'stored slides deck found in context',
        },
        {
          item: 'claims traceable',
          status: 'pass',
          detail: 'claims cite persisted spec ids',
        },
      ],
      talkTrack: 'Question → insight → locked-protocol evidence → takeaway.',
      qAndA: [
        {
          question: 'What is the main claim?',
          answer: 'The claim stated in the stored plan.',
          source: 'plan-claim-1',
        },
      ],
      blockers: [],
      reviewerFeedback: {
        verdict: 'REVIEW_UNAVAILABLE',
        notes: ['no reviewer backend in the fake harness'],
      },
    });
  }
  if (request.outputSchema === 'paper-write-v1') {
    // Test hook: raw override exercises parse/validation failure paths.
    const override = process.env.IDEASEEK_FAKE_PAPER_WRITE_OUTPUT;
    if (override != null) return override;
    const context = firstTextInput(request);
    const venueLine =
      context.split('\n').find((line) => line.startsWith('Venue: ')) ?? 'Venue: none stored';
    const venue = venueLine.includes('none stored')
      ? 'ICLR'
      : venueLine.slice('Venue: '.length).split(' ')[0];
    return JSON.stringify({
      venue,
      title: 'Fake Manuscript',
      abstract: 'A fake abstract grounded in the persisted results.',
      sections: [
        {
          id: 'intro',
          heading: 'Introduction',
          latex: '\\section{Introduction}\nBody text citing the stored plan claims.',
          sources: ['plan-claims'],
        },
        {
          id: 'experiments',
          heading: 'Experiments',
          latex: '\\section{Experiments}\nResults cited by specId.',
          sources: ['experiment-results'],
        },
      ],
      bibliography: [{ key: 'fake2026', bibtex: '@article{fake2026, title={Fake Work}}' }],
      qualityPasses: ['reverse-outline'],
      manualFixes: ['camera-ready formatting'],
      reviewerFeedback: {
        verdict: 'REVIEW_UNAVAILABLE',
        notes: ['no reviewer backend in the fake harness'],
      },
    });
  }
  if (request.outputSchema === 'paper-plan-v1') {
    // Test hook: raw override exercises parse/validation failure paths.
    const override = process.env.IDEASEEK_FAKE_PAPER_PLAN_OUTPUT;
    if (override != null) return override;
    const context = firstTextInput(request);
    const questionLine =
      context.split(/\r?\n/).find((line) => line.startsWith('Research question:')) ??
      'Research question: unknown';
    const claim = 'The persisted results bear on the research question';
    return JSON.stringify({
      paperType: 'empirical-study',
      venue: 'ICLR',
      maxPages: 9,
      contribution: `Fake contribution derived from: ${questionLine.slice(0, 120)}`,
      claimsEvidence: [
        {
          claim,
          evidence: [
            {
              source: questionLine.includes('(no run yet)') ? 'context' : 'experiment-results',
              location: questionLine.slice(0, 100),
            },
          ],
          status: 'unadjudicated',
        },
      ],
      structure: [
        {
          section: '§0 Abstract',
          purpose: 'state the contribution and strongest evidence',
          keyPoints: ['contribution', 'evidence'],
        },
      ],
      figurePlan: [
        { id: 'fig-1', kind: 'bar', caption: 'Fake main result figure', supportsClaims: [claim] },
      ],
      citationPlan: [{ topic: 'related work', candidates: ['fake-citation-1'] }],
      reviewerFeedback: {
        verdict: 'REVIEW_UNAVAILABLE',
        notes: ['no reviewer backend in the fake harness'],
      },
      nextSteps: ['draft the introduction', 'run the venue checklist'],
    });
  }
  return buildFakeCard(request, call);
}

/**
 * Deterministic claim-driven plan that passes parseExperimentPlan guards:
 * one MUST-RUN anchor (smoke run, quick data tier), a nice-to-have block,
 * 3 seeds (ARIS DEFAULT_SEEDS) and a budget inside the fixture card ceiling
 * (maxGpuMinutes: 120). Metrics come from the idea context (card metric +
 * protocol primaries) so the plan stays coherent with the spec it plans.
 */
function buildFakeExperimentPlan(request: HarnessTaskRequest): Record<string, unknown> {
  let cardMetric = 'accuracy';
  const directions = new Map<string, 'higher' | 'lower'>();
  try {
    const context = JSON.parse(textInputAt(request, 0) ?? '{}') as {
      minimalExperiment?: { metrics?: unknown };
      protocol?: { primaryMetrics?: { name?: unknown; direction?: unknown }[] };
      budget?: { maxGpuMinutes?: unknown };
    };
    const first = Array.isArray(context.minimalExperiment?.metrics)
      ? context.minimalExperiment.metrics[0]
      : null;
    if (typeof first === 'string' && first) cardMetric = first;
    for (const metric of context.protocol?.primaryMetrics ?? []) {
      if (
        typeof metric.name === 'string' &&
        (metric.direction === 'higher' || metric.direction === 'lower')
      ) {
        directions.set(metric.name, metric.direction);
      }
    }
  } catch {
    // no context — defaults apply
  }
  const metricNames = [...new Set([cardMetric, ...directions.keys()])];
  const metrics = metricNames.map((name) => ({
    name,
    direction: directions.get(name) ?? ('higher' as const),
  }));

  return {
    problem: 'non-IID clients diverge under uniform aggregation',
    thesis: 'drift-proportional reweighting reduces worst-client drift',
    claims: [
      {
        claimId: 'c1',
        statement: 'reweighting clients by measured drift improves worst-client recall',
        linkedBlocks: ['b1-anchor'],
      },
    ],
    blocks: [
      {
        blockId: 'b1-anchor',
        name: 'anchor result',
        claimTested: 'c1',
        priority: 'MUST-RUN',
        scale: 'smoke',
        dataScale: 'quick',
        metrics,
        successCriterion: 'beats the uniform-weight baseline on the smoke slice',
        failureInterpretation: 'hypothesis unsupported at this scale',
      },
      {
        blockId: 'b2-diagnosis',
        name: 'failure diagnosis',
        claimTested: 'c1',
        priority: 'NICE-TO-HAVE',
        scale: 'quick',
        dataScale: 'quick',
        metrics,
        successCriterion: 'variance drops across seeds',
        failureInterpretation: 'report as diagnosis, not support',
      },
    ],
    runOrder: ['b1-anchor', 'b2-diagnosis'],
    seeds: [42, 200, 201],
    budgetMinutes: 90,
    risks: [{ risk: 'seed variance on tiny slices', mitigation: 'report 3-seed spread' }],
  };
}

/**
 * Deterministic IdeaCard that passes validateIdeaCard and the mechanism
 * gate (full six-step chain, one necessary component) so the generate →
 * validate → create path runs end to end without a model.
 */
function buildFakeIdeaCard(): Record<string, unknown> {
  return {
    ideaId: 'gen-fake-1',
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: {
      statement: 'per-client reweighting of the local objective reduces worst-client drift',
      targetProblem: 'non-IID clients diverge under uniform aggregation',
    },
    paperEvidence: [
      {
        paperRef: 'fixture-paper-1',
        statement: 'uniform averaging hurts strong non-IID clients',
        evidence: 'fixture quote [page 1]',
      },
    ],
    contradictions: ['prior work reports no drift with small local epochs'],
    novelty: {
      claim: 'reweight by measured drift instead of client size',
      uncertainty: 'may only help on extreme label skew',
      whyNotRestatement: 'size-based weighting is the restated baseline',
    },
    mechanismChain: {
      designPrincipleLink: 'adapt aggregation to measured client drift',
      steps: [
        { kind: 'observation', text: 'worst-client loss oscillates under uniform averaging' },
        { kind: 'hypothesis', text: 'drift-proportional weights dampen the oscillation' },
        { kind: 'intervention', text: 'weight clients by rolling loss slope' },
        { kind: 'expected-change', text: 'worst-client loss variance decreases' },
        { kind: 'baseline-difference', text: 'beats uniform FedAvg on the same slice' },
        { kind: 'falsifier', text: 'no variance reduction across 3 seeds' },
      ],
    },
    nearestComparisons: [
      { methodId: 'fedavg', difference: 'adaptive weights', evidence: 'fixture quote [page 2]' },
    ],
    componentNecessity: [
      {
        component: 'drift reweighting',
        role: 'necessary-mechanism',
        removeEffect: 'reverts to uniform averaging',
      },
    ],
    competingExplanations: ['learning-rate schedule explains the gain'],
    boundaryConditions: ['label-skew only; feature-skew untested'],
    risks: ['weight noise on tiny clients'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'dataset slice',
      baselines: ['fedavg'],
      metrics: ['worst-client accuracy'],
      ablations: ['uniform weights'],
    },
    falsification: { conditions: ['variance unchanged across 3 seeds'] },
    budget: { maxRounds: 1, maxGpuMinutes: 10 },
    stopConditions: ['budget exhausted'],
    createdAt: 1,
  };
}
function buildFakeCard(request: HarnessTaskRequest, call: number): string {
  const content = firstTextInput(request);
  const line =
    content
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length >= 15) ?? content.slice(0, 60).trim();
  const card = {
    paper_id: 'pending',
    document_hash: `sha256:${'0'.repeat(64)}`,
    title: 'unknown',
    problem: 'unknown',
    method: { summary: 'unknown', steps: [], motivation: [] },
    datasets: [],
    metrics: [],
    baselines: [],
    limitations: [],
    claims: line
      ? [
          {
            text: `fake claim derived from source text (call ${call})`,
            evidence: [{ quote: line.slice(0, 120) }],
          },
        ]
      : [],
    unknowns: ['fake harness leaves every field it cannot know as unknown'],
    parser_version: 'fake-1',
    prompt_schema_version: request.outputSchema,
  };
  return JSON.stringify(card);
}

export class FakeHarnessAdapter implements HarnessAdapter {
  readonly kind = 'fake' as const;
  readonly version = 'fake-1';

  private readonly opts: FakeHarnessOptions;
  private readonly calls = new Map<string, number>();
  private initialized = false;

  constructor(opts: FakeHarnessOptions = {}) {
    this.opts = opts;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  callCount(idempotencyKey: string): number {
    return this.calls.get(idempotencyKey) ?? 0;
  }

  async runTask(
    request: HarnessTaskRequest,
    onEvent?: (event: HarnessEvent) => void,
    signal?: AbortSignal,
  ): Promise<HarnessTaskResult> {
    if (!this.initialized) {
      throw new IdeaseekError('INVALID_STATE', 'harness not initialized; call initialize() first');
    }
    const now = Date.now();
    const count = (this.calls.get(request.idempotencyKey) ?? 0) + 1;
    this.calls.set(request.idempotencyKey, count);

    onEvent?.({
      type: 'started',
      ts: now,
      runId: request.runId,
      taskId: request.taskId,
      summary: `fake harness started ${request.profile} (call ${count})`,
    });

    // Live tool_call events (PROGRESS 86): the fake agent "makes" the
    // configured calls as the real DSH adapter would — observers see
    // them as they happen, not batched after completion.
    for (const call of readFakeToolCalls(this.opts.toolCalls)) {
      onEvent?.({
        type: 'tool_call',
        ts: Date.now(),
        runId: request.runId,
        taskId: request.taskId,
        summary: `${call.tool}(${call.summary}) ${call.ok ? 'ok' : 'failed'}`,
        toolCall: call,
      });
    }

    if (this.opts.latencyMs) {
      await new Promise<void>((resolve, reject) => {
        // An abort that fired BEFORE the latency window started (e.g. slow
        // fixture parsing) must still reject — listeners on an already-
        // aborted signal never fire.
        if (signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        const timer = setTimeout(resolve, this.opts.latencyMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          },
          { once: true },
        );
      });
    }

    if (this.opts.block && count <= (this.opts.blockTimes ?? 1)) {
      throw new HarnessBlockError(
        this.opts.block,
        `fake harness injected ${this.opts.block} (call ${count})`,
      );
    }
    if (this.opts.failTimes && count <= this.opts.failTimes) {
      throw new Error(`fake harness injected failure (call ${count})`);
    }

    const payload = buildFakeOutput(request, count);
    onEvent?.({
      type: 'completed',
      ts: Date.now(),
      runId: request.runId,
      taskId: request.taskId,
      summary: `fake harness produced ${request.outputSchema} output`,
    });
    return {
      runId: request.runId,
      taskId: request.taskId,
      output: payload, // buildFakeOutput already returns JSON text
      usage: readFakeUsage(),
      model: 'fake-model',
      toolCalls: readFakeToolCalls(this.opts.toolCalls),
      runtime: { kind: 'fake', version: this.version },
      sessionId: null,
      finishedAt: Date.now(),
    };
  }

  async health(): Promise<HarnessHealth> {
    return {
      reachable: true,
      models: [{ name: 'fake-model', available: true, detail: 'in-memory' }],
      blocked: this.opts.block != null && (this.opts.blockTimes ?? 1) > 0,
      blockReason: null,
    };
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }
}
