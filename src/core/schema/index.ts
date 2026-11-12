import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { IdeaseekError } from '../errors.js';
import papercardV1 from './schemas/papercard-v1.json' with { type: 'json' };
import parsedPaperV1 from './schemas/parsed-paper-v1.json' with { type: 'json' };

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
export type SchemaName = 'papercard-v1' | 'parsed-paper-v1';

const SCHEMAS: Record<SchemaName, object> = {
  'papercard-v1': papercardV1,
  'parsed-paper-v1': parsedPaperV1,
};

let ajv: Ajv | null = null;
const compiled = new Map<string, ValidateFunction>();

function validatorFor(name: SchemaName): ValidateFunction {
  const cached = compiled.get(name);
  if (cached) return cached;
  if (!ajv) {
    ajv = new Ajv({ allErrors: true, strict: true });
  }
  const validate = ajv.compile(SCHEMAS[name]);
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
