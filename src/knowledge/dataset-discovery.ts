import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of, sha256OfFile, type ContentHash } from '../core/hash.js';
import { writeFileAtomic } from '../core/atomic.js';
import { stableJson } from '../experiment/spec.js';
import type { ProjectRuntime } from '../workflow/runtime.js';
import { readManifest } from './organize.js';
import { createAcademicIndexClient, type AcademicIndexClient } from './academic-index.js';
import { assertAgainstSchema } from '../core/schema/index.js';

/**
 * Dataset Discovery Agent (docs/AGENT_ROLES.md, docs/CLI_SPEC.md
 * `datasets discover/list/explain`, docs/DATA_CONTRACTS.md §DatasetCandidate,
 * docs/ARIS_INTEGRATION_PLAN §P1 数据集发现).
 *
 * Build-vs-reuse gate (ARIS_INTEGRATION_PLAN §Build-vs-reuse gate):
 * 1. DSH has no dataset-discovery capability or tool.
 * 2. ARIS has no dataset-discovery skill; the closest material is the
 *    research-lit/openalex/semantic-scholar retrieval methodology, whose
 *    fetchers assume a shell-capable executor (see academic-index.ts §gate).
 *    This module absorbs the methodology instead of vendoring unusable prose:
 *    multi-source priority order with graceful degradation (research-lit D2
 *    contribute tracking → per-source status records), anti-hallucination
 *    grounding (ARIS verify_papers discipline → evidenceIds must exist and the
 *    candidate name must match that evidence), and DOI/url dedup semantics.
 * 3. Not a configuration problem: the missing piece is persistence with
 *    provenance against IdeaSeek's own contracts, which is exactly what this
 *    thin implementation adds. No second Agent Loop and no second task DB —
 *    the model call goes through HarnessAdapter.runTask like every other
 *    capability, and the artifact is a knowledge/ file + RunEvent.
 *
 * Hard rules encoded here:
 * - Discovery writes ONLY the discovery artifact (knowledge/dataset-candidates.json
 *   + knowledge/dataset-recommendations.md). It never writes datasets/, never
 *   registers DatasetSlices and never feeds Protocol/Experiment inputs: a
 *   candidate becomes experiment-eligible only after the user provides the
 *   data and links it (datasets link), and assertCandidateExperimentReady is
 *   the single promotion gate every future consumer must call.
 * - Every candidate records provenance per source: kind, ref, retrievedAt,
 *   content hash + hash basis, license, download status and user authorization
 *   (docs/ARIS_INTEGRATION_PLAN 验收: 不能把推荐数据当成已验证输入).
 * - Model enrichment is optional: `--harness none` still yields an honest
 *   artifact from deterministic evidence; model output is grounded and
 *   validated BEFORE any byte is written; blocks/quota failures leave the
 *   previous artifact untouched (rerun = idempotent recovery).
 * - Public datasets get a download proposal; large/restricted/unknown-access
 *   candidates require explicit user confirmation before authorization
 *   (datasets authorize --grant --confirm), and the decision is audited.
 */

export const DISCOVERY_SCHEMA = 'dataset-discovery-v1';
export const CANDIDATES_SCHEMA = 'dataset-candidates-v1';
/** Bumped whenever the harness instruction changes → inputHash changes. */
export const DISCOVERY_PROMPT_VERSION = 'dataset-discovery-prompt.1';

export type DiscoverySourceKind =
  'papers' | 'local-inputs' | 'comparisons' | 'tables' | 'research-map' | 'academic-index';

/** Sources tried when the user does not pass --sources (index is policy-gated). */
export const DEFAULT_DISCOVERY_SOURCES: readonly DiscoverySourceKind[] = [
  'papers',
  'local-inputs',
  'comparisons',
  'tables',
  'research-map',
];

export const ALL_DISCOVERY_SOURCES: readonly DiscoverySourceKind[] = [
  ...DEFAULT_DISCOVERY_SOURCES,
  'academic-index',
];

export type EvidenceKind =
  | 'papercard'
  | 'dataset-paper'
  | 'local-manifest'
  | 'comparison-readme'
  | 'experiment-table'
  | 'research-map'
  | 'academic-index';

export type SourceStatus = 'ok' | 'empty' | 'missing' | 'refused' | 'failed';

export type CandidateStatus =
  'recommended' | 'needs-access' | 'user-provided' | 'validated' | 'rejected';

export type AcquisitionMethod =
  'public-download' | 'registration' | 'request' | 'local-mount' | 'unknown';

export type SizeCategory = 'unknown' | 'small' | 'large';

export type DownloadStatus = 'none' | 'proposed' | 'authorized' | 'blocked' | 'local-present';

export type AuthorizationState = 'none' | 'granted' | 'denied';

/** Per-source run record: what was attempted, what happened, when, hashed. */
export interface DiscoverySourceReport {
  kind: DiscoverySourceKind;
  /** Path, artifact kind or index query this source read. */
  ref: string;
  status: SourceStatus;
  /** Why the source is not `ok` (and the fix hint when there is one). */
  reason: string | null;
  retrievedAt: number;
  /**
   * Hash of the source content when it is one readable body; null for
   * multi-artifact sources — each evidence record then carries its own hash.
   */
  contentHash: ContentHash | null;
  evidenceCount: number;
}

/** One grounded dataset-name mention. Candidates reference these by id. */
export interface DiscoveryEvidence {
  evidenceId: string;
  kind: EvidenceKind;
  sourceKind: DiscoverySourceKind;
  /** Project-relative path, artifact kind, landing url or index query. */
  ref: string;
  /** The dataset name grounded in this evidence (exact, pre-normalization). */
  name: string;
  /** Bounded verbatim span carrying the mention. */
  quote: string;
  retrievedAt: number;
  contentHash: ContentHash;
  /** What contentHash hashes: a file, an artifact body, an API response or a stable record. */
  hashBasis: 'file' | 'artifact' | 'response' | 'record';
  /** Indexed paper this mention came from (paperKeys for grounding). */
  paperKey: string | null;
  url: string | null;
  indexId: string | null;
}

/** Facts about data the user already has (from manifest/describe/config). */
export interface LocalFact {
  evidenceId: string;
  paths: string[];
  bytes: number | null;
  size: SizeCategory;
  /** Single hashed file → content-derived snapshot id; null when multi-part. */
  snapshotId: string | null;
  sha256: ContentHash | null;
  licenseHint: string | null;
  /** A deterministic dataset card/profile exists for this data. */
  profiled: boolean;
  /** Configured readonly dataset outside the scan roots. */
  external: boolean;
  /** e.g. "1200 rows × 8 columns" — a scale fact from the dataset card. */
  scaleHint: string | null;
}

export interface CandidateLicense {
  value: string;
  confidence: number;
  note: string;
}

export interface CandidateAccess {
  acquisition: AcquisitionMethod;
  restricted: boolean;
  size: SizeCategory;
  url: string | null;
  indexId: string | null;
  /** 获取方式: how to obtain it (free text; "unknown" is honest). */
  instructions: string;
}

export interface CandidateAuthorization {
  state: AuthorizationState;
  decidedBy: string | null;
  decidedAt: number | null;
  reason: string | null;
}

export interface DatasetCandidate {
  /** Stable id: `ds-` + normalized name (dedup key). */
  candidateId: string;
  name: string;
  status: CandidateStatus;
  /** 任务/用途. */
  task: string;
  /** 字段/样本单位说明. */
  unit: string;
  /** 规模 (free text, null when no source states it). */
  scale: string | null;
  license: CandidateLicense;
  access: CandidateAccess;
  relatedPapers: string[];
  relevance: { question: string; reason: string };
  confidence: number;
  confidenceBasis: string[];
  evidenceIds: string[];
  /** Present only when the user's data is actually in the project. */
  local: { path: string; sha256: ContentHash | null; datasetSnapshotId: string | null } | null;
  downloadStatus: DownloadStatus;
  authorization: CandidateAuthorization;
  discoveredAt: number;
  notes: string[];
}

export interface DatasetDiscoveryArtifact {
  contract: typeof DISCOVERY_SCHEMA;
  generatedAt: number;
  inputHash: ContentHash;
  /** `deterministic` (no model) or the harness kind used for enrichment. */
  mode: string;
  harnessRuntime: string | null;
  question: string | null;
  sources: DiscoverySourceReport[];
  evidence: DiscoveryEvidence[];
  candidates: DatasetCandidate[];
  /** True while any requested source is missing/refused/failed. */
  incompleteSources: boolean;
  notes: string[];
}

export interface DiscoveryContext {
  question: string | null;
  sources: DiscoverySourceReport[];
  evidence: DiscoveryEvidence[];
  facts: LocalFact[];
}

// ---------------------------------------------------------------------------
// Name normalization and grounded mention extraction
// ---------------------------------------------------------------------------

/**
 * Dedup key: case/punctuation-insensitive so "MNIST" / "mnist " / "MNIST!"
 * collapse to one candidate. Unicode letters stay (dataset names may be CJK).
 */
export function normalizeDatasetName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function candidateIdFor(name: string): string {
  const slug = normalizeDatasetName(name).slice(0, 48);
  if (slug) return `ds-${slug}`;
  return `ds-${sha256Of(name).slice(7, 19)}`;
}

function makeEvidenceId(sourceKind: DiscoverySourceKind, ref: string, name: string): string {
  const norm = normalizeDatasetName(name) || name.trim().toLowerCase();
  return `ev-${sha256Of(`${sourceKind}|${ref}|${norm}`).slice(7, 19)}`;
}

/** Leading words that never belong to a dataset name. */
const LEADING_STOPWORDS = new Set([
  'the',
  'this',
  'that',
  'these',
  'those',
  'our',
  'a',
  'an',
  'their',
  'its',
  'we',
  'you',
  'it',
]);

/** A capture composed only of these words is generic prose, not a name. */
const COMMON_WORDS = new Set([
  ...LEADING_STOPWORDS,
  'new',
  'each',
  'any',
  'both',
  'same',
  'such',
  'used',
  'using',
  'based',
  'model',
  'models',
  'method',
  'methods',
  'proposed',
  'above',
  'below',
  'whole',
  'total',
  'main',
  'extra',
  'full',
  'tiny',
  'small',
  'large',
  'standard',
  'public',
  'private',
  'own',
  'first',
  'second',
  'other',
  'more',
  'most',
  'few',
  'many',
  'given',
  'present',
  'real',
  'one',
  'two',
  'recent',
  'different',
  'various',
  'specific',
  'current',
  'training',
  'test',
  'validation',
  'dataset',
  'benchmark',
  'corpus',
]);

/**
 * Mention patterns (deterministic, best-effort — every hit keeps its quote so
 * a researcher can audit what the extractor saw):
 * 1. "MNIST dataset" / "CIFAR-10 benchmark" — proper-noun lead token;
 * 2. "Penn Treebank, a large-scale dataset" — appositive;
 * 3. "(FEMNIST) dataset" — parenthetical short name.
 */
const MENTION_PATTERNS: RegExp[] = [
  // "MNIST dataset" / "CIFAR-10 benchmark" — proper-noun lead token. Every
  // token must start uppercase/digit so the match cannot reach backwards
  // through lowercase sentence words ("We evaluate on the MNIST dataset").
  /\b([A-Z][A-Za-z0-9.+-]*(?:[ ][A-Z0-9][A-Za-z0-9.+-]*){0,5})[ ](?:dataset|benchmark|corpus)\b/g,
  // "GLUE: A benchmark for …" / "Penn Treebank, a large-scale corpus" — title case kept,
  // the article accepts capitalized forms because paper titles capitalize them
  /\b([A-Z][A-Za-z0-9.+-]*(?:[ ][A-Z][A-Za-z0-9.+-]*){0,4})[,:]\s*(?:[Aa]n?|[Oo]ur|[Tt]he)\s+(?:[a-z-]+\s+){0,2}(?:dataset|benchmark|corpus)\b/g,
  // "(FEMNIST) dataset" — parenthetical short name
  /\(([A-Z][A-Za-z0-9+-]{1,24})\)[ ](?:dataset|benchmark|corpus)\b/g,
];

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const MAX_MENTIONS_PER_SOURCE = 25;
const MAX_QUOTE = 240;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isValidMention(name: string): boolean {
  const trimmed = collapseWhitespace(name).replace(/^[(\s]+|[),.;:!?"']+$/g, '');
  if (trimmed.length < 2 || trimmed.length > 80) return false;
  if (!normalizeDatasetName(trimmed)) return false;
  const tokens = trimmed
    .toLowerCase()
    .split(/[^a-z0-9.+-]+/)
    .filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => COMMON_WORDS.has(token))) return false;
  return true;
}

function stripLeadingStopwords(name: string): string {
  const tokens = collapseWhitespace(name).split(' ');
  while (tokens.length > 1 && LEADING_STOPWORDS.has((tokens[0] ?? '').toLowerCase())) {
    tokens.shift();
  }
  return tokens.join(' ');
}

function quoteWindow(text: string, start: number, length: number): string {
  const from = Math.max(0, start - 80);
  const to = Math.min(text.length, start + length + 80);
  return collapseWhitespace(text.slice(from, to)).slice(0, MAX_QUOTE);
}

export interface MentionHit {
  name: string;
  quote: string;
  url: string | null;
}

/**
 * Extracts grounded dataset mentions from free text: pattern hits plus
 * corroboration of names already known from structured sources (papers/local
 * inputs first, so README/map/table text attaches to the same candidate).
 */
export function extractDatasetMentions(text: string, knownNames?: Iterable<string>): MentionHit[] {
  const hits: MentionHit[] = [];
  const seen = new Set<string>();
  const push = (rawName: string, quote: string): void => {
    if (hits.length >= MAX_MENTIONS_PER_SOURCE) return;
    const name = stripLeadingStopwords(rawName);
    if (!isValidMention(name)) return;
    const norm = normalizeDatasetName(name);
    if (seen.has(norm)) return;
    seen.add(norm);
    const urlMatch = URL_RE.exec(quote);
    URL_RE.lastIndex = 0;
    hits.push({ name, quote: quote.slice(0, MAX_QUOTE), url: urlMatch ? urlMatch[0] : null });
  };

  for (const pattern of MENTION_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      const index = match.index ?? 0;
      push(raw, quoteWindow(text, index, match[0].length));
      if (hits.length >= MAX_MENTIONS_PER_SOURCE) break;
    }
  }

  for (const known of knownNames ?? []) {
    if (hits.length >= MAX_MENTIONS_PER_SOURCE) break;
    const at = text.toLowerCase().indexOf(known.toLowerCase());
    if (at < 0) continue;
    push(known, quoteWindow(text, at, known.length));
  }

  return hits;
}

function addEvidence(
  store: Map<string, DiscoveryEvidence>,
  input: Omit<DiscoveryEvidence, 'evidenceId'> & { name: string },
): DiscoveryEvidence {
  const evidenceId = makeEvidenceId(input.sourceKind, input.ref, input.name);
  const existing = store.get(evidenceId);
  if (existing) return existing;
  const evidence: DiscoveryEvidence = { ...input, evidenceId };
  store.set(evidenceId, evidence);
  return evidence;
}

// ---------------------------------------------------------------------------
// Source collectors
// ---------------------------------------------------------------------------

interface CardProfile {
  datasetSnapshotId: string;
  source: { path: string };
  rows: number;
  columns: { name: string }[];
  licenseHint: string | null;
}

interface ExternalDatasetManifestEntry {
  path: string;
  profile?: {
    rootHash?: string;
    clientCount?: number;
    fileCount?: number;
    splits?: Record<string, unknown>;
  };
}

function normalizeSourceList(raw: string[] | undefined): DiscoverySourceKind[] {
  const requested = raw ?? [...DEFAULT_DISCOVERY_SOURCES];
  const wanted = new Set<string>();
  for (const entry of requested) {
    for (const part of entry.split(',')) {
      const value = part.trim();
      if (value) wanted.add(value);
    }
  }
  for (const value of wanted) {
    if (!(ALL_DISCOVERY_SOURCES as readonly string[]).includes(value)) {
      throw new IdeaseekError(
        'INVALID_ARGUMENT',
        `unknown discovery source "${value}" (valid: ${ALL_DISCOVERY_SOURCES.join(', ')})`,
      );
    }
  }
  // Canonical order keeps the inputHash independent of flag order and runs
  // structured sources first so their names can corroborate text extraction.
  return ALL_DISCOVERY_SOURCES.filter((kind) => wanted.has(kind));
}

export { normalizeSourceList };

export interface CollectOptions {
  question: string | null;
  /** Ordered subset of ALL_DISCOVERY_SOURCES (use normalizeSourceList). */
  sources: DiscoverySourceKind[];
  now: number;
  /** Test injection; production creates the HTTP client internally. */
  indexClient?: AcademicIndexClient;
}

export interface CollectResult {
  sources: DiscoverySourceReport[];
  evidence: DiscoveryEvidence[];
  facts: LocalFact[];
  /** Display names of structured mentions, used to corroborate text sources. */
  knownNames: string[];
}

function pushSource(
  out: CollectResult,
  report: Omit<DiscoverySourceReport, 'evidenceCount'>,
  evidence: DiscoveryEvidence[],
  facts: LocalFact[],
): void {
  out.sources.push({ ...report, evidenceCount: evidence.length });
  for (const item of evidence) {
    const id = item.evidenceId;
    if (!out.evidence.some((existing) => existing.evidenceId === id)) out.evidence.push(item);
  }
  for (const fact of facts) {
    if (!out.facts.some((existing) => existing.evidenceId === fact.evidenceId))
      out.facts.push(fact);
  }
}

/** One store per collector: addEvidence dedups by evidenceId inside it. */
function newEvidenceStore(): Map<string, DiscoveryEvidence> {
  return new Map();
}

function storeValues(store: Map<string, DiscoveryEvidence>): DiscoveryEvidence[] {
  return [...store.values()];
}

async function collectPapers(
  runtime: ProjectRuntime,
  out: CollectResult,
  now: number,
): Promise<void> {
  const ref = 'artifact-kind:papercard';
  const artifacts = await runtime.db.listArtifactsByKind('papercard');
  const index = await runtime.db.listIndexedPapers();
  const keyBySource = new Map(index.map((entry) => [entry.source, entry.paperKey]));
  const store = newEvidenceStore();
  for (const artifact of artifacts) {
    let wrapper: { card?: Record<string, unknown>; source?: { sourcePath?: string } };
    try {
      wrapper = JSON.parse(
        await runtime.store.readFinalText(artifact.contentHash),
      ) as typeof wrapper;
    } catch {
      continue;
    }
    const card = wrapper.card;
    const sourcePath = wrapper.source?.sourcePath;
    if (!card || !sourcePath) continue;
    const datasets = Array.isArray(card.datasets)
      ? card.datasets.filter(
          (value): value is string => typeof value === 'string' && !!value.trim(),
        )
      : [];
    // A card whose title/problem talks about a dataset/benchmark is treated as
    // a dataset paper (the AGENT_ROLES "数据集论文" source) — a keyword
    // heuristic with the card text as its auditable basis.
    const kind: EvidenceKind = /\b(dataset|benchmark|corpus)\b/i.test(
      `${String(card.title ?? '')} ${String(card.problem ?? '')}`,
    )
      ? 'dataset-paper'
      : 'papercard';
    for (const name of datasets.slice(0, MAX_MENTIONS_PER_SOURCE)) {
      addEvidence(store, {
        kind,
        sourceKind: 'papers',
        ref: sourcePath,
        name: collapseWhitespace(name).slice(0, 120),
        quote: collapseWhitespace(name).slice(0, MAX_QUOTE),
        retrievedAt: now,
        contentHash: artifact.contentHash,
        hashBasis: 'artifact',
        paperKey: keyBySource.get(sourcePath) ?? null,
        url: null,
        indexId: null,
      });
    }
  }
  const evidence = storeValues(store);
  const status: SourceStatus = evidence.length > 0 ? 'ok' : 'empty';
  const reason =
    evidence.length > 0
      ? null
      : artifacts.length > 0
        ? `${artifacts.length} PaperCard(s) present but datasets[] entries are unknown/empty`
        : 'no PaperCards yet — run: ideaseek extract';
  pushSource(
    out,
    {
      kind: 'papers',
      ref,
      status,
      reason,
      retrievedAt: now,
      // Many artifacts: each evidence record carries its own contentHash.
      contentHash: null,
    },
    evidence,
    [],
  );
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Same formula as profileCsv/slice-csv: content-derived snapshot identity. */
function csvSnapshotId(sha256: string): string {
  return `data-${sha256.slice(7, 19)}`;
}

function federatedSnapshotId(rootHash: string): string {
  return `data-fed-${rootHash.slice(7, 19)}`;
}

function isSha256(value: unknown): value is ContentHash {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * Local inputs: what the researcher already provided (InputManifest data
 * files under datasets/, configured readonly datasets) plus the deterministic
 * dataset card/dataset manifest enrichments (license hint, profiled scale).
 * Directory/file names are inventory facts only — semantics stay unconfirmed.
 */
async function collectLocalInputs(
  runtime: ProjectRuntime,
  out: CollectResult,
  now: number,
): Promise<void> {
  const { paths, config } = runtime;
  const manifestPath = join(paths.knowledgeDir, 'input-manifest.json');
  const manifest = await readManifest(manifestPath);
  const store = newEvidenceStore();
  const facts: LocalFact[] = [];
  const notes: string[] = [];
  let manifestHash: ContentHash | null = null;
  if (manifest) manifestHash = await sha256OfFile(manifestPath);

  const cardFile = await readJsonFile<{ profiles?: CardProfile[] }>(
    join(paths.knowledgeDir, 'dataset-card.json'),
  );
  const profiles = cardFile?.profiles ?? [];
  const externalFile = await readJsonFile<{ datasets?: ExternalDatasetManifestEntry[] }>(
    join(paths.knowledgeDir, 'dataset-manifest.json'),
  );
  const externalEntries = externalFile?.datasets ?? [];

  // Group manifest data files into dataset units (first path segment under
  // datasets/, otherwise the file stem). Names are labels, not semantics.
  const prefix = `${config.inputs.datasetsDir.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  const groups = new Map<string, { relPath: string; sha256: string | null; bytes: number }[]>();
  if (manifest) {
    for (const file of manifest.files) {
      if (file.role !== 'data') continue;
      const rel = file.relPath.replace(/\\/g, '/');
      let unit: string;
      if (rel.startsWith(prefix)) {
        unit = rel.slice(prefix.length).split('/')[0] ?? '';
        if (unit && !unit.includes('/') && extname(unit)) unit = basename(unit, extname(unit));
      } else {
        unit = basename(rel, extname(rel));
      }
      if (!unit || unit === '.' || unit === '..') continue;
      const bucket = groups.get(unit) ?? [];
      bucket.push({ relPath: rel, sha256: file.sha256, bytes: file.bytes });
      groups.set(unit, bucket);
    }
  }

  const findProfile = (
    snapshotId: string | null,
    members: { relPath: string }[],
  ): CardProfile | null => {
    if (snapshotId) {
      const bySnapshot = profiles.find((profile) => profile.datasetSnapshotId === snapshotId);
      if (bySnapshot) return bySnapshot;
    }
    const names = new Set(members.map((member) => basename(member.relPath)));
    return profiles.find((profile) => names.has(profile.source.path)) ?? null;
  };

  for (const [unit, members] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ref =
      members
        .slice(0, 3)
        .map((member) => member.relPath)
        .join(', ') + (members.length > 3 ? ` (+${members.length - 3} more)` : '');
    const single = members.length === 1 ? members[0]! : null;
    const singleHash = isSha256(single?.sha256) ? single.sha256 : null;
    const contentHash: ContentHash = singleHash
      ? singleHash
      : sha256Of(
          stableJson(members.map((member) => ({ relPath: member.relPath, sha256: member.sha256 }))),
        );
    const evidence = addEvidence(store, {
      kind: 'local-manifest',
      sourceKind: 'local-inputs',
      ref,
      name: unit,
      quote: ref.slice(0, MAX_QUOTE),
      retrievedAt: now,
      contentHash,
      hashBasis: singleHash ? 'file' : 'record',
      paperKey: null,
      url: null,
      indexId: null,
    });
    const bytes = members.reduce((sum, member) => sum + member.bytes, 0);
    const snapshotId = singleHash ? csvSnapshotId(singleHash) : null;
    const profile = findProfile(snapshotId, members);
    facts.push({
      evidenceId: evidence.evidenceId,
      paths: members.map((member) => member.relPath),
      bytes,
      size: bytes > 1024 ** 3 ? 'large' : 'small',
      snapshotId,
      sha256: singleHash,
      licenseHint: profile?.licenseHint ?? null,
      profiled: profile !== null,
      external: false,
      scaleHint: profile ? `${profile.rows} rows × ${profile.columns.length} columns` : null,
    });
  }

  // Configured readonly datasets live outside the scan roots: their existence
  // is a user-declared fact; profile details come from dataset-manifest.json.
  for (const rootPath of config.inputs.readonlyDatasets) {
    try {
      await stat(rootPath);
    } catch {
      notes.push(`configured readonly dataset missing: ${rootPath}`);
      continue;
    }
    const clean = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const name = basename(clean) || clean;
    const entry = externalEntries.find((candidate) => candidate.path === rootPath);
    const rootHash = entry?.profile?.rootHash;
    const profiled = Boolean(entry?.profile);
    const evidence = addEvidence(store, {
      kind: 'local-manifest',
      sourceKind: 'local-inputs',
      ref: rootPath,
      name,
      quote: `configured readonly dataset: ${name}`,
      retrievedAt: now,
      contentHash: isSha256(rootHash) ? rootHash : sha256Of(`external:${rootPath}`),
      hashBasis: isSha256(rootHash) ? 'artifact' : 'record',
      paperKey: null,
      url: null,
      indexId: null,
    });
    facts.push({
      evidenceId: evidence.evidenceId,
      paths: [rootPath],
      bytes: null,
      size: 'unknown',
      snapshotId: isSha256(rootHash) ? federatedSnapshotId(rootHash) : null,
      sha256: isSha256(rootHash) ? rootHash : null,
      licenseHint: null,
      profiled,
      external: true,
      scaleHint: entry?.profile
        ? `${entry.profile.clientCount ?? '?'} clients, splits ${
            Object.keys(entry.profile.splits ?? {}).join('/') || 'unknown'
          }`
        : null,
    });
  }

  const evidence = storeValues(store);
  let status: SourceStatus;
  let reason: string | null;
  if (evidence.length > 0) {
    status = 'ok';
    reason = manifest
      ? null
      : 'input manifest missing — run: ideaseek scan to discover datasets/ (only configured readonly datasets were collected)';
  } else if (!manifest) {
    status = 'missing';
    reason =
      'no input manifest — run: ideaseek scan (local datasets cannot be discovered without it)';
  } else {
    status = 'empty';
    reason = 'no data files in the manifest — put data under datasets/ and run ideaseek scan';
  }
  for (const note of notes) reason = reason ? `${reason}; ${note}` : note;
  pushSource(
    out,
    {
      kind: 'local-inputs',
      ref: 'knowledge/input-manifest.json (+dataset-card.json, dataset-manifest.json)',
      status,
      reason,
      retrievedAt: now,
      contentHash: manifestHash,
    },
    evidence,
    facts,
  );
}

async function collectComparisons(
  runtime: ProjectRuntime,
  out: CollectResult,
  now: number,
): Promise<void> {
  const dir = join(runtime.paths.root, runtime.config.inputs.comparisonsDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    pushSource(
      out,
      {
        kind: 'comparisons',
        ref: runtime.config.inputs.comparisonsDir,
        status: 'missing',
        reason: `comparisons directory not found — register methods under ${runtime.config.inputs.comparisonsDir}/<id>/`,
        retrievedAt: now,
        contentHash: null,
      },
      [],
      [],
    );
    return;
  }
  const store = newEvidenceStore();
  const files: { rel: string; hash: ContentHash }[] = [];
  for (const entry of [...entries].sort()) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const sub = join(dir, entry);
    try {
      const info = await stat(sub);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    for (const fileName of ['README.md', 'method.yaml', 'method.yml']) {
      const filePath = join(sub, fileName);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) continue;
        const text = await readFile(filePath, 'utf8');
        const hash = await sha256OfFile(filePath);
        const rel = `${runtime.config.inputs.comparisonsDir}/${entry}/${fileName}`.replace(
          /\\/g,
          '/',
        );
        files.push({ rel, hash });
        for (const hit of extractDatasetMentions(text, out.knownNames)) {
          addEvidence(store, {
            kind: 'comparison-readme',
            sourceKind: 'comparisons',
            ref: rel,
            name: hit.name,
            quote: hit.quote,
            retrievedAt: now,
            contentHash: hash,
            hashBasis: 'file',
            paperKey: null,
            url: hit.url,
            indexId: null,
          });
        }
      } catch {
        // absent or unreadable file: other candidates in the method dir still count
      }
    }
  }
  const evidence = storeValues(store);
  pushSource(
    out,
    {
      kind: 'comparisons',
      ref: `${runtime.config.inputs.comparisonsDir}/*/README.md|method.yaml`,
      status: evidence.length > 0 ? 'ok' : 'empty',
      reason:
        evidence.length > 0
          ? null
          : files.length > 0
            ? `${files.length} comparison file(s) read but no dataset-shaped names inside`
            : 'no comparison README/method.yaml yet — add methods under comparisons/<id>/',
      retrievedAt: now,
      contentHash: files.length === 1 ? files[0]!.hash : null,
    },
    evidence,
    [],
  );
}

async function collectTables(
  runtime: ProjectRuntime,
  out: CollectResult,
  now: number,
): Promise<void> {
  const artifacts = await runtime.db.listArtifactsByKind('paper-tables');
  const index = await runtime.db.listIndexedPapers();
  const keyBySource = new Map(index.map((entry) => [entry.source, entry.paperKey]));
  const store = newEvidenceStore();
  const hashes: ContentHash[] = [];
  for (const artifact of artifacts) {
    let payload: {
      source?: string;
      sourceHash?: string;
      tables?: unknown;
    };
    try {
      payload = JSON.parse(
        await runtime.store.readFinalText(artifact.contentHash),
      ) as typeof payload;
    } catch {
      continue;
    }
    const ref = payload.source ?? 'unknown-source';
    const hash: ContentHash | null = isSha256(payload.sourceHash) ? payload.sourceHash : null;
    if (hash) hashes.push(hash);
    else hashes.push(artifact.contentHash);
    const text = JSON.stringify(payload.tables ?? '');
    for (const hit of extractDatasetMentions(text, out.knownNames)) {
      addEvidence(store, {
        kind: 'experiment-table',
        sourceKind: 'tables',
        ref,
        name: hit.name,
        quote: hit.quote,
        retrievedAt: now,
        contentHash: hash ?? artifact.contentHash,
        hashBasis: hash ? 'file' : 'artifact',
        paperKey: keyBySource.get(ref) ?? null,
        url: hit.url,
        indexId: null,
      });
    }
  }
  const evidence = storeValues(store);
  pushSource(
    out,
    {
      kind: 'tables',
      ref: 'artifact-kind:paper-tables',
      status: evidence.length > 0 ? 'ok' : 'empty',
      reason:
        evidence.length > 0
          ? null
          : artifacts.length > 0
            ? `${artifacts.length} table extract(s) present but no dataset-shaped names inside`
            : 'no extracted experiment tables — opt-in: ideaseek ingest --tables',
      retrievedAt: now,
      contentHash: hashes.length === 1 ? hashes[0]! : null,
    },
    evidence,
    [],
  );
}

async function collectResearchMap(
  runtime: ProjectRuntime,
  out: CollectResult,
  now: number,
): Promise<void> {
  const rel = 'knowledge/research-map.md';
  const filePath = join(runtime.paths.knowledgeDir, 'research-map.md');
  let text: string;
  let hash: ContentHash;
  try {
    text = await readFile(filePath, 'utf8');
    hash = await sha256OfFile(filePath);
  } catch {
    pushSource(
      out,
      {
        kind: 'research-map',
        ref: rel,
        status: 'missing',
        reason: 'no research map — run: ideaseek synthesize first',
        retrievedAt: now,
        contentHash: null,
      },
      [],
      [],
    );
    return;
  }
  const store = newEvidenceStore();
  for (const hit of extractDatasetMentions(text, out.knownNames)) {
    addEvidence(store, {
      kind: 'research-map',
      sourceKind: 'research-map',
      ref: rel,
      name: hit.name,
      quote: hit.quote,
      retrievedAt: now,
      contentHash: hash,
      hashBasis: 'file',
      paperKey: null,
      url: hit.url,
      indexId: null,
    });
  }
  const evidence = storeValues(store);
  pushSource(
    out,
    {
      kind: 'research-map',
      ref: rel,
      status: evidence.length > 0 ? 'ok' : 'empty',
      reason: evidence.length > 0 ? null : 'research map read but no dataset-shaped names inside',
      retrievedAt: now,
      contentHash: hash,
    },
    evidence,
    [],
  );
}

/**
 * Academic index (OpenAlex + Semantic Scholar). Three explicit refusals keep
 * the boundary honest: external_search off, allow_network off, no question —
 * each records a refused source instead of silently skipping. Transport
 * failures record a failed source with the per-endpoint error.
 */
async function collectAcademicIndex(
  runtime: ProjectRuntime,
  out: CollectResult,
  opts: CollectOptions,
): Promise<void> {
  const { now, question } = opts;
  const ref = `openalex + semantic-scholar query: "${(question ?? '').slice(0, 60)}"`;
  const refuse = (reason: string): void => {
    pushSource(
      out,
      {
        kind: 'academic-index',
        ref,
        status: 'refused',
        reason,
        retrievedAt: now,
        contentHash: null,
      },
      [],
      [],
    );
  };
  if (!runtime.config.research.externalSearch) {
    refuse(
      'research.external_search is false — external academic index queries are disabled (set external_search: true in research.yaml to allow them)',
    );
    return;
  }
  if (!runtime.config.runtime.allowNetwork) {
    refuse(
      'runtime.allow_network is false — network access is disabled (set allow_network: true in research.yaml to allow index queries)',
    );
    return;
  }
  if (!question || !question.trim()) {
    refuse('no research question configured (research.question) — index queries need a query');
    return;
  }

  const client = opts.indexClient ?? createAcademicIndexClient();
  const query = `${question.trim().slice(0, 160)} dataset`;
  let result;
  try {
    result = await client.search(query, { limit: 10 });
  } catch (error) {
    pushSource(
      out,
      {
        kind: 'academic-index',
        ref: `openalex + semantic-scholar query: "${query}"`,
        status: 'failed',
        reason: `network refused: ${(error as Error).message.slice(0, 200)}`,
        retrievedAt: now,
        contentHash: null,
      },
      [],
      [],
    );
    return;
  }

  const hashByEndpoint = new Map(
    result.endpoints.map((endpoint) => [endpoint.endpoint, endpoint.contentHash]),
  );
  const failed = result.endpoints.filter((endpoint) => !endpoint.ok);
  const succeeded = result.endpoints.filter((endpoint) => endpoint.ok);

  if (succeeded.length === 0) {
    pushSource(
      out,
      {
        kind: 'academic-index',
        ref: `openalex + semantic-scholar query: "${query}"`,
        status: 'failed',
        reason: `index query failed — ${failed
          .map((endpoint) => `${endpoint.endpoint}: ${endpoint.error ?? 'unknown error'}`)
          .join('; ')}`,
        retrievedAt: now,
        contentHash: null,
      },
      [],
      [],
    );
    return;
  }

  const store = newEvidenceStore();
  const seen = new Set<string>();
  let added = 0;
  for (const hit of result.hits) {
    if (added >= MAX_MENTIONS_PER_SOURCE) break;
    const text = `${hit.title}. ${hit.abstract ?? ''}`;
    for (const mention of extractDatasetMentions(text, out.knownNames)) {
      if (added >= MAX_MENTIONS_PER_SOURCE) break;
      // One evidence record per dataset name across all index hits: the first
      // hit carrying the name wins, so a popular dataset cannot flood the list.
      const norm = normalizeDatasetName(mention.name);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      const endpointHash = hashByEndpoint.get(hit.endpoint);
      addEvidence(store, {
        kind: 'academic-index',
        sourceKind: 'academic-index',
        ref: hit.url ?? hit.indexId ?? hit.title,
        name: mention.name,
        quote: mention.quote,
        retrievedAt: now,
        contentHash: endpointHash ?? sha256Of(`${hit.endpoint}:${hit.indexId ?? hit.title}`),
        hashBasis: endpointHash ? 'response' : 'record',
        paperKey: null,
        url: mention.url ?? hit.url,
        indexId: hit.indexId,
      });
      added += 1;
    }
  }

  const endpointNotes = failed.length
    ? `partial: ${failed
        .map((endpoint) => `${endpoint.endpoint}: ${endpoint.error ?? 'error'}`)
        .join('; ')}`
    : null;
  const evidence = storeValues(store);
  const compositeHash = succeeded.every((endpoint) => endpoint.contentHash)
    ? sha256Of(stableJson(succeeded.map((endpoint) => endpoint.contentHash)))
    : null;
  const status: SourceStatus = evidence.length > 0 ? 'ok' : 'empty';
  const reason =
    evidence.length > 0
      ? endpointNotes
      : endpointNotes
        ? `index responded but no dataset-shaped names in the top results (${endpointNotes})`
        : 'index responded but no dataset-shaped names in the top results';
  pushSource(
    out,
    {
      kind: 'academic-index',
      ref: `openalex + semantic-scholar query: "${query}"`,
      status,
      reason,
      retrievedAt: now,
      contentHash: compositeHash,
    },
    evidence,
    [],
  );
}

/**
 * Runs every requested source in canonical order (structured sources first so
 * their names corroborate free-text extraction) and records one status report
 * per source. Missing/failed/refused sources never abort the run — they mark
 * the artifact incomplete with a fix hint (fail-open collection, fail-closed
 * writes: the artifact only commits after full validation downstream).
 */
export async function collectDiscoverySources(
  runtime: ProjectRuntime,
  opts: CollectOptions,
): Promise<CollectResult> {
  const out: CollectResult = { sources: [], evidence: [], facts: [], knownNames: [] };
  const known = new Map<string, string>();
  const noteKnown = (): void => {
    for (const item of out.evidence) {
      const norm = normalizeDatasetName(item.name);
      if (norm && !known.has(norm)) known.set(norm, item.name);
    }
    out.knownNames = [...known.values()];
  };
  for (const kind of opts.sources) {
    switch (kind) {
      case 'papers':
        await collectPapers(runtime, out, opts.now);
        break;
      case 'local-inputs':
        await collectLocalInputs(runtime, out, opts.now);
        break;
      case 'comparisons':
        await collectComparisons(runtime, out, opts.now);
        break;
      case 'tables':
        await collectTables(runtime, out, opts.now);
        break;
      case 'research-map':
        await collectResearchMap(runtime, out, opts.now);
        break;
      case 'academic-index':
        await collectAcademicIndex(runtime, out, opts);
        break;
    }
    noteKnown();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery context, input hash and the harness request
// ---------------------------------------------------------------------------

export function buildDiscoveryContext(
  collected: CollectResult,
  question: string | null,
): DiscoveryContext {
  return {
    question,
    sources: collected.sources,
    evidence: collected.evidence,
    facts: collected.facts,
  };
}

/** Evidence ordering for prompts and display: structured sources first. */
const EVIDENCE_PRIORITY: Record<DiscoverySourceKind, number> = {
  papers: 0,
  comparisons: 1,
  tables: 2,
  'research-map': 3,
  'academic-index': 4,
  'local-inputs': 5,
};

function sortEvidence(evidence: DiscoveryEvidence[]): DiscoveryEvidence[] {
  return [...evidence].sort(
    (a, b) =>
      EVIDENCE_PRIORITY[a.sourceKind] - EVIDENCE_PRIORITY[b.sourceKind] ||
      a.evidenceId.localeCompare(b.evidenceId),
  );
}

/**
 * Cache key over everything the output depends on: contract + prompt version,
 * generation mode (`none`/`fake`/`dsh`), the question, every source's status
 * and content hash, and the evidence ids. Timestamps are excluded so an
 * unchanged project reuses the artifact (idempotent recovery).
 */
export function computeDiscoveryInputHash(ctx: DiscoveryContext, mode: string): ContentHash {
  return sha256Of(
    stableJson({
      contract: DISCOVERY_SCHEMA,
      promptVersion: DISCOVERY_PROMPT_VERSION,
      mode,
      question: ctx.question,
      sources: ctx.sources.map((source) => ({
        kind: source.kind,
        ref: source.ref,
        status: source.status,
        reason: source.reason,
        contentHash: source.contentHash,
      })),
      // Evidence ids AND their content hashes: a re-extracted card or a
      // re-scanned file keeps its id (kind|ref|name) but changes the hash —
      // that must invalidate the cached artifact.
      evidence: ctx.evidence
        .map((evidence) => ({ evidenceId: evidence.evidenceId, contentHash: evidence.contentHash }))
        .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)),
    }),
  );
}

const OUTPUT_CONTRACT = `
# IdeaSeek output contract (${CANDIDATES_SCHEMA})

Reply with ONE JSON object and nothing else:

{"candidates": [{"name": "...", "task": "...", "unit": "...", "scale": "..."|null,
  "license": {"value": "license id or 'unknown'", "confidence": <0-1>, "note": "..."},
  "acquisition": "public-download|registration|request|local-mount|unknown",
  "restricted": <true|false>, "size": "small|large|unknown",
  "url": "https://..."|null, "indexId": "..."|null, "instructions": "...",
  "relatedPapers": ["<paperKey from ProvidedPaperRefs>"],
  "evidenceIds": ["ev-..."],
  "relevanceReason": "...",
  "confidence": <0-1>, "confidenceBasis": ["..."], "notes": ["..."]}],
 "notes": ["..."]}

Rules:
- EVERY candidate needs ≥1 evidenceIds entry from the Evidence list below and
  its name must match that evidence's name (case-insensitive). NEVER invent a
  dataset that is not grounded in the provided evidence.
- relatedPapers must be a subset of ProvidedPaperRefs (else []).
- Prefer literal "unknown" over guessing: task/unit/license/instructions stay
  "unknown" when the evidence does not state them. acquisition=public-download
  requires a url copied from the evidence; size=small ONLY when the evidence
  states a small size; restricted=true when registration, request terms or a
  license limit use.
- confidence is 0..1 with ≥1 confidenceBasis entry naming which evidence backs
  the estimate; unknown-backed guesses stay low.
- relevanceReason: 1-2 sentences connecting the dataset to the research
  question below.
- Discovery recommends only: never claim data is downloaded, validated or an
  experiment input.
- No prose, no markdown fence, no commentary outside the JSON object.
`.trim();

export interface DiscoveryRequest {
  instruction: string;
  inputHash: ContentHash;
  idempotencyKey: string;
  /** Evidence actually offered to the model (bounded, ordered). */
  evidence: DiscoveryEvidence[];
  providedPaperRefs: string[];
}

const MAX_EVIDENCE_FOR_MODEL = 60;

/**
 * Renders the harness instruction: role + output contract + grounded evidence
 * table + provided paper refs + source status summary. The same evidence list
 * becomes the `discovery_context` input fragment (the fake provider reads it).
 */
export function buildDiscoveryRequest(opts: {
  question: string | null;
  sources: DiscoverySourceReport[];
  evidence: DiscoveryEvidence[];
  mode: string;
}): DiscoveryRequest {
  const evidence = sortEvidence(opts.evidence).slice(0, MAX_EVIDENCE_FOR_MODEL);
  const truncated = opts.evidence.length - evidence.length;
  const providedPaperRefs = [
    ...new Set(
      evidence
        .map((item) => item.paperKey)
        .filter((key): key is string => typeof key === 'string' && !!key),
    ),
  ].sort();
  const inputHash = computeDiscoveryInputHash(
    {
      question: opts.question,
      sources: opts.sources,
      evidence: opts.evidence,
      facts: [],
    },
    opts.mode,
  );
  const evidenceLines = evidence.map(
    (item) =>
      `  - ${item.evidenceId}  ${item.kind}  name="${item.name}"  ref=${item.ref}` +
      `  quote=${item.quote}`,
  );
  const sourceLines = opts.sources.map(
    (source) => `  - ${source.kind}: ${source.status}${source.reason ? ` — ${source.reason}` : ''}`,
  );
  const instruction = [
    '# IdeaSeek Dataset Discovery (Dataset Discovery role, docs/AGENT_ROLES.md)',
    '',
    `Research question: ${opts.question ?? '(none configured)'}`,
    '',
    OUTPUT_CONTRACT,
    '',
    'Evidence (the ONLY grounding for candidate names and evidenceIds):',
    ...(evidenceLines.length > 0
      ? evidenceLines
      : ['  (no evidence collected — reply {"candidates": [], "notes": ["no evidence"]})']),
    ...(truncated > 0
      ? [`  (… ${truncated} further evidence record(s) omitted by the context bound)`]
      : []),
    '',
    'ProvidedPaperRefs (the ONLY allowed relatedPapers values):',
    ...(providedPaperRefs.length > 0
      ? providedPaperRefs.map((ref) => `  - ${ref}`)
      : ['  (none — relatedPapers must be [])']),
    '',
    'Source status (what the platform could and could not read):',
    ...sourceLines,
  ].join('\n');
  return {
    instruction,
    inputHash,
    idempotencyKey: `dataset-discovery:${inputHash}`,
    evidence,
    providedPaperRefs,
  };
}

// ---------------------------------------------------------------------------
// Model output validation, candidate assembly and merges
// ---------------------------------------------------------------------------

/** One validated model candidate (raw fields the platform then stamps). */
export interface ModelDatasetCandidate {
  name: string;
  task: string;
  unit: string;
  scale: string | null;
  license: CandidateLicense;
  acquisition: AcquisitionMethod;
  restricted: boolean;
  size: SizeCategory;
  url: string | null;
  indexId: string | null;
  instructions: string;
  relatedPapers: string[];
  evidenceIds: string[];
  relevanceReason: string;
  confidence: number;
  confidenceBasis: string[];
  notes: string[];
}

export interface ValidationExpected {
  evidence: { evidenceId: string; name: string }[];
  paperRefs: string[];
}

const ACQUISITIONS: readonly AcquisitionMethod[] = [
  'public-download',
  'registration',
  'request',
  'local-mount',
  'unknown',
];
const SIZES: readonly SizeCategory[] = ['unknown', 'small', 'large'];

/**
 * Fail-closed validation of the model's JSON (docs/DATA_CONTRACTS.md): the
 * grounding rules are anti-hallucination checks — a candidate name must match
 * one of its referenced evidence records, evidenceIds must exist, related
 * papers must come from the provided refs. Nothing is written when this fails.
 */
export function validateDatasetCandidatesOutput(
  value: unknown,
  expected: ValidationExpected,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['output must be a JSON object'] };
  }
  const record = value as Record<string, unknown>;
  if (record.notes !== undefined && !Array.isArray(record.notes)) {
    errors.push('notes must be an array');
  }
  const candidates = record.candidates;
  if (!Array.isArray(candidates)) {
    errors.push('candidates must be an array (may be empty)');
    return { ok: false, errors };
  }
  const evidenceById = new Map(expected.evidence.map((item) => [item.evidenceId, item.name]));
  const paperRefs = new Set(expected.paperRefs);

  for (const [index, entry] of candidates.entries()) {
    const item = entry as Partial<ModelDatasetCandidate> | null;
    const where = `candidates[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120) {
      errors.push(`${where}.name must be a non-empty string (≤120 chars)`);
    }
    if (typeof item.task !== 'string' || !item.task.trim()) {
      errors.push(`${where}.task must be a non-empty string (use "unknown")`);
    }
    if (typeof item.unit !== 'string' || !item.unit.trim()) {
      errors.push(`${where}.unit must be a non-empty string (use "unknown")`);
    }
    if (item.scale !== null && typeof item.scale !== 'string') {
      errors.push(`${where}.scale must be a string or null`);
    }
    const license = item.license as Partial<CandidateLicense> | undefined;
    if (!license || typeof license !== 'object') {
      errors.push(`${where}.license must be an object {value, confidence, note}`);
    } else {
      if (typeof license.value !== 'string' || !license.value.trim()) {
        errors.push(`${where}.license.value must be a non-empty string (use "unknown")`);
      }
      if (
        typeof license.confidence !== 'number' ||
        !Number.isFinite(license.confidence) ||
        license.confidence < 0 ||
        license.confidence > 1
      ) {
        errors.push(`${where}.license.confidence must be in [0,1]`);
      }
      if (typeof license.note !== 'string') {
        errors.push(`${where}.license.note must be a string`);
      }
    }
    if (!ACQUISITIONS.includes(item.acquisition as AcquisitionMethod)) {
      errors.push(`${where}.acquisition must be ${ACQUISITIONS.join('|')}`);
    }
    if (typeof item.restricted !== 'boolean') {
      errors.push(`${where}.restricted must be a boolean`);
    }
    if (!SIZES.includes(item.size as SizeCategory)) {
      errors.push(`${where}.size must be ${SIZES.join('|')}`);
    }
    if (item.url !== null && (typeof item.url !== 'string' || !item.url.trim())) {
      errors.push(`${where}.url must be a non-empty string or null`);
    }
    if (item.acquisition === 'public-download' && !(item.url && String(item.url).trim())) {
      errors.push(`${where}.url is required when acquisition is public-download`);
    }
    if (item.indexId !== null && typeof item.indexId !== 'string') {
      errors.push(`${where}.indexId must be a string or null`);
    }
    if (typeof item.instructions !== 'string' || !item.instructions.trim()) {
      errors.push(`${where}.instructions must be a non-empty string (use "unknown")`);
    }
    if (typeof item.relevanceReason !== 'string' || !item.relevanceReason.trim()) {
      errors.push(`${where}.relevanceReason must be a non-empty string`);
    }
    if (
      typeof item.confidence !== 'number' ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1
    ) {
      errors.push(`${where}.confidence must be in [0,1]`);
    }
    if (
      !Array.isArray(item.confidenceBasis) ||
      item.confidenceBasis.length === 0 ||
      item.confidenceBasis.some((entry_) => typeof entry_ !== 'string' || !entry_.trim())
    ) {
      errors.push(`${where}.confidenceBasis must have ≥1 non-empty entry`);
    }
    if (item.notes !== undefined && !Array.isArray(item.notes)) {
      errors.push(`${where}.notes must be an array`);
    }

    const related = item.relatedPapers;
    if (!Array.isArray(related) || related.some((ref) => typeof ref !== 'string')) {
      errors.push(`${where}.relatedPapers must be an array of strings`);
    } else {
      for (const ref of related) {
        if (!paperRefs.has(ref)) {
          errors.push(
            `${where}.relatedPapers entry "${ref}" is not among ProvidedPaperRefs (never invent papers)`,
          );
        }
      }
    }

    const ids = item.evidenceIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
      errors.push(`${where}.evidenceIds must be a non-empty array of evidence ids`);
    } else {
      let grounded = false;
      for (const id of ids) {
        const evidenceName = evidenceById.get(id);
        if (evidenceName === undefined) {
          errors.push(
            `${where}.evidenceIds entry "${id}" was not provided (never invent evidence)`,
          );
          continue;
        }
        if (
          typeof item.name === 'string' &&
          normalizeDatasetName(evidenceName) === normalizeDatasetName(item.name)
        ) {
          grounded = true;
        }
      }
      if (!grounded && typeof item.name === 'string' && item.name.trim()) {
        errors.push(
          `${where}.name "${item.name}" is not grounded in its evidence — the name must match` +
            ' (case-insensitive) one of the referenced evidence records (never invent datasets)',
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Parses + validates the harness output; throws PARSE_FAILED (fail-closed). */
export function parseDatasetCandidatesOutput(
  output: string,
  expected: ValidationExpected,
): ModelDatasetCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `dataset candidates output is not JSON: ${output.slice(0, 160)}`,
    );
  }
  const validation = validateDatasetCandidatesOutput(parsed, expected);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `dataset candidates failed validation: ${validation.errors.slice(0, 4).join('; ')}`,
      { errors: validation.errors.slice(0, 8) },
    );
  }
  // Defense in depth (JSON Schema authority): the grounding checks ran
  // first; the shared contract re-checks structure as a subset gate.
  assertAgainstSchema('dataset-candidates-v1', parsed);
  return (parsed as { candidates: ModelDatasetCandidate[] }).candidates;
}

// --- candidate assembly -----------------------------------------------------

/** Confidence floor per evidence kind (structured > text > index > name-only). */
const KIND_CONFIDENCE: Record<EvidenceKind, number> = {
  'dataset-paper': 0.5,
  papercard: 0.45,
  'comparison-readme': 0.45,
  'experiment-table': 0.4,
  'research-map': 0.4,
  'local-manifest': 0.4,
  'academic-index': 0.35,
};

function kindBasis(evidence: DiscoveryEvidence): string {
  switch (evidence.kind) {
    case 'dataset-paper':
      return `datasets[] entry in dataset/benchmark paper ${evidence.ref}`;
    case 'papercard':
      return `datasets[] entry in ${evidence.ref}`;
    case 'comparison-readme':
      return `comparison README/config ${evidence.ref}`;
    case 'experiment-table':
      return `experiment table in ${evidence.ref}`;
    case 'research-map':
      return `research map ${evidence.ref}`;
    case 'local-manifest':
      return `local input manifest entry: ${evidence.ref}`;
    case 'academic-index':
      return `academic index record ${evidence.ref}`;
  }
}

function deriveStatus(
  hasLocal: boolean,
  access: CandidateAccess,
  profiled: boolean,
): CandidateStatus {
  if (hasLocal) return profiled ? 'validated' : 'user-provided';
  if (
    access.restricted ||
    access.acquisition === 'registration' ||
    access.acquisition === 'request'
  ) {
    return 'needs-access';
  }
  return 'recommended';
}

function deriveDownloadStatus(hasLocal: boolean, access: CandidateAccess): DownloadStatus {
  if (hasLocal) return 'local-present';
  if (access.acquisition === 'public-download' && access.url) return 'proposed';
  return 'none';
}

/**
 * A download/authorization proposal needs explicit user confirmation unless it
 * is a public, small, unrestricted dataset the researcher already has locally
 * (docs/ARIS_INTEGRATION_PLAN: 大型或受限数据集必须要求用户确认; unknown size or
 * access stays conservative).
 */
export function requiresUserConfirmation(candidate: DatasetCandidate): boolean {
  if (
    candidate.status === 'rejected' ||
    candidate.status === 'user-provided' ||
    candidate.status === 'validated'
  ) {
    return false;
  }
  if (
    candidate.access.acquisition === 'local-mount' ||
    candidate.downloadStatus === 'local-present'
  ) {
    return false;
  }
  return (
    candidate.access.restricted ||
    candidate.access.size !== 'small' ||
    candidate.access.acquisition !== 'public-download'
  );
}

interface AssembleArgs {
  name: string;
  evidence: DiscoveryEvidence[];
  fact: LocalFact | null;
  question: string | null;
  now: number;
  model?: ModelDatasetCandidate;
}

function assembleCandidate(args: AssembleArgs): DatasetCandidate {
  const { evidence, fact, model, now } = args;
  const ordered = sortEvidence(evidence);

  // Access: local facts are platform truth; then the model's grounded claim;
  // otherwise a conservative deterministic default (unknown access = confirm).
  let access: CandidateAccess;
  if (fact) {
    access = {
      acquisition: 'local-mount',
      restricted: false,
      size: fact.size,
      url: null,
      indexId: null,
      instructions:
        'already present in this project — discovery does not copy, move or re-download it',
    };
  } else if (model) {
    access = {
      acquisition: model.acquisition,
      restricted: model.restricted,
      size: model.size,
      url: model.url,
      indexId: model.indexId,
      instructions: model.instructions,
    };
  } else {
    const url = ordered.map((item) => item.url).find((value) => value) ?? null;
    access = {
      acquisition: url ? 'public-download' : 'unknown',
      restricted: false,
      size: 'unknown',
      url,
      indexId: ordered.find((item) => item.sourceKind === 'academic-index')?.indexId ?? null,
      instructions: url
        ? `proposed download: ${url} — confirm size and license before use`
        : 'no obtain method stated in the provided sources — check the related papers or ask the researcher',
    };
  }

  const hasLocal = fact !== null;
  const status = deriveStatus(hasLocal, access, fact?.profiled ?? false);

  let license: CandidateLicense;
  if (fact?.licenseHint) {
    license = {
      value: fact.licenseHint,
      confidence: 0.5,
      note: 'LICENSE file next to the data (deterministic dataset card)',
    };
    if (model && model.license.value !== 'unknown' && model.license.value !== fact.licenseHint) {
      license = {
        ...license,
        note: `license conflict: dataset card says "${fact.licenseHint}", model inferred "${model.license.value}" — using the dataset card`,
      };
    }
  } else if (model) {
    license = model.license;
  } else {
    license = { value: 'unknown', confidence: 0, note: 'not stated in the provided sources' };
  }

  const relatedPapers = model
    ? [...new Set(model.relatedPapers)].sort()
    : [
        ...new Set(
          ordered
            .map((item) => item.paperKey)
            .filter((key): key is string => typeof key === 'string' && !!key),
        ),
      ].sort();

  const kinds = [...new Set(ordered.map((item) => item.kind))];
  let confidence: number;
  const confidenceBasis: string[] = [];
  if (model) {
    confidence = Math.min(0.95, Math.max(0, model.confidence));
    confidenceBasis.push(...model.confidenceBasis);
    for (const item of ordered.slice(0, 4)) confidenceBasis.push(kindBasis(item));
  } else {
    const base = Math.max(...ordered.map((item) => KIND_CONFIDENCE[item.kind] ?? 0.3), 0.1);
    confidence = Math.min(
      0.95,
      base + 0.1 * Math.max(0, kinds.length - 1) + (license.value !== 'unknown' ? 0.05 : 0),
    );
    for (const item of ordered.slice(0, 5)) confidenceBasis.push(kindBasis(item));
    if (kinds.length > 1) confidenceBasis.push(`corroborated by ${kinds.length} evidence kinds`);
    if (fact) confidenceBasis.push('local presence confirmed via the input manifest');
  }
  if (kinds.length > 1) {
    confidenceBasis.push(`grounded by ${kinds.length} distinct evidence kind(s)`);
  }

  const unit = model
    ? model.unit
    : fact
      ? fact.scaleHint
        ? `profiled ${fact.scaleHint}; sample-unit semantics need user confirmation`
        : 'sample-unit semantics need user confirmation'
      : 'unknown';
  const scale = model?.scale ?? fact?.scaleHint ?? null;
  const task = model?.task ?? 'unknown';
  const relevanceReason = model
    ? model.relevanceReason
    : `appears in ${ordered.length} evidence record(s) from the project corpus for this question` +
      ' — relevance inferred from presence, needs researcher confirmation';

  const notes = [...(model?.notes ?? [])];
  if (!model) notes.push('deterministic discovery (no model enrichment)');

  return {
    candidateId: candidateIdFor(args.name),
    name: model?.name ?? ordered[0]?.name ?? args.name,
    status,
    task,
    unit,
    scale,
    license,
    access,
    relatedPapers,
    relevance: { question: args.question ?? '', reason: relevanceReason },
    confidence: Number(confidence.toFixed(3)),
    confidenceBasis: [...new Set(confidenceBasis)].slice(0, 8),
    evidenceIds: ordered.map((item) => item.evidenceId),
    local: fact
      ? { path: fact.paths[0] ?? '', sha256: fact.sha256, datasetSnapshotId: fact.snapshotId }
      : null,
    downloadStatus: deriveDownloadStatus(hasLocal, access),
    authorization: { state: 'none', decidedBy: null, decidedAt: null, reason: null },
    discoveredAt: now,
    notes: [...new Set(notes)].slice(0, 8),
  };
}

function sortCandidates(candidates: DatasetCandidate[]): DatasetCandidate[] {
  return [...candidates].sort(
    (a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name),
  );
}

/** Deterministic candidates: grounded only in collected evidence (no model). */
export function buildDeterministicCandidates(
  ctx: DiscoveryContext,
  now: number,
): DatasetCandidate[] {
  const groups = new Map<string, DiscoveryEvidence[]>();
  for (const evidence of sortEvidence(ctx.evidence)) {
    const norm = normalizeDatasetName(evidence.name);
    if (!norm) continue;
    const bucket = groups.get(norm) ?? [];
    bucket.push(evidence);
    groups.set(norm, bucket);
  }
  const factByEvidenceId = new Map(ctx.facts.map((fact) => [fact.evidenceId, fact]));
  const candidates: DatasetCandidate[] = [];
  for (const [, evidenceList] of groups) {
    const fact =
      evidenceList
        .map((item) => factByEvidenceId.get(item.evidenceId))
        .find((value): value is LocalFact => Boolean(value)) ?? null;
    candidates.push(
      assembleCandidate({
        name: evidenceList[0]!.name,
        evidence: evidenceList,
        fact,
        question: ctx.question,
        now,
      }),
    );
  }
  return sortCandidates(candidates);
}

/** Stamps validated model candidates with platform-owned fields. */
export function stampModelCandidates(
  raw: ModelDatasetCandidate[],
  ctx: DiscoveryContext,
  now: number,
): DatasetCandidate[] {
  const evidenceById = new Map(ctx.evidence.map((item) => [item.evidenceId, item]));
  const factByEvidenceId = new Map(ctx.facts.map((fact) => [fact.evidenceId, fact]));
  const factByNorm = new Map<string, LocalFact>();
  for (const fact of ctx.facts) {
    const evidence = evidenceById.get(fact.evidenceId);
    if (evidence) {
      const norm = normalizeDatasetName(evidence.name);
      if (norm && !factByNorm.has(norm)) factByNorm.set(norm, fact);
    }
  }
  const byNorm = new Map<string, DatasetCandidate>();
  for (const item of raw) {
    const evidence = item.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((value): value is DiscoveryEvidence => Boolean(value));
    if (evidence.length === 0) continue; // unreachable: validation already required it
    const fact =
      factByNorm.get(normalizeDatasetName(item.name)) ??
      evidence
        .map((evidenceItem) => factByEvidenceId.get(evidenceItem.evidenceId))
        .find((value): value is LocalFact => Boolean(value)) ??
      null;
    const candidate = assembleCandidate({
      name: item.name,
      evidence,
      fact,
      question: ctx.question,
      now,
      model: item,
    });
    const norm = normalizeDatasetName(candidate.name);
    if (!norm) continue;
    if (!byNorm.has(norm)) byNorm.set(norm, candidate);
  }
  return sortCandidates([...byNorm.values()]);
}

/** Model enrichment wins on descriptive fields; platform truth stays put. */
export function mergeModelIntoDeterministic(
  deterministic: DatasetCandidate[],
  model: DatasetCandidate[],
): DatasetCandidate[] {
  const byId = new Map(deterministic.map((candidate) => [candidate.candidateId, candidate]));
  for (const enriched of model) {
    const base = byId.get(enriched.candidateId);
    if (!base) {
      byId.set(enriched.candidateId, enriched);
      continue;
    }
    const license = base.license.value !== 'unknown' ? base.license : enriched.license;
    const access = base.local ? base.access : enriched.access;
    const hasLocal = base.local !== null;
    const status = base.local
      ? base.status
      : enriched.status === 'rejected'
        ? 'rejected'
        : deriveStatus(false, access, false);
    const merged: DatasetCandidate = {
      ...base,
      name: enriched.name,
      task: enriched.task !== 'unknown' ? enriched.task : base.task,
      unit: enriched.unit !== 'unknown' ? enriched.unit : base.unit,
      scale: enriched.scale ?? base.scale,
      license,
      access,
      relatedPapers: [...new Set([...base.relatedPapers, ...enriched.relatedPapers])].sort(),
      relevance: enriched.relevance,
      confidence: Math.max(base.confidence, enriched.confidence),
      confidenceBasis: [...new Set([...enriched.confidenceBasis, ...base.confidenceBasis])].slice(
        0,
        8,
      ),
      evidenceIds: [...new Set([...base.evidenceIds, ...enriched.evidenceIds])].sort(),
      status,
      downloadStatus: deriveDownloadStatus(hasLocal, access),
      notes: [...new Set([...base.notes, ...enriched.notes])].slice(0, 8),
    };
    byId.set(merged.candidateId, merged);
  }
  return sortCandidates([...byId.values()]);
}

/**
 * Carries user decisions across discovery runs: authorization and `rejected`
 * are sticky; linked local data survives when this run could not re-check the
 * manifest; candidates the new run did not reconfirm are kept with an honest
 * note instead of silently disappearing.
 */
export function mergeWithPrevious(
  fresh: DatasetCandidate[],
  previous: DatasetCandidate[] | null,
  opts: { localSourcesChecked: boolean },
): DatasetCandidate[] {
  if (!previous || previous.length === 0) return sortCandidates(fresh);
  const prevById = new Map(previous.map((candidate) => [candidate.candidateId, candidate]));
  const freshIds = new Set(fresh.map((candidate) => candidate.candidateId));
  const merged = fresh.map((candidate) => {
    const prev = prevById.get(candidate.candidateId);
    if (!prev) return candidate;
    const authorization =
      prev.authorization.state !== 'none' ? prev.authorization : candidate.authorization;
    let local = candidate.local;
    let status = candidate.status;
    if (!local && !opts.localSourcesChecked && prev.local) {
      // The manifest could not be re-checked this run: keep the link as-is.
      local = prev.local;
      status = prev.status;
    }
    if (!local && prev.status === 'rejected') status = 'rejected';
    let downloadStatus = candidate.downloadStatus;
    if (local) downloadStatus = 'local-present';
    else if (authorization.state === 'denied') downloadStatus = 'blocked';
    else if (authorization.state === 'granted') downloadStatus = 'authorized';
    const notes = [...candidate.notes];
    if (prev.authorization.state !== 'none') {
      notes.push(`authorization ${prev.authorization.state} carried from the previous run`);
    }
    if (status === 'rejected' && prev.status === 'rejected') {
      notes.push('rejected by the researcher — kept across discovery runs');
    }
    return {
      ...candidate,
      authorization,
      local,
      status,
      downloadStatus,
      notes: [...new Set(notes)].slice(0, 8),
    };
  });
  for (const prev of previous) {
    if (freshIds.has(prev.candidateId)) continue;
    merged.push({
      ...prev,
      notes: [
        ...new Set([
          ...prev.notes,
          'carried forward from the previous discovery run — not reconfirmed by this run',
        ]),
      ].slice(0, 8),
    });
  }
  return sortCandidates(merged);
}

// ---------------------------------------------------------------------------
// Discovery artifact I/O, exports and the promotion gate
// ---------------------------------------------------------------------------

export function discoveryArtifactPath(root: string): string {
  return join(root, 'knowledge', 'dataset-candidates.json');
}

export function discoveryRecommendationsPath(root: string): string {
  return join(root, 'knowledge', 'dataset-recommendations.md');
}

/** Reads the discovery artifact; wrong contract/version → null (fail-closed). */
export async function readDiscoveryArtifact(
  root: string,
): Promise<DatasetDiscoveryArtifact | null> {
  try {
    const parsed = JSON.parse(
      await readFile(discoveryArtifactPath(root), 'utf8'),
    ) as DatasetDiscoveryArtifact;
    if (parsed.contract !== DISCOVERY_SCHEMA || !Array.isArray(parsed.candidates)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Human-readable recommendations export (docs/plan.md §dataset-recommendations).
 * The JSON artifact stays canonical; this markdown is a derived reading view.
 */
export function renderDiscoveryMarkdown(artifact: DatasetDiscoveryArtifact): string {
  const generatedAt = new Date(artifact.generatedAt).toISOString();
  const counts = new Map<string, number>();
  for (const candidate of artifact.candidates) {
    counts.set(candidate.status, (counts.get(candidate.status) ?? 0) + 1);
  }
  const lines: string[] = [
    '# Dataset recommendations',
    '',
    `- generated: ${generatedAt} · mode: ${artifact.mode} · inputHash: \`${artifact.inputHash}\``,
    `- research question: ${artifact.question ?? '(none configured)'}`,
    `- candidates: ${artifact.candidates.length} (${[...counts.entries()].map(([status, count]) => `${status}=${count}`).join(', ') || 'none'})`,
    artifact.incompleteSources
      ? '- ⚠ some sources were incomplete — see the source table before trusting absence'
      : '- all requested sources answered',
    '',
    '> **Discovery recommends only.** Candidates are not experiment inputs:',
    '> only data the researcher provides and links (`ideaseek datasets link`) can',
    '> back a DatasetSnapshot, slices and experiments. Large, restricted or',
    '> unknown-access datasets require explicit user confirmation before any',
    '> download or authorization (`ideaseek datasets authorize --grant --confirm`).',
    '',
    '## Sources',
    '',
    '| source | status | ref | evidence | reason |',
    '|---|---|---|---|---|',
    ...artifact.sources.map(
      (source) =>
        `| ${source.kind} | ${source.status} | \`${source.ref.slice(0, 60)}\` | ${source.evidenceCount} | ${source.reason ?? '—'} |`,
    ),
    '',
    '## Candidates',
    '',
    '| id | name | status | confidence | license | size | download | authorization |',
    '|---|---|---|---|---|---|---|---|',
    ...artifact.candidates.map(
      (candidate) =>
        `| \`${candidate.candidateId}\` | ${candidate.name} | ${candidate.status} | ${candidate.confidence} | ${candidate.license.value} | ${candidate.access.size} | ${candidate.downloadStatus} | ${candidate.authorization.state} |`,
    ),
    '',
  ];
  for (const candidate of artifact.candidates) {
    lines.push(
      `### ${candidate.name} (\`${candidate.candidateId}\`)`,
      '',
      `- status: **${candidate.status}** · confidence ${candidate.confidence}`,
      `- task: ${candidate.task}`,
      `- 字段/样本单位 (unit): ${candidate.unit}`,
      `- scale: ${candidate.scale ?? 'unknown'}`,
      `- license: ${candidate.license.value} (${candidate.license.confidence}) — ${candidate.license.note}`,
      `- access: ${candidate.access.acquisition}, restricted=${candidate.access.restricted}, size=${candidate.access.size}${
        candidate.access.url ? `, url: ${candidate.access.url}` : ''
      }`,
      `- 获取方式 (acquisition): ${candidate.access.instructions}`,
      `- related papers: ${candidate.relatedPapers.join(', ') || 'none in the local index'}`,
      `- relevance: ${candidate.relevance.reason || '—'}`,
      `- confidence basis: ${candidate.confidenceBasis.join('; ')}`,
      `- local: ${candidate.local ? `${candidate.local.path} (snapshot ${candidate.local.datasetSnapshotId ?? 'none'})` : 'not provided yet'}`,
      `- download status: ${candidate.downloadStatus} · authorization: ${candidate.authorization.state}${
        candidate.authorization.reason ? ` (${candidate.authorization.reason})` : ''
      }`,
      `- sources (${candidate.evidenceIds.length}):`,
      ...candidate.evidenceIds.map((id) => {
        const evidence = artifact.evidence.find((item) => item.evidenceId === id);
        if (!evidence) return `  - ${id} (missing — artifact incomplete)`;
        return (
          `  - ${id} ${evidence.kind} · ${evidence.ref} · retrieved ${new Date(evidence.retrievedAt).toISOString()}` +
          ` · ${evidence.contentHash.slice(0, 19)}… (${evidence.hashBasis}) · “${evidence.quote.slice(0, 120)}”`
        );
      }),
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Writes the canonical JSON artifact plus the markdown reading view. */
export async function writeDiscoveryExports(
  root: string,
  artifact: DatasetDiscoveryArtifact,
): Promise<string[]> {
  const jsonPath = discoveryArtifactPath(root);
  const mdPath = discoveryRecommendationsPath(root);
  await writeFileAtomic(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFileAtomic(mdPath, renderDiscoveryMarkdown(artifact));
  return [jsonPath, mdPath];
}

// --- promotion gate ---------------------------------------------------------

export interface ReadinessReport {
  ready: boolean;
  reasons: string[];
}

/**
 * The ONE check a future experiment/protocol consumer must run before treating
 * a candidate as data (DATA_CONTRACTS: 推荐不等于已下载或已验证；只有用户提供/授权
 * 并建立 DatasetSnapshot 后才能进入实验). Discovery itself never calls the
 * asserting variant — it only produces reasons for display.
 */
export function candidateExperimentReadiness(candidate: DatasetCandidate): ReadinessReport {
  const reasons: string[] = [];
  if (candidate.status === 'rejected') {
    reasons.push('candidate was rejected by the researcher');
  }
  if (candidate.status !== 'user-provided' && candidate.status !== 'validated') {
    reasons.push(
      `status is ${candidate.status} — only user-provided/validated candidates may back experiments`,
    );
  }
  if (!candidate.local) {
    reasons.push(
      'no local data linked — provide the file and run: ideaseek datasets link <id> --path <file>',
    );
  } else if (!candidate.local.datasetSnapshotId) {
    reasons.push(
      'linked data has no content-derived DatasetSnapshot — link the canonical data file',
    );
  }
  if (candidate.authorization.state === 'denied') {
    reasons.push('authorization was denied by the researcher');
  }
  return { ready: reasons.length === 0, reasons };
}

/** Asserting wrapper: throws USER_INPUT_REQUIRED unless the candidate is usable. */
export function assertCandidateExperimentReady(candidate: DatasetCandidate): void {
  const report = candidateExperimentReadiness(candidate);
  if (report.ready) return;
  throw new IdeaseekError(
    'USER_INPUT_REQUIRED',
    `dataset candidate ${candidate.candidateId} ("${candidate.name}") is a discovery recommendation, not experiment input: ` +
      report.reasons.join('; '),
    { candidateId: candidate.candidateId, status: candidate.status },
  );
}

// --- user decisions ---------------------------------------------------------

function withCandidate(
  artifact: DatasetDiscoveryArtifact,
  candidateId: string,
  update: (candidate: DatasetCandidate) => DatasetCandidate,
): { artifact: DatasetDiscoveryArtifact; candidate: DatasetCandidate } {
  let updated: DatasetCandidate | null = null;
  const candidates = artifact.candidates.map((candidate) => {
    if (candidate.candidateId !== candidateId) return candidate;
    updated = update(candidate);
    return updated;
  });
  if (!updated) {
    throw new IdeaseekError(
      'TASK_NOT_FOUND',
      `dataset candidate ${candidateId} not found — run: ideaseek datasets list`,
      { candidateId },
    );
  }
  return { artifact: { ...artifact, candidates }, candidate: updated };
}

export interface AuthorizeInput {
  /** true = grant (may download/obtain later), false = deny (reject). */
  grant: boolean;
  reason: string;
  by: string;
  now: number;
}

/**
 * Records the user's authorization decision on the artifact. This mutates
 * ONLY discovery state (status/downloadStatus/authorization) — never data,
 * slices or experiment inputs. Callers enforce the autonomy gate + Decision
 * event before invoking this (CLI: `datasets authorize`).
 */
export function authorizeCandidate(
  artifact: DatasetDiscoveryArtifact,
  candidateId: string,
  input: AuthorizeInput,
): { artifact: DatasetDiscoveryArtifact; candidate: DatasetCandidate } {
  const decision = {
    state: (input.grant ? 'granted' : 'denied') as AuthorizationState,
    decidedBy: input.by,
    decidedAt: input.now,
    reason: input.reason || null,
  };
  return withCandidate(artifact, candidateId, (candidate) => {
    if (input.grant) {
      // A previous `rejected` reverts to the derived status (the researcher
      // changed their mind). `validated` was overwritten at deny time, so a
      // re-grant of linked data lands on `user-provided` — re-linking (which
      // re-reads the dataset card) restores `validated`.
      const status =
        candidate.status === 'rejected'
          ? deriveStatus(candidate.local !== null, candidate.access, false)
          : candidate.status;
      return {
        ...candidate,
        status,
        authorization: decision,
        downloadStatus: candidate.local ? 'local-present' : 'authorized',
        notes: [
          ...new Set([
            ...candidate.notes,
            `authorization granted by ${input.by}${input.reason ? `: ${input.reason}` : ''}`,
          ]),
        ].slice(0, 8),
      };
    }
    return {
      ...candidate,
      status: 'rejected',
      authorization: decision,
      downloadStatus: 'blocked',
      notes: [
        ...new Set([
          ...candidate.notes,
          `rejected by ${input.by}${input.reason ? `: ${input.reason}` : ''}`,
        ]),
      ].slice(0, 8),
    };
  });
}

export interface LinkInput {
  path: string;
  sha256: ContentHash | null;
  bytes: number | null;
  snapshotId: string | null;
  licenseHint: string | null;
  profiled: boolean;
  scaleHint: string | null;
  now: number;
}

/**
 * Binds provided data to a candidate: status becomes user-provided (validated
 * when a deterministic dataset card exists), downloadStatus local-present.
 * The caller has already verified the path is inside the project/manifest/
 * readonly roots and computed the hash — this function only records state.
 */
export function linkCandidateLocal(
  artifact: DatasetDiscoveryArtifact,
  candidateId: string,
  input: LinkInput,
): { artifact: DatasetDiscoveryArtifact; candidate: DatasetCandidate } {
  return withCandidate(artifact, candidateId, (candidate) => {
    const size: SizeCategory =
      input.bytes !== null ? (input.bytes > 1024 ** 3 ? 'large' : 'small') : 'unknown';
    const license =
      input.licenseHint && candidate.license.value === 'unknown'
        ? {
            value: input.licenseHint,
            confidence: 0.5,
            note: 'LICENSE file next to the linked data (deterministic dataset card)',
          }
        : candidate.license;
    const unit =
      candidate.unit === 'unknown' && input.scaleHint
        ? `profiled ${input.scaleHint}; sample-unit semantics need user confirmation`
        : candidate.unit;
    return {
      ...candidate,
      status: input.profiled ? 'validated' : 'user-provided',
      local: { path: input.path, sha256: input.sha256, datasetSnapshotId: input.snapshotId },
      access: {
        ...candidate.access,
        acquisition: 'local-mount',
        restricted: false,
        size,
        instructions: 'provided by the researcher in this project',
      },
      license,
      unit,
      scale: input.scaleHint ?? candidate.scale,
      downloadStatus: 'local-present',
      discoveredAt: candidate.discoveredAt,
      notes: [
        ...new Set([
          ...candidate.notes,
          `linked to ${input.path} (snapshot ${input.snapshotId ?? 'n/a'})`,
        ]),
      ].slice(0, 8),
    };
  });
}

/**
 * Protocol Synthesis hook (docs/plan.md 阶段 B2): when no user dataset is
 * registered, the proposal input may add this suffix so the model states that
 * discovered candidates are recommendations only — never registered data.
 * Returns null when no artifact / no live candidates (input hash unchanged).
 */
export async function discoveryCandidatesNote(knowledgeDir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(knowledgeDir, 'dataset-candidates.json'), 'utf8'),
    ) as DatasetDiscoveryArtifact;
    if (parsed.contract !== DISCOVERY_SCHEMA || !Array.isArray(parsed.candidates)) return null;
    const live = parsed.candidates.filter(
      (candidate) => candidate.status !== 'rejected' && candidate.status !== 'validated',
    ).length;
    if (live === 0) return null;
    return (
      `${live} discovered dataset candidate(s) exist in knowledge/dataset-candidates.json; ` +
      'they are recommendations only and must NOT be treated as registered data or experiment inputs ' +
      'until the researcher provides the file and links it'
    );
  } catch {
    return null;
  }
}
