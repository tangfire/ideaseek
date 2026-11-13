/**
 * Startup banner and context header (docs/TERMINAL_UX.md). The block wordmark
 * is interactive-only; narrow terminals, `--plain` and dumb terminals fall
 * back to the short `[IS]` mark. UI never gates machine-readable output.
 */

export const BLOCK_BANNER = [
  '██╗    ██████╗     ███████╗     █████╗     ███████╗    ███████╗    ███████╗    ██╗  ██╗',
  '██║    ██╔══██╗    ██╔════╝    ██╔══██╗    ██╔════╝    ██╔════╝    ██╔════╝    ██║ ██╔╝',
  '██║    ██║  ██║    █████╗      ███████║    ███████╗    █████╗      █████╗      █████╔╝',
  '██║    ██║  ██║    ██╔══╝      ██╔══██║    ╚════██║    ██╔══╝      ██╔══╝      ██╔═██╗',
  '██║    ██████╔╝    ███████╗    ██║  ██║    ███████║    ███████╗    ███████╗    ██║  ██╗',
  '╚═╝    ╚═════╝     ╚══════╝    ╚═╝  ╚═╝    ╚══════╝    ╚══════╝    ╚══════╝    ╚═╝  ╚═╝',
].join('\n');

export const PLAIN_MARK = '[IS]  IdeaSeek  ·  research from evidence';

/** Columns needed to fit the block wordmark without wrapping. */
const BLOCK_MIN_COLUMNS = 112;

/** Last observed terminal width; updated live on SIGWINCH (resize). */
let observedColumns: number | undefined;
if (process.stdout.columns) observedColumns = process.stdout.columns;
process.stdout.on('resize', () => {
  observedColumns = process.stdout.columns;
});

export interface BannerOptions {
  plain?: boolean;
  /** Terminal width; defaults to the latest observed width. */
  columns?: number;
}

export function renderBanner(opts: BannerOptions = {}): string {
  const columns = opts.columns ?? observedColumns ?? process.stdout.columns ?? 80;
  if (opts.plain || columns < BLOCK_MIN_COLUMNS || process.env.TERM === 'dumb') {
    return PLAIN_MARK;
  }
  // The block wordmark is the whole greeting; the tagline lives in the
  // short mark so a wide startup never repeats the brand name twice.
  return BLOCK_BANNER;
}

export interface HeaderContext {
  project: string;
  /** Session mode as displayed: RESEARCH | AGENT. */
  sessionMode: string;
  question: string | null;
  runId: string | null;
  runStatus: string | null;
  blockReason: string | null;
}

/**
 * Interactive startup context (docs/TERMINAL_UX 启动信息): at most two
 * lines — project · mode · run state (plus the research question). Stage,
 * tasks, papers, resources and supervisor details belong to `/status`, not
 * the startup screen. Never includes secrets, full prompts or model
 * reasoning — only persisted run facts.
 */
export function renderHeader(ctx: HeaderContext): string {
  const run = ctx.runId ? `${ctx.runId}${ctx.runStatus ? ` · ${ctx.runStatus}` : ''}` : 'no run';
  const parts = [ctx.project, ctx.sessionMode, run];
  if (ctx.blockReason) parts.push(`blocked: ${ctx.blockReason}`);
  const lines = [parts.join(' · ')];
  if (ctx.question) lines.push(ctx.question);
  return lines.join('\n');
}
