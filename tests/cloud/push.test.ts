/**
 * 同步链路端到端（F1.1 / F1.3 / F1.5 / F1.6 / F1.7 / F1.8 / F1.9 / F1.11 / F1.13 / NFR-05 / NFR-06）。
 *
 * 真 SQLite + 假 `fetch` + 注入时钟：这条链上"什么时候出网、出去的是什么、
 * 失败了游标动不动"三件事必须同时可观察，所以不在单元桩里测。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pushProject, readStatus, hostTag, type CloudTarget } from '../../src/cloud/push.js';
import { cloudDirs } from '../../src/cloud/buffer.js';
import { isIdeaseekError } from '../../src/core/errors.js';
import type { FetchLike } from '../../src/cloud/client.js';
import { makeProjectDir, openRuntime, createDemoRun } from '../helpers.js';
import type { ProjectRuntime } from '../../src/workflow/runtime.js';

const NOW = 1_700_001_000_000;
const TOKEN = 'tok-0123456789abcdef0123456789abcdef';
const SITE = 'https://demo.qoder.site';

let dir: string;
let runtime: ProjectRuntime;
let target: CloudTarget;

beforeEach(async () => {
  dir = await makeProjectDir();
  runtime = await openRuntime(dir, { recover: false });
  target = { site: SITE, tokenRef: 'env:IDEASEEK_CLOUD_SYNC_TOKEN' };
});

afterEach(async () => {
  await runtime.close();
});

/** 假站点：记录每一次请求体，按脚本给出结局。 */
function station(...responses: (() => Response | Promise<Response>)[]): {
  fetch: FetchLike;
  bodies: Record<string, unknown>[];
  headers: Record<string, string>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  let index = 0;
  return {
    bodies,
    headers,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers.push((init?.headers ?? {}) as Record<string, string>);
      const next = responses[Math.min(index, responses.length - 1)!];
      index += 1;
      return next();
    },
  };
}

const accepted = (): Response =>
  new Response(
    JSON.stringify({
      ok: true,
      status: 'accepted',
      external_batch_id: 'bat-0000000000000001',
      counts: { runs: 1, stages: 1, events: 1 },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );

const dead = (): Promise<Response> => Promise.reject(new TypeError('fetch failed'));

function push(opts: Parameters<typeof pushProject>[2]) {
  return pushProject(runtime, target, { site: SITE, token: TOKEN, now: () => NOW, ...opts });
}

async function stateOnDisk(): Promise<{
  cursors: Record<string, number>;
  stop: { kind: string } | null;
  lastOkAt: number | null;
}> {
  const raw = await readFile(join(dir, '.research', 'cloud', 'state.json'), 'utf8');
  return JSON.parse(raw);
}

async function pendingNames(): Promise<string[]> {
  return readdir(join(dir, '.research', 'cloud', 'pending')).catch(() => []);
}

async function droppedNames(): Promise<string[]> {
  return readdir(join(dir, '.research', 'cloud', 'dropped')).catch(() => []);
}

describe('a successful sync (F1.1 / F1.5 / F1.7)', () => {
  it('projects the run out of SQLite, sends it, and only then records the cursor', async () => {
    const run = await createDemoRun(runtime, '小样本上降低遗忘');
    const stored = await runtime.db.listEvents(run.runId);
    const site = station(accepted);
    const report = await push({ fetch: site.fetch });
    const events = (site.bodies[0]!.entities as { events: { seq: number }[] }).events;

    expect(report.sent).toBe(1);
    expect(report.accepted).toBe(1);
    expect(report.replayed).toBe(0);
    expect(report.queuedRemaining).toBe(0);
    expect(report.stopped).toBeNull();
    expect(report.enqueued).toBe(1);

    const body = site.bodies[0]!;
    const entities = body.entities as { runs: { external_run_id: string }[]; stages: unknown[] };
    expect(entities.runs.map((r) => r.external_run_id)).toEqual([run.runId]);
    expect(events).toHaveLength(stored.length);
    expect(body.schema_version).toBe(1);
    expect(String(body.external_batch_id)).toMatch(/^bat-[0-9a-f]{16}$/);
    // 本地迁移版本跟着批次出去，云端才知道该不该拒绝（F1.11）。
    expect(body.local_schema_version).toBe(await runtime.db.schemaVersion());
    expect(events.map((e) => e.seq)).toEqual(stored.map((e) => e.seq));

    // 游标落在最后一条已确认事件上，下次只补新的。
    expect(report.cursors[run.runId]).toBe(stored[stored.length - 1]!.seq);
    expect((await stateOnDisk()).cursors).toEqual({ [run.runId]: stored[stored.length - 1]!.seq });
    expect((await stateOnDisk()).lastOkAt).toBe(NOW);
    expect(await pendingNames()).toEqual([]);
  });

  it('carries the desensitized shape, not the local machine', async () => {
    await createDemoRun(runtime);
    const site = station(accepted);
    await push({ fetch: site.fetch });
    const serialized = JSON.stringify(site.bodies[0]);
    const project = (site.bodies[0]!.project as Record<string, unknown>)!;
    expect(project.source_host).toBe(hostTag());
    expect(String(project.source_host)).toMatch(/^host-[0-9a-f]{12}$/);
    expect(serialized).not.toContain(hostname());
    expect(serialized).not.toContain(dir.replace(/\\/g, '/'));
    expect(serialized).not.toContain(dir);
    expect(site.headers[0]!['x-ideaseek-token']).toBe(TOKEN);
    expect(serialized).not.toContain(TOKEN);
    expect(site.headers[0]!.origin).toBe('demo.qoder.site');
  });

  it('does nothing at all when there is nothing new (F1.9)', async () => {
    await createDemoRun(runtime);
    const first = station(accepted);
    await push({ fetch: first.fetch });
    const second = station(() => Promise.reject(new Error('没有新事件就不该出网')));
    const report = await push({ fetch: second.fetch });
    expect(report.projected).toBe(0);
    expect(report.sent).toBe(0);
    expect(second.bodies).toHaveLength(0);
  });

  it('sends only the events after the acknowledged cursor', async () => {
    const run = await createDemoRun(runtime);
    const site = station(accepted, accepted);
    await push({ fetch: site.fetch });
    const firstCount = (site.bodies[0]!.entities as { events: unknown[] }).events.length;

    await runtime.db.appendEvent({
      runId: run.runId,
      phase: 'INIT',
      eventType: 'step_finished',
      summary: '追加的一步',
    });
    const report = await push({ fetch: site.fetch });
    const second = (site.bodies[1]!.entities as { events: { seq: number; summary: string }[] })
      .events;
    expect(second).toHaveLength(1);
    expect(second[0]!.summary).toBe('追加的一步');
    expect(second[0]!.seq).toBe(firstCount + 1);
    expect(report.cursors[run.runId]).toBe(firstCount + 1);
    expect(report.accepted).toBe(1);
  });
});

describe('offline and partial failure (F1.8 / F1.11 / NFR-05)', () => {
  it('keeps the batch buffered and the cursor frozen when the network is down', async () => {
    const run = await createDemoRun(runtime);
    const offline = station(dead);
    const report = await push({ fetch: offline.fetch });
    expect(report.sent).toBe(1);
    expect(report.accepted).toBe(0);
    expect(report.queuedRemaining).toBe(1);
    expect(offline.bodies).toHaveLength(1);
    // 关键：没拿到回执就没有游标。状态文件里那条推进过的游标才是数据缺失的根源。
    expect(report.cursors).toEqual({});
    await expect(stateOnDisk()).rejects.toThrow();

    // 退避未到之前，再点一次 `push` 一条都不发。
    const again = station(dead);
    const second = await push({ fetch: again.fetch });
    expect(again.bodies).toHaveLength(0);
    expect(second.queuedRemaining).toBe(1);

    // 到点了——重放的是同一个 `external_batch_id`，云端靠它去重。
    const later = station(accepted);
    const third = await pushProject(runtime, target, {
      site: SITE,
      token: TOKEN,
      now: () => NOW + 61_000,
      fetch: later.fetch,
    });
    expect(later.bodies[0]!.external_batch_id).toBe(offline.bodies[0]!.external_batch_id);
    expect(third.accepted).toBe(1);
    expect(third.replayed).toBe(0);
    expect((await stateOnDisk()).cursors[run.runId]).toBeGreaterThan(0);
    expect(await pendingNames()).toEqual([]);
  });

  it('treats a 5xx the same way as a dead socket, and a 400 differently', async () => {
    await createDemoRun(runtime);
    const busy = station(() => new Response('boom', { status: 503 }));
    const report = await push({ fetch: busy.fetch });
    expect(report.queuedRemaining).toBe(1);
    expect(report.stopped).toBeNull(); // 值得再试，不该熔断

    // 退避未到之前再点一次，同一段字节不重发（5xx 跟死网一个待遇）。
    const retryTooSoon = station(() => new Response('boom', { status: 503 }));
    const held = await push({ fetch: retryTooSoon.fetch });
    expect(retryTooSoon.bodies).toHaveLength(0);
    expect(held.queuedRemaining).toBe(1);

    // 到点了，把同一个批次按 400 重发——这次是契约拒绝，必须熔断。
    const rejected = station(
      () =>
        new Response(
          JSON.stringify({ ok: false, code: 'invalid_projection', message: '/runs/0 少字段' }),
          { status: 400 },
        ),
    );
    const stopped = await pushProject(runtime, target, {
      site: SITE,
      token: TOKEN,
      now: () => NOW + 61_000,
      fetch: rejected.fetch,
    });
    expect(stopped.stopped!.kind).toBe('rejected');
    expect(stopped.queuedRemaining).toBe(1);
    expect((await stateOnDisk()).stop!.kind).toBe('rejected');
  });

  it('stops hammering the site once a contract failure is on the books', async () => {
    await createDemoRun(runtime);
    const version = station(
      () =>
        new Response(
          JSON.stringify({
            ok: false,
            code: 'invalid_projection',
            message: '不支持的投影版本：99',
          }),
          { status: 415 },
        ),
    );
    const report = await push({ fetch: version.fetch });
    expect(report.stopped!.kind).toBe('version-unsupported');

    const next = station(accepted);
    const second = await push({ fetch: next.fetch });
    // 同一段字节重试一万次也还是 415，出网只让一次。
    expect(second.sent).toBe(0);
    expect(next.bodies).toHaveLength(0);
    expect(second.stopped!.kind).toBe('version-unsupported');
    expect(second.queuedRemaining).toBe(1);
  });

  it('gives up on the buffer after repeated contract failures instead of retrying forever', async () => {
    await createDemoRun(runtime);
    const site = station(
      () =>
        new Response(JSON.stringify({ ok: false, code: 'invalid_projection', message: '不支持' }), {
          status: 415,
        }),
    );
    let last = await push({ fetch: site.fetch });
    for (let i = 0; i < 5 && last.stopped!.kind !== 'discarded'; i += 1) {
      last = await pushProject(runtime, target, {
        site: SITE,
        token: TOKEN,
        now: () => NOW + (i + 1) * 3_600_000,
        fetch: site.fetch,
      });
    }
    expect(last.stopped!.kind).toBe('discarded');
    expect(last.cursors).toEqual({});
    expect(await pendingNames()).toEqual([]);
    expect(await droppedNames()).toHaveLength(1);
    const status = await readStatus(
      join(dir, '.research'),
      { site: SITE, tokenRef: target.tokenRef },
      true,
      { now: () => NOW },
    );
    expect(status.stop!.kind).toBe('discarded');
    expect(status.dropped).toBe(1);
  });
});

describe('the gate wins over the wire (F1.13 / WS-13)', () => {
  it('queues nothing and sends nothing when a credential shape is in the timeline', async () => {
    const run = await createDemoRun(runtime);
    await runtime.db.appendEvent({
      runId: run.runId,
      phase: 'INIT',
      eventType: 'step_finished',
      summary: `本轮用完 sk-0123456789abcdef0123456789abcdef 额度`,
    });
    const site = station(accepted);
    let caught: unknown;
    try {
      await push({ fetch: site.fetch });
    } catch (error) {
      caught = error;
    }
    expect(isIdeaseekError(caught) && caught.code).toBe('SECRET_GATE_BLOCKED');
    // 一条请求都没发；队列目录也还没建起来。
    expect(site.bodies).toHaveLength(0);
    expect(await pendingNames()).toEqual([]);
    await expect(stateOnDisk()).rejects.toThrow();
  });

  it('reports a dry run without writing a byte or opening a socket (F1.3)', async () => {
    const run = await createDemoRun(runtime);
    const site = station(() => Promise.reject(new Error('dry-run 不许出网')));
    const report = await push({ fetch: site.fetch, dryRun: true });
    const events = await runtime.db.listEvents(run.runId);
    expect(site.bodies).toHaveLength(0);
    expect(report.dryRun).toBe(true);
    expect(report.sent).toBe(0);
    expect(report.enqueued).toBe(0);
    expect(report.projected).toBe(1);
    expect(report.eventsSent).toBe(events.length);
    expect(report.bytesSent).toBeGreaterThan(100);
    expect(report.cursors).toEqual({});
    expect(await pendingNames()).toEqual([]);
    await expect(stateOnDisk()).rejects.toThrow();
  });

  it('does not lose the timeline behind a torn batch file', async () => {
    const run = await createDemoRun(runtime);
    const ok = station(accepted);
    await push({ fetch: ok.fetch });
    await runtime.db.appendEvent({
      runId: run.runId,
      phase: 'INIT',
      eventType: 'step_finished',
      summary: '追加的一步',
    });

    const dirs = cloudDirs(join(dir, '.research'));
    await mkdir(dirs.pending, { recursive: true });
    await writeFile(
      join(dirs.pending, '000123-bat-aaaaaaaaaaaaaaaa.json'),
      '{"batch": {"truncated',
    );

    const second = station(accepted);
    const report = await push({ fetch: second.fetch });
    // 坏文件读不出游标，也就推不动游标：那条新事件从原游标重读，另起一批照常出网。
    const sent = (second.bodies[0]!.entities as { events: { summary: string }[] }).events;
    expect(sent.map((e) => e.summary)).toEqual(['追加的一步']);
    expect(report.accepted).toBe(1);

    const status = await readStatus(
      join(dir, '.research'),
      { site: SITE, tokenRef: target.tokenRef },
      true,
      { now: () => NOW },
    );
    // 但它是可见的：缓冲里有一条永远投不出去的文件，`status` 必须说出来。
    expect(status.unreadable).toBe(1);
  });
});

describe('status without a network (F1.10)', () => {
  it('reads back link, cursors, queue and stop reason locally', async () => {
    const run = await createDemoRun(runtime);
    const events = await runtime.db.listEvents(run.runId);
    const site = station(accepted);
    await push({ fetch: site.fetch });
    const status = await readStatus(
      join(dir, '.research'),
      { site: SITE, tokenRef: target.tokenRef },
      true,
      { now: () => NOW },
    );
    expect(status.linked).toBe(true);
    expect(status.tokenPresent).toBe(true);
    expect(status.site).toBe(SITE);
    expect(status.queued).toBe(0);
    expect(status.cursors[run.runId]).toBe(events[events.length - 1]!.seq);
    expect(status.stop).toBeNull();
    expect(status.oldestKinds).toEqual([]);
    expect(status.retentionMs).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it('says the link is incomplete rather than pretending a sync happened', async () => {
    const status = await readStatus(join(dir, '.research'), { site: null, tokenRef: null }, false, {
      now: () => NOW,
    });
    expect(status.linked).toBe(false);
    expect(status.cursors).toEqual({});
    expect(status.lastOkAt).toBeNull();
  });
});
