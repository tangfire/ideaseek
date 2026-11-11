import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of, sha256OfFile, type ContentHash } from '../core/hash.js';
import { redactSecrets } from '../core/redact.js';

/**
 * RepositoryUnderstanding (docs/DATA_CONTRACTS.md): structure-agnostic
 * analysis of an arbitrary code repository — the "Codebase Analyst". It never
 * assumes fixed layouts like `src/train.py`; every conclusion is backed by
 * filename/content evidence with a confidence, and anything ambiguous lands in
 * `openQuestions` for user confirmation. The analyzed tree is read-only.
 */

export const REPOSITORY_PARSER_VERSION = 'ideaseek-repo-1';

export interface RecognitionEvidence {
  /** Which conclusion this evidence supports (e.g. `entrypoints.training`). */
  field: string;
  path: string;
  line?: number;
  /** Trimmed source line, secret-redacted, capped at 160 chars. */
  snippet: string;
  /** Signal identifier (rule id / filename pattern / manifest name). */
  basis: string;
  confidence: number;
}

export interface LanguageStat {
  language: string;
  files: number;
  bytes: number;
}

export interface DependencyRecord {
  ecosystem: string;
  manifest: string;
  name: string | null;
  requirement: string;
  parsed: boolean;
}

export interface EntryCandidate {
  path: string;
  kind: 'train' | 'eval' | 'test' | 'launch';
  confidence: number;
  /** Sorted signal identifiers that produced this candidate. */
  signals: string[];
  evidence: RecognitionEvidence[];
}

export interface DataInterfaceCandidate {
  path: string;
  kind: 'dataset-loader' | 'data-file' | 'split';
  confidence: number;
  signals: string[];
  evidence: RecognitionEvidence[];
}

export interface MetricCandidate {
  path: string;
  /** Metric identifiers observed in this file (lowercase, deduped). */
  names: string[];
  confidence: number;
  signals: string[];
  evidence: RecognitionEvidence[];
}

export interface ReadmeInfo {
  path: string | null;
  headings: string[];
  summary: string | null;
}

export interface RepositoryUnderstanding {
  understandingVersion: 1;
  parserVersion: string;
  analyzedAt: number;
  source: {
    root: string;
    relPath: string | null;
    /** sha256 over sorted `path\tbytes\thash` lines — changes iff content does. */
    snapshotHash: ContentHash;
    files: number;
    bytes: number;
  };
  languages: LanguageStat[];
  readme: ReadmeInfo;
  dependencies: {
    manifests: string[];
    records: DependencyRecord[];
    unparsedManifests: string[];
  };
  entrypoints: {
    training: EntryCandidate[];
    evaluation: EntryCandidate[];
    test: EntryCandidate[];
    other: EntryCandidate[];
  };
  configs: string[];
  dataInterfaces: DataInterfaceCandidate[];
  metrics: MetricCandidate[];
  evidence: RecognitionEvidence[];
  /** Aggregate heuristic in [0,1] over present components; never a guarantee. */
  confidence: number;
  /** Things the platform could not safely conclude on its own. */
  openQuestions: string[];
  /** Always true: entries must be confirmed before any automatic run. */
  needsConfirmation: boolean;
}

export interface AnalyzeRepositoryOptions {
  /** When given, records a project-relative source path. */
  projectRoot?: string;
  now?: number;
  /** Snapshot budget: files beyond this are excluded (noted in openQuestions). */
  maxFiles?: number;
  /** Content-signal budget per file. */
  maxSignalBytes?: number;
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_SIGNAL_BYTES = 512 * 1024;
const MAX_HASH_BYTES = 256 * 1024 * 1024;
const SNIPPET_LIMIT = 160;
const SUMMARY_LIMIT = 300;
const MIN_ENTRY_SCORE = 0.45;
const MIN_AUX_SCORE = 0.3;
const MAX_EVIDENCE = 150;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.eggs',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.idea',
  '.vscode',
  '.research',
]);

const LANG_BY_EXT: Record<string, string> = {
  '.py': 'Python',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.jsx': 'JavaScript',
  '.java': 'Java',
  '.c': 'C',
  '.h': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.hh': 'C++',
  '.rs': 'Rust',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.r': 'R',
  '.jl': 'Julia',
  '.m': 'MATLAB',
  '.mm': 'Objective-C',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.scala': 'Scala',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.ps1': 'PowerShell',
  '.sql': 'SQL',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.ipynb': 'Jupyter',
  '.lua': 'Lua',
  '.pl': 'Perl',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.hs': 'Haskell',
  '.ml': 'OCaml',
  '.dart': 'Dart',
  '.zig': 'Zig',
  '.tex': 'TeX',
  '.md': 'Markdown',
  '.rst': 'reStructuredText',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.json': 'JSON',
};

const LANG_BY_BASENAME: Record<string, string> = {
  makefile: 'Make',
  gnumakefile: 'Make',
  dockerfile: 'Dockerfile',
  gemfile: 'Ruby',
  rakefile: 'Ruby',
};

/** Extensions whose text content is searched for entry/data/metric signals. */
const SIGNAL_EXT = new Set([
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.sh',
  '.bash',
  '.zsh',
  '.ipynb',
  '.r',
  '.jl',
  '.java',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.scala',
  '.kt',
  '.m',
  '.pl',
  '.lua',
  '.yaml',
  '.yml',
  '.toml',
  '.json',
  '.ini',
  '.cfg',
  '.conf',
  '.md',
  '.rst',
  '.txt',
  '.make',
  '.mk',
]);
const SIGNAL_BASENAME = new Set(['makefile', 'dockerfile', 'gemfile', 'pipfile', 'rakefile']);

/** Files that must never contribute content evidence (secret-shaped names). */
const SECRET_BASENAME_RE = /^\.env|id_rsa|id_ed25519|\.pem$|\.key$|\.p12$|\.pfx$/i;

const DATA_FILE_EXT = new Set([
  '.csv',
  '.tsv',
  '.parquet',
  '.feather',
  '.arrow',
  '.jsonl',
  '.npy',
  '.npz',
  '.h5',
  '.hdf5',
  '.pkl',
  '.pickle',
  '.mat',
  '.arff',
  '.tfrecord',
]);

const CONFIG_EXT = new Set(['.yaml', '.yml', '.json', '.toml', '.ini', '.cfg', '.conf']);
const LOCKFILE_RE = /(lock|\.lock$)/i;

interface ContentRule {
  id: string;
  kind: 'train' | 'eval' | 'test' | 'data' | 'metric' | 'launch';
  pattern: RegExp;
  weight: number;
}

/** Line-level content signals; weights sum into a per-file score. */
const CONTENT_RULES: ContentRule[] = [
  // training
  {
    id: 'c:epochs-flag',
    kind: 'train',
    pattern: /--epochs|--max-steps|--num-epochs/,
    weight: 0.25,
  },
  { id: 'c:lr-flag', kind: 'train', pattern: /--learning-rate|--lr\b/, weight: 0.15 },
  {
    id: 'c:optimizer-step',
    kind: 'train',
    pattern: /optimizer\.(step|zero_grad)\(|loss\.backward\(/,
    weight: 0.3,
  },
  {
    id: 'c:train-function',
    kind: 'train',
    pattern: /def train(_|\b)|def train_one_epoch|def train_epoch/,
    weight: 0.3,
  },
  { id: 'c:model-fit', kind: 'train', pattern: /\.fit\(|trainer\.fit\(/, weight: 0.25 },
  {
    id: 'c:lightning',
    kind: 'train',
    pattern: /LightningModule|pytorch_lightning|pl\.Trainer\(/,
    weight: 0.3,
  },
  {
    id: 'c:distributed-train',
    kind: 'train',
    pattern: /torchrun|DistributedDataParallel|torch\.distributed/,
    weight: 0.25,
  },
  {
    id: 'c:train-loop-call',
    kind: 'train',
    pattern: /train_one_epoch\(|train_loop\(|run_training\(/,
    weight: 0.25,
  },
  // evaluation
  {
    id: 'c:sklearn-metrics',
    kind: 'eval',
    pattern: /from sklearn\.metrics|import sklearn\.metrics/,
    weight: 0.3,
  },
  { id: 'c:torchmetrics', kind: 'eval', pattern: /torchmetrics/, weight: 0.3 },
  { id: 'c:evaluate-function', kind: 'eval', pattern: /def evaluate\b|\.evaluate\(/, weight: 0.3 },
  {
    id: 'c:metric-scores',
    kind: 'eval',
    pattern: /accuracy_score|f1_score|precision_score|recall_score|roc_auc|classification_report/,
    weight: 0.25,
  },
  { id: 'c:nlp-metrics', kind: 'eval', pattern: /\bbleu\b|\brouge\b|\bperplexity\b/, weight: 0.2 },
  { id: 'c:eval-flag', kind: 'eval', pattern: /--eval\b|--evaluate\b/, weight: 0.2 },
  {
    id: 'c:tf-metrics',
    kind: 'eval',
    pattern: /tensorflow\.keras\.metrics|tf\.keras\.metrics/,
    weight: 0.25,
  },
  // test
  { id: 'c:pytest', kind: 'test', pattern: /import pytest|from pytest/, weight: 0.35 },
  {
    id: 'c:jest-describe',
    kind: 'test',
    pattern: /describe\(|require\(['"]node:test['"]\)|from ['"]node:test['"]/,
    weight: 0.3,
  },
  // data interfaces
  { id: 'c:dataloader', kind: 'data', pattern: /DataLoader\(|torch\.utils\.data/, weight: 0.35 },
  { id: 'c:tf-data', kind: 'data', pattern: /tf\.data\./, weight: 0.35 },
  {
    id: 'c:tabular-read',
    kind: 'data',
    pattern: /read_csv\(|read_parquet\(|read_excel\(|read_table\(/,
    weight: 0.3,
  },
  { id: 'c:hf-dataset', kind: 'data', pattern: /load_dataset\(/, weight: 0.3 },
  { id: 'c:numpy-load', kind: 'data', pattern: /np\.load\(|numpy\.load\(/, weight: 0.25 },
  { id: 'c:hdf5', kind: 'data', pattern: /h5py|\.hdf5['"]/, weight: 0.25 },
  {
    id: 'c:image-folder',
    kind: 'data',
    pattern: /ImageFolder\(|torchvision\.datasets/,
    weight: 0.3,
  },
  { id: 'c:dataset-class', kind: 'data', pattern: /class\s+\w*(Dataset|Corpus)\b/, weight: 0.3 },
  {
    id: 'c:data-path-literal',
    kind: 'data',
    pattern: /['"][^'"]*\.(csv|jsonl|parquet|npz|tfrecord)['"]/,
    weight: 0.25,
  },
  { id: 'c:train-test-split', kind: 'data', pattern: /train_test_split\(/, weight: 0.15 },
  // metrics
  {
    id: 'c:metric-function',
    kind: 'metric',
    pattern: /def (compute_metrics|calculate_metrics|metrics)\b/,
    weight: 0.35,
  },
  {
    id: 'c:metric-import',
    kind: 'metric',
    pattern: /from sklearn\.metrics import|torchmetrics|tensorflow\.keras\.metrics/,
    weight: 0.25,
  },
  // generic launch (only counts when nothing more specific matched)
  {
    id: 'c:main-guard',
    kind: 'launch',
    pattern: /if\s+__name__\s*==\s*['"]__main__['"]/,
    weight: 0.3,
  },
  { id: 'c:argparse', kind: 'launch', pattern: /ArgumentParser\(/, weight: 0.25 },
];

const METRIC_NAME_RE =
  /\b(accuracy(?:_score)?|f1(?:_[a-z]+)?|precision(?:_score)?|recall(?:_score)?|roc_auc|auc|average_precision|bleu|rouge[_a-z0-9]*|ndcg\d*|perplexity|mae|mean_absolute_error|mse|mean_squared_error|rmse|mape|map_\d+|iou|dice|wer|cer)\b/gi;

interface MatchedRule {
  id: string;
  line: number;
  snippet: string;
  weight: number;
}

interface FileSignals {
  relPath: string;
  matches: MatchedRule[];
  filenameSignals: { kind: 'train' | 'eval' | 'test'; id: string; weight: number }[];
  metricNames: string[];
}

interface WalkedFile {
  relPath: string;
  bytes: number;
  sha256: string | null;
}

function extOfPath(relPath: string): string {
  const name = basename(relPath).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

function isSignalFile(relPath: string): boolean {
  const name = basename(relPath).toLowerCase();
  if (SECRET_BASENAME_RE.test(name)) return false;
  if (SIGNAL_BASENAME.has(name)) return true;
  return SIGNAL_EXT.has(extOfPath(name));
}

async function walkRepository(
  root: string,
  maxFiles: number,
): Promise<{ files: WalkedFile[]; truncated: boolean }> {
  const relPaths: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow links (cycles/escapes)
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        await visit(full);
      } else if (entry.isFile()) {
        relPaths.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  await visit(root);
  relPaths.sort();
  const truncated = relPaths.length > maxFiles;
  const selected = truncated ? relPaths.slice(0, maxFiles) : relPaths;

  const files: WalkedFile[] = [];
  for (const relPath of selected) {
    const info = await stat(join(root, relPath));
    let sha256: string | null = null;
    if (info.size <= MAX_HASH_BYTES) {
      try {
        sha256 = await sha256OfFile(join(root, relPath));
      } catch {
        sha256 = null;
      }
    }
    files.push({ relPath, bytes: info.size, sha256 });
  }
  return { files, truncated };
}

function languageOf(relPath: string): string | null {
  const name = basename(relPath).toLowerCase();
  const byBase = LANG_BY_BASENAME[name];
  if (byBase) return byBase;
  return LANG_BY_EXT[extOfPath(name)] ?? null;
}

function filenameKindSignals(relPath: string): FileSignals['filenameSignals'] {
  const name = basename(relPath).toLowerCase();
  const stem = name.replace(/\.[^.]+$/, '');
  const out: FileSignals['filenameSignals'] = [];
  if (
    /(^|[^a-z0-9])(train|training|finetune|pretrain|fit)([^a-z0-9]|$)/.test(stem) ||
    /^train/.test(stem)
  ) {
    out.push({ kind: 'train', id: 'fn:train-name', weight: 0.5 });
  }
  if (/(^|[^a-z0-9])(eval|evaluate|evaluation)([^a-z0-9]|$)/.test(stem)) {
    out.push({ kind: 'eval', id: 'fn:eval-name', weight: 0.5 });
  }
  if (/^test_.*|.*_test$|.*\.(test|spec)$/.test(stem)) {
    out.push({ kind: 'test', id: 'fn:test-name', weight: 0.5 });
  }
  const segments = relPath.split('/');
  if (
    segments.some(
      (segment, index) =>
        index < segments.length - 1 && (segment === 'tests' || segment === 'test'),
    )
  ) {
    out.push({ kind: 'test', id: 'fn:test-directory', weight: 0.4 });
  }
  return out;
}

async function readSignals(
  root: string,
  relPath: string,
  maxSignalBytes: number,
): Promise<{ matches: MatchedRule[]; metricNames: string[] }> {
  const full = join(root, relPath);
  const info = await stat(full);
  if (info.size > maxSignalBytes) return { matches: [], metricNames: [] };
  let text: string;
  try {
    const buf = await readFile(full);
    if (buf.subarray(0, 4096).includes(0)) return { matches: [], metricNames: [] }; // binary
    text = buf.toString('utf8');
  } catch {
    return { matches: [], metricNames: [] };
  }

  const lines = text.split(/\r?\n/);
  const matches: MatchedRule[] = [];
  const seenRules = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    for (const rule of CONTENT_RULES) {
      if (seenRules.has(rule.id)) continue;
      if (rule.pattern.test(line)) {
        seenRules.add(rule.id);
        matches.push({
          id: rule.id,
          line: index + 1,
          snippet: redactSecrets(line.trim().slice(0, SNIPPET_LIMIT)),
          weight: rule.weight,
        });
      }
    }
  }

  const metricNames = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(METRIC_NAME_RE)) {
      metricNames.add(match[1]!.toLowerCase());
      if (metricNames.size >= 8) break;
    }
    if (metricNames.size >= 8) break;
  }
  return { matches, metricNames: [...metricNames].sort() };
}

function evidenceFor(
  field: string,
  relPath: string,
  match: MatchedRule,
  confidence: number,
): RecognitionEvidence {
  return {
    field,
    path: relPath,
    line: match.line,
    snippet: match.snippet,
    basis: match.id,
    confidence,
  };
}

function scoreOf(matches: readonly MatchedRule[], kind: ContentRule['kind']): number {
  let score = 0;
  for (const match of matches) {
    const rule = CONTENT_RULES.find((candidate) => candidate.id === match.id);
    if (rule && rule.kind === kind) score += rule.weight;
  }
  return score;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function entryFieldFor(kind: EntryCandidate['kind']): string {
  if (kind === 'train') return 'entrypoints.training';
  if (kind === 'eval') return 'entrypoints.evaluation';
  if (kind === 'test') return 'entrypoints.test';
  return 'entrypoints.other';
}

function buildEntrypoints(signals: readonly FileSignals[]): RepositoryUnderstanding['entrypoints'] {
  const entries: EntryCandidate[] = [];

  for (const file of signals) {
    const buckets = new Map<
      EntryCandidate['kind'],
      { score: number; signals: Set<string>; evidence: RecognitionEvidence[] }
    >();
    const bucketOf = (kind: EntryCandidate['kind']) => {
      const existing = buckets.get(kind);
      if (existing) return existing;
      const fresh = { score: 0, signals: new Set<string>(), evidence: [] as RecognitionEvidence[] };
      buckets.set(kind, fresh);
      return fresh;
    };

    for (const fn of file.filenameSignals) {
      const bucket = bucketOf(fn.kind);
      bucket.score += fn.weight;
      bucket.signals.add(fn.id);
      bucket.evidence.push({
        field: entryFieldFor(fn.kind),
        path: file.relPath,
        snippet: basename(file.relPath),
        basis: fn.id,
        confidence: fn.weight,
      });
    }
    for (const match of file.matches) {
      const rule = CONTENT_RULES.find((candidate) => candidate.id === match.id);
      if (
        !rule ||
        (rule.kind !== 'train' &&
          rule.kind !== 'eval' &&
          rule.kind !== 'test' &&
          rule.kind !== 'launch')
      ) {
        continue;
      }
      const bucket = bucketOf(rule.kind);
      bucket.score += rule.weight;
      bucket.signals.add(rule.id);
      if (bucket.evidence.length < 3) {
        bucket.evidence.push(
          evidenceFor(entryFieldFor(rule.kind), file.relPath, match, rule.weight),
        );
      }
    }

    const scoreOfKind = (kind: EntryCandidate['kind']): number => buckets.get(kind)?.score ?? 0;
    const trainScore = scoreOfKind('train');
    const evalScore = scoreOfKind('eval');
    const testScore = scoreOfKind('test');
    const launchScore = scoreOfKind('launch');

    const tryEmit = (kind: EntryCandidate['kind'], score: number) => {
      if (score < MIN_ENTRY_SCORE) return;
      const bucket = buckets.get(kind)!;
      entries.push({
        path: file.relPath,
        kind,
        confidence: round2(Math.min(0.95, score)),
        signals: [...bucket.signals].sort(),
        evidence: [...bucket.evidence].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
      });
    };

    tryEmit('train', trainScore);
    tryEmit('eval', evalScore);
    tryEmit('test', testScore);
    // `launch` only when nothing more specific already claimed the file.
    if (
      trainScore < MIN_ENTRY_SCORE &&
      evalScore < MIN_ENTRY_SCORE &&
      testScore < MIN_ENTRY_SCORE
    ) {
      tryEmit('launch', launchScore);
    }
  }

  const sorted = (kind: EntryCandidate['kind']): EntryCandidate[] =>
    entries
      .filter((candidate) => candidate.kind === kind)
      .sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path));

  return {
    training: sorted('train'),
    evaluation: sorted('eval'),
    test: sorted('test'),
    other: sorted('launch'),
  };
}

function buildDataInterfaces(
  signals: readonly FileSignals[],
  files: readonly WalkedFile[],
): DataInterfaceCandidate[] {
  const out = new Map<string, DataInterfaceCandidate>();

  for (const file of signals) {
    const score = scoreOf(file.matches, 'data');
    if (score < MIN_AUX_SCORE) continue;
    const matches = file.matches.filter((match) => {
      const rule = CONTENT_RULES.find((candidate) => candidate.id === match.id);
      return rule?.kind === 'data';
    });
    out.set(file.relPath, {
      path: file.relPath,
      kind: 'dataset-loader',
      confidence: round2(Math.min(0.95, score)),
      signals: matches.map((match) => match.id).sort(),
      evidence: matches
        .slice(0, 3)
        .map((match) => evidenceFor('dataInterfaces', file.relPath, match, 0.95)),
    });
  }

  for (const file of files) {
    if (out.has(file.relPath)) continue;
    const name = basename(file.relPath).toLowerCase();
    const ext = extOfPath(name);
    const stem = name.replace(/\.[^.]+$/, '');
    if (DATA_FILE_EXT.has(ext)) {
      const isSplit = /^(train|valid|validation|val|test|dev|holdout)([-_.].*)?$/.test(stem);
      out.set(file.relPath, {
        path: file.relPath,
        kind: isSplit ? 'split' : 'data-file',
        confidence: 0.9,
        signals: isSplit ? ['fn:split-name', 'fn:data-extension'] : ['fn:data-extension'],
        evidence: [
          {
            field: 'dataInterfaces',
            path: file.relPath,
            snippet: basename(file.relPath),
            basis: isSplit ? 'fn:split-name' : 'fn:data-extension',
            confidence: 0.9,
          },
        ],
      });
    }
  }

  return [...out.values()].sort(
    (a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path),
  );
}

function buildMetrics(signals: readonly FileSignals[]): MetricCandidate[] {
  const out: MetricCandidate[] = [];
  for (const file of signals) {
    const name = basename(file.relPath).toLowerCase();
    const filenameHit = name.includes('metric');
    const score =
      scoreOf(file.matches, 'metric') +
      (filenameHit ? 0.4 : 0) +
      (file.metricNames.length > 0 ? 0.2 : 0);
    if (score < MIN_AUX_SCORE) continue;
    const matches = file.matches.filter((match) => {
      const rule = CONTENT_RULES.find((candidate) => candidate.id === match.id);
      return rule?.kind === 'metric';
    });
    const evidence: RecognitionEvidence[] = matches
      .slice(0, 3)
      .map((match) => evidenceFor('metrics', file.relPath, match, 0.9));
    if (filenameHit) {
      evidence.push({
        field: 'metrics',
        path: file.relPath,
        snippet: basename(file.relPath),
        basis: 'fn:metric-name',
        confidence: 0.4,
      });
    }
    out.push({
      path: file.relPath,
      names: file.metricNames,
      confidence: round2(Math.min(0.95, score)),
      signals: [
        ...new Set([
          ...matches.map((match) => match.id),
          ...(filenameHit ? ['fn:metric-name'] : []),
        ]),
      ].sort(),
      evidence,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path));
}

interface ParsedManifest {
  records: DependencyRecord[];
  unparsed: boolean;
}

function manifestKindOf(relPath: string): string | null {
  const name = basename(relPath).toLowerCase();
  if (/^requirements.*\.txt$/.test(name)) return 'pip-requirements';
  if (name === 'pyproject.toml') return 'pyproject';
  if (name === 'setup.py') return 'setup-py';
  if (name === 'environment.yml' || name === 'environment.yaml') return 'conda';
  if (name === 'package.json') return 'npm';
  if (name === 'cargo.toml') return 'cargo';
  if (name === 'go.mod') return 'go';
  if (name === 'pom.xml') return 'maven';
  if (name === 'gemfile') return 'gem';
  if (name === 'composer.json') return 'composer';
  if (name === 'pipfile') return 'pipfile';
  return null;
}

async function parseDependencyManifest(
  root: string,
  relPath: string,
  kind: string,
): Promise<ParsedManifest> {
  const ecosystemByKind: Record<string, string> = {
    'pip-requirements': 'pip',
    pyproject: 'pip',
    'setup-py': 'pip',
    conda: 'conda',
    npm: 'npm',
    cargo: 'cargo',
    go: 'go',
    maven: 'maven',
    gem: 'rubygems',
    composer: 'composer',
    pipfile: 'pip',
  };
  const ecosystem = ecosystemByKind[kind] ?? kind;
  const record = (name: string | null, requirement: string, parsed: boolean): DependencyRecord => ({
    ecosystem,
    manifest: relPath,
    name,
    requirement,
    parsed,
  });

  let text: string;
  try {
    text = await readFile(join(root, relPath), 'utf8');
  } catch {
    return { records: [record(null, '<unreadable>', false)], unparsed: true };
  }

  try {
    switch (kind) {
      case 'pip-requirements': {
        const records: DependencyRecord[] = [];
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#') || line.startsWith('-')) continue;
          const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/.exec(line);
          if (match) records.push(record(match[1]!, match[2] || '*', true));
          else records.push(record(null, line, false));
        }
        return { records, unparsed: false };
      }
      case 'npm':
      case 'composer': {
        const json = JSON.parse(text) as Record<string, Record<string, string>>;
        const sections =
          kind === 'npm' ? ['dependencies', 'devDependencies'] : ['require', 'require-dev'];
        const records: DependencyRecord[] = [];
        for (const section of sections) {
          const deps = json[section];
          if (!deps || typeof deps !== 'object') continue;
          for (const [name, range] of Object.entries(deps)) {
            records.push(record(name, String(range), true));
          }
        }
        return { records, unparsed: false };
      }
      case 'pyproject': {
        const records: DependencyRecord[] = [];
        const arrayBlocks = [...text.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/g)];
        for (const block of arrayBlocks) {
          for (const item of block[1]!.matchAll(/["']([^"']+)["']/g)) {
            const spec = item[1]!;
            const nameMatch = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
            records.push(record(nameMatch?.[1] ?? null, spec, Boolean(nameMatch)));
          }
        }
        const poetrySection = /^\[tool\.poetry\.dependencies\]([\s\S]*?)(?=^\[|\$)/m.exec(text);
        if (poetrySection) {
          for (const line of poetrySection[1]!.split('\n')) {
            const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
            if (match) records.push(record(match[1]!, line.trim(), true));
          }
        }
        return { records, unparsed: false };
      }
      case 'conda': {
        const parsed = parseYaml(text) as { dependencies?: unknown[] } | null;
        const records: DependencyRecord[] = [];
        const deps = Array.isArray(parsed?.dependencies) ? parsed.dependencies : null;
        if (!deps) return { records, unparsed: true };
        for (const entry of deps) {
          if (typeof entry === 'string') {
            const name = entry.split(/[=<>!~]/)[0] ?? entry;
            records.push(record(name, entry, true));
          } else if (
            entry &&
            typeof entry === 'object' &&
            'pip' in (entry as Record<string, unknown>)
          ) {
            const pipDeps = (entry as { pip?: unknown }).pip;
            if (Array.isArray(pipDeps)) {
              for (const pipEntry of pipDeps) {
                if (typeof pipEntry !== 'string') continue;
                const name = pipEntry.split(/[=<>!~]/)[0] ?? pipEntry;
                records.push({ ...record(name, pipEntry, true), ecosystem: 'pip' });
              }
            }
          }
        }
        return { records, unparsed: false };
      }
      case 'cargo':
      case 'pipfile': {
        const records: DependencyRecord[] = [];
        const sectionRe =
          kind === 'cargo' ? /^\[(dev-)?dependencies\]$/ : /^\[(dev-packages|packages)\]$/;
        let inSection = false;
        for (const line of text.split(/\r?\n/)) {
          const heading = line.trim();
          if (heading.startsWith('[')) {
            inSection = sectionRe.test(heading);
            continue;
          }
          if (!inSection || !heading || heading.startsWith('#')) continue;
          const match = /^["']?([A-Za-z0-9_-]+)["']?\s*=\s*(.+)$/.exec(heading);
          if (match) {
            const raw = match[2]!.replace(/^["']|["']$/g, '');
            records.push(record(match[1]!, raw, true));
          }
        }
        return { records, unparsed: false };
      }
      case 'go': {
        const records: DependencyRecord[] = [];
        let inRequire = false;
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.startsWith('require (')) {
            inRequire = true;
            continue;
          }
          if (inRequire && trimmed === ')') {
            inRequire = false;
            continue;
          }
          if (trimmed.startsWith('require ')) {
            const parts = trimmed.slice('require '.length).trim().split(/\s+/);
            if (parts.length >= 2) records.push(record(parts[0]!, parts[1]!, true));
            continue;
          }
          if (inRequire) {
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 2 && !trimmed.startsWith('//')) {
              records.push(record(parts[0]!, parts[1]!, true));
            }
          }
        }
        return { records, unparsed: false };
      }
      case 'maven': {
        const records: DependencyRecord[] = [];
        for (const dep of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
          const block = dep[1]!;
          const artifact = /<artifactId>([^<]+)<\/artifactId>/.exec(block)?.[1];
          const version = /<version>([^<]+)<\/version>/.exec(block)?.[1];
          if (artifact) records.push(record(artifact, version ?? '*', Boolean(version)));
        }
        return { records, unparsed: false };
      }
      case 'gem': {
        const records: DependencyRecord[] = [];
        for (const match of text.matchAll(
          /^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm,
        )) {
          records.push(record(match[1]!, match[2] ?? '*', Boolean(match[2])));
        }
        return { records, unparsed: false };
      }
      case 'setup-py':
      default:
        return { records: [], unparsed: true };
    }
  } catch {
    return { records: [], unparsed: true };
  }
}

async function findReadme(root: string, files: readonly WalkedFile[]): Promise<ReadmeInfo> {
  const candidates = files
    .filter((file) => /^readme(\.(md|rst|txt|markdown))?$/i.test(basename(file.relPath)))
    .sort((a, b) => {
      const depthA = a.relPath.split('/').length;
      const depthB = b.relPath.split('/').length;
      return depthA - depthB || a.relPath.localeCompare(b.relPath);
    });
  const best = candidates[0];
  if (!best) return { path: null, headings: [], summary: null };

  let text: string;
  try {
    text = await readFile(join(root, best.relPath), 'utf8');
  } catch {
    return { path: best.relPath, headings: [], summary: null };
  }
  const lines = text.split(/\r?\n/).slice(0, 400);
  const headings: string[] = [];
  for (const line of lines) {
    const match = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (match) headings.push(redactSecrets(match[1]!.trim()).slice(0, 120));
    if (headings.length >= 10) break;
  }

  let summary: string | null = null;
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length > 0) paragraphs.push(current.join(' '));
      current = [];
      if (paragraphs.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed) || /^[-=]{3,}$/.test(trimmed)) continue;
    current.push(trimmed);
  }
  if (current.length > 0 && paragraphs.length === 0) paragraphs.push(current.join(' '));
  if (paragraphs[0]) summary = redactSecrets(paragraphs[0]).slice(0, SUMMARY_LIMIT);

  return { path: best.relPath, headings, summary };
}

function collectConfigs(files: readonly WalkedFile[], depManifests: Set<string>): string[] {
  const out = new Set<string>();
  for (const file of files) {
    const name = basename(file.relPath).toLowerCase();
    if (depManifests.has(file.relPath) || LOCKFILE_RE.test(name)) continue;
    const ext = extOfPath(name);
    if (!CONFIG_EXT.has(ext)) continue;
    const segments = file.relPath.split('/');
    const inConfigDir = segments.some(
      (segment, index) => index < segments.length - 1 && /^configs?$/.test(segment),
    );
    const namedConfig = /^(config|settings|params|options|hyperparams)[.-]/.test(name);
    const looseConfigExt = ext === '.ini' || ext === '.cfg' || ext === '.conf';
    if (inConfigDir || namedConfig || looseConfigExt) out.add(file.relPath);
  }
  return [...out].sort();
}

function computeConfidence(parts: {
  readme: boolean;
  deps: boolean;
  train: boolean;
  eval: boolean;
  metrics: boolean;
  data: boolean;
}): number {
  let score = 0;
  if (parts.readme) score += 0.15;
  if (parts.deps) score += 0.2;
  if (parts.train) score += 0.3;
  if (parts.eval) score += 0.2;
  if (parts.metrics) score += 0.1;
  if (parts.data) score += 0.05;
  return round2(score);
}

function tryRelative(projectRoot: string, absPath: string): string | null {
  const rel = relative(resolve(projectRoot), absPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * Analyzes a repository directory read-only and produces a
 * RepositoryUnderstanding. Never writes, never executes, never assumes a
 * fixed layout: conclusions come from filename/content evidence, and anything
 * not safely inferable is surfaced in `openQuestions`.
 */
export async function analyzeRepository(
  repoRoot: string,
  opts: AnalyzeRepositoryOptions = {},
): Promise<RepositoryUnderstanding> {
  const root = resolve(repoRoot);
  let info;
  try {
    info = await stat(root);
  } catch {
    throw new IdeaseekError('FILE_NOT_FOUND', `repository not found: ${repoRoot}`);
  }
  if (!info.isDirectory()) {
    throw new IdeaseekError('INVALID_ARGUMENT', `not a directory: ${repoRoot}`);
  }

  const now = opts.now ?? Date.now();
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxSignalBytes = opts.maxSignalBytes ?? DEFAULT_MAX_SIGNAL_BYTES;

  const { files, truncated } = await walkRepository(root, maxFiles);
  const snapshotLines = files
    .map((file) => `${file.relPath}\t${file.bytes}\t${file.sha256 ?? `unhashed:${file.bytes}`}`)
    .join('\n');
  const snapshotHash = sha256Of(snapshotLines);

  const languageMap = new Map<string, LanguageStat>();
  for (const file of files) {
    const language = languageOf(file.relPath);
    if (!language) continue;
    const stat_ = languageMap.get(language) ?? { language, files: 0, bytes: 0 };
    stat_.files += 1;
    stat_.bytes += file.bytes;
    languageMap.set(language, stat_);
  }
  const languages = [...languageMap.values()].sort(
    (a, b) => b.bytes - a.bytes || a.language.localeCompare(b.language),
  );

  const signals: FileSignals[] = [];
  for (const file of files) {
    if (!isSignalFile(file.relPath)) continue;
    const { matches, metricNames } = await readSignals(root, file.relPath, maxSignalBytes);
    signals.push({
      relPath: file.relPath,
      matches,
      filenameSignals: filenameKindSignals(file.relPath),
      metricNames,
    });
  }

  const readme = await findReadme(root, files);

  const depManifests: string[] = [];
  const depRecords: DependencyRecord[] = [];
  const unparsedManifests: string[] = [];
  for (const file of files) {
    const kind = manifestKindOf(file.relPath);
    if (!kind) continue;
    depManifests.push(file.relPath);
    const parsed = await parseDependencyManifest(root, file.relPath, kind);
    depRecords.push(...parsed.records);
    if (parsed.unparsed) unparsedManifests.push(file.relPath);
  }
  depManifests.sort();

  const entrypoints = buildEntrypoints(signals);
  const dataInterfaces = buildDataInterfaces(signals, files);
  const metrics = buildMetrics(signals);
  const configs = collectConfigs(files, new Set(depManifests));

  const evidence: RecognitionEvidence[] = [];
  for (const candidate of [
    ...entrypoints.training,
    ...entrypoints.evaluation,
    ...entrypoints.test,
    ...entrypoints.other,
  ]) {
    evidence.push(...candidate.evidence);
  }
  for (const candidate of dataInterfaces) evidence.push(...candidate.evidence);
  for (const candidate of metrics) evidence.push(...candidate.evidence);
  if (readme.path) {
    evidence.push({
      field: 'readme',
      path: readme.path,
      line: 1,
      snippet: redactSecrets(readme.summary ?? readme.headings[0] ?? basename(readme.path)).slice(
        0,
        SNIPPET_LIMIT,
      ),
      basis: 'readme-filename',
      confidence: 0.9,
    });
  }
  for (const manifest of depManifests) {
    const first = depRecords.find((record) => record.manifest === manifest);
    evidence.push({
      field: 'dependencies.manifest',
      path: manifest,
      snippet: first
        ? `${first.name ?? first.requirement}`.slice(0, SNIPPET_LIMIT)
        : basename(manifest),
      basis: 'manifest-filename',
      confidence: 0.8,
    });
  }
  evidence.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));

  const openQuestions: string[] = [];
  if (files.length === 0) openQuestions.push('repository contains no files');
  if (truncated) {
    openQuestions.push(
      `file budget exceeded (${maxFiles}); analysis covers the first ${maxFiles} files only`,
    );
  }
  if (!readme.path) openQuestions.push('no README found anywhere in the repository');
  else if (readme.path.includes('/')) {
    openQuestions.push(`no root-level README (found ${readme.path})`);
  }
  if (depManifests.length === 0) openQuestions.push('no dependency manifest detected');
  if (unparsedManifests.length > 0) {
    openQuestions.push(
      `dependency manifests not statically parsed: ${unparsedManifests.join(', ')}`,
    );
  }
  if (entrypoints.training.length === 0) {
    openQuestions.push('no training entry detected; confirm how training is launched');
  } else if (entrypoints.training.filter((candidate) => candidate.confidence >= 0.6).length > 1) {
    const paths = entrypoints.training
      .filter((candidate) => candidate.confidence >= 0.6)
      .slice(0, 5)
      .map((candidate) => candidate.path);
    openQuestions.push(
      `multiple training entry candidates; confirm which to run: ${paths.join(', ')}`,
    );
  }
  if (entrypoints.evaluation.length === 0) {
    openQuestions.push('no evaluation entry detected; confirm how metrics are computed');
  }
  if (metrics.length === 0) openQuestions.push('no metric implementation detected');

  return {
    understandingVersion: 1,
    parserVersion: REPOSITORY_PARSER_VERSION,
    analyzedAt: now,
    source: {
      root,
      relPath: opts.projectRoot ? tryRelative(opts.projectRoot, root) : null,
      snapshotHash,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    },
    languages,
    readme,
    dependencies: {
      manifests: depManifests,
      records: depRecords.sort(
        (a, b) =>
          a.manifest.localeCompare(b.manifest) || (a.name ?? '').localeCompare(b.name ?? ''),
      ),
      unparsedManifests,
    },
    entrypoints,
    configs,
    dataInterfaces,
    metrics,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    confidence: computeConfidence({
      readme: Boolean(readme.path),
      deps: depManifests.length > 0,
      train: entrypoints.training.length > 0,
      eval: entrypoints.evaluation.length > 0,
      metrics: metrics.length > 0,
      data: dataInterfaces.length > 0,
    }),
    openQuestions,
    needsConfirmation: true,
  };
}
