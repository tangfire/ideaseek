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

export const BLOCK_TAGLINE = 'IdeaSeek · Research from evidence';
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
  return `${BLOCK_BANNER}\n\n${BLOCK_TAGLINE}`;
}

export interface HeaderContext {
  project: string;
  question: string | null;
  mode: string | null;
  runId: string | null;
  runStatus: string | null;
  stage: string | null;
  blockReason: string | null;
  agents: number;
  tasks: { done: number; total: number; queued: number; running: number; failed: number };
  papersIndexed: number | null;
  gpu: string | null;
  cpuCores: number;
  memoryGiB: number;
  /** Background supervisor daemon state, when one owns this run. */
  supervisor: string | null;
}

function pad(label: string): string {
  return `${label}`.padEnd(9);
}

/**
 * Interactive startup context (docs/TERMINAL_UX 启动信息). Never includes
 * secrets, full prompts or model reasoning — only persisted run facts.
 */
export function renderHeader(ctx: HeaderContext): string {
  const lines: string[] = [];
  lines.push(`${pad('Project')}: ${ctx.project}`);
  if (ctx.question) lines.push(`${pad('Question')}: ${ctx.question}`);
  if (ctx.mode) lines.push(`${pad('Mode')}: ${ctx.mode}`);
  lines.push(`${pad('Run')}: ${ctx.runId ?? 'none'}${ctx.runStatus ? `  ${ctx.runStatus}` : ''}`);
  if (ctx.stage) lines.push(`${pad('Stage')}: ${ctx.stage}`);
  if (ctx.blockReason) lines.push(`${pad('Blocked')}: ${ctx.blockReason}`);
  lines.push(
    `${pad('Agents')}: ${ctx.agents} active · tasks ${ctx.tasks.done}/${ctx.tasks.total} done` +
      (ctx.tasks.queued > 0 ? ` · ${ctx.tasks.queued} queued` : '') +
      (ctx.tasks.running > 0 ? ` · ${ctx.tasks.running} running` : '') +
      (ctx.tasks.failed > 0 ? ` · ${ctx.tasks.failed} failed` : ''),
  );
  if (ctx.papersIndexed !== null) {
    lines.push(`${pad('Papers')}: ${ctx.papersIndexed} indexed`);
  }
  lines.push(
    `${pad('GPU')}: ${ctx.gpu ?? 'nvidia-smi not found'}` +
      ` · CPU ${ctx.cpuCores} cores · mem ${ctx.memoryGiB} GiB`,
  );
  if (ctx.supervisor) lines.push(`${pad('Supervisor')}: ${ctx.supervisor}`);
  return lines.join('\n');
}
