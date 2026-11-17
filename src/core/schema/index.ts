import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { IdeaseekError } from '../errors.js';
import papercardV1 from './schemas/papercard-v1.json' with { type: 'json' };
import parsedPaperV1 from './schemas/parsed-paper-v1.json' with { type: 'json' };
import experimentSpecV1 from './schemas/experiment-spec-v1.json' with { type: 'json' };
import runResultV1 from './schemas/run-result-v1.json' with { type: 'json' };
import datasetProfileV1 from './schemas/dataset-profile-v1.json' with { type: 'json' };
import imageProfileV1 from './schemas/image-profile-v1.json' with { type: 'json' };
import directionAuditV1 from './schemas/direction-audit-v1.json' with { type: 'json' };
import analysisVerdictV1 from './schemas/analysis-verdict-v1.json' with { type: 'json' };
import materializationReportV1 from './schemas/materialization-report-v1.json' with { type: 'json' };
import metricAlignmentV1 from './schemas/metric-alignment-v1.json' with { type: 'json' };
import implementationProgramV1 from './schemas/implementation-program-v1.json' with { type: 'json' };
import ideaImplementationV1 from './schemas/idea-implementation-v1.json' with { type: 'json' };
import failureDiagnosisV1 from './schemas/failure-diagnosis-v1.json' with { type: 'json' };
import experimentPlanV1 from './schemas/experiment-plan-v1.json' with { type: 'json' };
import ablationPlanV1 from './schemas/ablation-plan-v1.json' with { type: 'json' };
import noveltyCheckV1 from './schemas/novelty-check-v1.json' with { type: 'json' };
import ideaReviewV1 from './schemas/idea-review-v1.json' with { type: 'json' };
import experimentAuditV1 from './schemas/experiment-audit-v1.json' with { type: 'json' };
import datasetCandidatesV1 from './schemas/dataset-candidates-v1.json' with { type: 'json' };
import ideaCardV1 from './schemas/idea-card-v1.json' with { type: 'json' };
import ideaCandidatesV1 from './schemas/idea-candidates-v1.json' with { type: 'json' };
import integrityForensicsV1 from './schemas/integrity-forensics-v1.json' with { type: 'json' };
import paperPlanV1 from './schemas/paper-plan-v1.json' with { type: 'json' };
import paperFigureV1 from './schemas/paper-figure-v1.json' with { type: 'json' };
import paperWriteV1 from './schemas/paper-write-v1.json' with { type: 'json' };
import rebuttalV1 from './schemas/rebuttal-v1.json' with { type: 'json' };
import paperSlidesV1 from './schemas/paper-slides-v1.json' with { type: 'json' };
import paperTalkV1 from './schemas/paper-talk-v1.json' with { type: 'json' };
import protocolProposalV1 from './schemas/protocol-proposal-v1.json' with { type: 'json' };
import comparisonMatrixProposalV1 from './schemas/comparison-matrix-proposal-v1.json' with { type: 'json' };
import comparisonMatrixV1 from './schemas/comparison-matrix-v1.json' with { type: 'json' };
import datasetDiscoveryV1 from './schemas/dataset-discovery-v1.json' with { type: 'json' };
import dependencyPlanV1 from './schemas/dependency-plan-v1.json' with { type: 'json' };
import evidenceAuditV1 from './schemas/evidence-audit-v1.json' with { type: 'json' };
import fairnessLockV1 from './schemas/fairness-lock-v1.json' with { type: 'json' };
import figureRenderV1 from './schemas/figure-render-v1.json' with { type: 'json' };
import fullPlanV1 from './schemas/full-plan-v1.json' with { type: 'json' };
import ideaDiagnosisV1 from './schemas/idea-diagnosis-v1.json' with { type: 'json' };
import ideaDiscussV1 from './schemas/idea-discuss-v1.json' with { type: 'json' };
import mechanismAnalysisV1 from './schemas/mechanism-analysis-v1.json' with { type: 'json' };
import overleafExportV1 from './schemas/overleaf-export-v1.json' with { type: 'json' };
import pageVisualV1 from './schemas/page-visual-v1.json' with { type: 'json' };
import paperCompileV1 from './schemas/paper-compile-v1.json' with { type: 'json' };
import reproductionBlueprintV1 from './schemas/reproduction-blueprint-v1.json' with { type: 'json' };
import researchMapV1 from './schemas/research-map-v1.json' with { type: 'json' };
import researchMaterialAssessmentV1 from './schemas/research-material-assessment-v1.json' with { type: 'json' };
import researchWikiV1 from './schemas/research-wiki-v1.json' with { type: 'json' };
import resultToClaimV1 from './schemas/result-to-claim-v1.json' with { type: 'json' };
import supervisorIntentV1 from './schemas/supervisor-intent-v1.json' with { type: 'json' };
import synthesisLeadV1 from './schemas/synthesis-lead-v1.json' with { type: 'json' };
import topicSynthesisV1 from './schemas/topic-synthesis-v1.json' with { type: 'json' };

/**
 * JSON Schema registry (DEPENDENCY_POLICY: 契约校验 = JSON Schema + 成熟
 * 校验器). Each schema file under `schemas/` is the single authority for its
 * contract's STRUCTURE across TypeScript, Python workers and ARIS skills —
 * Python/ARIS read the same JSON files. Semantic rules (evidence
 * verification, hash binding, state machines) stay with their domain
 * modules; this layer only answers "is this payload structurally the
 * contract it claims to be?".
 *
 * ajv is compiled lazily and cached; validation never throws on bad data
 * (only on unknown schema names — a programming error).
 */

export interface SchemaIssue {
  /** JSON instance path, e.g. `/claims/0/evidence`. */
  path: string;
  message: string;
}

export interface SchemaCheck {
  ok: boolean;
  issues: SchemaIssue[];
  /** Human-readable `path message` lines (stable for tests/logs). */
  errors: string[];
}

/** Registry keys — keep in lockstep with `schemas/*.json`. */
/**
 * Every registered contract name, derived from the registry object itself
 * rather than hand-maintained beside it.
 *
 * The union used to be a separate list of 29 literals next to the object, which
 * let the two disagree in both directions: register a schema and forget to add
 * the name (TS shouts), or name one with no file behind it (TS stays silent and
 * the caller gets Ajv's runtime "no schema with key"). Task #14 added 22
 * contracts at once, and a hand-maintained list beside a 51-entry registry is
 * exactly the arrangement where that drift lives. Deriving the type removes
 * the possibility instead of adding another check for it.
 *
 * The union used to be a separate list of 29 literals, which meant the two
 * could disagree in both directions: register a schema and forget the name
 * (TS rejects the object, so at least that one shouts), or add a name with no
 * file behind it (TS stays silent and the caller gets a runtime "no schema with
 * key" from Ajv). #14 added 22 contracts at once, and a hand-maintained list
 * next to a 51-entry registry is precisely the arrangement where that drift
 * lives. Deriving the type removes the possibility instead of checking for it.
 */

const SCHEMAS = {
  'papercard-v1': papercardV1,
  'parsed-paper-v1': parsedPaperV1,
  'experiment-spec-v1': experimentSpecV1,
  'run-result-v1': runResultV1,
  'dataset-profile-v1': datasetProfileV1,
  'image-profile-v1': imageProfileV1,
  'direction-audit-v1': directionAuditV1,
  'analysis-verdict-v1': analysisVerdictV1,
  'materialization-report-v1': materializationReportV1,
  'metric-alignment-v1': metricAlignmentV1,
  'implementation-program-v1': implementationProgramV1,
  'idea-implementation-v1': ideaImplementationV1,
  'failure-diagnosis-v1': failureDiagnosisV1,
  'experiment-plan-v1': experimentPlanV1,
  'ablation-plan-v1': ablationPlanV1,
  'novelty-check-v1': noveltyCheckV1,
  'idea-review-v1': ideaReviewV1,
  'experiment-audit-v1': experimentAuditV1,
  'dataset-candidates-v1': datasetCandidatesV1,
  'idea-card-v1': ideaCardV1,
  'idea-candidates-v1': ideaCandidatesV1,
  'integrity-forensics-v1': integrityForensicsV1,
  'paper-plan-v1': paperPlanV1,
  'paper-figure-v1': paperFigureV1,
  'paper-write-v1': paperWriteV1,
  'rebuttal-v1': rebuttalV1,
  'paper-slides-v1': paperSlidesV1,
  'paper-talk-v1': paperTalkV1,
  'protocol-proposal-v1': protocolProposalV1,
  'comparison-matrix-proposal-v1': comparisonMatrixProposalV1,
  'comparison-matrix-v1': comparisonMatrixV1,
  'dataset-discovery-v1': datasetDiscoveryV1,
  'dependency-plan-v1': dependencyPlanV1,
  'evidence-audit-v1': evidenceAuditV1,
  'fairness-lock-v1': fairnessLockV1,
  'figure-render-v1': figureRenderV1,
  'full-plan-v1': fullPlanV1,
  'idea-diagnosis-v1': ideaDiagnosisV1,
  'idea-discuss-v1': ideaDiscussV1,
  'mechanism-analysis-v1': mechanismAnalysisV1,
  'overleaf-export-v1': overleafExportV1,
  'page-visual-v1': pageVisualV1,
  'paper-compile-v1': paperCompileV1,
  'reproduction-blueprint-v1': reproductionBlueprintV1,
  'research-map-v1': researchMapV1,
  'research-material-assessment-v1': researchMaterialAssessmentV1,
  'research-wiki-v1': researchWikiV1,
  'result-to-claim-v1': resultToClaimV1,
  'supervisor-intent-v1': supervisorIntentV1,
  'synthesis-lead-v1': synthesisLeadV1,
  'topic-synthesis-v1': topicSynthesisV1,
};
export type SchemaName = keyof typeof SCHEMAS;

let ajv: Ajv | null = null;
const compiled = new Map<string, ValidateFunction>();

function validatorFor(name: SchemaName): ValidateFunction {
  const cached = compiled.get(name);
  if (cached) return cached;
  if (!ajv) {
    ajv = new Ajv({ allErrors: true, strict: true });
    // Register every schema up front so $ref links between contracts
    // (e.g. idea-candidates-v1 -> idea-card-v1.json#) resolve by $id.
    for (const schema of Object.values(SCHEMAS)) ajv.addSchema(schema);
  }
  const validate = ajv.getSchema((SCHEMAS[name] as { $id: string }).$id);
  if (!validate) {
    throw new IdeaseekError('INTERNAL', `schema $id not registered: ${name}`);
  }
  compiled.set(name, validate);
  return validate;
}

function formatIssue(error: ErrorObject): SchemaIssue {
  // Required-property failures report the PARENT instance path in ajv;
  // point at the missing property itself so callers see `/title`, not `/`.
  const params = error.params as { missingProperty?: string };
  const missing =
    error.keyword === 'required' && typeof params.missingProperty === 'string'
      ? `/${params.missingProperty}`
      : '';
  const path = `${error.instancePath}${missing}` || '/';
  return { path, message: error.message ?? 'is invalid' };
}

export function listSchemaNames(): SchemaName[] {
  return Object.keys(SCHEMAS) as SchemaName[];
}

/** Structural validation against the registered schema. Never throws on data. */
export function validateAgainstSchema(name: SchemaName, data: unknown): SchemaCheck {
  if (!(name in SCHEMAS)) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `unknown schema "${name}" — known: ${listSchemaNames().join(', ')}`,
    );
  }
  const validate = validatorFor(name);
  const ok = validate(data) as boolean;
  const issues = ok ? [] : (validate.errors ?? []).map(formatIssue);
  return { ok, issues, errors: issues.map((issue) => `${issue.path} ${issue.message}`) };
}

/**
 * Gate for persistence boundaries: throws INVALID_ARTIFACT listing every
 * structural violation instead of storing a payload that later stages
 * (Evidence Checker, reports, cross-language consumers) would reject.
 */
export function assertAgainstSchema(name: SchemaName, data: unknown): void {
  const check = validateAgainstSchema(name, data);
  if (check.ok) return;
  throw new IdeaseekError(
    'INVALID_ARTIFACT',
    `${name} payload failed schema validation: ${check.errors.slice(0, 5).join('; ')}` +
      (check.errors.length > 5 ? ` (+${check.errors.length - 5} more)` : ''),
    { schema: name, issues: check.issues },
  );
}
