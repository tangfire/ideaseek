import { padVisualEnd, truncateVisual } from './text-width.js';

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

/**
 * Order is the palette's default order: the two orientation commands stay
 * first (unit tests pin /help selected and /status second), then the
 * research workflow (what needs my decision → what is the state → what can
 * I act on), then session/control. Descriptions and help sections are
 * derived from this single registry.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', usage: '/help', description: 'show this help' },
  {
    name: '/init',
    usage: '/init [name]',
    description: 'create the IdeaSeek project in this directory (papers/, datasets/, …)',
  },
  { name: '/status', usage: '/status', description: 'run state, tasks, workers, recent events' },
  { name: '/next', usage: '/next', description: 'state-aware suggestion for the next command' },
  {
    name: '/assessment',
    usage: '/assessment [--force]',
    description: 'material readiness & gap report (Analysis prep check)',
  },
  {
    name: '/drift',
    usage: '/drift [--idea <id>]',
    description: 'preview input drift & invalidated downstream artifacts',
  },
  {
    name: '/pending',
    usage: '/pending',
    description: 'approvals waiting for you (protocol, code revisions, requests)',
  },
  {
    name: '/approve',
    usage: '/approve [n]',
    description: 'approve the pending item (or item n from /pending)',
  },
  {
    name: '/reject',
    usage: '/reject <reason>',
    description: 'reject the pending proposal with a reason',
  },
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
  { name: '/logs', usage: '/logs <task-id>', description: 'task detail with redacted logs' },
  { name: '/report', usage: '/report', description: 'write the factual run report' },
  {
    name: '/models',
    usage: '/models [list|use <route>]',
    description: 'model tier routes, roles, credential presence',
  },
  {
    name: '/mode',
    usage: '/mode [research|analysis|coding]',
    description: 'show tier/project/permissions; switch tier, or the coding focus',
  },
  {
    name: '/agent',
    usage: '/agent <指令>',
    description: 'run a general DSH coding turn in this project (approvals asked per tool)',
  },
  {
    name: '/open',
    usage: '/open [project]',
    description: 'switch the session project (confirm with --confirm) or read a document',
  },
  { name: '/pause', usage: '/pause', description: 'stop claiming new tasks (safe pause)' },
  { name: '/resume', usage: '/resume', description: 'resume a paused run' },
  { name: '/continue', usage: '/continue', description: 'continue a run blocked on quota/auth' },
  { name: '/cancel', usage: '/cancel', description: 'cancel the run (artifacts and events kept)' },
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

/** Help sections: how a researcher actually walks through a session. */
const HELP_SECTIONS: readonly { title: string; names: readonly string[] }[] = [
  { title: 'overview', names: ['/help', '/init', '/status', '/next', '/assessment', '/drift'] },
  { title: 'approvals', names: ['/pending', '/approve', '/reject'] },
  { title: 'research', names: ['/papers', '/comparisons', '/ideas', '/experiments', '/logs'] },
  { title: 'ideation', names: ['/rounds', '/ideate', '/feedback'] },
  { title: 'session', names: ['/models', '/mode', '/agent', '/open', '/report'] },
  { title: 'control', names: ['/pause', '/resume', '/continue', '/cancel', '/quit'] },
];

/**
 * Compact grouped map — one line per section. Per-command descriptions
 * live in the `/` palette (which shows name + purpose while filtering);
 * a full per-command dump would overflow the activity pane window and
 * bury the first line off-screen.
 */
export function helpText(): string {
  const lines = ['Ideaseek commands:'];
  for (const section of HELP_SECTIONS) {
    lines.push(`  ${section.title.padEnd(11)}${section.names.join(' · ')}`);
  }
  lines.push('');
  lines.push('Type / to browse commands with descriptions · Tab completes · unique prefix works.');
  lines.push('Natural language: queries answer from state; high-impact requests need approval.');
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

/** Truncates to terminal display columns with an ellipsis (CJK/resize-safe). */
export function truncateForWidth(text: string, columns: number): string {
  return truncateVisual(text, columns);
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
    const body = `${marker}${padVisualEnd(cmd.name, nameWidth)}${cmd.description}`;
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
  return helpText().split('\n');
}
