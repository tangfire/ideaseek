import { expect, it } from 'vitest';
import { protocolMetricNames, readLockedProtocol } from '../src/experiment/protocol-source.js';

function runtimeFor(proposals: unknown[], lockedIds: string[] = []) {
  const byHash = new Map<string, string>();
  return {
    db: {
      listArtifactsByKind: async () =>
        proposals.map((proposal, index) => {
          const contentHash = `h${index}`;
          byHash.set(contentHash, JSON.stringify(proposal));
          return { contentHash };
        }),
      getProtocolLock: async (protocolId: string) =>
        lockedIds.includes(protocolId) ? { protocolId } : null,
    },
    store: { readFinalText: async (contentHash: string) => byHash.get(contentHash) ?? '{}' },
  };
}

it('reads the newest proposal, which is the current one', async () => {
  const protocol = await readLockedProtocol(
    runtimeFor([
      { protocolId: 'proto-1', primaryMetrics: [{ name: 'old_metric', direction: 'higher' }] },
      {
        protocolId: 'proto-2',
        primaryMetrics: [{ name: 'target_unseen_domain_top1_accuracy', direction: 'higher' }],
      },
    ]),
  );
  expect(protocol?.protocolId).toBe('proto-2');
  expect(protocolMetricNames(protocol)).toEqual(['target_unseen_domain_top1_accuracy']);
});

it('distinguishes proposed from locked', async () => {
  const proposal = [
    { protocolId: 'proto-1', primaryMetrics: [{ name: 'm', direction: 'higher' }] },
  ];
  expect((await readLockedProtocol(runtimeFor(proposal)))?.locked).toBe(false);
  expect((await readLockedProtocol(runtimeFor(proposal, ['proto-1'])))?.locked).toBe(true);
});

it('counts secondary metrics as required output too', async () => {
  const protocol = await readLockedProtocol(
    runtimeFor([
      {
        protocolId: 'proto-1',
        primaryMetrics: [{ name: 'acc', direction: 'higher' }],
        secondaryMetrics: [{ name: 'std', direction: 'lower' }],
      },
    ]),
  );
  expect(protocolMetricNames(protocol)).toEqual(['acc', 'std']);
});

it('accepts slicing both as a sourced value and as a bare list', async () => {
  const wrapped = await readLockedProtocol(
    runtimeFor([{ protocolId: 'p', slicing: { value: [{ fold: 'lodo' }] } }]),
  );
  expect(wrapped?.slicing).toEqual([{ fold: 'lodo' }]);
  const bare = await readLockedProtocol(
    runtimeFor([{ protocolId: 'p', slicing: [{ fold: 'lodo' }] }]),
  );
  expect(bare?.slicing).toEqual([{ fold: 'lodo' }]);
});

it('returns null instead of inventing a protocol when none exists', async () => {
  expect(await readLockedProtocol(runtimeFor([]))).toBeNull();
  expect(protocolMetricNames(null)).toEqual([]);
});

it('fails loudly on an unreadable stored artifact', async () => {
  const broken = {
    db: {
      listArtifactsByKind: async () => [{ contentHash: 'h0' }],
      getProtocolLock: async () => null,
    },
    store: { readFinalText: async () => '{not json' },
  };
  await expect(readLockedProtocol(broken)).rejects.toThrow(/cannot be read/);
});

it('reads baselineEntries so confirm can enforce them against the registry', async () => {
  const protocol = await readLockedProtocol(
    runtimeFor([
      {
        protocolId: 'proto-baselines',
        primaryMetrics: [{ name: 'acc', direction: 'higher' }],
        baselineEntries: [
          { methodId: 'fedavg', entry: 'python train.py', source: 'code' },
          { methodId: 42 }, // malformed entries are dropped, not crashed on
          'nonsense',
        ],
      },
    ]),
  );
  expect(protocol?.baselineEntries).toEqual([
    { methodId: 'fedavg', entry: 'python train.py', source: 'code' },
  ]);
});

it('reports an empty baseline list when an older proposal lacks the field', async () => {
  const protocol = await readLockedProtocol(runtimeFor([{ protocolId: 'proto-old' }]));
  expect(protocol?.baselineEntries).toEqual([]);
});
