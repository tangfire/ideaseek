import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { sha256Of, type ContentHash } from '../src/core/hash.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import type { RunRecord, StagedArtifactInput } from '../src/workflow/types.js';
import { createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

let dir: string;
let clock: ManualClock;
let runtime: ProjectRuntime;
let run: RunRecord;

beforeEach(async () => {
  dir = await makeProjectDir();
  clock = new ManualClock();
  runtime = await openRuntime(dir, { clock, recover: false });
  run = await createDemoRun(runtime);
});

afterEach(async () => {
  await runtime.close();
});

const LEASE = { leaseMs: 10_000 };

function staged(
  kind: string,
  body: string,
  tempPath = `/nonexistent/${kind}.tmp`,
): StagedArtifactInput {
  return {
    kind,
    tempPath,
    contentHash: sha256Of(body),
    size: Buffer.byteLength(body),
    meta: {},
  };
}

describe('idempotent two-phase commit', () => {
  it('begin → finalize commits the task exactly once', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    await runtime.db.markTaskStarted(task!.taskId, 'w1');
    const begin = await runtime.db.beginCommit({
      taskId: task!.taskId,
      workerId: 'w1',
      attempt: task!.attempt,
      artifacts: [staged('input-manifest', '{"a":1}')],
      result: { summary: 'ok', artifacts: [] },
    });
    expect(begin.status).toBe('accepted');
    expect(begin.artifactIds).toHaveLength(1);

    // Task is now committing: a second begin from the same worker is a no-op.
    const again = await runtime.db.beginCommit({
      taskId: task!.taskId,
      workerId: 'w1',
      attempt: task!.attempt,
      artifacts: [staged('input-manifest', '{"a":1}')],
      result: { summary: 'ok', artifacts: [] },
    });
    expect(again.status).toBe('accepted');

    const outcome = await runtime.db.finalizeCommit({
      taskId: task!.taskId,
      workerId: 'w1',
    });
    expect(outcome.status).toBe('committed');
    expect(outcome.task.status).toBe('succeeded');
    expect(outcome.task.result?.summary).toBe('ok');
    expect(outcome.task.result?.artifacts).toHaveLength(1);

    const artifacts = await runtime.db.listArtifacts(task!.taskId);
    expect(artifacts.every((artifact) => artifact.status === 'committed')).toBe(true);
    expect(artifacts[0]!.tempPath).toBeNull(); // hmm: finalize doesn't clear temp_path
  });

  it('duplicate submit with identical output is a no-op', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    const artifact = staged('input-manifest', '{"same":true}');
    await runtime.db.beginCommit({
      taskId: task!.taskId,
      workerId: 'w1',
      attempt: task!.attempt,
      artifacts: [artifact],
      result: { summary: 'ok', artifacts: [] },
    });
    await runtime.db.finalizeCommit({ taskId: task!.taskId, workerId: 'w1' });

    // Repeat submit against the succeeded task with the same content.
    const dup = await runtime.db.beginCommit({
      taskId: task!.taskId,
      workerId: 'w1',
      attempt: task!.attempt,
      artifacts: [artifact],
      result: { summary: 'ok', artifacts: [] },
    });
    expect(dup.status).toBe('duplicate');
    expect(dup.artifactIds).toHaveLength(1);

    const finalizeDup = await runtime.db.finalizeCommit({
      taskId: task!.taskId,
      workerId: 'w1',
    });
    expect(finalizeDup.status).toBe('duplicate');
  });

  it('repeat submit with different output on a succeeded task is rejected', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    await runtime.db.beginCommit({
      taskId: task!.taskId,
      workerId: 'w1',
      attempt: task!.attempt,
      artifacts: [staged('input-manifest', '{"v":1}')],
      result: { summary: 'ok', artifacts: [] },
    });
    await runtime.db.finalizeCommit({ taskId: task!.taskId, workerId: 'w1' });

    await expect(
      runtime.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'w1',
        attempt: task!.attempt,
        artifacts: [staged('input-manifest', '{"v":2}')],
        result: { summary: 'ok', artifacts: [] },
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_COMMITTED' });
  });

  it('stale attempts cannot commit after the lease was reclaimed', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    // Lease expires; a second worker reclaims (attempt increments).
    clock.advance(LEASE.leaseMs + 1);
    const reclaimed = await runtime.db.claimNextTask(run.runId, 'w2', LEASE);
    expect(reclaimed?.taskId).toBe(task!.taskId);
    expect(reclaimed?.attempt).toBe(2);

    // The zombie first worker tries to commit with its old attempt/owner.
    await expect(
      runtime.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'w1',
        attempt: 1,
        artifacts: [staged('input-manifest', '{"zombie":true}')],
        result: { summary: 'zombie', artifacts: [] },
      }),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });

    // Even the correct owner with a stale attempt number is rejected.
    await expect(
      runtime.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'w2',
        attempt: 1,
        artifacts: [staged('input-manifest', '{"stale":true}')],
        result: { summary: 'stale', artifacts: [] },
      }),
    ).rejects.toMatchObject({ code: 'STALE_ATTEMPT' });
  });

  it('commit after cancel is rejected and the worker acks cancellation', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    await runtime.db.markTaskStarted(task!.taskId, 'w1');
    await runtime.db.cancelRun(run.runId);

    await expect(
      runtime.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'w1',
        attempt: task!.attempt,
        artifacts: [staged('input-manifest', '{"late":true}')],
        result: { summary: 'late', artifacts: [] },
      }),
    ).rejects.toMatchObject({ code: 'TASK_CANCELED' });

    const acked = await runtime.db.ackCancel(task!.taskId, 'w1', 'cancel');
    expect(acked.status).toBe('canceled');
  });

  it('failAttempt from committing aborts staged rows and requeues', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    await runtime.db.beginCommit({
      taskId: task!.taskId,
      workerId: 'w1',
      attempt: task!.attempt,
      artifacts: [staged('input-manifest', '{"corrupt":true}')],
      result: { summary: 'bad', artifacts: [] },
    });
    const failed = await runtime.db.failAttempt(task!.taskId, 'w1', {
      code: 'OUTPUT_HASH_MISMATCH',
      message: 'hash mismatch',
      retryable: true,
      at: clock.now(),
    });
    expect(failed.willRetry).toBe(true);
    expect(failed.task.status).toBe('queued');
    const artifacts = await runtime.db.listArtifacts(task!.taskId);
    expect(artifacts.every((artifact) => artifact.status === 'aborted')).toBe(true);

    // Advance past the exponential backoff (1s for attempt 1) so the retry
    // is claimable. Without this, claimNextTask would skip the task.
    clock.advance(1001);

    // A fresh attempt can stage and commit again without unique-key collisions.
    const next = await runtime.db.claimNextTask(run.runId, 'w2', LEASE);
    expect(next?.attempt).toBe(2);
    const begin = await runtime.db.beginCommit({
      taskId: next!.taskId,
      workerId: 'w2',
      attempt: 2,
      artifacts: [staged('input-manifest', '{"corrupt":true}')],
      result: { summary: 'retry', artifacts: [] },
    });
    expect(begin.status).toBe('accepted');
    const outcome = await runtime.db.finalizeCommit({ taskId: next!.taskId, workerId: 'w2' });
    expect(outcome.status).toBe('committed');
  });

  it('empty commits are rejected as invalid artifacts', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    await expect(
      runtime.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'w1',
        attempt: task!.attempt,
        artifacts: [],
        result: { summary: 'nothing', artifacts: [] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' });
  });

  it('invalid hash format is rejected before any state change', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    const bad = { ...staged('x', 'y'), contentHash: 'md5:abc' as ContentHash };
    await expect(
      runtime.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'w1',
        attempt: task!.attempt,
        artifacts: [bad],
        result: { summary: 'bad', artifacts: [] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' });
    const after = await runtime.db.getTask(task!.taskId);
    expect(after?.status).toBe('leased'); // unchanged by the rolled-back tx
  });
});
