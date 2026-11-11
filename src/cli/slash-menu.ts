/**
 * Slash command registry + interactive menu state machine
 * (docs/TERMINAL_UX.md: 输入 / 立即显示菜单、↑/↓ 选择、Enter 确认、Esc 关闭).
 * Pure and terminal-agnostic: the REPL owns readline, this module owns
 * matching, selection, rendering and width handling so plain/JSON/narrow
 * terminals share one implementation.
 */

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', usage: '/help', description: 'show this help' },
  { name: '/status', usage: '/status', description: 'run state, tasks, workers, recent events' },
  { name: '/next', usage: '/next', description: 'state-aware suggestion for the next command' },
  { name: '/papers', usage: '/papers', description: 'paper indexing progress and parse failures' },
  {
    name: '/comparisons',
    usage: '/comparisons',
    description: 'comparison methods, sources and blockers',
  },
  { name: '/ideas', usage: '/ideas', description: 'idea list with status and versions' },
  {
    name: '/experiments',
    usage: '/experiments',
    description: 'recorded experiment specs and results',
  },
  { name: '/logs', usage: '/logs <task-id>', description: 'task detail with redacted logs' },
  { name: '/approve', usage: '/approve', description: 'confirm the pending protocol proposal' },
  {
    name: '/reject',
    usage: '/reject <reason>',
    description: 'reject the pending proposal with a reason',
  },
  { name: '/pause', usage: '/pause', description: 'stop claiming new tasks (safe pause)' },
  { name: '/resume', usage: '/resume', description: 'resume a paused run' },
  { name: '/continue', usage: '/continue', description: 'continue a run blocked on quota/auth' },
  { name: '/cancel', usage: '/cancel', description: 'cancel the run (artifacts and events kept)' },
  { name: '/report', usage: '/report', description: 'write the factual run report' },
  {
    name: '/models',
    usage: '/models [list|use <route>]',
    description: 'model tier routes, roles, credential presence',
  },
  {
    name: '/mode',
    usage: '/mode [research|agent]',
    description: 'show mode, project and permissions; switch session mode',
  },
  {
    name: '/open',
    usage: '/open [project]',
    description: 'switch the session project (confirm with --confirm) or read a document',
  },
  {
    name: '/rounds',
    usage: '/rounds [list|show <id>]',
    description: 'inspect ideation rounds',
  },
  {
    name: '/ideate',
    usage: '/ideate --round new|rN [--continue]',
    description: 'create or continue an IdeationRound',
  },
  {
    name: '/feedback',
    usage: '/feedback <label> --idea <id>',
    description: 'record user feedback on an idea',
  },
  { name: '/quit', usage: '/quit', description: 'exit the UI (background runs keep going)' },
];

/** Readline Tab completer: prefix filter over slash commands. */
export function slashCompleter(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const matches = SLASH_COMMANDS.map((cmd) => cmd.name).filter((name) => name.startsWith(line));
  return [matches, line];
}

export type SlashResolution =
  | { kind: 'exact'; name: string }
  | { kind: 'prefix'; name: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unknown' };

/** Exact match, else unique-prefix match (e.g. `/sta` → `/status`). */
export function resolveSlash(input: string): SlashResolution {
  const names = SLASH_COMMANDS.map((cmd) => cmd.name);
  if (names.includes(input)) return { kind: 'exact', name: input };
  const candidates = names.filter((name) => name.startsWith(input));
  if (candidates.length === 1) return { kind: 'prefix', name: candidates[0]! };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  return { kind: 'unknown' };
}

export function helpText(): string {
  const lines = ['Ideaseek commands:'];
  for (const cmd of SLASH_COMMANDS) {
    lines.push(`  ${cmd.usage.padEnd(22)} ${cmd.description}`);
  }
  lines.push('');
  lines.push('Tab completes; a unique prefix works too (e.g. /sta → /status).');
  lines.push('Natural language: queries like "为什么 method-x 还没通过" answer from state;');
  lines.push(
    'high-impact requests ("优先验证 idea-001") become pending-approval Decisions — never silent.',
  );
  lines.push('Every command has an equivalent non-interactive CLI form.');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Interactive menu (typing `/` opens it; ↑/↓ select; Enter; Esc)      */
/* ------------------------------------------------------------------ */

export interface MenuState {
  open: boolean;
  selected: number;
  filter: string;
  visible: SlashCommand[];
}

export function openMenu(filter: string): MenuState {
  const visible = SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(filter));
  return { open: visible.length > 0, selected: 0, filter, visible };
}

export function closeMenu(): MenuState {
  return { open: false, selected: 0, filter: '', visible: [] };
}

export function moveSelection(state: MenuState, delta: number): MenuState {
  if (!state.open || state.visible.length === 0) return state;
  const n = state.visible.length;
  const selected = (((state.selected + delta) % n) + n) % n;
  return { ...state, selected };
}

export function selectedCommand(state: MenuState): SlashCommand | null {
  return state.visible[state.selected] ?? null;
}

/** Truncates to terminal width with an ellipsis (resize-safe rendering). */
export function truncateForWidth(text: string, columns: number): string {
  if (!Number.isFinite(columns) || columns <= 0 || text.length <= columns) return text;
  if (columns <= 1) return '…';
  return `${text.slice(0, columns - 1)}…`;
}

export interface MenuRenderOptions {
  /** Terminal width for row truncation (resize-aware). */
  columns?: number;
  /** Include the keyboard-hint footer (interactive terminals only). */
  keyHints?: boolean;
}

/**
 * Renders the menu rows: command padded + description, a `>` marker on the
 * selected row, plus the selected command's usage line (argument hints).
 */
export function renderMenu(state: MenuState, opts: MenuRenderOptions = {}): string[] {
  if (!state.open) return [];
  const columns = opts.columns ?? 80;
  const nameWidth = Math.max(...SLASH_COMMANDS.map((c) => c.name.length)) + 2;
  const rows = state.visible.map((cmd, index) => {
    const marker = index === state.selected ? '> ' : '  ';
    const body = `${marker}${cmd.name.padEnd(nameWidth)}${cmd.description}`;
    return truncateForWidth(body, columns);
  });
  const selected = selectedCommand(state);
  if (selected) {
    rows.push(truncateForWidth(`  usage: ${selected.usage}`, columns));
  }
  if (opts.keyHints) {
    rows.push(truncateForWidth('  ↑/↓ select · Enter run · Esc close · Tab complete', columns));
  }
  return rows;
}

/** Static help listing (also used for `/help` and non-TTY `/` fallback). */
export function menuHelpLines(): string[] {
  const lines = ['Ideaseek commands:'];
  for (const cmd of SLASH_COMMANDS) {
    lines.push(`  ${cmd.usage.padEnd(34)} ${cmd.description}`);
  }
  lines.push('');
  lines.push('Type / to open the menu · Tab completes · a unique prefix works (/sta → /status).');
  lines.push(
    'Natural language: queries answer from state; high-impact requests become pending-approval Decisions.',
  );
  lines.push('Every command has an equivalent non-interactive CLI form.');
  return lines;
}
