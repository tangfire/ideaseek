import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { IdeaseekError } from '../errors.js';
import papercardV1 from './schemas/papercard-v1.json' with { type: 'json' };
import parsedPaperV1 from './schemas/parsed-paper-v1.json' with { type: 'json' };
import experimentSpecV1 from './schemas/experiment-spec-v1.json' with { type: 'json' };
import runResultV1 from './schemas/run-result-v1.json' with { type: 'json' };
import datasetProfileV1 from './schemas/dataset-profile-v1.json' with { type: 'json' };
import imageProfileV1 from './schemas/image-profile-v1.json' with { type: 'json' };
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
export type SchemaName =
  | 'papercard-v1'
  | 'parsed-paper-v1'
  | 'experiment-spec-v1'
  | 'run-result-v1'
  | 'dataset-profile-v1'
  | 'image-profile-v1'
  | 'materialization-report-v1'
  | 'metric-alignment-v1'
  | 'implementation-program-v1'
  | 'idea-implementation-v1'
  | 'failure-diagnosis-v1'
  | 'experiment-plan-v1'
  | 'ablation-plan-v1'
  | 'novelty-check-v1'
  | 'idea-review-v1'
  | 'experiment-audit-v1'
  | 'dataset-candidates-v1'
  | 'idea-card-v1'
  | 'idea-candidates-v1'
  | 'integrity-forensics-v1'
  | 'paper-plan-v1'
  | 'paper-figure-v1'
  | 'paper-write-v1'
  | 'rebuttal-v1'
  | 'paper-slides-v1'
  | 'paper-talk-v1'
  | 'protocol-proposal-v1';

const SCHEMAS: Record<SchemaName, object> = {
  'papercard-v1': papercardV1,
  'parsed-paper-v1': parsedPaperV1,
  'experiment-spec-v1': experimentSpecV1,
  'run-result-v1': runResultV1,
  'dataset-profile-v1': datasetProfileV1,
  'image-profile-v1': imageProfileV1,
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
};

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
