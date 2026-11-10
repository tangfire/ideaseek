import type { Context } from '@deepseek-ai/cordis';

/**
 * Capability profile for the Paper Extractor agent preset: inside the agent
 * scope, restrict the visible tool surface to IdeaSeek's research tools.
 * Runs as a preset child so `ctx.tools` is agent-scoped (global restrict
 * throws by design in DSH).
 */
export const inject = ['tools'];

export function apply(ctx: Context): void {
  ctx.tools.restrict({ allow: ['project_read'] });
}
