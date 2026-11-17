import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { metricIdentifier } from '../core/metric-id.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import { isBaselineSubjectRun } from '../idea/analyze.js';
import { stableJson } from '../experiment/spec.js';

/**
 * Full-run comparison fairness lock (docs/PROGRESS Phase 7, checklist
 * 数据/split、预处理、指标、调参预算、seed/repeats、资源和偏差说明;
 * docs/FULL_RESEARCH_MODE.md 锁定前逐方法对齐): a per-method alignment
 * of every required comparison against the locked protocol and the
 * idea's own experiment spec.
 *
 * Machine-checkable dimensions (data/split, metrics, seeds/repeats) are
 * derived from persisted specs; dimensions the platform cannot verify
 * from records (preprocessing, tuning budget, early stopping, model
 * selection, resources) are reported as `unknown` with an explicit
 * detail — the researcher's `--confirm` is what declares them, never a
 * silent pass. Missing inputs (no protocol lock, no idea spec, a
 * required method with no succeeded experiment) are blockers: the lock
 * refuses to confirm until each has a recovery command.
 *
 * Confirmation binds to inputHash (same rule as `full plan`): any state
 * change makes the stored lock stale and forces a re-build + re-confirm.
 */

export const FAIRNESS_SCHEMA = 'fairness-lock-v1';

export const FAIRNESS_DIMENSIONS = [
  'data-split',
  'preprocessing',
  'metrics',
  'tuning-budget',
  'seeds-repeats',
  'resources',
  'early-stopping',
  'model-selection',
] as const;

export type FairnessDimension = (typeof FAIRNESS_DIMENSIONS)[number];
export type FairnessStatus = 'aligned' | 'deviation' | 'unknown';

export interface FairnessDimensionStatus {
  dimension: FairnessDimension;
  status: FairnessStatus;
  detail: string;
}

export interface FairnessMethodEntry {
  methodId: string;
  status: string;
  dimensions: FairnessDimensionStatus[];
  deviations: string[];
}

export interface FairnessLock {
  contract: typeof FAIRNESS_SCHEMA;
  ideaId: string;
  inputHash: string;
  generatedAt: number;
  protocol: { protocolId: string; protocolHash: string } | null;
  /** The idea-side spec every required method is aligned against. */
  reference: {
    specId: string | null;
    dataSnapshotId: string | null;
    sliceIds: string[];
    seeds: number[];
    metrics: string[];
  };
  methods: FairnessMethodEntry[];
  /** Must be empty before `--confirm`. */
  blockers: string[];
  confirmed?: { at: number; mode: string; inputHash: string };
}

/** Dimensions the platform derives from recorded specs (the rest are declared). */
const MACHINE_CHECKED: ReadonlySet<FairnessDimension> = new Set<FairnessDimension>([
  'data-split',
  'metrics',
  'seeds-repeats',
]);

function metricNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : ((item as { name?: unknown })?.name ?? null)))
    .filter((name): name is string => typeof name === 'string');
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

function computeInputHash(
  plan: Omit<FairnessLock, 'inputHash' | 'generatedAt' | 'confirmed'>,
): string {
  // generatedAt is wall-clock and confirmed is the researcher stamp —
  // neither may affect the hash (same rule as the full plan).
  const { generatedAt: _ts, ...stable } = plan as FairnessLock;
  return sha256Of(stableJson(stable));
}

interface SpecShape {
  /** The idea binding decides whether a run may stand as a method's evidence. */
  idea?: { ideaId: string; version: number } | null;
  dataSnapshotId?: unknown;
  sliceIds?: unknown;
  seeds?: unknown;
  metrics?: unknown;
  comparisonIds?: unknown;
  createdAt?: unknown;
}

function readSpec(spec: Record<string, unknown> | null | undefined): SpecShape | null {
  return spec ? (spec as SpecShape) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : [];
}

/**
 * Builds the fairness lock from persisted state (read-only). Never throws
 * for missing prerequisites — they become blockers with recovery commands
 * so the report itself is always printable.
 */
export async function buildFairnessLock(root: string, ideaId: string): Promise<FairnessLock> {
  const { loadIdeaCard } = await import('../idea/workspace.js');
  void (await loadIdeaCard(root, ideaId)); // existence check: unknown idea still fails loud
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const blockers: string[] = [];

    const locks = await runtime.db.listProtocolLocks();
    const protocol = locks.length > 0 ? locks[locks.length - 1]! : null;
    if (!protocol) {
      blockers.push(
        'no locked protocol — run: ideaseek protocol propose, then ideaseek confirm protocol',
      );
    }

    const ideaDoc = await runtime.db.getExperiment(`idea-${ideaId}`);
    const ideaSpec = readSpec(ideaDoc?.spec);
    if (!ideaSpec) {
      blockers.push(
        `no experiment spec for idea-${ideaId} — run: ideaseek idea experiment ${ideaId} --scale smoke`,
      );
    }

    const reference = {
      specId: ideaDoc?.specId ?? null,
      dataSnapshotId: typeof ideaSpec?.dataSnapshotId === 'string' ? ideaSpec.dataSnapshotId : null,
      sliceIds: strings(ideaSpec?.sliceIds).slice().sort(),
      seeds: numbers(ideaSpec?.seeds)
        .slice()
        .sort((a, b) => a - b),
      metrics: metricNames(ideaSpec?.metrics).slice().sort(),
    };

    const protocolPrimaries = metricNames(protocol?.record?.primaryMetrics)
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort();
    const protocolSecondaries = metricNames(protocol?.record?.secondaryMetrics)
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort();
    const protocolMetrics = [...protocolPrimaries, ...protocolSecondaries]
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort();

    const experiments = await runtime.db.listExperiments();
    // Latest succeeded experiment covering each method (spec.createdAt,
    // then specId as a deterministic tiebreak).
    const covering = new Map<string, Record<string, unknown> | null>();
    for (const doc of experiments) {
      const spec = readSpec(doc.spec);
      if (!spec) continue;
      const resultStatus = (doc.result as { status?: unknown } | null)?.status;
      if (resultStatus !== 'succeeded' && resultStatus !== 'partial') continue;
      for (const id of strings(spec.comparisonIds)) {
        // A run that merely *lists* a method in comparisonIds is not evidence
        // about that method — it is the idea naming its opponents. Without this
        // filter the idea's own experiment (created latest, so it always wins)
        // became "the fedavg run", and the fairness lock compared the idea
        // against itself: identical seeds, identical snapshot, `aligned`, and a
        // full run authorised with no baseline evidence at all. Same defect as
        // #23, which was already closed in the analysis layer by
        // `isBaselineSubjectRun` — this gate had simply never been audited.
        if (
          !isBaselineSubjectRun(
            { idea: spec.idea ?? null, comparisonIds: strings(spec.comparisonIds) },
            id,
            ideaId,
          )
        )
          continue;
        const current = covering.get(id);
        const currentSpec = readSpec(current);
        const currentAt = typeof currentSpec?.createdAt === 'number' ? currentSpec.createdAt : -1;
        const nextAt = typeof spec.createdAt === 'number' ? spec.createdAt : -1;
        // Strictly-newer wins; ties keep the first (list order is stable).
        if (!current || nextAt > currentAt) {
          covering.set(id, doc.spec as Record<string, unknown>);
        }
      }
    }

    const methods = await runtime.db.listComparisons({ required: true });
    const entries: FairnessMethodEntry[] = [];
    for (const method of methods.slice().sort((a, b) => a.methodId.localeCompare(b.methodId))) {
      if (method.status === 'excluded') continue; // out of the full run by decision
      if (method.status === 'blocked') {
        blockers.push(
          `required comparison ${method.methodId} is blocked — resolve it (comparison repair/import) or exclude it with a reason`,
        );
      }

      const spec = readSpec(covering.get(method.methodId));
      const dimensions: FairnessDimensionStatus[] = [];
      const deviations: string[] = [];

      if (!spec) {
        blockers.push(
          `required comparison ${method.methodId} has no succeeded experiment — record one (comparison import/eval) before locking fairness`,
        );
        for (const dimension of FAIRNESS_DIMENSIONS) {
          dimensions.push({
            dimension,
            status: 'unknown',
            detail: `no succeeded experiment spec covers ${method.methodId}`,
          });
        }
        entries.push({ methodId: method.methodId, status: method.status, dimensions, deviations });
        continue;
      }

      // data/split: same snapshot + same slices as the idea's own spec.
      const specSnapshot = typeof spec.dataSnapshotId === 'string' ? spec.dataSnapshotId : null;
      const specSlices = strings(spec.sliceIds).slice().sort();
      if (specSnapshot === reference.dataSnapshotId && sameSet(specSlices, reference.sliceIds)) {
        dimensions.push({
          dimension: 'data-split',
          status: 'aligned',
          detail: `snapshot ${specSnapshot ?? 'none'} with the same slices as the idea spec`,
        });
      } else {
        const detail =
          `method uses snapshot ${specSnapshot ?? 'none'} slices [${specSlices.join(', ')}] ` +
          `vs idea ${reference.dataSnapshotId ?? 'none'} slices [${reference.sliceIds.join(', ')}]`;
        dimensions.push({ dimension: 'data-split', status: 'deviation', detail });
        deviations.push(`data-split: ${detail}`);
      }

      // metrics: every protocol primary/secondary metric must be produced.
      //
      // Matched by metric identifier, not by string equality. The protocol
      // declares `target_unseen_domain_top1_accuracy (held-out domain value, all
      // samples, %)` while a method spec records the bare identifier, so exact
      // comparison called every protocol metric missing on every method — a lock
      // that reports universal unfairness teaches the operator to confirm past
      // it, which destroys the only thing a fairness lock is for. This is #15's
      // vocabulary gap arriving in a layer nobody had looked at.
      const specMetrics = metricNames(spec.metrics);
      const specIdentifiers = new Set(specMetrics.map(metricIdentifier));
      // Fairness asks one question: is the quantity being compared produced the
      // same way on both sides. So only the protocol's PRIMARY metrics can be a
      // deviation. Requiring every declared secondary turned the lock into a
      // machine that reported all real baselines as unfair — upstream method
      // code is not ours to extend, and an idea-specific diagnostic
      // (`communication_cost_per_round`, a privacy attack score) missing from
      // fedavg says nothing about whether top-1 accuracy was measured alike.
      // Secondaries are still reported, because coverage is a fact the
      // researcher needs; they just do not block, which is what made operators
      // confirm past a lock that cried wolf every time.
      const missingPrimaries = protocolPrimaries.filter(
        (name) => !specIdentifiers.has(metricIdentifier(name)),
      );
      const missingSecondaries = protocolSecondaries.filter(
        (name) => !specIdentifiers.has(metricIdentifier(name)),
      );
      const missing = [...missingPrimaries, ...missingSecondaries];
      const coveredCount = protocolMetrics.length - missing.length;
      const matchedByName = protocolMetrics.filter(
        (name) => specMetrics.includes(name) && !missing.includes(name),
      );
      const matchedByIdOnly = coveredCount - matchedByName.length;
      if (protocolMetrics.length === 0) {
        dimensions.push({
          dimension: 'metrics',
          status: 'unknown',
          detail: 'locked protocol declares no metrics',
        });
      } else if (missingPrimaries.length > 0) {
        // The compared quantity itself is absent: this is a real deviation and
        // it blocks, because a delta against a method that did not produce the
        // primary metric is not a comparison at all.
        const detail =
          `method does not produce ${missingPrimaries.length} of ` +
          `${protocolPrimaries.length} protocol PRIMARY metric(s): ` +
          `${missingPrimaries.map((name) => metricIdentifier(name)).join(', ')}`;
        dimensions.push({ dimension: 'metrics', status: 'deviation', detail });
        deviations.push(`metrics: ${detail}`);
      } else if (missingSecondaries.length > 0) {
        // Reported, not blocked: the primaries line up, and a missing
        // idea-specific diagnostic is coverage information rather than an
        // unfair comparison.
        dimensions.push({
          dimension: 'metrics',
          status: 'aligned',
          detail:
            `produces all ${protocolPrimaries.length} primary metric(s); ` +
            `${missingSecondaries.length} of ${protocolSecondaries.length} secondary metric(s) ` +
            `not produced by this method (${missingSecondaries
              .slice(0, 4)
              .map((name) => metricIdentifier(name))
              .join(', ')}${
              missingSecondaries.length > 4 ? ` +${missingSecondaries.length - 4} more` : ''
            } — information only, the compared quantity is matched)`,
        });
      } else {
        // Saying "all matched" when nothing matched by the declared string is
        // misleading in the other direction: the comparison succeeded because
        // the identifier agreed while the prose differed, which is worth
        // knowing before someone treats the two names as interchangeable.
        const proseNote =
          matchedByIdOnly > 0
            ? ` — ${matchedByIdOnly} matched by identifier only, where the method spec omits the ` +
              'protocol definition prose: identity rests on the name, not on the stated ' +
              'population or aggregation'
            : '';
        dimensions.push({
          dimension: 'metrics',
          status: 'aligned',
          detail: `produces all ${protocolMetrics.length} protocol metric(s)${proseNote}`,
        });
      }

      // seeds/repeats: identical seed set to the idea's own spec.
      const specSeeds = numbers(spec.seeds)
        .slice()
        .sort((a, b) => a - b);
      if (
        reference.seeds.length > 0 &&
        sameSet(specSeeds.map(String), reference.seeds.map(String))
      ) {
        dimensions.push({
          dimension: 'seeds-repeats',
          status: 'aligned',
          detail: `same seeds as the idea spec: ${reference.seeds.join(', ')}`,
        });
      } else {
        const detail = `method seeds [${specSeeds.join(', ')}] vs idea seeds [${reference.seeds.join(', ')}]`;
        dimensions.push({ dimension: 'seeds-repeats', status: 'deviation', detail });
        deviations.push(`seeds-repeats: ${detail}`);
      }

      // Declared dimensions: the platform cannot verify these from
      // recorded specs — the researcher's confirm is the declaration.
      const declaredDetail =
        'not machine-checkable from recorded specs — researcher confirms the aligned setup at --confirm';
      for (const dimension of FAIRNESS_DIMENSIONS) {
        if (MACHINE_CHECKED.has(dimension)) continue;
        dimensions.push({ dimension, status: 'unknown', detail: declaredDetail });
      }

      entries.push({ methodId: method.methodId, status: method.status, dimensions, deviations });
    }

    const base: Omit<FairnessLock, 'inputHash'> = {
      contract: FAIRNESS_SCHEMA,
      ideaId,
      generatedAt: Date.now(),
      protocol: protocol
        ? { protocolId: protocol.protocolId, protocolHash: protocol.protocolHash }
        : null,
      reference,
      methods: entries,
      blockers,
    };
    const inputHash = computeInputHash(base);
    const lock: FairnessLock = { ...base, inputHash };
    // Defense in depth (JSON Schema authority): the lock is COMPUTED BY CODE
    // from persisted specs, never answered by a model, so a payload that does not
    // match fairness-lock-v1 is a platform bug with no defensible reading. It
    // matters which payload that is: this file is the evidence `full plan` reads
    // back to decide whether fairness is confirmed+current, and a lock whose
    // methods/dimensions drifted from the contract would gate a full run on
    // structure nobody can interpret. Refused before knowledge/fairness-<idea>.json
    // is written (src/commands/full.ts), so a broken build never becomes state.
    assertAgainstSchema(FAIRNESS_SCHEMA, lock);
    return lock;
  } finally {
    await runtime.close();
  }
}

/** Pure confirm gates: shape + freshness + blockers (unit-testable). */
export function assertFairnessApprovable(lock: FairnessLock, currentInputHash: string): void {
  // The object confirmed here is the one on disk, which the researcher may have
  // opened. A lock missing `blockers` used to crash this very gate
  // (`lock.blockers.length` on undefined) after the freshness comparison had
  // already passed, which is a stack trace where a contract violation was the
  // truth; `ideaseek full fairness --idea <id>` rebuilds it either way, so
  // nothing that could be confirmed before is refused now — a valid lock passes
  // and the confirmation stamp it earns is unchanged.
  assertAgainstSchema(FAIRNESS_SCHEMA, lock);
  if (lock.inputHash !== currentInputHash) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      'fairness lock is stale (project state changed since it was built) — rerun: ideaseek full fairness --idea <id>',
    );
  }
  if (lock.blockers.length > 0) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `fairness lock has blockers: ${lock.blockers.join('; ')}`,
      { blockers: lock.blockers },
    );
  }
}
