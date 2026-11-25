import type { BackendErrorLike, Db } from './deps.ts';
import { rows } from './deps.ts';
import { byExternalId, canRead, deniesAsAbsent, readLevel, type Viewer } from './views.ts';
import type { CloudTask } from './engine/cloud-engine.ts';
import { presentTask } from './task-presentation.ts';

interface ArtifactRef {
  external_artifact_id: string;
  external_task_id: string | null;
  kind: string;
  content_hash: string;
  size_bytes: number;
  status: string;
  committed_at: string | null;
}

export async function resourceView(
  db: Db,
  viewer: Viewer,
  externalId: string,
  externalRunId: string,
  BackendError: BackendErrorLike,
): Promise<Response> {
  const project = await byExternalId(db, externalId, BackendError);
  if (!project) throw new BackendError('not_found', 404);
  if (!canRead(viewer, project)) {
    throw new BackendError(
      deniesAsAbsent(viewer) ? 'not_found' : 'no_access',
      deniesAsAbsent(viewer) ? 404 : 403,
    );
  }
  if (readLevel(viewer, project) !== 'full') throw new BackendError('no_access', 403);
  const run = rows<{ id: string }>(
    await db
      .from<{ id: string }>('cloud_run')
      .select('id')
      .eq('project_id', project.id)
      .eq('external_run_id', externalRunId)
      .limit(1),
    BackendError,
  )[0];
  if (!run) throw new BackendError('not_found', 404);
  const tasks = rows<CloudTask>(
    await db
      .from<CloudTask>('cloud_task')
      .select(
        'external_task_id,kind,phase_tag,status,attempt,max_attempts,started_at,ended_at,payload,result',
      )
      .eq('run_id', run.id)
      // cloud_task 没有 created_at 列：按它排序在真库报 database_request_failed
      // （fake-db 不校验列名，测试抓不到）。started_at 是这张表唯一的时间列。
      .order('started_at', { ascending: false })
      .limit(101),
    BackendError,
  );
  const artifacts = rows<ArtifactRef>(
    await db
      .from<ArtifactRef>('cloud_artifact_ref')
      .select(
        'external_artifact_id,external_task_id,kind,content_hash,size_bytes,status,committed_at',
      )
      .eq('run_id', run.id)
      .order('committed_at', { ascending: false })
      .limit(101),
    BackendError,
  );
  return Response.json({
    ok: true,
    external_run_id: externalRunId,
    tasks: tasks.slice(0, 100).map((task) => ({ ...presentTask(task), stage: task.phase_tag })),
    artifacts: artifacts.slice(0, 100),
    tasks_truncated: tasks.length > 100,
    artifacts_truncated: artifacts.length > 100,
  });
}
