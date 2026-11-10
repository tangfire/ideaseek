import type { ProjectRuntime } from '../workflow/runtime.js';
import { renderCardMarkdown } from './card-export.js';
import type { CompactCard } from './synthesis.js';

export interface LoadedCard {
  artifactId: string;
  source: string;
  /** Full committed card object (already platform-stamped). */
  card: Record<string, unknown>;
}

function str(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function strList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Loads every committed papercard with a project-relative source path. */
export async function loadCards(runtime: ProjectRuntime): Promise<LoadedCard[]> {
  const cards: LoadedCard[] = [];
  for (const artifact of await runtime.db.listArtifactsByKind('papercard')) {
    try {
      const wrapper = JSON.parse(await runtime.store.readFinalText(artifact.contentHash)) as {
        card?: Record<string, unknown>;
        source?: { sourcePath?: string };
      };
      const source = wrapper.source?.sourcePath;
      if (!wrapper.card || !source) continue;
      cards.push({ artifactId: artifact.artifactId, source, card: wrapper.card });
    } catch {
      continue;
    }
  }
  cards.sort((a, b) => a.source.localeCompare(b.source));
  return cards;
}

/** Projects a full card into the compact synthesis input shape. */
export function toCompactCard(loaded: LoadedCard): CompactCard {
  const card = loaded.card;
  const method = (card.method ?? {}) as Record<string, unknown>;
  const claims = Array.isArray(card.claims) ? card.claims : [];
  return {
    paperId: str(card.paper_id, loaded.source),
    source: loaded.source,
    title: str(card.title),
    problem: str(card.problem),
    methodSummary: str(method.summary),
    datasets: strList(card.datasets),
    metrics: strList(card.metrics),
    topClaims: claims.slice(0, 8).map((raw) => {
      const claim = (raw ?? {}) as Record<string, unknown>;
      const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
      const first = (evidence[0] ?? {}) as Record<string, unknown>;
      return {
        text: str(claim.text, ''),
        quote: typeof first.quote === 'string' ? first.quote.slice(0, 200) : null,
        page: typeof first.page === 'number' ? first.page : null,
      };
    }),
    limitations: strList(card.limitations),
  };
}

export async function loadCompactCards(runtime: ProjectRuntime): Promise<CompactCard[]> {
  return (await loadCards(runtime)).map(toCompactCard);
}

/**
 * Readable exports under knowledge/paper-cards/ (plan.md 阶段 C: DB is the
 * authority, markdown/json are review exports). Deterministic content ⇒
 * idempotent overwrites; never writes secrets or raw prompts.
 */
export async function exportPaperCards(
  runtime: ProjectRuntime,
  cards: LoadedCard[],
): Promise<{ written: number; dir: string }> {
  const { writeFileAtomic, ensureDir } = await import('../core/atomic.js');
  const { join } = await import('node:path');
  const dir = join(runtime.paths.knowledgeDir, 'paper-cards');
  await ensureDir(dir);
  let written = 0;
  for (const loaded of cards) {
    const safe = str(loaded.card.paper_id, loaded.source)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 80);
    await writeFileAtomic(join(dir, `${safe}.json`), `${JSON.stringify(loaded, null, 2)}\n`);
    await writeFileAtomic(join(dir, `${safe}.md`), renderCardMarkdown(loaded));
    written += 1;
  }
  return { written, dir };
}
