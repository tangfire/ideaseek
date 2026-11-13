import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { stableJson } from '../experiment/spec.js';

/**
 * `idea improve` diagnosis capability (docs/IDEA_IMPROVEMENT.md 诊断阶段):
 * the Idea Improvement Agent's first deliverable — a structured diagnosis
 * of an imported idea seed against the persisted evidence base, with
 * improvement routes that keep engineering fixes separate from scientific
 * hypothesis changes.
 *
 * Platform-native contract (ADR-009): upstream ARIS has no matching
 * diagnosis skill, so IdeaSeek owns the prompt/contract exactly as it owns
 * IdeaCard/ExperimentSpec. The envelope binds the diagnosis to the seed's
 * registered snapshot rootHash and the user's question — a changed source
 * invalidates reuse and forces re-import.
 */

export const IDEA_DIAGNOSIS_SCHEMA = 'idea-diagnosis-v1';

export const FAILURE_CATEGORIES = [
  'implementation_issue',
  'environment_issue',
  'data_issue',
  'metric_issue',
  'comparison_issue',
  'hypothesis_issue',
  'novelty_issue',
  'insufficient_evidence',
] as const;

export const FINDING_AREAS = [
  'implementation',
  'environment',
  'data',
  'metric',
  'comparison',
  'hypothesis',
  'novelty',
  'evidence',
] as const;

export const ROUTE_KINDS = ['engineering', 'mechanism', 'generalization', 'new-idea'] as const;

export interface DiagnosisFinding {
  area: (typeof FINDING_AREAS)[number];
  finding: string;
  evidence: { source: string; location: string }[];
}

export interface ImprovementRoute {
  kind: (typeof ROUTE_KINDS)[number];
  summary: string;
  expectedChange: string;
  risks: string;
  discriminatingExperiment: string;
  stopConditions: string[];
}

export interface IdeaDiagnosis {
  question: string;
  baselineStatus: 'reproduced' | 'baseline_unavailable' | 'not_attempted';
  mechanismSummary: string;
  failureCategories: (typeof FAILURE_CATEGORIES)[number][];
  findings: DiagnosisFinding[];
  routes: ImprovementRoute[];
}

export const IDEA_DIAGNOSIS_OUTPUT_CONTRACT = [
  `OUTPUT CONTRACT (${IDEA_DIAGNOSIS_SCHEMA}) — return ONLY one JSON object, no prose, no fences:`,
  '{',
  '  "question": string, // MUST equal the user question from the context verbatim',
  '  "baselineStatus": "reproduced" | "baseline_unavailable" | "not_attempted",',
  '  "mechanismSummary": string, // current method mechanism + hypothesis in 1-3 sentences',
  `  "failureCategories": [${FAILURE_CATEGORIES.map((c) => `"${c}"`).join(' | ')}] — at least 1 (the categories the diagnosis actually finds)`,
  '  "findings": [{"area": ' +
    FINDING_AREAS.map((a) => `"${a}"`).join(' | ') +
    ', "finding": string, "evidence": [{"source": string, "location": string}]}] — at least 1; evidence.source must cite context ids (seed file, specId, idea id, protocol id)',
  '  "routes": [{"kind": ' +
    ROUTE_KINDS.map((k) => `"${k}"`).join(' | ') +
    ', "summary": string, "expectedChange": string, "risks": string, "discriminatingExperiment": string, "stopConditions": [string] ≥ 1}] — at least 1',
  '}',
  'Rules:',
  '- Distinguish engineering fixes (implementation/environment/data/metric) from scientific changes (hypothesis) — a hypothesis change must be a "new-idea" route, never disguised as code polish.',
  '- If the baseline cannot be reproduced, baselineStatus must be "baseline_unavailable" and no route may claim measured improvement.',
  '- No invented evidence: every evidence.source comes from the context.',
].join('\n');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateIdeaDiagnosis(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ['diagnosis must be an object'] };

  if (!nonEmpty(value.question)) errors.push('question must be a non-empty string');
  if (
    !['reproduced', 'baseline_unavailable', 'not_attempted'].includes(String(value.baselineStatus))
  ) {
    errors.push('baselineStatus must be reproduced | baseline_unavailable | not_attempted');
  }
  if (!nonEmpty(value.mechanismSummary)) errors.push('mechanismSummary must be a non-empty string');

  if (!Array.isArray(value.failureCategories) || value.failureCategories.length === 0) {
    errors.push('failureCategories must be a non-empty array');
  } else {
    for (const [index, category] of value.failureCategories.entries()) {
      if (!(FAILURE_CATEGORIES as readonly unknown[]).includes(category)) {
        errors.push(`failureCategories[${index}] must be one of ${FAILURE_CATEGORIES.join(' | ')}`);
      }
    }
  }

  if (!Array.isArray(value.findings) || value.findings.length === 0) {
    errors.push('findings must be a non-empty array');
  } else {
    value.findings.forEach((finding, index) => {
      if (!isObject(finding)) {
        errors.push(`findings[${index}] must be an object`);
        return;
      }
      if (!(FINDING_AREAS as readonly unknown[]).includes(finding.area)) {
        errors.push(`findings[${index}].area must be one of ${FINDING_AREAS.join(' | ')}`);
      }
      if (!nonEmpty(finding.finding)) errors.push(`findings[${index}].finding must be non-empty`);
      if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
        errors.push(`findings[${index}].evidence must contain at least one source`);
      } else {
        finding.evidence.forEach((item, e) => {
          if (!isObject(item) || !nonEmpty(item.source) || !nonEmpty(item.location)) {
            errors.push(`findings[${index}].evidence[${e}] needs non-empty source and location`);
          }
        });
      }
    });
  }

  if (!Array.isArray(value.routes) || value.routes.length === 0) {
    errors.push('routes must be a non-empty array');
  } else {
    value.routes.forEach((route, index) => {
      if (!isObject(route)) {
        errors.push(`routes[${index}] must be an object`);
        return;
      }
      if (!(ROUTE_KINDS as readonly unknown[]).includes(route.kind)) {
        errors.push(`routes[${index}].kind must be one of ${ROUTE_KINDS.join(' | ')}`);
      }
      for (const field of [
        'summary',
        'expectedChange',
        'risks',
        'discriminatingExperiment',
      ] as const) {
        if (!nonEmpty(route[field])) errors.push(`routes[${index}].${field} must be non-empty`);
      }
      if (!Array.isArray(route.stopConditions) || route.stopConditions.length === 0) {
        errors.push(`routes[${index}].stopConditions must be a non-empty array`);
      } else if (route.stopConditions.some((stop) => !nonEmpty(stop))) {
        errors.push(`routes[${index}].stopConditions entries must be non-empty strings`);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

export interface ImproveContext {
  question: string;
  sourceRel: string;
  sourceRootHash: string;
  /** Seed file listing (capped) — what the diagnosis may cite. */
  files: string[];
  /** Persisted experiment/idea evidence (hashable ids the diagnosis cites). */
  evidenceLines: string[];
}

export const DIAGNOSIS_ENVELOPE_CONTRACT = [
  `IDEA DIAGNOSIS (${IDEA_DIAGNOSIS_SCHEMA}) — the envelope below wraps the contract object; return ONLY the envelope JSON.`,
  '{',
  '  "contract": "' + IDEA_DIAGNOSIS_SCHEMA + '",',
  '  "question": string, // verbatim user question',
  '  "source": {"path": string, "rootHash": string}, // MUST equal the context values verbatim',
  '  ...the diagnosis fields from the output contract',
  '}',
].join('\n');

export function buildImproveRequest(opts: { question: string; context: ImproveContext }): {
  instruction: string;
  inputHash: string;
  idempotencyKey: string;
} {
  const contextLines = [
    `User question: ${opts.context.question}`,
    `Idea seed: ${opts.context.sourceRel} (rootHash ${opts.context.sourceRootHash})`,
    'Seed files (cite these paths in evidence):',
    ...opts.context.files.slice(0, 30).map((file) => `  - ${file}`),
    'Persisted evidence (cite these ids):',
    ...(opts.context.evidenceLines.length > 0
      ? opts.context.evidenceLines.map((line) => `  - ${line}`)
      : ['  (none — be honest about missing evidence)']),
    'Baseline rule: if no reproduced result exists in the evidence, set baselineStatus to baseline_unavailable.',
  ];
  const inputHash = sha256Of(
    stableJson({
      contract: IDEA_DIAGNOSIS_SCHEMA,
      question: opts.question,
      sourceRel: opts.context.sourceRel,
      sourceRootHash: opts.context.sourceRootHash,
      files: opts.context.files,
      evidenceLines: opts.context.evidenceLines,
    }),
  );
  const instruction = [
    'You are the Idea Improvement Agent (docs/IDEA_IMPROVEMENT.md).',
    'Diagnose the imported idea seed against the persisted evidence and propose improvement routes.',
    'Engineering fixes and scientific hypothesis changes must stay separate.',
    '',
    '---',
    '',
    DIAGNOSIS_ENVELOPE_CONTRACT,
    '',
    IDEA_DIAGNOSIS_OUTPUT_CONTRACT,
    '',
    'Context (persisted, hashable sources only):',
    contextLines.join('\n'),
  ].join('\n');
  return {
    instruction,
    inputHash,
    idempotencyKey: `idea-improve:${inputHash}`,
  };
}

/** Parses + validates; binds envelope to the expected source/question. */
export function parseDiagnosisOutput(
  output: string,
  context: ImproveContext,
): IdeaDiagnosis & { contract: string; source: { path: string; rootHash: string } } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `idea diagnosis output is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!isObject(parsed)) {
    throw new IdeaseekError('PARSE_FAILED', 'idea diagnosis output must be an object');
  }
  if (parsed.contract !== IDEA_DIAGNOSIS_SCHEMA) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `idea diagnosis contract must be ${IDEA_DIAGNOSIS_SCHEMA}, got ${String(parsed.contract)}`,
    );
  }
  const source = parsed.source;
  if (
    !isObject(source) ||
    source.path !== context.sourceRel ||
    source.rootHash !== context.sourceRootHash
  ) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      'idea diagnosis source binding does not match the registered seed — the model must echo the context values verbatim',
      { expected: { path: context.sourceRel, rootHash: context.sourceRootHash } },
    );
  }
  if (parsed.question !== context.question) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `idea diagnosis question must echo the user question verbatim`,
    );
  }
  const validation = validateIdeaDiagnosis(parsed);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `idea diagnosis violates ${IDEA_DIAGNOSIS_SCHEMA}: ${validation.errors.slice(0, 5).join('; ')}`,
      { errors: validation.errors },
    );
  }
  return parsed as unknown as IdeaDiagnosis & {
    contract: string;
    source: { path: string; rootHash: string };
  };
}
