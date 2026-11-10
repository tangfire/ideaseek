function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Human-readable PaperCard export (knowledge/paper-cards/*.md). */
export function renderCardMarkdown(loaded: {
  source: string;
  card: Record<string, unknown>;
}): string {
  const card = loaded.card;
  const method = (card.method ?? {}) as Record<string, unknown>;
  const claims = Array.isArray(card.claims) ? (card.claims as Record<string, unknown>[]) : [];
  const lines: string[] = [
    `# ${String(card.title ?? 'Untitled')} `,
    '',
    `- source: \`${loaded.source}\``,
    `- paper_id: \`${String(card.paper_id ?? 'unknown')}\``,
    `- document_hash: \`${String(card.document_hash ?? 'unknown')}\``,
    `- parser: ${String(card.parser_version ?? 'unknown')} · schema: ${String(card.prompt_schema_version ?? 'unknown')}`,
    '',
    '## Problem',
    '',
    String(card.problem ?? 'unknown'),
    '',
    '## Method',
    '',
    String(method.summary ?? 'unknown'),
    '',
    ...(list(method.steps).length
      ? ['**Steps:**', ...list(method.steps).map((s) => `- ${s}`), '']
      : []),
    ...(list(method.motivation).length
      ? ['**Motivation:**', ...list(method.motivation).map((s) => `- ${s}`), '']
      : []),
    '## Datasets / Metrics / Baselines',
    '',
    `- datasets: ${list(card.datasets).join(', ') || 'unknown'}`,
    `- metrics: ${list(card.metrics).join(', ') || 'unknown'}`,
    `- baselines: ${list(card.baselines).join(', ') || 'unknown'}`,
    '',
    '## Claims and evidence',
    '',
    ...(claims.length
      ? claims.flatMap((claim, index) => {
          const evidence = Array.isArray(claim.evidence)
            ? (claim.evidence as Record<string, unknown>[])
            : [];
          return [
            `${index + 1}. ${String(claim.text ?? '')}`,
            ...evidence.map(
              (span) =>
                `   - p.${String(span.page ?? '?')}${span.quote ? ` “${String(span.quote)}”` : ''}`,
            ),
          ];
        })
      : ['_none recorded_']),
    '',
    '## Limitations',
    '',
    ...(list(card.limitations).length
      ? list(card.limitations).map((l) => `- ${l}`)
      : ['_none recorded_']),
    '',
    '## Unknowns',
    '',
    ...(list(card.unknowns).length ? list(card.unknowns).map((u) => `- ${u}`) : ['_none_']),
    '',
  ];
  return lines.join('\n');
}
