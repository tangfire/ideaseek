/**
 * Deterministic official-code discovery (docs/plan.md §Comparison Discovery):
 * locate repository URLs mentioned in parsed papers, normalize them and
 * aggregate per-repo candidates. No network access — GitHub/academic search
 * stays an agent tool; this only reads what the corpus already contains.
 */

export interface RepoUrlMention {
  paperKey: string;
  source: string;
  page: number;
  /** Normalized canonical url, e.g. https://github.com/owner/repo */
  url: string;
}

export interface ComparisonCandidate {
  repoUrl: string;
  /** Papers that mention this repository (deduped, sorted). */
  paperRefs: string[];
  /** Total mention count across the corpus. */
  mentions: number;
  /** Sorted unique pages carrying a mention, per paper. */
  pages: Record<string, number[]>;
}

const HOST_PATTERN =
  '(?:https?:\\/\\/)?(?:www\\.)?(github\\.com|gitlab\\.com|bitbucket\\.org|gitee\\.com)';
const REPO_URL_RE = new RegExp(`${HOST_PATTERN}\\/([A-Za-z0-9_.-]+)\\/([A-Za-z0-9_.-]+)`, 'gi');

/** Path segments that are never an owner name (github.com/topics/... etc.). */
const RESERVED_OWNERS = new Set([
  'topics',
  'settings',
  'features',
  'marketplace',
  'orgs',
  'organizations',
  'search',
  'login',
  'signup',
  'about',
  'pricing',
  'apps',
  'collections',
  'trending',
  'sponsors',
  'codespaces',
  'pulls',
  'issues',
  'new',
  'notifications',
  'explore',
  'events',
  'solutions',
  'enterprise',
  'team',
  'readme',
  'blog',
  'docs',
  'help',
  'users',
  'search',
]);

/**
 * Normalizes a repository mention to its canonical root url.
 * Returns null for non-repo paths (reserved owners, empty segments).
 */
export function normalizeRepoUrl(raw: string): string | null {
  REPO_URL_RE.lastIndex = 0;
  const match = REPO_URL_RE.exec(raw);
  if (!match) return null;
  const host = match[1]!.toLowerCase();
  const owner = match[2]!;
  const repo = match[3]!.replace(/[.,;:)\]>'"]+$/i, '').replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  return `https://${host}/${owner}/${repo}`;
}

/** Extracts unique normalized repository urls from free text, in order. */
export function extractRepoUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of text.match(REPO_URL_RE) ?? []) {
    const url = normalizeRepoUrl(token);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/** Groups mentions into per-repository candidates with paper provenance. */
export function buildCandidates(mentions: RepoUrlMention[]): ComparisonCandidate[] {
  const byUrl = new Map<string, ComparisonCandidate>();
  for (const mention of mentions) {
    let candidate = byUrl.get(mention.url);
    if (!candidate) {
      candidate = { repoUrl: mention.url, paperRefs: [], mentions: 0, pages: {} };
      byUrl.set(mention.url, candidate);
    }
    candidate.mentions += 1;
    if (!candidate.paperRefs.includes(mention.paperKey)) {
      candidate.paperRefs.push(mention.paperKey);
    }
    const pages = (candidate.pages[mention.paperKey] ??= []);
    if (!pages.includes(mention.page)) pages.push(mention.page);
  }
  for (const candidate of byUrl.values()) {
    candidate.paperRefs.sort();
    for (const key of Object.keys(candidate.pages)) {
      (candidate.pages[key] ?? []).sort((a, b) => a - b);
    }
  }
  return [...byUrl.values()].sort(
    (a, b) => b.mentions - a.mentions || a.repoUrl.localeCompare(b.repoUrl),
  );
}

export type LicenseKind = 'permissive' | 'weak-copyleft' | 'copyleft' | 'unknown' | 'none';

/**
 * Classifies a license file head (first ~120 chars) for provenance records.
 * Coarse by design: enough to gate imports, not legal advice.
 */
export function classifyLicense(head: string | null): LicenseKind {
  if (!head || !head.trim()) return 'none';
  const h = head.toLowerCase();
  if (h.includes('affero') || h.includes('agpl')) return 'copyleft';
  if (h.includes('gnu lgpl') || h.includes('lesser general public')) return 'weak-copyleft';
  if (h.includes('mozilla public license') || h.includes('mpl')) return 'weak-copyleft';
  if (h.includes('gnu general public') || /\bgpl\b/.test(h)) return 'copyleft';
  if (
    h.includes('mit license') ||
    h.includes('apache license') ||
    h.includes('permission is hereby granted') ||
    h.includes('bsd') ||
    h.includes('isc license') ||
    h.includes('unlicense')
  ) {
    return 'permissive';
  }
  return 'unknown';
}
