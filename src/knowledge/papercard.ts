/**
 * PaperCard contract (docs/DATA_CONTRACTS.md §PaperCard): every critical
 * field carries an evidence locator into the original document; anything not
 * confirmable must be the literal "unknown" — never invented.
 */
export interface EvidenceSpan {
  /** 1-based page in the source document (Phase 2 parser output). */
  page?: number;
  section?: string;
  /** Short verbatim quote anchoring the claim to the source. */
  quote?: string;
}

export interface PaperClaim {
  text: string;
  evidence: EvidenceSpan[];
}

export interface PaperCard {
  paper_id: string;
  document_hash: `sha256:${string}`;
  title: string;
  problem: string;
  method: {
    summary: string;
    steps: string[];
    motivation: string[];
  };
  datasets: string[];
  metrics: string[];
  baselines: string[];
  limitations: string[];
  claims: PaperClaim[];
  unknowns: string[];
  parser_version: string;
  prompt_schema_version: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function requireString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${path} must be a non-empty string`);
  }
}

function requireStringArray(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${path} must be an array of strings`);
  }
}

/**
 * Validates the structural contract of a PaperCard. Claims must carry at
 * least one evidence span (page/quote) so the evidence checker and reports
 * can always trace a statement back to the source.
 */
export function validatePaperCard(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['paper card must be an object'] };
  }
  const card = value as Record<string, unknown>;

  requireString(card.paper_id, 'paper_id', errors);
  if (typeof card.document_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(card.document_hash)) {
    errors.push('document_hash must be sha256:<64 hex>');
  }
  requireString(card.title, 'title', errors);
  requireString(card.problem, 'problem', errors);

  const method = card.method as Record<string, unknown> | undefined;
  if (!method || typeof method !== 'object') {
    errors.push('method must be an object');
  } else {
    requireString(method.summary, 'method.summary', errors);
    requireStringArray(method.steps, 'method.steps', errors);
    requireStringArray(method.motivation, 'method.motivation', errors);
  }

  requireStringArray(card.datasets, 'datasets', errors);
  requireStringArray(card.metrics, 'metrics', errors);
  requireStringArray(card.baselines, 'baselines', errors);
  requireStringArray(card.limitations, 'limitations', errors);
  requireStringArray(card.unknowns, 'unknowns', errors);

  if (!Array.isArray(card.claims)) {
    errors.push('claims must be an array');
  } else {
    card.claims.forEach((claim, index) => {
      if (!claim || typeof claim !== 'object') {
        errors.push(`claims[${index}] must be an object`);
        return;
      }
      const typed = claim as Record<string, unknown>;
      requireString(typed.text, `claims[${index}].text`, errors);
      if (!Array.isArray(typed.evidence) || typed.evidence.length === 0) {
        errors.push(`claims[${index}].evidence must contain at least one locator`);
        return;
      }
      typed.evidence.forEach((span, spanIndex) => {
        if (!span || typeof span !== 'object') {
          errors.push(`claims[${index}].evidence[${spanIndex}] must be an object`);
          return;
        }
        const typedSpan = span as Record<string, unknown>;
        const hasLocator =
          (typeof typedSpan.page === 'number' && typedSpan.page >= 1) ||
          (typeof typedSpan.quote === 'string' && typedSpan.quote.length > 0) ||
          (typeof typedSpan.section === 'string' && typedSpan.section.length > 0);
        if (!hasLocator) {
          errors.push(
            `claims[${index}].evidence[${spanIndex}] needs a page, section or quote locator`,
          );
        }
      });
    });
  }

  requireString(card.parser_version, 'parser_version', errors);
  requireString(card.prompt_schema_version, 'prompt_schema_version', errors);

  return { ok: errors.length === 0, errors };
}
