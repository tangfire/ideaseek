import { describe, expect, it } from 'vitest';
import { validateAgainstSchema } from '../src/core/schema/index.js';

/**
 * cloud-projection-v1: the wire contract between `ideaseek cloud push` and the
 * Sites Function `/api/ingest`.
 *
 * These tests pin the BOUNDARY half of the contract — the mechanical
 * invariants that must not depend on anyone's judgment: batch identity,
 * closedness under unknown keys, length caps, hash and path shapes, and the
 * coherence rules that keep an un-disclosed hypothesis off the wire.
 * Content-level sanitization (deciding that a given summary leaks something)
 * is the projector's job and is tested there, not here.
 */

type Rec = Record<string, unknown>;

function validBatch(): Rec {
  return {
    schema_version: 1,
    external_batch_id: 'run-a1b2c3d4e5f60718',
    generated_at: 1_700_000_000_000,
    local_schema_version: 10,
    project: {
      external_id: 'proj-a1b2c3d4e5f60718',
      title: 'Continual learning',
      question: 'How to reduce catastrophic forgetting?',
      strategy: 'standard',
      autonomy: 'guided',
      visibility: 'private',
      source_host: 'gpu-node-01',
    },
    entities: {
      runs: [
        {
          external_run_id: 'run-a1b2c3d4e5f60718',
          status: 'RUNNING',
          phase_tag: 'PAPER_ANALYSIS',
          started_at: 1_700_000_000_000,
          budget: { budget_usd_micro: 5_000_000, spent_usd_micro: 120_340 },
        },
      ],
      stages: [
        {
          run_external_id: 'run-a1b2c3d4e5f60718',
          stage: 'PAPER_ANALYSIS',
          state: 'active',
          stage_known: true,
        },
      ],
      tasks: [
        {
          external_task_id: 'task-a1b2c3d4e5f60718',
          run_external_id: 'run-a1b2c3d4e5f60718',
          kind: 'paper.extract',
          status: 'succeeded',
          attempt: 1,
          artifact_count: 2,
        },
      ],
      events: [
        {
          run_external_id: 'run-a1b2c3d4e5f60718',
          seq: 7,
          ts: 1_700_000_001_000,
          event_type: 'harness_tool_call',
          summary: 'extracted 34 claims from 12 papers',
          level: 'info',
        },
      ],
      artifacts: [
        {
          external_artifact_id: 'art-a1b2c3d4e5f60718',
          run_external_id: 'run-a1b2c3d4e5f60718',
          kind: 'papercard',
          content_hash: `sha256:${'a'.repeat(64)}`,
          size_bytes: 18_244,
          path_hint: 'knowledge/papers/attention.json',
          status: 'committed',
        },
      ],
      ideas: [
        {
          external_idea_id: 'idea-a1b2c3d4e5f60718',
          title: 'Memory-aware replay weighting',
          hypothesis_disclosure: 'withheld',
          status: 'PROPOSED',
        },
      ],
      metrics: [
        {
          external_metric_id: 'metric-a1b2c3d4e5f60718',
          experiment_external_id: 'spec-a1b2c3d4e5f60718',
          name: 'forgetting_rate',
          value: 0.12,
          is_synthetic: false,
        },
      ],
    },
  };
}

function mutate(apply: (batch: Rec) => void): Rec {
  const batch = structuredClone(validBatch());
  apply(batch);
  return batch;
}

function first(batch: Rec, collection: string): Rec {
  const entities = batch.entities as Record<string, Rec[]>;
  const head = entities[collection]?.[0];
  if (!head) throw new Error(`fixture has no ${collection}[0]`);
  return head;
}

function expectAccepted(batch: Rec): void {
  const check = validateAgainstSchema('cloud-projection-v1', batch);
  expect(check.errors).toEqual([]);
}

/** Asserts the rejection lands on `path`, not merely that something failed. */
function expectRejectedAt(batch: Rec, path: string): void {
  const check = validateAgainstSchema('cloud-projection-v1', batch);
  expect(check.ok, `expected a rejection at ${path}`).toBe(false);
  expect(
    check.errors.some((error) => error.startsWith(`${path} `)),
    check.errors.join('; '),
  ).toBe(true);
}

describe('cloud-projection-v1', () => {
  it('accepts a realistic minimal batch', () => {
    expectAccepted(validBatch());
  });

  it('rejects an unknown major contract version instead of guessing at fields', () => {
    expectRejectedAt(
      mutate((b) => {
        b.schema_version = 2;
      }),
      '/schema_version',
    );
  });

  it('requires the idempotency key to be a real local id', () => {
    expectRejectedAt(
      mutate((b) => {
        b.external_batch_id = 'batch-1';
      }),
      '/external_batch_id',
    );
  });

  it('rejects an unknown top-level key: silently dropping a field is how contracts drift', () => {
    expectRejectedAt(
      mutate((b) => {
        b.raw_prompt_log = [];
      }),
      '/raw_prompt_log',
    );
  });

  it('rejects an unknown entity collection key', () => {
    expectRejectedAt(
      mutate((b) => {
        (b.entities as Rec).secrets = [{ leak: true }];
      }),
      '/entities/secrets',
    );
  });

  it('reads an absent entity collection as "nothing changed", never as a deletion', () => {
    const batch = validBatch();
    delete (batch.entities as Rec).metrics;
    expectAccepted(batch);
  });

  it('refuses a run status the engine cannot emit', () => {
    expectRejectedAt(
      mutate((b) => {
        first(b, 'runs').status = 'BLOCKED';
      }),
      '/entities/runs/0/status',
    );
  });

  it('keeps phase_tag open because RunPhase is only INIT|DEMO|COMPLETED today', () => {
    // A 14-value enum here would be a contract the engine cannot satisfy; the
    // gap is surfaced through stages[].stage_known instead.
    expectAccepted(
      mutate((b) => {
        first(b, 'runs').phase_tag = 'COMPARISON_DISCOVERY';
      }),
    );
  });

  it('caps a summary at the NFR-03 limit', () => {
    expectRejectedAt(
      mutate((b) => {
        first(b, 'events').summary = 'x'.repeat(401);
      }),
      '/entities/events/0/summary',
    );
  });

  it('lets truncation be stated instead of implied by a full-length line', () => {
    expectAccepted(
      mutate((b) => {
        first(b, 'events').truncated = true;
      }),
    );
  });

  it('rejects an absolute path hint: the local filesystem layout is itself a disclosure', () => {
    expectRejectedAt(
      mutate((b) => {
        first(b, 'artifacts').path_hint = '/home/researcher/papers/x.json';
      }),
      '/entities/artifacts/0/path_hint',
    );
  });

  it('rejects a traversal in the path hint', () => {
    expectRejectedAt(
      mutate((b) => {
        first(b, 'artifacts').path_hint = '../../.env';
      }),
      '/entities/artifacts/0/path_hint',
    );
  });

  it('rejects a drive-qualified path hint', () => {
    expectRejectedAt(
      mutate((b) => {
        first(b, 'artifacts').path_hint = 'D:/study/papers/x.json';
      }),
      '/entities/artifacts/0/path_hint',
    );
  });

  it('rejects a content hash that is not a sha256 digest', () => {
    expectRejectedAt(
      mutate((b) => {
        first(b, 'artifacts').content_hash = 'md5:deadbeef';
      }),
      '/entities/artifacts/0/content_hash',
    );
  });

  it('has nowhere to put an artifact body', () => {
    expectRejectedAt(
      mutate((b) => {
        first(b, 'artifacts').body_base64 = 'aWNl';
      }),
      '/entities/artifacts/0/body_base64',
    );
  });

  it('requires a failed task to carry a classified cause', () => {
    expectRejectedAt(
      mutate((b) => {
        first(b, 'tasks').status = 'failed';
      }),
      '/entities/tasks/0/error_class',
    );
  });

  it('accepts an explicitly unknown failure class over a coerced one', () => {
    expectAccepted(
      mutate((b) => {
        const task = first(b, 'tasks');
        task.status = 'failed';
        task.error_class = 'unknown';
      }),
    );
  });

  it('accepts null in every optional nullable field', () => {
    // Regression: draft-07 ignores keywords beside `$ref`, so
    // `{type:[string,null], $ref}` silently drops the null and fails a field
    // that is legitimately absent. Optionality must travel through `anyOf`.
    expectAccepted(
      mutate((b) => {
        const run = first(b, 'runs');
        run.config_hash = null;
        run.budget = null;
        run.block_reason = null;
        first(b, 'artifacts').path_hint = null;
        first(b, 'tasks').agent_role = null;
        (b.project as Rec).question = null;
      }),
    );
  });

  it('will not carry hypothesis text while calling it withheld', () => {
    expectRejectedAt(
      mutate((b) => {
        first(b, 'ideas').hypothesis =
          'replay weighting reduces forgetting by rebalancing episodic memory';
      }),
      '/entities/ideas/0/hypothesis',
    );
  });

  it('carries the hypothesis once the Owner has disclosed it', () => {
    expectAccepted(
      mutate((b) => {
        const idea = first(b, 'ideas');
        idea.hypothesis_disclosure = 'public';
        idea.hypothesis = 'replay weighting reduces forgetting';
      }),
    );
  });

  it('requires the synthetic flag on every metric rather than defaulting it away', () => {
    expectRejectedAt(
      mutate((b) => {
        delete first(b, 'metrics').is_synthetic;
      }),
      '/entities/metrics/0/is_synthetic',
    );
  });

  it('keeps money in whole micro-dollars', () => {
    expectRejectedAt(
      mutate((b) => {
        (first(b, 'runs').budget as Rec).spent_usd_micro = 1.5;
      }),
      '/entities/runs/0/budget/spent_usd_micro',
    );
  });

  it('has no prompt field in the egress ledger', () => {
    expectRejectedAt(
      mutate((b) => {
        (b.entities as Rec).egress = [
          {
            external_egress_id: 'eg-a1b2c3d4e5f60718',
            run_external_id: 'run-a1b2c3d4e5f60718',
            destination_class: 'model-api',
            count: 3,
            prompt_excerpt: 'sk-abcdef',
          },
        ];
      }),
      '/entities/egress/0/prompt_excerpt',
    );
  });

  it('rejects a comparison source hint carrying basic-auth credentials', () => {
    const batch = mutate((b) => {
      (b.entities as Rec).comparisons = [
        {
          external_method_id: 'method-a1b2c3d4e5f60718',
          name: 'FedProx',
          code_source: 'official-code',
          required: true,
          status: 'VALIDATED',
          source_hint: 'https://me:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/x/y',
        },
      ];
    });
    expectRejectedAt(batch, '/entities/comparisons/0/source_hint');
  });

  it('still accepts the credential-free forms of a repo URL', () => {
    for (const sourceHint of [
      'https://github.com/x/y',
      'ssh://git@github.com/x/y',
      'git@github.com:x/y',
    ]) {
      expectAccepted(
        mutate((b) => {
          (b.entities as Rec).comparisons = [
            {
              external_method_id: 'method-a1b2c3d4e5f60718',
              name: 'FedProx',
              code_source: 'official-code',
              required: true,
              status: 'VALIDATED',
              source_hint: sourceHint,
            },
          ];
        }),
      );
    }
  });

  it('leaves visibility escalation to the console, not to a push', () => {
    // The schema is a shape check: a push may REPORT the stored level, and the
    // Function refuses a value more public than the row it has. Encoding that
    // here would make the contract depend on database state it cannot see.
    expectAccepted(
      mutate((b) => {
        (b.project as Rec).visibility = 'listed';
      }),
    );
  });
});
