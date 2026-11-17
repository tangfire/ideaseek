import { delimiter, isAbsolute, normalize, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';

/**
 * Project-wide tool capability guard (docs/ARCHITECTURE.md capability
 * profiles; enforced via the public `tools/pre-execute` waterfall).
 *
 * Real-model runs showed sessions falling back to base-profile tools even
 * when a preset allowlist was composed — so visibility restriction alone is
 * not enough. This guard is defense in depth: every tool execution in this
 * project must be an IdeaSeek research tool, otherwise it is denied with an
 * auditable reason (the denial lands in the session log as tool/call +
 * tool/result). Allowed members grow per role; the guard defaults to the
 * Phase 1-2 research surface.
 *
 * The second rule here is the read fence. DSH confines file *effects* —
 * writes, deletes, subprocess behaviour — by permission mode, and says so
 * plainly: "Reads pass through untouched: every mode permits reading." So
 * nothing in the runtime stops a coding session, whose cwd is
 * `ideas/<id>`, from reading the platform's own source by absolute path. One
 * did exactly that on FDG (`read D:\IdeaSeek\src\idea\check.ts`, then a grep
 * over `D:\IdeaSeek\src`) because a gate had refused its output and the
 * refusal was not self-explanatory. That is the difference between an agent
 * solving the research task and reverse-engineering the validator: the second
 * one leaks our internals into an unreviewed context, spends the session
 * budget, and teaches the model to game the check instead of fixing the code.
 */
export const inject = ['tools'];

const DEFAULT_ALLOWED = new Set(['project_read', 'knowledge_search']);

/**
 * Tools that carry a filesystem path the session is about to read or write.
 *
 * The names are DSH's own (`read`/`grep`/`glob`/`write`/`edit`/`apply_patch`),
 * matched case-insensitively, and each is mapped to the argument names it has
 * been observed using. An unlisted argument is not guessed at: if this module
 * cannot tell which path a call means, it allows the call — a fence that
 * invents a target would deny legitimate work, and a guard that rejects valid
 * work gets removed under pressure, which is how the leak started mattering
 * less than the outage.
 */
const PATH_ARGUMENTS: Record<string, string[]> = {
  read: ['file_path', 'filePath', 'path'],
  write: ['file_path', 'filePath', 'path'],
  edit: ['file_path', 'filePath', 'path'],
  apply_patch: ['path', 'file_path'],
  grep: ['path', 'paths', 'root', 'dir'],
  glob: ['path', 'paths', 'root', 'dir'],
};

const PATH_LIST_KEYS = new Set(['paths', 'root', 'dir']);

/** Pure decision helper (unit-tested without a Cordis context). */
export function capabilityDecision(
  toolName: string,
  allowed: ReadonlySet<string> = DEFAULT_ALLOWED,
): { kind: 'allow' } | { kind: 'deny'; reason: string } {
  if (allowed.size === 0 || allowed.has(toolName)) return { kind: 'allow' };
  return {
    kind: 'deny',
    reason:
      `tool "${toolName}" is denied by the IdeaSeek capability profile ` +
      `(allowed: ${[...allowed].join(', ')}); use project_read or knowledge_search instead`,
  };
}

/**
 * The roots a session may read, and the roots it may not.
 *
 * Both come from the environment the parent set, never from the model. The
 * deny list is checked first because it is the more specific statement: an
 * allowed project root that happens to contain the platform checkout (a
 * monorepo, a symlinked dev install) must still fence the platform source.
 */
export interface ReadScope {
  allow: string[];
  deny: string[];
}

function splitPaths(value: string | undefined): string[] {
  // `delimiter`, not `[:;]`. Splitting on every colon turns `D:\FDG\papers`
  // into `D` and a drive-relative fragment, so on Windows the list would parse
  // to nothing and the fence would sit there looking configured while denying
  // nothing — the worst shape a security rule can have, since it passes any
  // test written on a POSIX machine.
  return (value ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && isAbsolute(entry))
    .map((entry) => normalize(entry));
}

export function readScopeFromEnv(env: NodeJS.ProcessEnv = process.env): ReadScope {
  return {
    allow: splitPaths(env.IDEASEEK_READ_ROOTS),
    deny: splitPaths(env.IDEASEEK_READ_DENY_ROOTS),
  };
}

/** The allowlist in force for a role. Empty means "visibility is not this guard's job". */
export function allowedToolsForRole(role: string): Set<string> {
  // A coding session legitimately needs DSH's own file and shell tools; the
  // read fence still applies to it. Empty set = skip the allowlist rule, which
  // is what keeps this change from breaking the implementation path it secures.
  if (role === 'coding') return new Set();
  return new Set(DEFAULT_ALLOWED);
}

/**
 * Whether `candidate` is `root` itself or below it, by path segments.
 *
 * Compares normalised forms and requires a separator after the prefix, because
 * a bare string prefix would let `D:\FDG\papers-evil` pass as inside
 * `D:\FDG\papers` — the mistake that makes a fence decorative. Separator-agnostic
 * on purpose: this runs inside the DSH child on the host OS, where the earlier
 * separator-sensitive version of this check refused legitimate Windows paths.
 */
function isInside(root: string, candidate: string): boolean {
  const base = normalize(root).replace(/[\\/]+$/, '');
  const path = normalize(candidate);
  if (path === base) return true;
  if (!path.startsWith(base)) return false;
  const next = path[base.length];
  return next === '/' || next === '\\';
}

/**
 * Whether a path steps on a platform-managed segment, wherever it lives.
 *
 * The same rule `project_read` already enforces, now applied to DSH's own
 * `read`/`grep`/`glob` too. It was inconsistent in a way that mattered: a
 * coding session could not read `.research` through our tool but could through
 * the base one, because the fence was written for the tool that no longer
 * covers the path. Segment-based rather than root-based because these trees are
 * not in a fixed place relative to a session's cwd — `ideas/<id>/.research` and
 * `<project>/.research` are both platform-managed, and neither is the
 * researcher's own work.
 */
export function platformSegmentViolation(target: string): string | null {
  const segments = normalize(target)
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === '.research') return '.research';
    if (segment === '.env' || segment.startsWith('.env.')) return segment;
  }
  return null;
}

/**
 * Whether one path may be read, with the reason a session can act on.
 *
 * Denied roots win over allowed ones; a path outside every allowed root is
 * denied only when an allow list exists at all (no list = the operator said
 * nothing about scope, and silence is not a restriction).
 */
export function readFenceDecision(
  target: string,
  scope: ReadScope,
): { kind: 'allow' } | { kind: 'deny'; reason: string } {
  const absolute = normalize(resolve(target));
  const segment = platformSegmentViolation(absolute);
  if (segment) {
    return {
      kind: 'deny',
      reason:
        `"${target}" touches the platform-managed segment ${segment}, which no research session ` +
        'reads: it holds the event log, the registry database and the credentials file. Your own ' +
        'run logs are handed to you as paths in the check report; open those.',
    };
  }
  for (const root of scope.deny) {
    if (isInside(root, absolute)) {
      return {
        kind: 'deny',
        reason:
          `"${target}" is inside a root the platform fenced for research sessions ` +
          `(${root}). A coding session reads its own workspace and the declared inputs — ` +
          'papers/, datasets/, comparisons/upstream/ — not the platform that runs it. If a ' +
          'platform rule is unclear, quote the refusal text in your final message instead of ' +
          'reading the code behind it: the rule you must satisfy is stated in your task input, ' +
          'and consulting the validator cannot change what it checks.',
      };
    }
  }
  if (scope.allow.length === 0) return { kind: 'allow' };
  if (scope.allow.some((root) => isInside(root, absolute))) return { kind: 'allow' };
  return {
    kind: 'deny',
    reason:
      `"${target}" is outside every root this session may read (allowed: ${scope.allow.join(', ')}). ` +
      'Work inside your workspace and the declared inputs; if you need another path, say so in ' +
      'your final message and the operator can grant it.',
  };
}

/** Path arguments a call carries, flattened. Exported for the fence's unit tests. */
export function pathArgumentsOf(toolName: string, args: unknown): string[] {
  const keys = PATH_ARGUMENTS[toolName.toLowerCase()];
  if (!keys || !args || typeof args !== 'object') return [];
  const record = args as Record<string, unknown>;
  const found: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) found.push(value.trim());
    else if (PATH_LIST_KEYS.has(key) && Array.isArray(value)) {
      for (const entry of value)
        if (typeof entry === 'string' && entry.trim()) found.push(entry.trim());
    }
  }
  return found;
}

export function apply(ctx: Context): void {
  const role = process.env.IDEASEEK_CAPABILITY_ROLE ?? 'extractor';
  const allowed = allowedToolsForRole(role);
  const scope = readScopeFromEnv();
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = capabilityDecision(exec.name, allowed);
    if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason };
    for (const target of pathArgumentsOf(exec.name, exec.arguments)) {
      const fenced = readFenceDecision(target, scope);
      if (fenced.kind === 'deny') return { kind: 'deny', reason: fenced.reason };
    }
    return next();
  });
}
