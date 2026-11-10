import type { FederatedDatasetProfile, DatasetSplitProfile } from '../knowledge/federated.js';

/**
 * Federated dataset slice rules (rule v2, selection-only: NO data is copied —
 * originals stay read-only and experiments read them directly using these
 * selections). Deterministic seeded picks per scale:
 *
 * | scale    | clients        | samples/client |
 * | smoke    | ceil(10%) ≥ 1  | 50             |
 * | quick    | ceil(20%) ≥ 1  | 100            |
 * | standard | all            | all            |
 */
export const FEDERATED_RULE_VERSION = 2;

export const FEDERATED_SCALE_RULES: Record<
  'smoke' | 'quick' | 'standard',
  { clientFraction: number; samplesPerClient: number | null }
> = {
  smoke: { clientFraction: 0.1, samplesPerClient: 50 },
  quick: { clientFraction: 0.2, samplesPerClient: 100 },
  standard: { clientFraction: 1, samplesPerClient: null },
};

export interface FederatedClientSelection {
  id: string;
  sourceSamples: number;
  /** Selected sample count. */
  keptSamples: number;
  /** Explicit indices (null = all rows, i.e. standard scale). */
  indices: number[] | null;
}

export interface FederatedSliceRecord {
  kind: 'federated';
  sliceId: string;
  datasetSnapshotId: string;
  datasetRoot: string;
  rootHash: string;
  scale: 'smoke' | 'quick' | 'standard';
  split: 'train' | 'test';
  rule: string;
  ruleVersion: number;
  seed: number;
  clients: FederatedClientSelection[];
  stats: { clientsSelected: number; clientsTotal: number; rowsSelected: number; rowsTotal: number };
  boundaries: string[];
  limits: string[];
  generatedBy: string;
  generatedAt: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface BuildFederatedSlicesOptions {
  profile: FederatedDatasetProfile;
  scale: 'smoke' | 'quick' | 'standard';
  split: 'train' | 'test';
  seed: number;
  generatedBy: string;
  now: number;
}

/** Deterministic selection manifest for one scale/split (content-addressed id). */
export function buildFederatedSlice(opts: BuildFederatedSlicesOptions): FederatedSliceRecord {
  const split: DatasetSplitProfile | undefined = opts.profile.splits[opts.split];
  if (!split) {
    throw new Error(`dataset has no ${opts.split} split`);
  }
  const rules = FEDERATED_SCALE_RULES[opts.scale];
  const random = mulberry32(opts.seed ^ (opts.split === 'test' ? 0x9e3779b9 : 0));
  const pickedClients = shuffled(split.clients, random).slice(
    0,
    Math.max(1, Math.ceil(split.clients.length * rules.clientFraction)),
  );

  let rowsSelected = 0;
  const clients: FederatedClientSelection[] = pickedClients.map((client) => {
    if (rules.samplesPerClient === null) {
      rowsSelected += client.samples;
      return {
        id: client.id,
        sourceSamples: client.samples,
        keptSamples: client.samples,
        indices: null,
      };
    }
    const take = Math.min(rules.samplesPerClient, client.samples);
    const indices = shuffled(
      Array.from({ length: client.samples }, (_, index) => index),
      random,
    )
      .slice(0, take)
      .sort((a, b) => a - b);
    rowsSelected += indices.length;
    return { id: client.id, sourceSamples: client.samples, keptSamples: indices.length, indices };
  });

  const datasetSnapshotId = `data-fed-${opts.profile.rootHash.slice(7, 19)}`;
  const sliceId = `ds-fed-${opts.profile.rootHash.slice(7, 19)}-${opts.split}-${opts.scale}-r${FEDERATED_RULE_VERSION}`;
  const rule =
    opts.scale === 'standard'
      ? `all ${split.clients.length} ${opts.split} clients, all samples (rule v${FEDERATED_RULE_VERSION})`
      : `${rules.clientFraction * 100}% of clients seeded(seed=${opts.seed}), up to ${rules.samplesPerClient} samples/client (rule v${FEDERATED_RULE_VERSION})`;

  return {
    kind: 'federated',
    sliceId,
    datasetSnapshotId,
    datasetRoot: opts.profile.root,
    rootHash: opts.profile.rootHash,
    scale: opts.scale,
    split: opts.split,
    rule,
    ruleVersion: FEDERATED_RULE_VERSION,
    seed: opts.seed,
    clients,
    stats: {
      clientsSelected: clients.length,
      clientsTotal: split.clients.length,
      rowsSelected,
      rowsTotal: split.totalSamples,
    },
    boundaries: [
      `client-partition preserved (${opts.split}: ${split.clients.length} clients, non-IID tv=${opts.profile.nonIid.tvDistanceMean})`,
      'sample selection is within-client; no cross-client mixing',
    ],
    limits: [
      'selection-only manifest: experiments read the ORIGINAL read-only files by client id + indices',
      'label semantics come from the dataset owner; platform treats y as opaque labels',
    ],
    generatedBy: opts.generatedBy,
    generatedAt: opts.now,
  };
}

/** All six slice records (3 scales × train/test) for a federated dataset. */
export function buildAllFederatedSlices(
  profile: FederatedDatasetProfile,
  opts: { seed: number; generatedBy: string; now: number },
): FederatedSliceRecord[] {
  const out: FederatedSliceRecord[] = [];
  for (const split of ['train', 'test'] as const) {
    if (!profile.splits[split]) continue;
    for (const scale of ['smoke', 'quick', 'standard'] as const) {
      out.push(
        buildFederatedSlice({
          profile,
          scale,
          split,
          seed: opts.seed,
          generatedBy: opts.generatedBy,
          now: opts.now,
        }),
      );
    }
  }
  return out;
}
