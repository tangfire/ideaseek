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
 */
export const inject = ['tools'];

const DEFAULT_ALLOWED = new Set(['project_read', 'knowledge_search']);

/** Pure decision helper (unit-tested without a Cordis context). */
export function capabilityDecision(
  toolName: string,
  allowed: ReadonlySet<string> = DEFAULT_ALLOWED,
): { kind: 'allow' } | { kind: 'deny'; reason: string } {
  if (allowed.has(toolName)) return { kind: 'allow' };
  return {
    kind: 'deny',
    reason:
      `tool "${toolName}" is denied by the IdeaSeek capability profile ` +
      `(allowed: ${[...allowed].join(', ')}); use project_read or knowledge_search instead`,
  };
}

export function apply(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = capabilityDecision(exec.name);
    if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason };
    return next();
  });
}
