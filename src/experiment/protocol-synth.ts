import type { CompactCard } from '../knowledge/synthesis.js';

/** Prompt+schema version for provenance; bump when the instruction changes. */
export const PROTOCOL_PROMPT_VERSION = 'protocol-proposal-v1-prompt.4';

/**
 * Measured structure of an image corpus (docs/DATA_CONTRACTS.md §RunEnv
 * lineage). Without this the agent can only see a row count, so it correctly
 * marks the domain axis as unconfirmed even when `data describe` measured it.
 */
export interface CorpusStructureSummary {
  path: string;
  format: string;
  samples: number;
  domainAxis: string | null;
  domains: { name: string; count: number }[];
  classColumn: string | null;
  distinctClasses: number;
  splitCandidates: string[];
  warnings: string[];
}

export interface DatasetProfileSummary {
  present: boolean;
  files: {
    path: string;
    rows: number;
    columns: number;
    columnNames?: string[];
    labelCandidates: string[];
  }[];
  /** Present once an image/parquet corpus has been profiled. */
  corpora?: CorpusStructureSummary[];
  note: string;
}

/**
 * Bounded digest of one paper's extracted experiment tables. Domain-neutral:
 * the platform never interprets what a column means, it only hands the agent
 * the numbers that were measured off the page (docs/DOMAIN_ADAPTERS.md
 * 协议自动综合流程 lists tables as a required input).
 */
export interface TableDigest {
  source: string;
  tables: { page: number; rows: string[][] }[];
}

/** Registered comparison methods as design evidence: entry point, license, status. */
export interface ComparisonDigest {
  methodId: string;
  status: string;
  required: boolean;
  entry: string[] | string | null;
  license: string | null;
  sourceKind: string | null;
  readme: string | null;
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
  /** Experiment tables, when `ingest --tables` has run. */
  tables?: TableDigest[];
  /** Registered comparisons, when any exist. */
  comparisons?: ComparisonDigest[];
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
  tables?: TableDigest[];
  comparisons?: ComparisonDigest[];
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
    ...(opts.tables && opts.tables.length > 0 ? { tables: opts.tables } : {}),
    ...(opts.comparisons && opts.comparisons.length > 0 ? { comparisons: opts.comparisons } : {}),
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
  ' "slicing": {"value": [{"fold": string, "holdoutColumn": string|null,',
  '   "holdoutValues": [string], "clientColumn": string|null, "stratifyBy": string|null,',
  '   "seed": integer}], "source": string, "confidence": number},',
  ' "leakageChecks": [string],',
  ' "preprocessing": [string],',
  ' "baselineEntries": [{"methodId": string, "entry": string, "source": string, "confidence": number}],',
  ' "primaryMetrics": [{"name": string, "direction": "higher"|"lower", "unit": "percent"|"fraction"|"count"|"ratio"|"none", "source": string, "confidence": number}],',
  ' "secondaryMetrics": [{"name": string, "direction": "higher"|"lower", "unit": "percent"|"fraction"|"count"|"ratio"|"none", "source": string, "confidence": number}],',
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
  'when dataset.corpora is present its structure was MEASURED from the local corpus, not',
  'inferred: cite a domain axis, its values and per-domain counts as source "data-probe"',
  'with confidence >= 0.7, and prefer its splitCandidates over inventing a split; only mark',
  'a data property unconfirmed if it is absent from both files[] and corpora[].',
  'slicing[] is the machine-readable form of splitRules and must be emitted whenever the',
  'corpus has a measurable grouping column: one entry per evaluation fold, naming columns',
  'EXACTLY as they appear in dataset files[].columnNames or corpora[] (a column you invent',
  'will be rejected against the measured structure), holdoutValues taken verbatim from the',
  'measured values, clientColumn set when clients are simulated per group, and a fixed seed',
  'so every run reproduces. Use null for any axis the corpus does not actually have.',
  'when tables[] is present it holds numeric results transcribed from the papers: ground',
  'baseline entries, metric targets and resource estimates in them with source',
  '"paper-evidence" rather than inventing magnitudes; numbers you cannot trace to a table',
  'row or a card fact are agent-inference and must be flagged.',
  'when comparisons[] is present those methods are already registered with a code entry',
  'point: reuse their entry commands instead of proposing new ones, and treat their',
  'license/status as binding (a required method that is not smoke-tested blocks the gate).',
  'Propose structure, not vocabulary: name any additional parameter you need as its own',
  "key inside the existing slots; never assume the platform knows your field's terms.",
  'metrics direction must reflect how the paper reports them; baseline entries name the',
  'methods found in the corpus; stopConditions must include a budget bound. All arrays',
  'must be non-empty unless secondaryMetrics (may be empty).',
].join('\n');
