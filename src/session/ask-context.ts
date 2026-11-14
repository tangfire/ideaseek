import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import { redactSecrets } from '../core/redact.js';

/**
 * Compact, secret-free project context + short conversational memory for
 * `ideaseek ask` (both Research supervisor and Analysis read-only analyst).
 * All contents are read from persisted artifacts/DB and strictly bounded so
 * free-text Q&A stays cheap, grounded in evidence, and coherent across turns.
 */

export interface AskTurnEntry {
  ts: number;
  mode: 'research' | 'analysis';
  question: string;
  kind: string;
  answer: string;
}

const MAX_HISTORY_ENTRIES = 8;

function historyPath(root: string): string {
  return join(root, '.research', 'ask-history.json');
}

export async function readAskHistory(root: string): Promise<AskTurnEntry[]> {
  try {
    const raw = JSON.parse(await readFile(historyPath(root), 'utf8')) as { entries?: unknown };
    if (!Array.isArray(raw.entries)) return [];
    return raw.entries
      .filter((e): e is AskTurnEntry => Boolean(e && typeof e === 'object'))
      .slice(-MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

export async function appendAskHistory(root: string, entry: AskTurnEntry): Promise<void> {
  const existing = await readAskHistory(root);
  const sanitized: AskTurnEntry = {
    ts: entry.ts,
    mode: entry.mode,
    question: redactSecrets(entry.question).replace(/\s+/g, ' ').slice(0, 260),
    kind: entry.kind,
    answer: redactSecrets(entry.answer).replace(/\s+/g, ' ').slice(0, 420),
  };
  const next = [...existing, sanitized].slice(-MAX_HISTORY_ENTRIES);
  await writeFileAtomic(historyPath(root), `${JSON.stringify({ entries: next }, null, 2)}\n`);
}

export async function buildAskContext(
  root: string,
  sessionMode: 'research' | 'analysis',
): Promise<string> {
  const sections: string[] = [];
  try {
    const { ProjectRuntime } = await import('../workflow/runtime.js');
    const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
    try {
      const run = await runtime.db.getLatestRun(runtime.project.id);
      const cards = await runtime.db.listArtifactsByKind('papercard');
      const parsed = await runtime.db.listArtifactsByKind('parsed-paper');
      const comparisons = await runtime.db.listComparisons({});
      const locks = await runtime.db.listProtocolLocks();

      const effectiveQuestion = run?.question || runtime.config.research.question || '';
      sections.push(
        [
          `project: ${runtime.project.name}`,
          `sessionMode: ${sessionMode}`,
          `autonomyMode: ${runtime.config.policy.autonomyMode}`,
          `question: ${(effectiveQuestion || '(unset)').slice(0, 240)}`,
          `papers: ${parsed.length} parsed, ${cards.length} PaperCard(s)`,
          `protocol: ${locks.length > 0 ? `locked (${locks[locks.length - 1]!.protocolId})` : 'not locked'}`,
          run
            ? `latestRun: ${run.runId} status=${run.status} phase=${run.phase}${run.blockReason ? ` blocked=${run.blockReason}` : ''}`
            : 'latestRun: none',
        ].join('\n'),
      );

      if (comparisons.length > 0) {
        const lines = comparisons
          .slice(0, 12)
          .map(
            (c) => `  - ${c.methodId}: ${c.status} (${c.required ? 'required' : 'reference-only'})`,
          );
        sections.push(`comparisons (${comparisons.length}):\n${lines.join('\n')}`);
      }
    } finally {
      await runtime.close();
    }
  } catch {
    // non-fatal: fall through to filesystem knowledge reads
  }

  try {
    const { listWorkspaces } = await import('../idea/workspace.js');
    const ideas = await listWorkspaces(root);
    if (ideas.length > 0) {
      const lines = ideas
        .slice(0, 10)
        .map((idea) => `  - ${idea.ideaId}: ${idea.status} v${idea.currentVersion}`);
      sections.push(`ideas (${ideas.length}):\n${lines.join('\n')}`);
    }
  } catch {
    // no ideas yet
  }

  try {
    const rawAssessment = JSON.parse(
      await readFile(join(root, 'knowledge', 'research-material-assessment.json'), 'utf8'),
    ) as {
      verdict?: string;
      sufficientFor?: { protocolDesign?: boolean; smokeQuick?: boolean };
      gaps?: { id?: string; priority?: string; reason?: string }[];
    };
    const gaps = (rawAssessment.gaps ?? [])
      .slice(0, 6)
      .map((g) => `  - [${g.priority}] ${g.id}: ${g.reason}`);
    sections.push(
      `materialAssessment: verdict=${rawAssessment.verdict ?? '?'} protocol=${String(rawAssessment.sufficientFor?.protocolDesign)} smoke=${String(rawAssessment.sufficientFor?.smokeQuick)}` +
        (gaps.length > 0 ? `\n${gaps.join('\n')}` : ''),
    );
  } catch {
    // no stored assessment yet
  }

  try {
    const { detectInputDrift, hasInputDrift } = await import('../knowledge/input-drift.js');
    const drift = await detectInputDrift(root);
    if (drift.hasBaseline && hasInputDrift(drift)) {
      const files = drift.drifted.slice(0, 5).map((d) => `${d.relPath} (${d.change})`);
      sections.push(`inputDrift: ${drift.drifted.length} drifted file(s): ${files.join(', ')}`);
    }
  } catch {
    // drift check optional
  }

  try {
    const datasetCard = JSON.parse(
      await readFile(join(root, 'knowledge', 'dataset-card.json'), 'utf8'),
    ) as {
      profiles?: { source?: { path?: string }; rows?: number; columns?: { name?: string }[] }[];
    };
    const summaries = (datasetCard.profiles ?? []).slice(0, 4).map((p) => {
      const cols = (p.columns ?? [])
        .slice(0, 8)
        .map((c) => c.name)
        .filter(Boolean)
        .join(', ');
      return `  - ${p.source?.path ?? '?'}: rows=${p.rows ?? '?'} cols=[${cols}]`;
    });
    if (summaries.length > 0) {
      sections.push(`datasetCard:\n${summaries.join('\n')}`);
    }
  } catch {
    // no dataset card
  }

  try {
    const mapText = await readFile(join(root, 'knowledge', 'research-map.md'), 'utf8');
    if (mapText.trim()) {
      sections.push(`researchMapExcerpt:\n${redactSecrets(mapText.slice(0, 1200))}`);
    }
  } catch {
    // no research map yet
  }

  const history = await readAskHistory(root);
  if (history.length > 0) {
    const lines = history
      .slice(-4)
      .map((h) => `  Q(${h.mode}): ${h.question}\n  A(${h.kind}): ${h.answer}`);
    sections.push(`recentAskTurns:\n${lines.join('\n')}`);
  }

  return redactSecrets(sections.join('\n\n')).slice(0, 4500);
}
