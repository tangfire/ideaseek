import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A compact, honest description of what the platform has already measured
 * about a corpus, for the agents that have to write code against it.
 *
 * The first version read `profile.columns`, which does not exist: the column
 * names and types live on `profile.source`. The generator therefore received
 * an empty column list and guessed — "no numeric feature column among
 * ['image','domain','label']" from a project whose profile file had stated
 * those three names for hours. One reader, one set of field paths, tested
 * against the real schema.
 */
export async function describeProfiledCorpus(projectRoot: string): Promise<string | null> {
  const { stat } = await import('node:fs/promises');
  const path = join(projectRoot, 'knowledge', 'image-profiles.json');
  if (!(await stat(path).catch(() => null))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  const profiles = (parsed as { profiles?: unknown[] }).profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  const lines = profiles
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .map((profile) => describeOneProfile(profile));
  const warnings = profiles
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .flatMap((profile) => (Array.isArray(profile.warnings) ? profile.warnings.map(String) : []));
  const text = lines.filter(Boolean).join('\n');
  if (!text) return null;
  return warnings.length > 0
    ? `${text}\nprofiler warnings: ${[...new Set(warnings)].slice(0, 6).join(' | ')}`
    : text;
}

function describeOneProfile(profile: Record<string, unknown>): string {
  const source = (profile.source ?? {}) as Record<string, unknown>;
  const grouping = (profile.grouping ?? {}) as Record<string, unknown>;
  const classes = (profile.classes ?? {}) as Record<string, unknown>;
  const columns = Array.isArray(source.columns)
    ? source.columns.map((column) => String(column)).join(', ')
    : '(unknown)';
  const parts = [
    `source: ${String(source.path ?? '?')} (${String(source.format ?? '?')})`,
    `samples: ${String(profile.samples ?? '?')}`,
    `columns: ${columns}`,
  ];
  if (typeof source.byteColumns === 'string' || profile.imageBytesColumn) {
    parts.push(`image bytes column: ${String(source.byteColumns ?? profile.imageBytesColumn)}`);
  }
  if (grouping.column) {
    // grouping.values are { name, count } records and resolution is
    // { width, height }: stringifying either object directly produced
    // "[object Object]" in the agent's prompt, which is a useless value
    // dressed as a fact.
    const values = Array.isArray(grouping.values)
      ? grouping.values
          .map((value) => {
            if (value === null) return 'null';
            if (typeof value !== 'object') return String(value);
            const record = value as Record<string, unknown>;
            return String(record.name ?? record.value ?? JSON.stringify(record));
          })
          .slice(0, 12)
          .join('|')
      : '';
    parts.push(`grouping axis: ${String(grouping.column)} over [${values}]`);
  }
  if (classes.distinct !== undefined) parts.push(`classes: ${String(classes.distinct)}`);
  const resolution = profile.resolution as Record<string, unknown> | undefined;
  // width/height are statistics objects ({min, median, max, sampled}), not
  // numbers — printing them directly produced "[object Object]" in the agent's
  // prompt. The median is the honest single number to quote.
  const axis = (value: unknown): string | null => {
    if (typeof value === 'number' || typeof value === 'string') return String(value);
    if (value && typeof value === 'object') {
      const stats = value as Record<string, unknown>;
      const pick = stats.median ?? stats.min;
      if (pick !== undefined) return String(pick);
    }
    return null;
  };
  const width = axis(resolution?.width);
  const height = axis(resolution?.height);
  if (width !== null || height !== null) {
    parts.push(`image size (median): ${width ?? '?'}x${height ?? '?'}`);
  }
  return parts.join('; ');
}
