import type { CompactCard } from '../knowledge/synthesis.js';

/** Prompt+schema version for provenance; bump when the instruction changes. */
export const PROTOCOL_PROMPT_VERSION = 'protocol-proposal-v1-prompt.1';

export interface DatasetProfileSummary {
  present: boolean;
  files: { path: string; rows: number; columns: number; labelCandidates: string[] }[];
  note: string;
}

export interface ProtocolInput {
  question: string;
  corpusPapers: number;
  papers: {
    source: string;
    title: string;
    datasets: string[];
    metrics: string[];
    baselines: string[];
    topFindings: string[];
  }[];
  dataset: DatasetProfileSummary;
}

/**
 * Compact, evidence-grounded input for the Protocol Synthesis Agent: card
 * facts only (already verified by the Evidence Checker), plus the dataset
 * profile. When no user dataset exists the summary says so explicitly so the
 * agent must mark data-dependent rules as low-confidence agent-inferences
 * (the validator surfaces them for confirmation instead of trusting them).
 */
export function buildProtocolInput(opts: {
  question: string;
  cards: CompactCard[];
  datasetProfile: DatasetProfileSummary | null;
  /** Suffix from knowledge/dataset-candidates.json when discovery ran (Phase 4.5B). */
  discoveryNote?: string | null;
}): ProtocolInput {
  return {
    question: opts.question || '(no research question configured)',
    corpusPapers: opts.cards.length,
    papers: opts.cards.map((card) => ({
      source: card.source,
      title: card.title,
      datasets: card.datasets.slice(0, 10),
      metrics: card.metrics.slice(0, 10),
      baselines: card.topClaims
        .slice(0, 5)
        .map((claim) => claim.text)
        .filter(Boolean),
      topFindings: card.topClaims
        .slice(0, 5)
        .map((claim) => claim.text)
        .filter(Boolean),
    })),
    dataset: opts.datasetProfile ?? {
      present: false,
      files: [],
      note:
        'no user dataset registered (datasets/ empty or unscanned) — data-dependent rules must be low-confidence agent-inference and flagged for user confirmation' +
        (opts.discoveryNote ? `; ${opts.discoveryNote}` : ''),
    },
  };
}

export const PROTOCOL_INSTRUCTION = [
  'You are the Protocol Synthesis Agent. Propose an ExperimentalProtocolProposal grounded',
  'ONLY in the provided verified PaperCards and dataset profile.',
  'Do not call any tools. Output ONLY one JSON object with this shape:',
  '{',
  ' "taskDefinition": {"value": string, "source": one of [paper-evidence,code,data-probe,adapter-rule,agent-inference,user], "confidence": number},',
  ' "sampleUnit": {"value": string, "source": string, "confidence": number},',
  ' "labelSemantics": {"value": string, "source": string, "confidence": number},',
  ' "splitRules": {"value": [string], "source": string, "confidence": number},',
  ' "leakageChecks": [string],',
  ' "preprocessing": [string],',
  ' "baselineEntries": [{"methodId": string, "entry": string, "source": string, "confidence": number}],',
  ' "primaryMetrics": [{"name": string, "direction": "higher"|"lower", "source": string, "confidence": number}],',
  ' "secondaryMetrics": [{"name": string, "direction": "higher"|"lower", "source": string, "confidence": number}],',
  ' "statisticalSummary": [string],',
  ' "smokeTest": {"value": string, "source": string, "confidence": number},',
  ' "resourceEstimate": {"value": string, "source": string, "confidence": number},',
  ' "ablations": [string],',
  ' "supportCriteria": [string],',
  ' "refuteCriteria": [string],',
  ' "invalidRunCriteria": [string],',
  ' "stopConditions": [string]',
  '}',
  'Rules: confidence in [0,1]; use "user" source when the dataset profile says semantics',
  'are unconfirmed and keep confidence <= 0.6 so the confirmation gate lists them;',
  'metrics direction must reflect how the paper reports them; baseline entries name the',
  'methods found in the corpus; stopConditions must include a budget bound. All arrays',
  'must be non-empty unless secondaryMetrics (may be empty).',
].join('\n');
