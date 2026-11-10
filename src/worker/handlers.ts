import { IdeaseekError } from '../core/errors.js';
import type { TaskContext, TaskHandler } from './types.js';
import type { FaultSpec } from './types.js';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('task aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Applies payload fault injection before real work. The ordering matters:
 * crash first (dangling lease), then external blocks (no attempt burned),
 * then retryable/permanent failures, then slowness for cancel windows.
 */
export async function applyFaults(ctx: TaskContext): Promise<void> {
  const fault = ctx.payload.fault as FaultSpec | undefined;
  if (!fault) return;
  const attempt = ctx.task.attempt;

  if (fault.crash && (fault.crashAtAttempt ?? 1) === attempt) {
    // Simulates a worker killed mid-task: no heartbeat renewal, no commit.
    process.exit(7);
  }
  if (fault.blockCode && (!fault.blockOnce || ctx.task.error?.code !== fault.blockCode)) {
    throw new IdeaseekError(
      fault.blockCode,
      fault.blockCode === 'QUOTA_EXHAUSTED'
        ? 'injected quota exhaustion'
        : `injected block ${fault.blockCode}`,
    );
  }
  if (fault.failTimes !== undefined && attempt <= fault.failTimes) {
    const error = new Error(`injected failure on attempt ${attempt}`);
    if (fault.failPermanent) (error as Error & { permanent?: boolean }).permanent = true;
    throw error;
  }
  if (fault.slowMs) await sleep(fault.slowMs, ctx.signal);
}

async function readDependencyJson<T>(ctx: TaskContext, depTaskId: string): Promise<T | null> {
  const dep = await ctx.runtime.db.getTask(depTaskId);
  if (!dep || dep.status !== 'succeeded' || !dep.result) return null;
  const rows = await ctx.runtime.db.listArtifacts(dep.taskId);
  for (const artifactId of dep.result.artifacts) {
    const row = rows.find((item) => item.artifactId === artifactId && item.status === 'committed');
    if (!row) continue;
    const text = await ctx.runtime.store.readFinalText(row.contentHash);
    return JSON.parse(text) as T;
  }
  return null;
}

interface DemoManifest {
  version: number;
  generator: string;
  question: string;
  files: string[];
}

const ingest: TaskHandler = async (ctx) => {
  await applyFaults(ctx);
  const question = typeof ctx.payload.question === 'string' ? ctx.payload.question : '';
  const manifest: DemoManifest = {
    version: 1,
    generator: 'ideaseek-demo-ingest',
    question,
    files: [],
  };
  return {
    artifacts: [
      {
        kind: 'input-manifest',
        data: `${JSON.stringify(manifest, null, 2)}\n`,
        meta: { filename: 'input-manifest.json' },
      },
    ],
    summary: `ingested ${manifest.files.length} input file(s)`,
    data: { files: manifest.files.length },
  };
};

const analyze: TaskHandler = async (ctx) => {
  await applyFaults(ctx);
  const depId = ctx.task.dependsOn[0];
  if (!depId) throw new IdeaseekError('DEPENDENCY_NOT_MET', 'demo.analyze requires demo.ingest');
  const manifest = await readDependencyJson<DemoManifest>(ctx, depId);
  if (!manifest) {
    throw new IdeaseekError('DEPENDENCY_NOT_MET', 'input manifest not available yet');
  }
  const analysis = {
    version: 1,
    generator: 'ideaseek-demo-analyze',
    question: manifest.question,
    sources: { manifestQuestion: manifest.question },
    findings: [
      'demo finding: workflow state is durable across process restarts',
      'demo finding: artifacts are hash-verified before commit',
    ],
  };
  return {
    artifacts: [
      {
        kind: 'analysis',
        data: `${JSON.stringify(analysis, null, 2)}\n`,
        meta: { filename: 'analysis.json' },
      },
    ],
    summary: `analyzed manifest for "${manifest.question}"`,
    data: { findings: analysis.findings.length },
  };
};

interface DemoAnalysis {
  version: number;
  question: string;
  findings: string[];
}

const report: TaskHandler = async (ctx) => {
  await applyFaults(ctx);
  const depId = ctx.task.dependsOn[0];
  if (!depId) throw new IdeaseekError('DEPENDENCY_NOT_MET', 'demo.report requires demo.analyze');
  const analysis = await readDependencyJson<DemoAnalysis>(ctx, depId);
  if (!analysis) {
    throw new IdeaseekError('DEPENDENCY_NOT_MET', 'analysis not available yet');
  }
  const lines = [
    '# IdeaSeek Demo Report',
    '',
    `Question: ${analysis.question}`,
    '',
    '## Findings',
    ...analysis.findings.map((finding) => `- ${finding}`),
    '',
    '> Phase 0 vertical slice: no model, no external services.',
    '',
  ];
  return {
    artifacts: [
      {
        kind: 'report',
        data: `${lines.join('\n')}`,
        meta: { filename: 'report.md' },
      },
    ],
    summary: `report written with ${analysis.findings.length} finding(s)`,
    data: { findings: analysis.findings.length },
  };
};

/** Phase 0 demo pipeline: deterministic outputs so re-execution deduplicates. */
export const demoHandlers: Record<string, TaskHandler> = {
  'demo.ingest': ingest,
  'demo.analyze': analyze,
  'demo.report': report,
};
