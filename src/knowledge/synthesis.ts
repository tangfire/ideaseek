/**
 * Topic synthesis, mechanism library and research map contracts
 * (docs/plan.md 阶段 C: map/reduce 主题综合 → 研究地图; DATA_CONTRACTS 的
 * 引用要求). Clustering and validation are deterministic; generation runs
 * through the harness with embedded schemas (same pattern as extraction).
 * Every synthesis records inputHash over member cards + prompt version so
 * incremental runs only recompute changed inputs (plan.md §阶段 C).
 */
import { sha256Of, sha256OfJson } from '../core/hash.js';

export interface CompactCard {
  paperId: string;
  source: string;
  title: string;
  problem: string;
  methodSummary: string;
  datasets: string[];
  metrics: string[];
  topClaims: { text: string; quote: string | null; page: number | null }[];
  limitations: string[];
}

export interface TopicCluster {
  topicId: string;
  label: string;
  members: CompactCard[];
  /** Stable hash over member identities — the incremental cache key. */
  contentHash: string;
}

const STOPWORDS = new Set(
  [
    'the',
    'a',
    'an',
    'of',
    'and',
    'or',
    'for',
    'to',
    'in',
    'on',
    'with',
    'via',
    'using',
    'from',
    'is',
    'are',
    'be',
    'this',
    'that',
    'these',
    'those',
    'we',
    'our',
    'their',
    'into',
    'at',
    'by',
    'as',
    'it',
    'its',
    'can',
    'may',
    'new',
    'towards',
    'toward',
    'based',
    'learning',
    'study',
    'paper',
    'approach',
    'method',
    'methods',
  ]
    .join(' ')
    .split(' '),
);

function salientTerms(text: string, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || STOPWORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

/**
 * Deterministic topic clustering: union-find over exact shared datasets and
 * metrics (strong signals), Title terms only label clusters, never merge them (generic words would collapse unrelated topics).
 * Pure function of card content — same corpus ⇒ same clusters.
 */
export function clusterCards(cards: CompactCard[]): TopicCluster[] {
  const parent = cards.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const byDataset = new Map<string, number>();
  const byMetric = new Map<string, number>();
  cards.forEach((card, index) => {
    for (const dataset of card.datasets) {
      const key = dataset.trim().toLowerCase();
      if (!key || key === 'unknown') continue;
      const existing = byDataset.get(key);
      if (existing !== undefined) union(existing, index);
      else byDataset.set(key, index);
    }
    for (const metric of card.metrics) {
      const key = metric.trim().toLowerCase();
      if (!key || key === 'unknown') continue;
      const existing = byMetric.get(key);
      if (existing !== undefined) union(existing, index);
      else byMetric.set(key, index);
    }
  });
  const groups = new Map<number, CompactCard[]>();
  cards.forEach((card, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(card);
    else groups.set(root, [card]);
  });

  const clusters: TopicCluster[] = [];
  for (const members of groups.values()) {
    members.sort((a, b) => a.source.localeCompare(b.source));
    const identity = members.map((member) => member.paperId || member.source).sort();
    const label =
      members
        .map((member) => salientTerms(member.title, 3))
        .flat()
        .filter((term, index, all) => all.indexOf(term) === index)
        .slice(0, 5)
        .join(' ') || 'general';
    clusters.push({
      topicId: `topic-${sha256Of(identity.join('|')).slice(7, 15)}`,
      label,
      members,
      contentHash: sha256Of(identity.join('|')),
    });
  }
  clusters.sort(
    (a, b) => b.members.length - a.members.length || a.topicId.localeCompare(b.topicId),
  );
  return clusters;
}

/** Caps cluster count: keeps the largest N, merges the rest into one bucket. */
export function capClusters(clusters: TopicCluster[], maxTopics: number): TopicCluster[] {
  if (clusters.length <= maxTopics) return clusters;
  const keep = clusters.slice(0, Math.max(1, maxTopics - 1));
  const rest = clusters.slice(Math.max(1, maxTopics - 1));
  const mergedMembers = rest.flatMap((cluster) => cluster.members);
  mergedMembers.sort((a, b) => a.source.localeCompare(b.source));
  const identity = mergedMembers.map((m) => m.paperId || m.source).sort();
  return [
    ...keep,
    {
      topicId: `topic-${sha256Of(identity.join('|')).slice(7, 15)}`,
      label: 'cross-topic (merged tail)',
      members: mergedMembers,
      contentHash: sha256Of(identity.join('|')),
    },
  ];
}

export interface TopicSynthesisRecord {
  topicId: string;
  inputHash: string;
  topic: string;
  papers: { paperId: string; title: string }[];
  methodLineage: string[];
  keyFindings: { text: string; source: string; page: number | null; quote: string | null }[];
  conflicts: string[];
  mechanisms: { name: string; principle: string; conditions: string }[];
  openQuestions: string[];
  generatedAt: number;
  generator: string;
}

export interface ResearchMapRecord {
  inputHash: string;
  landscape: string;
  lineages: { name: string; summary: string }[];
  conflicts: { topic: string; detail: string }[];
  gaps: string[];
  citations: { source: string; title: string }[];
  generatedAt: number;
  generator: string;
}

export interface SynthesisValidation {
  ok: boolean;
  errors: string[];
}

function requireStringArray(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${path} must be an array of strings`);
  }
}

export function validateTopicSynthesis(value: unknown): SynthesisValidation {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['topic synthesis must be an object'] };
  }
  const t = value as Record<string, unknown>;
  if (typeof t.topicId !== 'string' || !t.topicId.startsWith('topic-')) {
    errors.push('topicId must start with topic-');
  }
  if (typeof t.topic !== 'string' || !t.topic) errors.push('topic is required');
  if (!Array.isArray(t.papers) || t.papers.length === 0) {
    errors.push('papers must list at least one member');
  }
  requireStringArray(t.methodLineage, 'methodLineage', errors);
  requireStringArray(t.conflicts, 'conflicts', errors);
  requireStringArray(t.openQuestions, 'openQuestions', errors);
  if (!Array.isArray(t.keyFindings)) {
    errors.push('keyFindings must be an array');
  } else {
    t.keyFindings.forEach((finding, index) => {
      const typed = finding as { text?: unknown; source?: unknown };
      if (!typed || typeof typed.text !== 'string' || typeof typed.source !== 'string') {
        errors.push(`keyFindings[${index}] needs text and source (cited paper)`);
      }
    });
  }
  if (!Array.isArray(t.mechanisms)) {
    errors.push('mechanisms must be an array');
  } else {
    t.mechanisms.forEach((mechanism, index) => {
      const typed = mechanism as { name?: unknown; principle?: unknown; conditions?: unknown };
      if (
        !typed ||
        typeof typed.name !== 'string' ||
        typeof typed.principle !== 'string' ||
        typeof typed.conditions !== 'string'
      ) {
        errors.push(`mechanisms[${index}] needs name, principle and conditions`);
      }
    });
  }
  if (typeof t.generator !== 'string' || !t.generator) errors.push('generator is required');
  return { ok: errors.length === 0, errors };
}

export function validateResearchMap(value: unknown): SynthesisValidation {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['research map must be an object'] };
  }
  const m = value as Record<string, unknown>;
  if (typeof m.landscape !== 'string' || !m.landscape) errors.push('landscape is required');
  requireStringArray(m.gaps, 'gaps', errors);
  if (!Array.isArray(m.lineages) || m.lineages.length === 0) {
    errors.push('lineages must list at least one method lineage');
  } else {
    // Element shape, not just "it is an array". The map prompt asks for
    // `{"name", "summary"}` objects, and this function checked `citations`
    // element-wise while leaving lineages and conflicts at the array level, so
    // a model that echoed back strings passed validation here and `renderResearchMap`
    // then wrote `- **undefined**: undefined` into knowledge/research-map.md with
    // zero errors logged. An artifact that reads as garbage and validates as clean
    // is worse than one that fails: the next stage (idea generation, which consumes
    // these gaps and conflicts) silently trusts it.
    m.lineages.forEach((lineage, index) => {
      const typed = lineage as { name?: unknown; summary?: unknown };
      if (
        !typed ||
        typeof typed.name !== 'string' ||
        !typed.name ||
        typeof typed.summary !== 'string' ||
        !typed.summary
      ) {
        errors.push(`lineages[${index}] needs name and summary`);
      }
    });
  }
  if (!Array.isArray(m.conflicts)) errors.push('conflicts must be an array');
  else {
    m.conflicts.forEach((conflict, index) => {
      const typed = conflict as { topic?: unknown; detail?: unknown };
      if (
        !typed ||
        typeof typed.topic !== 'string' ||
        !typed.topic ||
        typeof typed.detail !== 'string' ||
        !typed.detail
      ) {
        errors.push(`conflicts[${index}] needs topic and detail`);
      }
    });
  }
  if (!Array.isArray(m.citations) || m.citations.length === 0) {
    errors.push('citations must reference the papers behind the map');
  } else {
    m.citations.forEach((citation, index) => {
      const typed = citation as { source?: unknown; title?: unknown };
      if (!typed || typeof typed.source !== 'string' || typeof typed.title !== 'string') {
        errors.push(`citations[${index}] needs source and title`);
      }
    });
  }
  if (typeof m.generator !== 'string' || !m.generator) errors.push('generator is required');
  return { ok: errors.length === 0, errors };
}

export const SYNTHESIS_PROMPT_VERSION = 'synthesis-v1-prompt.1';
export const MAP_PROMPT_VERSION = 'research-map-v1-prompt.1';

export function synthesisInputHash(cluster: TopicCluster): Promise<string> {
  return sha256OfJson({
    members: cluster.members.map((member) => member.paperId || member.source),
    contentHash: cluster.contentHash,
    generator: SYNTHESIS_PROMPT_VERSION,
  });
}

export function renderTopicSynthesis(record: TopicSynthesisRecord): string {
  const lines: string[] = [
    `# ${record.topic}`,
    '',
    `- topic: \`${record.topicId}\` · papers: ${record.papers.length} · generated: ${new Date(record.generatedAt).toISOString()} · generator: ${record.generator}`,
    '',
    '## Papers',
    '',
    ...record.papers.map((paper) => `- ${paper.title} (\`${paper.paperId}\`)`),
    '',
    '## Method lineage',
    '',
    ...(record.methodLineage.length
      ? record.methodLineage.map((item) => `- ${item}`)
      : ['_none recorded_']),
    '',
    '## Key findings (with evidence)',
    '',
    ...(record.keyFindings.length
      ? record.keyFindings.map(
          (finding) =>
            `- ${finding.text} — **${finding.source}**${finding.page ? ` p.${finding.page}` : ''}${finding.quote ? ` (“${finding.quote}”)` : ''}`,
        )
      : ['_none recorded_']),
    '',
    '## Mechanisms',
    '',
    ...(record.mechanisms.length
      ? record.mechanisms.map(
          (mechanism) =>
            `- **${mechanism.name}**: ${mechanism.principle} _(conditions: ${mechanism.conditions})_`,
        )
      : ['_none recorded_']),
    '',
    '## Conflicts',
    '',
    ...(record.conflicts.length ? record.conflicts.map((item) => `- ${item}`) : ['_none_']),
    '',
    '## Open questions',
    '',
    ...(record.openQuestions.length ? record.openQuestions.map((item) => `- ${item}`) : ['_none_']),
    '',
  ];
  return lines.join('\n');
}

export function renderResearchMap(record: ResearchMapRecord): string {
  return [
    '# Research Map',
    '',
    `Generated ${new Date(record.generatedAt).toISOString()} · generator ${record.generator} · input \`${record.inputHash.slice(0, 19)}…\``,
    '',
    '## Landscape',
    '',
    record.landscape,
    '',
    '## Method lineages',
    '',
    ...record.lineages.map((lineage) => `- **${lineage.name}**: ${lineage.summary}`),
    '',
    '## Conflicts and tensions',
    '',
    ...(record.conflicts.length
      ? record.conflicts.map((conflict) => `- **${conflict.topic}**: ${conflict.detail}`)
      : ['_none recorded_']),
    '',
    '## Evidence gaps (candidate whitespace)',
    '',
    ...record.gaps.map((gap) => `- ${gap}`),
    '',
    '## Cited papers',
    '',
    ...record.citations.map((citation) => `- ${citation.title} (\`${citation.source}\`)`),
    '',
    '> Claims above are model-synthesized from verified PaperCards; evidence quotes were',
    '> checked by the Evidence Checker. Novelty and completeness still require researcher review.',
    '',
  ].join('\n');
}
