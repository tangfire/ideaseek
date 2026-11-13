import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { stableJson } from '../experiment/spec.js';

/**
 * Mechanism Analyst (docs/AGENT_ROLES.md): inputs are PaperCard-derived
 * topic syntheses and failure boundaries (rejected/inconclusive idea
 * analyses); outputs are a mechanism/design-principle/contradiction
 * graph. Hard rule from the role table: 不能把相关性当因果机制 — enforced
 * machine-checkably by requiring `correlationCaution: true` on every
 * analysis. Platform-owned contract (ADR-009: no matching ARIS skill).
 */

export const MECHANISM_ANALYSIS_SCHEMA = 'mechanism-analysis-v1';

export interface MechanismEntry {
  name: string;
  designPrinciple: string;
  conditions: string[];
  groundedIn: { source: string; location: string }[];
}

export interface DesignPrincipleEntry {
  principle: string;
  supportsMechanisms: string[];
}

export interface ContradictionEntry {
  claimA: string;
  claimB: string;
  resolution: string;
  evidence: { source: string; location: string }[];
}

export interface MechanismAnalysis {
  contract: typeof MECHANISM_ANALYSIS_SCHEMA;
  mechanisms: MechanismEntry[];
  designPrinciples: DesignPrincipleEntry[];
  contradictions: ContradictionEntry[];
  /** Explicit correlation-vs-causation statement (role boundary). */
  causalityStatement: string;
  /** MUST be true — the role never presents correlation as causation. */
  correlationCaution: boolean;
}

export const MECHANISM_OUTPUT_CONTRACT = [
  `MECHANISM ANALYSIS (${MECHANISM_ANALYSIS_SCHEMA}) — return ONLY the envelope JSON, no prose, no fences.`,
  '{',
  '  "contract": "' + MECHANISM_ANALYSIS_SCHEMA + '",',
  '  "mechanisms": [{"name": string, "designPrinciple": string, "conditions": [string] ≥1, "groundedIn": [{"source": string, "location": string}]}] — at least 1',
  '  "designPrinciples": [{"principle": string, "supportsMechanisms": [string] ≥1}] — at least 1; each supportsMechanisms entry MUST name a declared mechanism',
  '  "contradictions": [{"claimA": string, "claimB": string, "resolution": string, "evidence": [{"source": string, "location": string}] ≥1}] — may be empty when no contradiction exists',
  '  "causalityStatement": string, // explicit statement of what the evidence does and does NOT establish causally',
  '  "correlationCaution": true     // literal true — correlation is never presented as causation',
  '}',
  'Rules:',
  '- Every groundedIn/evidence.source MUST be one of the context sources below (or "speculation" with a location that says what is assumed).',
  '- mechanisms come from persisted topic syntheses; failure boundaries come from idea analyses — cite them, do not invent new failures.',
].join('\n');

export interface MechanismContext {
  /** Sources the model may cite. */
  sources: string[];
  lines: string[];
}

export async function collectMechanismContext(root: string): Promise<MechanismContext> {
  const sources = new Set<string>(['speculation', 'research-map']);
  const lines: string[] = [];

  // Topic syntheses: mechanisms[] straight from persisted Phase 2 output.
  const synthDir = join(root, 'knowledge', 'syntheses');
  let synthNames: string[] = [];
  try {
    synthNames = (await readdir(synthDir)).filter((name) => name.endsWith('.json'));
  } catch {
    synthNames = [];
  }
  if (synthNames.length > 0) {
    lines.push('Topic syntheses (mechanism sources):');
    for (const name of synthNames.sort()) {
      try {
        const record = JSON.parse(await readFile(join(synthDir, name), 'utf8')) as {
          topic?: unknown;
          mechanisms?: { name?: unknown; principle?: unknown; conditions?: unknown[] }[];
        };
        const topic = typeof record.topic === 'string' ? record.topic : name;
        sources.add(`synthesis:${topic}`);
        lines.push(`  - ${topic}:`);
        for (const mechanism of record.mechanisms ?? []) {
          if (typeof mechanism?.name !== 'string') continue;
          const conditions = Array.isArray(mechanism.conditions)
            ? (mechanism.conditions as unknown[]).map(String).join('; ')
            : '';
          lines.push(
            `      · ${mechanism.name} — ${String(mechanism.principle ?? '')} [${conditions}]`,
          );
        }
      } catch {
        lines.push(`  - ${name}: (unreadable, skipped)`);
      }
    }
  } else {
    lines.push('Topic syntheses: none (run: ideaseek synthesize)');
  }

  // Failure boundaries: latest analysis verdict/class per idea.
  const ideasDir = join(root, 'ideas');
  let ideaNames: string[] = [];
  try {
    ideaNames = (await readdir(ideasDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    ideaNames = [];
  }
  const boundaries: string[] = [];
  for (const ideaId of ideaNames.sort()) {
    try {
      const files = (await readdir(join(ideasDir, ideaId))).filter((name) =>
        /^analysis-v\d+\.json$/.test(name),
      );
      files.sort();
      const latest = files[files.length - 1];
      if (!latest) continue;
      const analysis = JSON.parse(await readFile(join(ideasDir, ideaId, latest), 'utf8')) as {
        verdict?: unknown;
        failureClass?: unknown;
      };
      boundaries.push(
        `  - ${ideaId}: verdict=${String(analysis.verdict)} failureClass=${String(analysis.failureClass)}`,
      );
      sources.add(`idea-analysis:${ideaId}`);
    } catch {
      // unreadable analysis → skip
    }
  }
  if (boundaries.length > 0) {
    lines.push('Failure boundaries (from idea analyses):');
    lines.push(...boundaries);
  } else {
    lines.push('Failure boundaries: none recorded');
  }

  const { stat } = await import('node:fs/promises');
  try {
    await stat(join(root, 'knowledge', 'research-map.md'));
    lines.push('Research map: knowledge/research-map.md');
  } catch {
    lines.push('Research map: none');
  }

  return { sources: [...sources].sort(), lines };
}

export function buildMechanismRequest(context: MechanismContext): {
  instruction: string;
  inputHash: string;
  idempotencyKey: string;
} {
  const inputHash = sha256Of(stableJson({ contract: MECHANISM_ANALYSIS_SCHEMA, context }));
  const instruction = [
    'You are the Mechanism Analyst (docs/AGENT_ROLES.md).',
    'Build the mechanism / design-principle / contradiction graph from the persisted syntheses and failure boundaries.',
    'Hard rule: correlation is NEVER causation — the causalityStatement must say exactly what the evidence does and does not establish.',
    '',
    '---',
    '',
    MECHANISM_OUTPUT_CONTRACT,
    '',
    'Context (persisted, hashable sources only):',
    `Allowed evidence sources: ${context.sources.join(', ')}`,
    context.lines.join('\n'),
  ].join('\n');
  return { instruction, inputHash, idempotencyKey: `mechanism-analysis:${inputHash}` };
}

/** Parses + validates; enforces source membership and name cross-links. */
export function parseMechanismOutput(output: string, context: MechanismContext): MechanismAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `mechanism analysis output is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IdeaseekError('PARSE_FAILED', 'mechanism analysis output must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.contract !== MECHANISM_ANALYSIS_SCHEMA) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `mechanism analysis contract must be ${MECHANISM_ANALYSIS_SCHEMA}, got ${String(record.contract)}`,
    );
  }

  const errors: string[] = [];
  const nonEmpty = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;
  const allowed = new Set(context.sources);

  const checkEvidence = (list: unknown, where: string): void => {
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`${where} must be a non-empty array`);
      return;
    }
    list.forEach((raw, index) => {
      const item = raw as { source?: unknown; location?: unknown } | null;
      if (!item || !nonEmpty(item.source) || !nonEmpty(item.location)) {
        errors.push(`${where}[${index}] needs non-empty source and location`);
      } else if (!allowed.has(item.source)) {
        errors.push(
          `${where}[${index}].source "${item.source}" is not among the context sources (never invent evidence)`,
        );
      }
    });
  };

  const mechanisms = record.mechanisms;
  const mechanismNames = new Set<string>();
  if (!Array.isArray(mechanisms) || mechanisms.length === 0) {
    errors.push('mechanisms must be a non-empty array');
  } else {
    mechanisms.forEach((raw, index) => {
      const item = raw as Partial<MechanismEntry> | null;
      const where = `mechanisms[${index}]`;
      if (!item || !nonEmpty(item.name) || !nonEmpty(item.designPrinciple)) {
        errors.push(`${where} needs non-empty name and designPrinciple`);
        return;
      }
      mechanismNames.add(item.name);
      if (!Array.isArray(item.conditions) || item.conditions.length === 0) {
        errors.push(`${where}.conditions must be a non-empty array`);
      } else if (item.conditions.some((condition) => !nonEmpty(condition))) {
        errors.push(`${where}.conditions entries must be non-empty strings`);
      }
      checkEvidence(item.groundedIn, `${where}.groundedIn`);
    });
  }

  const principles = record.designPrinciples;
  if (!Array.isArray(principles) || principles.length === 0) {
    errors.push('designPrinciples must be a non-empty array');
  } else {
    principles.forEach((raw, index) => {
      const item = raw as Partial<DesignPrincipleEntry> | null;
      const where = `designPrinciples[${index}]`;
      if (!item || !nonEmpty(item.principle)) {
        errors.push(`${where} needs a non-empty principle`);
        return;
      }
      if (!Array.isArray(item.supportsMechanisms) || item.supportsMechanisms.length === 0) {
        errors.push(`${where}.supportsMechanisms must be a non-empty array`);
      } else {
        for (const name of item.supportsMechanisms) {
          if (!nonEmpty(name)) {
            errors.push(`${where}.supportsMechanisms entries must be non-empty strings`);
          } else if (!mechanismNames.has(name)) {
            errors.push(
              `${where}.supportsMechanisms references unknown mechanism "${name}" (declare it first)`,
            );
          }
        }
      }
    });
  }

  const contradictions = record.contradictions;
  if (!Array.isArray(contradictions)) {
    errors.push('contradictions must be an array (may be empty)');
  } else {
    contradictions.forEach((raw, index) => {
      const item = raw as Partial<ContradictionEntry> | null;
      const where = `contradictions[${index}]`;
      if (!item || !nonEmpty(item.claimA) || !nonEmpty(item.claimB) || !nonEmpty(item.resolution)) {
        errors.push(`${where} needs non-empty claimA, claimB and resolution`);
        return;
      }
      checkEvidence(item.evidence, `${where}.evidence`);
    });
  }

  if (!nonEmpty(record.causalityStatement)) {
    errors.push('causalityStatement must be a non-empty string');
  }
  if (record.correlationCaution !== true) {
    errors.push('correlationCaution must be true — correlation is never causation (role boundary)');
  }

  if (errors.length > 0) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `mechanism analysis violates contract: ${errors.slice(0, 5).join('; ')}`,
      { errors },
    );
  }
  return parsed as MechanismAnalysis;
}
