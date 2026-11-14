import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContentHash } from '../src/core/hash.js';
import { IdeaseekError } from '../src/core/errors.js';
import { createAcademicIndexClient } from '../src/knowledge/academic-index.js';
import {
  ALL_DISCOVERY_SOURCES,
  assertCandidateExperimentReady,
  authorizeCandidate,
  buildDeterministicCandidates,
  buildDiscoveryContext,
  buildDiscoveryRequest,
  candidateExperimentReadiness,
  candidateIdFor,
  collectDiscoverySources,
  computeDiscoveryInputHash,
  discoveryArtifactPath,
  discoveryCandidatesNote,
  extractDatasetMentions,
  isPlaceholderDatasetName,
  linkCandidateLocal,
  matchesDatasetName,
  mergeModelIntoDeterministic,
  mergeWithPrevious,
  normalizeDatasetName,
  normalizeSourceList,
  parseDatasetCandidatesOutput,
  readDiscoveryArtifact,
  requiresUserConfirmation,
  stampModelCandidates,
  validateDatasetCandidatesOutput,
  writeDiscoveryExports,
  type DatasetCandidate,
  type DatasetDiscoveryArtifact,
  type DiscoveryContext,
  type DiscoveryEvidence,
  type DiscoverySourceReport,
  type ModelDatasetCandidate,
} from '../src/knowledge/dataset-discovery.js';
import { CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import type { DatasetIndexHit } from '../src/knowledge/dataset-index.js';

/**
 * Phase 4.5B Dataset Discovery conformance (docs/DATA_CONTRACTS.md
 * §DatasetCandidate, docs/ARIS_INTEGRATION_PLAN §P1 数据集发现):
 * - every candidate carries name/source/task/unit/scale/license/access/
 *   related papers/relevance/confidence + provenance (time, hash, license,
 *   download status, user authorization);
 * - discovery writes only the discovery artifact — promotion to experiment
 *   input requires user-provided data + a DatasetSnapshot (fail-closed gate);
 * - model output is grounded and validated before anything is written;
 * - no model / no network / refused sources / duplicates / recovery all work.
 */

const PAPER_KEY: ContentHash = `sha256:${'f'.repeat(64)}`;
const FILE_HASH: ContentHash = `sha256:${'a'.repeat(64)}`;

function makeEvidence(over: Partial<DiscoveryEvidence> = {}): DiscoveryEvidence {
  return {
    evidenceId: 'ev-aaaaaaaaaaaa',
    kind: 'papercard',
    sourceKind: 'papers',
    ref: 'papers/mnist.pdf',
    name: 'MNIST',
    quote: 'MNIST dataset',
    retrievedAt: 1_000,
    contentHash: FILE_HASH,
    hashBasis: 'artifact',
    paperKey: PAPER_KEY,
    url: null,
    indexId: null,
    ...over,
  };
}

function makeSourceReport(over: Partial<DiscoverySourceReport> = {}): DiscoverySourceReport {
  return {
    kind: 'papers',
    ref: 'artifact-kind:papercard',
    status: 'ok',
    reason: null,
    retrievedAt: 1_000,
    contentHash: null,
    evidenceCount: 1,
    ...over,
  };
}

function makeCandidate(over: Partial<DatasetCandidate> = {}): DatasetCandidate {
  return {
    candidateId: 'ds-mnist',
    name: 'MNIST',
    status: 'recommended',
    task: 'unknown',
    unit: 'unknown',
    scale: null,
    license: { value: 'unknown', confidence: 0, note: 'not stated in the provided sources' },
    access: {
      acquisition: 'unknown',
      restricted: false,
      size: 'unknown',
      url: null,
      indexId: null,
      instructions: 'unknown',
    },
    relatedPapers: [],
    relevance: { question: 'q', reason: 'r' },
    confidence: 0.5,
    confidenceBasis: ['fixture'],
    evidenceIds: ['ev-aaaaaaaaaaaa'],
    local: null,
    downloadStatus: 'none',
    authorization: { state: 'none', decidedBy: null, decidedAt: null, reason: null },
    discoveredAt: 1,
    notes: [],
    ...over,
  };
}

function validModelOutput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidates: [
      {
        name: 'MNIST',
        task: 'digit classification',
        unit: '28×28 grayscale digit image',
        scale: '70k images',
        license: { value: 'unknown', confidence: 0, note: 'not stated' },
        acquisition: 'unknown',
        restricted: false,
        size: 'unknown',
        url: null,
        indexId: null,
        instructions: 'unknown — check the related paper',
        relatedPapers: [PAPER_KEY],
        evidenceIds: ['ev-aaaaaaaaaaaa'],
        relevanceReason: 'matches the question about image benchmarks',
        confidence: 0.6,
        confidenceBasis: ['one papercard datasets[] entry'],
        notes: [],
      },
    ],
    notes: [],
    ...over,
  };
}

const VALIDATION_EXPECTED = {
  evidence: [{ evidenceId: 'ev-aaaaaaaaaaaa', name: 'MNIST' }],
  paperRefs: [PAPER_KEY],
};

describe('dataset discovery: name normalization, ids and grounded mentions', () => {
  it('collapses case/punctuation variants to one candidate id', () => {
    expect(normalizeDatasetName('MNIST ')).toBe('mnist');
    expect(normalizeDatasetName('CIFAR-10')).toBe('cifar10');
    expect(candidateIdFor('MNIST')).toBe(candidateIdFor('mnist!'));
    expect(candidateIdFor('联邦学习数据集')).toContain('ds-');
  });

  it('extracts proper-noun dataset mentions with quotes and urls', () => {
    const text =
      'We evaluate on the MNIST dataset (https://example.org/mnist) and report the ' +
      'CIFAR-10 benchmark. The Glue: A benchmark suite is also listed. ' +
      'Handwritten characters come from the (FEMNIST) dataset. The dataset is new.';
    const hits = extractDatasetMentions(text);
    const names = hits.map((hit) => normalizeDatasetName(hit.name));
    expect(names).toContain('mnist');
    expect(names).toContain('cifar10');
    expect(names).toContain('glue');
    expect(names).toContain('femnist');
    // stopword-only captures are dropped
    expect(names).not.toContain('the');
    const mnist = hits.find((hit) => normalizeDatasetName(hit.name) === 'mnist');
    expect(mnist?.url).toBe('https://example.org/mnist');
    expect(mnist?.quote).toContain('MNIST dataset');
  });

  it('corroborates already-known names without a dataset keyword', () => {
    const hits = extractDatasetMentions('custombench results are strong here', ['CustomBench']);
    expect(hits.map((hit) => hit.name)).toContain('CustomBench');
    expect(extractDatasetMentions('nothing interesting', ['CustomBench'])).toEqual([]);
  });

  it('rejects unknown source names in --sources', () => {
    expect(() => normalizeSourceList(['papers', 'github'])).toThrow(IdeaseekError);
    expect(normalizeSourceList(['research-map', 'papers'])).toEqual(['papers', 'research-map']);
    expect(normalizeSourceList(undefined).length).toBeGreaterThan(0);
    expect(ALL_DISCOVERY_SOURCES).toContain('academic-index');
  });
});

describe('dataset discovery: model output conformance (fail-closed)', () => {
  it('accepts a fully grounded candidate', () => {
    const result = validateDatasetCandidatesOutput(validModelOutput(), VALIDATION_EXPECTED);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('rejects invented evidence ids, ungrounded names and invented papers', () => {
    const inventedEvidence = validModelOutput({
      candidates: [
        {
          ...(validModelOutput().candidates as Record<string, unknown>[])[0],
          evidenceIds: ['ev-ghost'],
        },
      ],
    });
    const a = validateDatasetCandidatesOutput(inventedEvidence, VALIDATION_EXPECTED);
    expect(a.ok).toBe(false);
    expect(a.errors.join(' ')).toMatch(/was not provided/);

    const ungrounded = validModelOutput({
      candidates: [
        {
          ...(validModelOutput().candidates as Record<string, unknown>[])[0],
          name: 'ImageNet',
          task: 'recognition',
        },
      ],
    });
    const b = validateDatasetCandidatesOutput(ungrounded, VALIDATION_EXPECTED);
    expect(b.ok).toBe(false);
    expect(b.errors.join(' ')).toMatch(/not grounded/);

    const ghostPaper = validModelOutput({
      candidates: [
        {
          ...(validModelOutput().candidates as Record<string, unknown>[])[0],
          relatedPapers: ['sha256:deadbeef'],
        },
      ],
    });
    const c = validateDatasetCandidatesOutput(ghostPaper, VALIDATION_EXPECTED);
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toMatch(/ProvidedPaperRefs/);
  });

  it('rejects public-download without url, bad enums and missing basis', () => {
    const bad = validModelOutput({
      candidates: [
        {
          ...(validModelOutput().candidates as Record<string, unknown>[])[0],
          acquisition: 'public-download',
          url: null,
          size: 'huge',
          confidence: 1.5,
          confidenceBasis: [],
        },
      ],
    });
    const result = validateDatasetCandidatesOutput(bad, VALIDATION_EXPECTED);
    expect(result.ok).toBe(false);
    const text = result.errors.join(' | ');
    expect(text).toMatch(/url is required/);
    expect(text).toMatch(/size must be/);
    expect(text).toMatch(/confidence must be in/);
    expect(text).toMatch(/confidenceBasis/);
  });

  it('parse fails closed with PARSE_FAILED and writes nothing downstream', () => {
    expect(() => parseDatasetCandidatesOutput('not json {', VALIDATION_EXPECTED)).toThrow(
      /PARSE_FAILED|not JSON/,
    );
    const invalid = JSON.stringify(
      validModelOutput({
        candidates: [
          {
            ...(validModelOutput().candidates as Record<string, unknown>[])[0],
            name: 'ImageNet',
          },
        ],
      }),
    );
    let thrown: unknown;
    try {
      parseDatasetCandidatesOutput(invalid, VALIDATION_EXPECTED);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IdeaseekError);
    expect((thrown as IdeaseekError).code).toBe('PARSE_FAILED');
    expect((thrown as IdeaseekError).message).toMatch(/grounded/);
  });
});

describe('dataset discovery: input hash (idempotent reuse)', () => {
  const ctx = {
    question: 'how to reduce forgetting',
    sources: [makeSourceReport({ contentHash: FILE_HASH })],
    evidence: [makeEvidence()],
    facts: [],
  };

  it('is stable across timestamps and changes with content or mode', () => {
    const h1 = computeDiscoveryInputHash(ctx, 'none');
    const later = {
      ...ctx,
      sources: [{ ...ctx.sources[0]!, retrievedAt: 999_999 }],
      evidence: [{ ...ctx.evidence[0]!, retrievedAt: 999_999 }],
    };
    expect(computeDiscoveryInputHash(later, 'none')).toBe(h1);
    expect(computeDiscoveryInputHash(ctx, 'fake')).not.toBe(h1);
    const changed: DiscoveryContext = {
      ...ctx,
      evidence: [{ ...ctx.evidence[0]!, contentHash: `sha256:${'b'.repeat(64)}` }],
    };
    expect(computeDiscoveryInputHash(changed, 'none')).not.toBe(h1);
  });

  it('request embeds the hash, contract, evidence table and paper refs', () => {
    const request = buildDiscoveryRequest({
      question: ctx.question,
      sources: ctx.sources,
      evidence: ctx.evidence,
      mode: 'none',
    });
    expect(request.inputHash).toBe(computeDiscoveryInputHash(ctx, 'none'));
    expect(request.idempotencyKey).toContain('dataset-discovery:');
    expect(request.instruction).toContain('dataset-candidates-v1');
    expect(request.instruction).toContain('ev-aaaaaaaaaaaa');
    expect(request.instruction).toContain(PAPER_KEY);
    expect(request.providedPaperRefs).toEqual([PAPER_KEY]);
  });
});

describe('dataset discovery: deterministic candidates, dedup and enrichment', () => {
  it('merges duplicate mentions from two sources into one candidate', () => {
    const ctx = buildDiscoveryContext(
      {
        sources: [],
        evidence: [
          makeEvidence({ evidenceId: 'ev-papers00001', sourceKind: 'papers', ref: 'papers/a.pdf' }),
          makeEvidence({
            evidenceId: 'ev-map00000001',
            kind: 'research-map',
            sourceKind: 'research-map',
            ref: 'knowledge/research-map.md',
          }),
        ],
        facts: [],
        knownNames: ['MNIST'],
      },
      'question',
    );
    const candidates = buildDeterministicCandidates(ctx, 5_000);
    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate!.evidenceIds.sort()).toEqual(['ev-map00000001', 'ev-papers00001']);
    expect(candidate!.confidenceBasis.join(' ')).toMatch(/corroborated by 2 evidence kinds/);
    expect(candidate!.relatedPapers).toEqual([PAPER_KEY]);
    expect(candidate!.relevance.question).toBe('question');
  });

  it('a dataset-hub URL in evidence turns the candidate into a fetchable download', () => {
    // Papers name benchmarks but never state where to get them, so without
    // this the acquire step would have nothing to fetch.
    const evidence = makeEvidence({
      evidenceId: 'ev-hub0000001',
      kind: 'dataset-index',
      sourceKind: 'dataset-index',
      ref: 'https://huggingface.co/datasets/flwrlabs/pacs',
      name: 'PACS',
      quote:
        'HuggingFace dataset flwrlabs/pacs — fetchable file PACS.zip, 167.9 MiB, license tag mit',
      url: 'https://huggingface.co/datasets/flwrlabs/pacs/resolve/main/PACS.zip',
      indexId: 'flwrlabs/pacs',
      hashBasis: 'record',
      paperKey: null,
    });
    const ctx = buildDiscoveryContext(
      { sources: [], evidence: [evidence], facts: [], knownNames: ['PACS'] },
      'federated domain generalization',
    );
    const [candidate] = buildDeterministicCandidates(ctx, 5_000);
    expect(candidate!.access.acquisition).toBe('public-download');
    expect(candidate!.access.url).toBe(
      'https://huggingface.co/datasets/flwrlabs/pacs/resolve/main/PACS.zip',
    );
    expect(candidate!.access.instructions).toContain('proposed download');
    expect(candidate!.access.indexId).toBe('flwrlabs/pacs');
    // A URL is a proposal, not a grant: confirmation is still required.
    expect(candidate!.downloadStatus).toBe('proposed');
    expect(requiresUserConfirmation(candidate!)).toBe(true);
  });

  it('applies local facts: user-provided status, local-mount, local-present', () => {
    const evidence = makeEvidence({
      evidenceId: 'ev-local000001',
      kind: 'local-manifest',
      sourceKind: 'local-inputs',
      ref: 'datasets/mnist-local.csv',
      name: 'mnist-local',
      paperKey: null,
    });
    const ctx = buildDiscoveryContext(
      {
        sources: [],
        evidence: [evidence],
        facts: [
          {
            evidenceId: evidence.evidenceId,
            paths: ['datasets/mnist-local.csv'],
            bytes: 100,
            size: 'small',
            snapshotId: `data-${'1'.repeat(12)}`,
            sha256: FILE_HASH,
            licenseHint: 'MIT',
            profiled: false,
            external: false,
            scaleHint: null,
          },
        ],
        knownNames: [],
      },
      'question',
    );
    const [candidate] = buildDeterministicCandidates(ctx, 5_000);
    expect(candidate!.status).toBe('user-provided');
    expect(candidate!.access.acquisition).toBe('local-mount');
    expect(candidate!.downloadStatus).toBe('local-present');
    expect(candidate!.license.value).toBe('MIT');
    expect(candidate!.local).toEqual({
      path: 'datasets/mnist-local.csv',
      sha256: FILE_HASH,
      datasetSnapshotId: `data-${'1'.repeat(12)}`,
    });
    expect(requiresUserConfirmation(candidate!)).toBe(false);
  });

  it('proposes a download for evidence carrying a public url', () => {
    const ctx = buildDiscoveryContext(
      {
        sources: [],
        evidence: [
          makeEvidence({
            kind: 'comparison-readme',
            sourceKind: 'comparisons',
            ref: 'comparisons/a/README.md',
            url: 'https://example.org/data.zip',
          }),
        ],
        facts: [],
        knownNames: [],
      },
      'question',
    );
    const [candidate] = buildDeterministicCandidates(ctx, 5_000);
    expect(candidate!.access.acquisition).toBe('public-download');
    expect(candidate!.access.url).toBe('https://example.org/data.zip');
    expect(candidate!.downloadStatus).toBe('proposed');
    // unknown size stays conservative: user confirmation required
    expect(requiresUserConfirmation(candidate!)).toBe(true);
    expect(candidate!.notes.join(' ')).toMatch(/deterministic discovery/);
  });

  it('stamps model candidates with platform truth and merges enrichment', () => {
    const localEvidence = makeEvidence({
      evidenceId: 'ev-local000002',
      kind: 'local-manifest',
      sourceKind: 'local-inputs',
      ref: 'datasets/mnist-local.csv',
      name: 'MNIST',
      paperKey: null,
    });
    const paperEvidence = makeEvidence({ evidenceId: 'ev-papers00002' });
    const ctx = buildDiscoveryContext(
      {
        sources: [],
        evidence: [paperEvidence, localEvidence],
        facts: [
          {
            evidenceId: localEvidence.evidenceId,
            paths: ['datasets/mnist-local.csv'],
            bytes: 50,
            size: 'small',
            snapshotId: `data-${'2'.repeat(12)}`,
            sha256: FILE_HASH,
            licenseHint: null,
            profiled: true,
            external: false,
            scaleHint: '50 rows × 3 columns',
          },
        ],
        knownNames: ['MNIST'],
      },
      'question',
    );
    const raw: ModelDatasetCandidate[] = [
      {
        name: 'MNIST',
        task: 'digit classification',
        unit: '28×28 digit image',
        scale: '70k images',
        license: { value: 'CC-BY-4.0', confidence: 0.7, note: 'stated in README' },
        acquisition: 'unknown',
        restricted: false,
        size: 'unknown',
        url: null,
        indexId: null,
        instructions: 'unknown',
        relatedPapers: [PAPER_KEY],
        evidenceIds: [paperEvidence.evidenceId],
        relevanceReason: 'central benchmark for the question',
        confidence: 0.8,
        confidenceBasis: ['model read the papercard'],
        notes: [],
      },
    ];
    const model = stampModelCandidates(raw, ctx, 7_000);
    const deterministic = buildDeterministicCandidates(ctx, 7_000);
    const merged = mergeModelIntoDeterministic(deterministic, model);
    expect(merged).toHaveLength(1);
    const [candidate] = merged;
    expect(candidate!.task).toBe('digit classification');
    expect(candidate!.status).toBe('validated'); // platform truth: local + dataset card
    expect(candidate!.local?.datasetSnapshotId).toBe(`data-${'2'.repeat(12)}`);
    expect(candidate!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(candidate!.evidenceIds.sort()).toEqual(
      [paperEvidence.evidenceId, localEvidence.evidenceId].sort(),
    );
    // relatedPapers union stays grounded
    expect(candidate!.relatedPapers).toEqual([PAPER_KEY]);
  });

  it('carries authorization, rejections and orphan candidates across runs', () => {
    const granted = makeCandidate({
      candidateId: 'ds-granted',
      authorization: {
        state: 'granted',
        decidedBy: 'user',
        decidedAt: 10,
        reason: 'public small dataset',
      },
      downloadStatus: 'authorized',
    });
    const rejected = makeCandidate({ candidateId: 'ds-rejected', status: 'rejected' });
    const orphan = makeCandidate({ candidateId: 'ds-orphan', name: 'Orphan' });
    const previous = [granted, rejected, orphan];

    const fresh = [
      makeCandidate({ candidateId: 'ds-granted' }), // fresh run forgot the decision
      makeCandidate({ candidateId: 'ds-rejected' }),
    ];
    const merged = mergeWithPrevious(fresh, previous, { localSourcesChecked: true });
    const ids = merged.map((candidate) => candidate.candidateId).sort();
    expect(ids).toEqual(['ds-granted', 'ds-orphan', 'ds-rejected']);
    const mergedGranted = merged.find((candidate) => candidate.candidateId === 'ds-granted')!;
    expect(mergedGranted.authorization.state).toBe('granted');
    expect(mergedGranted.downloadStatus).toBe('authorized');
    const mergedRejected = merged.find((candidate) => candidate.candidateId === 'ds-rejected')!;
    expect(mergedRejected.status).toBe('rejected');
    const mergedOrphan = merged.find((candidate) => candidate.candidateId === 'ds-orphan')!;
    expect(mergedOrphan.notes.join(' ')).toMatch(/not reconfirmed/);
  });

  it('converges: stale duplicates and placeholder names do not accumulate', () => {
    const previous = [
      makeCandidate({ candidateId: 'ds-pacspacs', name: 'PACS (P, A, C, S)' }),
      makeCandidate({ candidateId: 'ds-unknown', name: 'unknown' }),
      makeCandidate({ candidateId: 'ds-orphan', name: 'Orphan' }),
    ];
    const fresh = [makeCandidate({ candidateId: 'ds-pacs', name: 'PACS' })];
    const ids = mergeWithPrevious(fresh, previous, { localSourcesChecked: true }).map(
      (candidate) => candidate.candidateId,
    );
    // Same benchmark under an older id is dropped; a placeholder never
    // survives; a genuinely absent one still carries forward.
    expect(ids.sort()).toEqual(['ds-orphan', 'ds-pacs']);
  });

  it('keeps linked local data when this run could not re-check the manifest', () => {
    const previous = [
      makeCandidate({
        candidateId: 'ds-mnist',
        status: 'user-provided',
        local: {
          path: 'datasets/mnist.csv',
          sha256: FILE_HASH,
          datasetSnapshotId: `data-${'3'.repeat(12)}`,
        },
        downloadStatus: 'local-present',
      }),
    ];
    const fresh = [makeCandidate({ candidateId: 'ds-mnist' })];
    const unchecked = mergeWithPrevious(fresh, previous, { localSourcesChecked: false });
    expect(unchecked[0]!.status).toBe('user-provided');
    expect(unchecked[0]!.local).not.toBeNull();
    const checked = mergeWithPrevious(fresh, previous, { localSourcesChecked: true });
    expect(checked[0]!.local).toBeNull();
    expect(checked[0]!.status).toBe('recommended');
  });
});

describe('dataset discovery: authorization, link and the promotion gate', () => {
  const now = 1_234;

  it('records grant/deny as candidate state only (no data side effects)', () => {
    const artifact = makeArtifact([makeCandidate()]);
    const granted = authorizeCandidate(artifact, 'ds-mnist', {
      grant: true,
      reason: 'public small dataset',
      by: 'researcher',
      now,
    });
    expect(granted.candidate.authorization).toMatchObject({
      state: 'granted',
      decidedBy: 'researcher',
      decidedAt: now,
      reason: 'public small dataset',
    });
    expect(granted.candidate.downloadStatus).toBe('authorized');
    expect(granted.candidate.status).toBe('recommended');
    // original artifact untouched (pure function)
    expect(artifact.candidates[0]!.authorization.state).toBe('none');

    const denied = authorizeCandidate(granted.artifact, 'ds-mnist', {
      grant: false,
      reason: 'license incompatible',
      by: 'researcher',
      now: now + 1,
    });
    expect(denied.candidate.status).toBe('rejected');
    expect(denied.candidate.downloadStatus).toBe('blocked');
    expect(denied.candidate.notes.join(' ')).toMatch(/license incompatible/);

    expect(() =>
      authorizeCandidate(denied.artifact, 'ds-ghost', { grant: true, reason: '', by: 'x', now }),
    ).toThrow(/not found/);
  });

  it('link promotes to user-provided/validated and enables the gate', () => {
    const artifact = makeArtifact([makeCandidate()]);
    const linked = linkCandidateLocal(artifact, 'ds-mnist', {
      path: 'datasets/mnist.csv',
      sha256: FILE_HASH,
      bytes: 1024,
      snapshotId: `data-${'4'.repeat(12)}`,
      licenseHint: null,
      profiled: false,
      scaleHint: null,
      now,
    });
    expect(linked.candidate.status).toBe('user-provided');
    expect(linked.candidate.downloadStatus).toBe('local-present');
    expect(linked.candidate.access.acquisition).toBe('local-mount');

    const validated = linkCandidateLocal(artifact, 'ds-mnist', {
      path: 'datasets/mnist.csv',
      sha256: FILE_HASH,
      bytes: 1024,
      snapshotId: `data-${'4'.repeat(12)}`,
      licenseHint: 'MIT',
      profiled: true,
      scaleHint: '10 rows × 2 columns',
      now,
    });
    expect(validated.candidate.status).toBe('validated');
    expect(validated.candidate.license.value).toBe('MIT');
    expect(validated.candidate.unit).toMatch(/sample-unit semantics need user confirmation/);

    expect(candidateExperimentReadiness(linked.candidate).ready).toBe(true);
    expect(() => assertCandidateExperimentReady(linked.candidate)).not.toThrow();
  });

  it('the gate fail-closes for recommendations, missing snapshots and denials', () => {
    const recommended = makeCandidate();
    expect(candidateExperimentReadiness(recommended).ready).toBe(false);
    expect(() => assertCandidateExperimentReady(recommended)).toThrow(
      /recommendation, not experiment input/,
    );

    const noSnapshot = makeCandidate({
      status: 'user-provided',
      local: { path: 'datasets/x.csv', sha256: FILE_HASH, datasetSnapshotId: null },
    });
    expect(candidateExperimentReadiness(noSnapshot).ready).toBe(false);

    const denied = makeCandidate({
      status: 'rejected',
      authorization: { state: 'denied', decidedBy: 'u', decidedAt: 1, reason: 'no' },
    });
    const report = candidateExperimentReadiness(denied);
    expect(report.ready).toBe(false);
    expect(report.reasons.join(' ')).toMatch(/rejected/);
  });

  it('requires confirmation for large, restricted, registered or unknown access', () => {
    expect(
      requiresUserConfirmation(
        makeCandidate({
          access: {
            acquisition: 'public-download',
            restricted: false,
            size: 'small',
            url: 'https://x.org/d.csv',
            indexId: null,
            instructions: 'curl',
          },
          downloadStatus: 'proposed',
        }),
      ),
    ).toBe(false);
    expect(
      requiresUserConfirmation(
        makeCandidate({
          access: {
            acquisition: 'public-download',
            restricted: false,
            size: 'unknown',
            url: 'https://x.org/d.csv',
            indexId: null,
            instructions: 'curl',
          },
        }),
      ),
    ).toBe(true);
    expect(
      requiresUserConfirmation(
        makeCandidate({
          access: {
            acquisition: 'registration',
            restricted: true,
            size: 'small',
            url: null,
            indexId: null,
            instructions: 'register',
          },
        }),
      ),
    ).toBe(true);
    expect(requiresUserConfirmation(makeCandidate({ status: 'rejected' }))).toBe(false);
  });
});

function makeArtifact(candidates: DatasetCandidate[]): DatasetDiscoveryArtifact {
  return {
    contract: 'dataset-discovery-v1',
    generatedAt: 1,
    inputHash: FILE_HASH,
    mode: 'none',
    harnessRuntime: null,
    question: 'q',
    sources: [makeSourceReport()],
    evidence: [makeEvidence()],
    candidates,
    incompleteSources: false,
    notes: [],
  };
}

describe('dataset discovery: artifact IO, exports and protocol note', () => {
  it('round-trips JSON, renders a provenance markdown and fail-closes on tamper', async () => {
    const dir = await makeProjectDir('discovery-io');
    const artifact = makeArtifact([
      makeCandidate({
        status: 'user-provided',
        local: {
          path: 'datasets/m.csv',
          sha256: FILE_HASH,
          datasetSnapshotId: `data-${'5'.repeat(12)}`,
        },
        downloadStatus: 'local-present',
      }),
    ]);
    const paths = await writeDiscoveryExports(dir, artifact);
    expect(paths).toHaveLength(2);
    const read = await readDiscoveryArtifact(dir);
    expect(read?.contract).toBe('dataset-discovery-v1');
    expect(read?.candidates[0]?.candidateId).toBe('ds-mnist');

    const markdown = await readFile(join(dir, 'knowledge', 'dataset-recommendations.md'), 'utf8');
    expect(markdown).toMatch(/Discovery recommends only/);
    expect(markdown).toMatch(/datasets link/);
    expect(markdown).toMatch(/ev-aaaaaaaaaaaa/);
    expect(markdown).toMatch(/retrieved 1970-/); // provenance time
    expect(markdown).toMatch(FILE_HASH.slice(0, 19)); // provenance hash

    // tampered contract → null (fail-closed read)
    await writeFile(
      discoveryArtifactPath(dir),
      JSON.stringify({ ...artifact, contract: 'bogus-v1' }),
      'utf8',
    );
    expect(await readDiscoveryArtifact(dir)).toBeNull();
  });

  it('discoveryCandidatesNote is null without an artifact and counts live candidates', async () => {
    const dir = await makeProjectDir('discovery-note');
    expect(await discoveryCandidatesNote(join(dir, 'knowledge'))).toBeNull();
    await writeDiscoveryExports(
      dir,
      makeArtifact([
        makeCandidate(),
        makeCandidate({
          candidateId: 'ds-dead',
          status: 'rejected',
        }),
      ]),
    );
    const note = await discoveryCandidatesNote(join(dir, 'knowledge'));
    expect(note).toMatch(/1 discovered dataset candidate/);
    expect(note).toMatch(/recommendations only/);
  });
});

describe('academic index port (no real network in tests)', () => {
  it('parses both endpoints and records response hashes', async () => {
    const client = createAcademicIndexClient({
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        text: async () =>
          url.includes('openalex')
            ? JSON.stringify({
                results: [
                  {
                    display_name: 'GLUE: A benchmark for language understanding',
                    id: 'https://openalex.org/W1',
                    publication_year: 2018,
                  },
                ],
              })
            : JSON.stringify({
                data: [
                  {
                    paperId: 's2-1',
                    title: 'Scaling laws with the CoQA dataset',
                    abstract: 'We study scaling on the CoQA dataset.',
                    year: 2020,
                    url: 'https://www.semanticscholar.org/paper/s2-1',
                    externalIds: {},
                  },
                ],
              }),
      }),
    });
    const result = await client.search('language dataset', { limit: 5 });
    expect(result.endpoints.every((endpoint) => endpoint.ok)).toBe(true);
    expect(result.endpoints.map((endpoint) => endpoint.endpoint).sort()).toEqual([
      'openalex',
      'semantic-scholar',
    ]);
    for (const endpoint of result.endpoints) {
      expect(endpoint.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(result.hits.length).toBeGreaterThanOrEqual(2);
  });

  it('uses polite-pool identification when configured, and names it when throttled', async () => {
    const savedEmail = process.env.IDEASEEK_CONTACT_EMAIL;
    const savedKey = process.env.IDEASEEK_S2_API_KEY;
    const seen: { url: string; headers?: Record<string, string> }[] = [];
    process.env.IDEASEEK_CONTACT_EMAIL = 'rd@example.org';
    process.env.IDEASEEK_S2_API_KEY = 's2-secret-value';
    try {
      const client = createAcademicIndexClient({
        fetchImpl: async (url, init) => {
          seen.push({ url, headers: init?.headers });
          return { ok: true, status: 200, text: async () => '{"results":[],"data":[]}' };
        },
      });
      await client.search('federated domain generalization');

      expect(seen.find((entry) => entry.url.includes('openalex'))?.url).toContain(
        'mailto=rd%40example.org',
      );
      expect(
        seen.find((entry) => entry.url.includes('semanticscholar'))?.headers?.['x-api-key'],
      ).toBe('s2-secret-value');

      // A 429 has to say which knob fixes it — otherwise `datasets discover`
      // reports a dead index with no way out.
      delete process.env.IDEASEEK_CONTACT_EMAIL;
      delete process.env.IDEASEEK_S2_API_KEY;
      const throttled = createAcademicIndexClient({
        fetchImpl: async () => ({ ok: false, status: 429, text: async () => '{}' }),
      });
      const result = await throttled.search('q');
      expect(result.endpoints[0]!.error).toContain('IDEASEEK_CONTACT_EMAIL');
      expect(result.endpoints[1]!.error).toContain('IDEASEEK_S2_API_KEY');
    } finally {
      if (savedEmail === undefined) delete process.env.IDEASEEK_CONTACT_EMAIL;
      else process.env.IDEASEEK_CONTACT_EMAIL = savedEmail;
      if (savedKey === undefined) delete process.env.IDEASEEK_S2_API_KEY;
      else process.env.IDEASEEK_S2_API_KEY = savedKey;
    }
  });

  it('surfaces network refusal and rate limits as per-endpoint errors, never throws', async () => {
    const failing = createAcademicIndexClient({
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const refused = await failing.search('q');
    expect(refused.hits).toEqual([]);
    expect(refused.endpoints.every((endpoint) => !endpoint.ok)).toBe(true);
    expect(refused.endpoints[0]!.error).toMatch(/network refused: connect ECONNREFUSED/);

    const limited = createAcademicIndexClient({
      fetchImpl: async (url) =>
        url.includes('openalex')
          ? { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) }
          : { ok: false, status: 429, text: async () => 'rate limited' },
    });
    const partial = await limited.search('q');
    expect(partial.endpoints.find((endpoint) => endpoint.endpoint === 'openalex')?.ok).toBe(true);
    expect(
      partial.endpoints.find((endpoint) => endpoint.endpoint === 'semantic-scholar')?.error,
    ).toMatch(/429/);
  });
});

describe('hub name matching and placeholder rejection', () => {
  const hit = (id: string, file: string | null): DatasetIndexHit => ({
    id,
    url: `https://hf.co/datasets/${id}`,
    fileUrl: file ? `https://hf.co/datasets/${id}/resolve/main/${file}` : null,
    fileName: file,
    bytes: 1000,
    tags: [],
    licenseTag: null,
    downloads: null,
    endpoint: 'https://hf.co',
  });

  it('accepts exact benchmark names and refuses model-artifact repos', () => {
    expect(matchesDatasetName('PACS', hit('flwrlabs/pacs', 'PACS.zip'))).toBe(true);
    expect(matchesDatasetName('DomainNet', hit('wltjr1007/DomainNet', 'a.parquet'))).toBe(true);
    expect(matchesDatasetName('Office-Home', hit('Xinxi-Zhang/Office-Home', 'x.mp'))).toBe(true);
    // Live-run failures: a prefix match landed on activations and on "Unknown".
    expect(matchesDatasetName('VLCS', hit('Yooniel/vlcs-vitb32-activations', 'f.parquet'))).toBe(
      false,
    );
    expect(matchesDatasetName('PACS', hit('someone/pacs-plus-extra', 'f.zip'))).toBe(false);
    expect(matchesDatasetName('PACS', hit('flwrlabs/pacs', null))).toBe(false);
  });

  it('a parenthetical domain list is one benchmark, not a second candidate', () => {
    expect(normalizeDatasetName('PACS (P, A, C, S)')).toBe(normalizeDatasetName('PACS'));
    expect(candidateIdFor('Office-10 (C, A, W, D)')).toBe(candidateIdFor('Office-10'));
  });

  it('placeholder names never become candidates', () => {
    expect(isPlaceholderDatasetName('unknown')).toBe(true);
    expect(isPlaceholderDatasetName('N/A')).toBe(true);
    expect(isPlaceholderDatasetName('PACS')).toBe(false);
    const evidence = makeEvidence({ name: 'unknown', evidenceId: 'ev-unknown00001' });
    const ctx = buildDiscoveryContext(
      { sources: [], evidence: [evidence], facts: [], knownNames: ['unknown'] },
      'q',
    );
    expect(buildDeterministicCandidates(ctx, 5_000)).toEqual([]);
  });
});

describe('collectDiscoverySources (ProjectRuntime fixtures)', () => {
  async function setup(name: string): Promise<ProjectRuntime> {
    const dir = await makeProjectDir(name);
    return openRuntime(dir, { recover: false });
  }

  async function writeConfig(dir: string, edits: Record<string, string>): Promise<void> {
    const configPath = join(dir, 'research.yaml');
    let text = await readFile(configPath, 'utf8');
    for (const [from, to] of Object.entries(edits)) {
      expect(text).toContain(from);
      text = text.replace(from, to);
    }
    await writeFile(configPath, text, 'utf8');
  }

  it('records honest statuses for a fresh project (incomplete sources visible)', async () => {
    const rt = await setup('discovery-fresh');
    try {
      const result = await collectDiscoverySources(rt, {
        question: 'q',
        sources: normalizeSourceList(undefined),
        now: Date.now(),
      });
      const byKind = new Map(result.sources.map((source) => [source.kind, source]));
      expect(byKind.get('papers')?.status).toBe('empty');
      expect(byKind.get('comparisons')?.status).toBe('empty');
      expect(byKind.get('tables')?.status).toBe('empty');
      expect(byKind.get('research-map')?.status).toBe('missing');
      expect(byKind.get('research-map')?.reason).toMatch(/ideaseek synthesize/);
      expect(byKind.get('local-inputs')?.status).toBe('missing');
      expect(byKind.get('local-inputs')?.reason).toMatch(/ideaseek scan/);
      expect(result.sources.some((source) => source.kind === 'academic-index')).toBe(false);
      expect(result.evidence).toEqual([]);
    } finally {
      await rt.close();
    }
  });

  it('extracts candidates from the research map and the input manifest', async () => {
    const rt = await setup('discovery-sources');
    try {
      const knowledgeDir = rt.paths.knowledgeDir;
      await writeFile(
        join(knowledgeDir, 'research-map.md'),
        '# Research map\n\n- conflicting evidence on the CustomBench dataset\n' +
          '- label skew follows (FedPF) dataset statistics\n',
        'utf8',
      );
      await writeFile(
        join(knowledgeDir, 'input-manifest.json'),
        JSON.stringify({
          manifestVersion: 1,
          parserVersion: 'ideaseek-scan-1',
          generatedAt: 1,
          roots: ['datasets'],
          files: [
            {
              path: join(rt.paths.root, 'datasets', 'mnist-local.csv'),
              relPath: 'datasets/mnist-local.csv',
              bytes: 200,
              mtimeMs: 1,
              ext: '.csv',
              sha256: `sha256:${'6'.repeat(64)}`,
              hashStatus: 'ok',
              role: 'data',
              confidence: 0.9,
              basis: ['csv under datasets/'],
              discoveredAt: 1,
            },
          ],
          groups: [],
          duplicateSets: [],
        }),
        'utf8',
      );

      const result = await collectDiscoverySources(rt, {
        question: 'question about label skew',
        sources: normalizeSourceList(['research-map', 'local-inputs']),
        now: Date.now(),
      });
      const byKind = new Map(result.sources.map((source) => [source.kind, source]));
      expect(byKind.get('research-map')?.status).toBe('ok');
      expect(byKind.get('local-inputs')?.status).toBe('ok');
      expect(byKind.get('local-inputs')?.contentHash).toMatch(/^sha256:/);

      const ctx = buildDiscoveryContext(result, 'question about label skew');
      const candidates = buildDeterministicCandidates(ctx, Date.now());
      const names = candidates.map((candidate) => normalizeDatasetName(candidate.name));
      expect(names).toContain('custombench');
      expect(names).toContain('fedpf');
      expect(names).toContain('mnistlocal');
      const local = candidates.find((candidate) => candidate.candidateId === 'ds-mnistlocal')!;
      expect(local.status).toBe('user-provided');
      expect(local.downloadStatus).toBe('local-present');
      expect(local.local?.datasetSnapshotId).toBe(`data-${'6'.repeat(12)}`);
      expect(local.evidenceIds).toHaveLength(1);
      const evidence = ctx.evidence.find((item) => item.evidenceId === local.evidenceIds[0]);
      expect(evidence?.contentHash).toBe(`sha256:${'6'.repeat(64)}`);
      expect(evidence?.hashBasis).toBe('file');

      // every candidate satisfies the DATA_CONTRACTS required fields
      for (const candidate of candidates) {
        expect(candidate.name.length).toBeGreaterThan(0);
        expect(candidate.task.length).toBeGreaterThan(0);
        expect(candidate.unit.length).toBeGreaterThan(0);
        expect(candidate.license.value.length).toBeGreaterThan(0);
        expect(candidate.access.instructions.length).toBeGreaterThan(0);
        expect(candidate.relevance.reason.length).toBeGreaterThan(0);
        expect(candidate.confidence).toBeGreaterThan(0);
        expect(candidate.evidenceIds.length).toBeGreaterThan(0);
        expect(['recommended', 'needs-access', 'user-provided', 'validated', 'rejected']).toContain(
          candidate.status,
        );
      }
    } finally {
      await rt.close();
    }
  });

  it('refuses the academic index by policy before any network attempt', async () => {
    const rt = await setup('discovery-index-policy');
    try {
      const refused = await collectDiscoverySources(rt, {
        question: 'q',
        sources: normalizeSourceList(['academic-index']),
        now: Date.now(),
      });
      expect(refused.sources[0]!.status).toBe('refused');
      expect(refused.sources[0]!.reason).toMatch(/external_search/);
    } finally {
      await rt.close();
    }
  });

  it('refuses at allow_network, then at missing question, then surfaces transport failure', async () => {
    const dir = await makeProjectDir('discovery-index-chain');
    await writeConfig(dir, { 'external_search: false': 'external_search: true' });
    const rt = await openRuntime(dir, { recover: false });
    try {
      const networkOff = await collectDiscoverySources(rt, {
        question: 'q',
        sources: normalizeSourceList(['academic-index']),
        now: Date.now(),
      });
      expect(networkOff.sources[0]!.status).toBe('refused');
      expect(networkOff.sources[0]!.reason).toMatch(/allow_network/);
    } finally {
      await rt.close();
    }

    await writeConfig(dir, {
      'allow_network: false': 'allow_network: true',
      'question: ""': 'question: "federated forgetting"',
    });
    const rt2 = await openRuntime(dir, { recover: false });
    try {
      const noQuestion = await collectDiscoverySources(rt2, {
        question: '   ',
        sources: normalizeSourceList(['academic-index']),
        now: Date.now(),
      });
      expect(noQuestion.sources[0]!.status).toBe('refused');
      expect(noQuestion.sources[0]!.reason).toMatch(/research\.question/);

      const failingClient = createAcademicIndexClient({
        fetchImpl: async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        },
      });
      const failed = await collectDiscoverySources(rt2, {
        question: 'federated forgetting',
        sources: normalizeSourceList(['academic-index']),
        now: Date.now(),
        indexClient: failingClient,
      });
      expect(failed.sources[0]!.status).toBe('failed');
      expect(failed.sources[0]!.reason).toMatch(/network refused/);

      const okClient = createAcademicIndexClient({
        fetchImpl: async (url) => ({
          ok: true,
          status: 200,
          text: async () =>
            url.includes('openalex')
              ? JSON.stringify({ results: [] })
              : JSON.stringify({
                  data: [
                    {
                      paperId: 's2-9',
                      title: 'FedScale: A benchmark for federated learning',
                      abstract: 'We release the FedScale dataset suite.',
                      year: 2022,
                      url: 'https://www.semanticscholar.org/paper/s2-9',
                      externalIds: {},
                    },
                  ],
                }),
        }),
      });
      const indexed = await collectDiscoverySources(rt2, {
        question: 'federated forgetting',
        sources: normalizeSourceList(['academic-index']),
        now: Date.now(),
        indexClient: okClient,
      });
      expect(indexed.sources[0]!.status).toBe('ok');
      expect(indexed.sources[0]!.contentHash).toMatch(/^sha256:/);
      const names = indexed.evidence.map((item) => normalizeDatasetName(item.name));
      expect(names).toContain('fedscale');
      const evidence = indexed.evidence[0]!;
      expect(evidence.kind).toBe('academic-index');
      expect(evidence.hashBasis).toBe('response');
      expect(evidence.indexId).toBe('s2-9');
    } finally {
      await rt2.close();
    }
  });
});

describe('datasets CLI (discover/list/explain/authorize/link)', () => {
  interface CliResult {
    code: number;
    stdout: string;
    stderr: string;
  }

  function runCli(
    cwd: string,
    args: string[],
    env: Record<string, string> = {},
    timeoutMs = 180_000,
  ): Promise<CliResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [CLI_BIN, ...args], {
        cwd,
        env: { ...process.env, IDEASEEK_CLI: '1', ...env },
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  async function initProject(name: string): Promise<string> {
    const dir = await makeProjectDir(name);
    const init = await runCli(dir, ['init']);
    expect(init.code, init.stderr).toBe(0);
    return dir;
  }

  const MAP_FIXTURE = '# Research map\n\n- the CustomBench dataset underlies most comparisons\n';

  interface LooseArtifact {
    contract: string;
    inputHash: string;
    notes: string[];
    evidence: { evidenceId: string }[];
    candidates: { task: string; evidenceIds: string[] }[];
  }

  async function readArtifact(dir: string): Promise<LooseArtifact> {
    return JSON.parse(
      await readFile(join(dir, 'knowledge', 'dataset-candidates.json'), 'utf8'),
    ) as LooseArtifact;
  }

  it('writes only the discovery artifact — no slices, no data, no experiment inputs', async () => {
    const dir = await initProject('datasets-fresh');
    const discover = await runCli(dir, ['datasets', 'discover', '--harness', 'none', '--json']);
    expect(discover.code, discover.stderr).toBe(0);
    const payload = JSON.parse(discover.stdout) as {
      mode: string;
      candidates: number;
      incompleteSources: boolean;
      sources: { kind: string; status: string; reason: string | null }[];
    };
    expect(payload.mode).toBe('none');
    expect(payload.candidates).toBe(0);
    expect(payload.incompleteSources).toBe(true);
    const byKind = new Map(payload.sources.map((source) => [source.kind, source]));
    expect(byKind.get('research-map')?.status).toBe('missing');
    expect(byKind.get('research-map')?.reason).toMatch(/ideaseek synthesize/);
    expect(byKind.get('local-inputs')?.status).toBe('missing');

    const artifact = await readArtifact(dir);
    expect(artifact.contract).toBe('dataset-discovery-v1');
    expect(artifact.notes.join(' ')).toMatch(/--harness none/);

    // Recommendations must not register slices or write datasets/.
    const slices = await runCli(dir, ['data', 'slices', '--json']);
    expect(slices.code).toBe(0);
    expect((JSON.parse(slices.stdout) as { slices: unknown[] }).slices).toEqual([]);

    const list = await runCli(dir, ['datasets', 'list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/no dataset candidates/);

    const markdown = await readFile(join(dir, 'knowledge', 'dataset-recommendations.md'), 'utf8');
    expect(markdown).toMatch(/Discovery recommends only/);
    expect(markdown).toMatch(/not experiment inputs/);
  }, 180_000);

  it('discovers a candidate from the research map with full provenance', async () => {
    const dir = await initProject('datasets-map');
    await writeFile(join(dir, 'knowledge', 'research-map.md'), MAP_FIXTURE, 'utf8');
    const discover = await runCli(dir, ['datasets', 'discover', '--harness', 'none', '--json']);
    expect(discover.code, discover.stderr).toBe(0);
    const payload = JSON.parse(discover.stdout) as {
      candidates: number;
      byStatus: Record<string, number>;
      needsConfirmation: number;
    };
    expect(payload.candidates).toBe(1);
    expect(payload.byStatus.recommended).toBe(1);
    expect(payload.needsConfirmation).toBe(1);

    const list = await runCli(dir, ['datasets', 'list', '--json']);
    const candidate = (JSON.parse(list.stdout) as { candidates: { candidateId: string }[] })
      .candidates[0]!;
    expect(candidate.candidateId).toBe('ds-custombench');

    const explain = await runCli(dir, ['datasets', 'explain', candidate.candidateId, '--json']);
    expect(explain.code, explain.stderr).toBe(0);
    const detail = JSON.parse(explain.stdout) as {
      requiresConfirmation: boolean;
      readiness: { ready: boolean; reasons: string[] };
      evidence: { ref: string; contentHash: string; retrievedAt: number; hashBasis: string }[];
      candidate: {
        task: string;
        unit: string;
        license: { value: string };
        access: { instructions: string };
      };
    };
    expect(detail.requiresConfirmation).toBe(true);
    expect(detail.readiness.ready).toBe(false);
    expect(detail.readiness.reasons.join(' ')).toMatch(/only user-provided\/validated/);
    expect(detail.evidence[0]!.ref).toBe('knowledge/research-map.md');
    expect(detail.evidence[0]!.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(detail.evidence[0]!.retrievedAt).toBeGreaterThan(0);
    expect(detail.evidence[0]!.hashBasis).toBe('file');
    expect(detail.candidate.task).toBe('unknown');
    expect(detail.candidate.license.value).toBe('unknown');
    expect(detail.candidate.access.instructions.length).toBeGreaterThan(0);
  }, 180_000);

  it('fake provider enriches, an unchanged rerun reuses, one event total', async () => {
    const dir = await initProject('datasets-fake');
    await writeFile(join(dir, 'knowledge', 'research-map.md'), MAP_FIXTURE, 'utf8');
    expect((await runCli(dir, ['run', '--question', 'discovery', '--enqueue-only'])).code).toBe(0);

    const first = await runCli(dir, ['datasets', 'discover', '--harness', 'fake', '--json']);
    expect(first.code, first.stderr).toBe(0);
    const payload = JSON.parse(first.stdout) as {
      mode: string;
      harnessRuntime: string;
      reused: boolean;
    };
    expect(payload.mode).toBe('fake');
    expect(payload.harnessRuntime).toBe('fake');
    expect(payload.reused).toBe(false);

    const artifact = await readArtifact(dir);
    expect(artifact.candidates[0]!.task).toBe('fake-enriched task (deterministic provider)');
    expect(artifact.candidates[0]!.evidenceIds.length).toBeGreaterThan(0);

    const second = await runCli(dir, ['datasets', 'discover', '--harness', 'fake', '--json']);
    expect(second.code, second.stderr).toBe(0);
    const reused = JSON.parse(second.stdout) as { reused: boolean; inputHash: string };
    expect(reused.reused).toBe(true);
    expect(reused.inputHash).toBe(artifact.inputHash);

    const events = await runCli(dir, ['events', '--json']);
    expect(events.stdout.split('dataset_discovery').length - 1).toBe(1);
  }, 180_000);

  it('rejects grounded-violating model output and leaves the artifact byte-identical', async () => {
    const dir = await initProject('datasets-bad-output');
    await writeFile(join(dir, 'knowledge', 'research-map.md'), MAP_FIXTURE, 'utf8');
    const good = await runCli(dir, ['datasets', 'discover', '--harness', 'fake', '--json']);
    expect(good.code, good.stderr).toBe(0);
    const before = await readFile(join(dir, 'knowledge', 'dataset-candidates.json'), 'utf8');

    const badOutput = JSON.stringify({
      candidates: [
        {
          name: 'CustomBench',
          task: 'benchmark',
          unit: 'unknown',
          scale: null,
          license: { value: 'unknown', confidence: 0, note: 'not stated' },
          acquisition: 'unknown',
          restricted: false,
          size: 'unknown',
          url: null,
          indexId: null,
          instructions: 'unknown',
          relatedPapers: [],
          evidenceIds: ['ev-ghost'],
          relevanceReason: 'matches the question',
          confidence: 0.5,
          confidenceBasis: ['invented evidence'],
          notes: [],
        },
      ],
      notes: [],
    });
    const failed = await runCli(dir, ['datasets', 'discover', '--harness', 'fake', '--force'], {
      IDEASEEK_FAKE_DATASET_OUTPUT: badOutput,
    });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/PARSE_FAILED/);
    expect(failed.stderr).toMatch(/was not provided|grounded/);
    const after = await readFile(join(dir, 'knowledge', 'dataset-candidates.json'), 'utf8');
    expect(after).toBe(before);
  }, 180_000);

  it('quota blocks write nothing and a plain rerun recovers', async () => {
    const dir = await initProject('datasets-quota');
    await writeFile(join(dir, 'knowledge', 'research-map.md'), MAP_FIXTURE, 'utf8');
    const first = await runCli(dir, ['datasets', 'discover', '--harness', 'fake', '--json']);
    expect(first.code, first.stderr).toBe(0);
    const before = await readFile(join(dir, 'knowledge', 'dataset-candidates.json'), 'utf8');

    const blocked = await runCli(dir, ['datasets', 'discover', '--harness', 'fake', '--force'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toMatch(/nothing was written/);
    expect(blocked.stderr).toMatch(/QUOTA_EXHAUSTED/);
    const after = await readFile(join(dir, 'knowledge', 'dataset-candidates.json'), 'utf8');
    expect(after).toBe(before);

    const recovered = await runCli(dir, ['datasets', 'discover', '--harness', 'fake', '--force']);
    expect(recovered.code, recovered.stderr).toBe(0);
  }, 180_000);

  it('authorization is confirmation-gated, audited and never downloads', async () => {
    const dir = await initProject('datasets-authorize');
    await writeFile(join(dir, 'knowledge', 'research-map.md'), MAP_FIXTURE, 'utf8');
    expect((await runCli(dir, ['run', '--question', 'authorize', '--enqueue-only'])).code).toBe(0);
    const discover = await runCli(dir, ['datasets', 'discover', '--harness', 'none', '--json']);
    expect(discover.code, discover.stderr).toBe(0);

    // Unknown access needs explicit confirmation in guided mode.
    const noConfirm = await runCli(dir, ['datasets', 'authorize', 'ds-custombench', '--grant']);
    expect(noConfirm.code).toBe(2);
    expect(noConfirm.stderr).toMatch(/change-data-usage/);
    expect(noConfirm.stderr).toMatch(/--confirm/);

    const granted = await runCli(dir, [
      'datasets',
      'authorize',
      'ds-custombench',
      '--grant',
      '--confirm',
      '--json',
    ]);
    expect(granted.code, granted.stderr).toBe(0);
    const grantPayload = JSON.parse(granted.stdout) as {
      status: string;
      downloadStatus: string;
      authorization: { state: string; decidedBy: string };
      decisionSeq: number | null;
    };
    expect(grantPayload.authorization.state).toBe('granted');
    expect(grantPayload.downloadStatus).toBe('authorized');
    expect(grantPayload.decisionSeq).toBeGreaterThan(0);

    const events = await runCli(dir, ['events', '--json']);
    expect(events.stdout).toContain('change-data-usage');
    expect(events.stdout).toContain('dataset-candidate:ds-custombench grant');

    const denyNoReason = await runCli(dir, ['datasets', 'authorize', 'ds-custombench', '--deny']);
    expect(denyNoReason.code).toBe(2);
    expect(denyNoReason.stderr).toMatch(/--deny requires --reason/);

    const denied = await runCli(dir, [
      'datasets',
      'authorize',
      'ds-custombench',
      '--deny',
      '--reason',
      'license incompatible',
      '--json',
    ]);
    expect(denied.code, denied.stderr).toBe(0);
    const denyPayload = JSON.parse(denied.stdout) as {
      status: string;
      downloadStatus: string;
      authorization: { state: string; reason: string };
    };
    expect(denyPayload.status).toBe('rejected');
    expect(denyPayload.downloadStatus).toBe('blocked');
    expect(denyPayload.authorization.reason).toBe('license incompatible');

    const explain = await runCli(dir, ['datasets', 'explain', 'ds-custombench', '--json']);
    const detail = JSON.parse(explain.stdout) as { readiness: { ready: boolean } };
    expect(detail.readiness.ready).toBe(false);
  }, 240_000);

  it('a public small dataset grant stays low-friction (no --confirm) yet recorded', async () => {
    const dir = await initProject('datasets-public-grant');
    await writeFile(join(dir, 'knowledge', 'research-map.md'), MAP_FIXTURE, 'utf8');
    const boot = await runCli(dir, ['datasets', 'discover', '--harness', 'none', '--json']);
    expect(boot.code, boot.stderr).toBe(0);
    const artifact = await readArtifact(dir);
    const evidenceId = artifact.evidence[0]!.evidenceId as string;

    const override = JSON.stringify({
      candidates: [
        {
          name: 'CustomBench',
          task: 'benchmark suite',
          unit: 'unknown',
          scale: null,
          license: { value: 'CC-BY-4.0', confidence: 0.8, note: 'stated in the research map' },
          acquisition: 'public-download',
          restricted: false,
          size: 'small',
          url: 'https://example.org/custombench.zip',
          indexId: null,
          instructions: 'download from the project page',
          relatedPapers: [],
          evidenceIds: [evidenceId],
          relevanceReason: 'matches the configured research question',
          confidence: 0.7,
          confidenceBasis: ['research-map mention with stated license and url'],
          notes: [],
        },
      ],
      notes: [],
    });
    const enriched = await runCli(
      dir,
      ['datasets', 'discover', '--harness', 'fake', '--force', '--json'],
      { IDEASEEK_FAKE_DATASET_OUTPUT: override },
    );
    expect(enriched.code, enriched.stderr).toBe(0);

    const explain = await runCli(dir, ['datasets', 'explain', 'ds-custombench', '--json']);
    const detail = JSON.parse(explain.stdout) as {
      requiresConfirmation: boolean;
      candidate: { access: { url: string; size: string }; downloadStatus: string };
    };
    expect(detail.requiresConfirmation).toBe(false);
    expect(detail.candidate.access.url).toBe('https://example.org/custombench.zip');
    expect(detail.candidate.downloadStatus).toBe('proposed');

    const granted = await runCli(dir, [
      'datasets',
      'authorize',
      'ds-custombench',
      '--grant',
      '--json',
    ]);
    expect(granted.code, granted.stderr).toBe(0);
    const payload = JSON.parse(granted.stdout) as {
      authorization: { state: string };
      requiresConfirmation: boolean;
      decisionSeq: number | null;
    };
    expect(payload.authorization.state).toBe('granted');
    expect(payload.requiresConfirmation).toBe(false);
    expect(payload.decisionSeq).toBeNull(); // no run exists — recorded honestly as null
  }, 240_000);

  it('refuses the academic index by policy before any network attempt', async () => {
    const dir = await initProject('datasets-index-policy');
    const discover = await runCli(dir, [
      'datasets',
      'discover',
      '--harness',
      'none',
      '--sources',
      'academic-index',
      '--json',
    ]);
    expect(discover.code, discover.stderr).toBe(0);
    const payload = JSON.parse(discover.stdout) as {
      incompleteSources: boolean;
      sources: { kind: string; status: string; reason: string | null }[];
    };
    expect(payload.sources).toHaveLength(1);
    expect(payload.sources[0]!.kind).toBe('academic-index');
    expect(payload.sources[0]!.status).toBe('refused');
    expect(payload.sources[0]!.reason).toMatch(/external_search/);
    expect(payload.incompleteSources).toBe(true);
  }, 180_000);

  it('link is the only promotion path: missing data refused, provided data promoted', async () => {
    const dir = await initProject('datasets-link');
    await writeFile(join(dir, 'knowledge', 'research-map.md'), MAP_FIXTURE, 'utf8');
    expect((await runCli(dir, ['run', '--question', 'link', '--enqueue-only'])).code).toBe(0);
    const discover = await runCli(dir, ['datasets', 'discover', '--harness', 'none', '--json']);
    expect(discover.code, discover.stderr).toBe(0);

    // Data not provided yet → link fail-closed.
    const missing = await runCli(dir, [
      'datasets',
      'link',
      'ds-custombench',
      '--path',
      'datasets/linked.csv',
    ]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toMatch(/not found/);

    // Paths outside the project are refused.
    await writeFile(join(dir, 'datasets', 'linked.csv'), 'label,feat\n0,1\n1,2\n', 'utf8');
    const outside = await runCli(dir, [
      'datasets',
      'link',
      'ds-custombench',
      '--path',
      join(dir, '..', 'outside.csv'),
    ]);
    expect(outside.code).toBe(2);

    expect((await runCli(dir, ['scan'])).code).toBe(0);
    const linked = await runCli(dir, [
      'datasets',
      'link',
      'ds-custombench',
      '--path',
      'datasets/linked.csv',
      '--json',
    ]);
    expect(linked.code, linked.stderr).toBe(0);
    const payload = JSON.parse(linked.stdout) as {
      status: string;
      downloadStatus: string;
      local: { datasetSnapshotId: string | null; path: string };
    };
    expect(payload.status).toBe('user-provided');
    expect(payload.downloadStatus).toBe('local-present');
    expect(payload.local.datasetSnapshotId).toMatch(/^data-[0-9a-f]{12}$/);

    const explain = await runCli(dir, ['datasets', 'explain', 'ds-custombench', '--json']);
    const detail = JSON.parse(explain.stdout) as {
      readiness: { ready: boolean };
      requiresConfirmation: boolean;
    };
    expect(detail.readiness.ready).toBe(true);
    expect(detail.requiresConfirmation).toBe(false);

    // Promotion is recorded in the audit stream.
    expect((await runCli(dir, ['events', '--json'])).stdout).toContain('dataset_linked');
  }, 240_000);
});
