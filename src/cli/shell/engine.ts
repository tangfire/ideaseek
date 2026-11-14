import { SLASH_COMMANDS } from '../slash-menu.js';
import { filterMentions, getSlashArgSuggestions, type CompletionEntry } from './mentions.js';

/**
 * Pure input/state engine for the interactive shell (ADR-010). No I/O, no
 * ANSI — the Ink view renders whatever this returns, so every keyboard
 * rule (palette, @-mentions, sub-arg completion, multi-line editing, large
 * paste collapse, reverse history search, scroll, Ctrl-C/D) is unit-testable
 * without a terminal.
 */

export interface EngineKey {
  /** Named keys: up/down/left/right/return/newline/tab/escape/backspace/delete/home/end/pageup/pagedown/wheelup/wheeldown/wordleft/wordright. */
  name?: string;
  /** Printable character(s), including paste bursts. */
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface PaletteOption {
  kind: 'command' | 'mention' | 'arg';
  label: string;
  description: string;
  insertText: string;
}

export interface EngineResult {
  line: string;
  cursor: number;
  paletteOpen: boolean;
  paletteMode: 'command' | 'mention' | 'arg';
  paletteIndex: number;
  paletteItems: string[];
  paletteOptions: PaletteOption[];
  /** Active `Ctrl+R` reverse history search state (null when inactive). */
  historySearch: { query: string; match: string | null } | null;
  /** +1 page up / -1 page down over the activity pane (0 = no change). */
  scrollDelta: number;
  /** +1 wheel notch up / -1 wheel notch down (0 = no change). */
  wheelDelta: number;
  /** Line to dispatch (Enter), with paste tokens expanded; null when nothing should run. */
  submit: string | null;
  /** Ctrl-C on an empty line → host interrupts running work or prints hint. */
  interrupt: boolean;
  /** Ctrl-D on an empty line → host closes (EOF semantics). */
  eof: boolean;
  /** Shift+Tab cycles the session mode through the shared mode command. */
  cycleMode: boolean;
  /** Ctrl+O toggles compact/expanded tool & diagnostic details. */
  toggleDetails: boolean;
  /** Ctrl+L adds a visual fresh-view divider and jumps to tail. */
  clearView: boolean;
  /** Ctrl+Y copies the most recent reply/output block to the clipboard. */
  copyLast: boolean;
  /** `?` on an empty line toggles the keyboard shortcuts overlay. */
  toggleHelp: boolean;
}

const EDIT_KEYS = new Set([
  'left',
  'right',
  'home',
  'end',
  'backspace',
  'delete',
  'wordleft',
  'wordright',
]);

const PASTE_COLLAPSE_MIN_LINES = 4;
const PASTE_COLLAPSE_MIN_CHARS = 180;

/** Returns word-boundary index moving left from `cursor`. */
function prevWordBoundary(text: string, cursor: number): number {
  let i = Math.max(0, cursor);
  while (i > 0 && /\s/.test(text[i - 1]!)) i -= 1;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i -= 1;
  return i;
}

/** Returns word-boundary index moving right from `cursor`. */
function nextWordBoundary(text: string, cursor: number): number {
  let i = Math.min(text.length, cursor);
  while (i < text.length && !/\s/.test(text[i]!)) i += 1;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  return i;
}

/** Finds an active `@mention` token immediately ending at `cursor`, if any. */
function findActiveMention(line: string, cursor: number): { start: number; query: string } | null {
  const before = line.slice(0, cursor);
  const match = /(?:^|\s)(@[^\s@]*)$/.exec(before);
  if (!match) return null;
  const token = match[1]!;
  return { start: cursor - token.length, query: token };
}

export class ShellEngine {
  private line = '';
  private cursor = 0;
  private paletteOpen = false;
  private paletteMode: 'command' | 'mention' | 'arg' = 'command';
  private paletteIndex = 0;
  private paletteNavigated = false;
  private paletteOptions: PaletteOption[] = [];
  /** Tracks the replacement range when palette mode is 'mention' or 'arg'. */
  private replaceRange: { start: number; end: number } | null = null;
  /** Submitted input, oldest first. ↑/↓ walk it when the palette is closed. */
  private history: string[] = [];
  private historyIndex = -1;
  private draft = '';
  /** Reverse-i-search (`Ctrl+R`) state. */
  private searchActive = false;
  private searchQuery = '';
  private searchOffset = 0;
  private searchDraft = '';
  /** Large paste storage keyed by placeholder token `[Pasted #N · M lines]`. */
  private nextPasteId = 1;
  private pastes = new Map<string, string>();
  /** Dynamic workspace `@` mention and `/open` targets supplied by host. */
  private mentionPool: CompletionEntry[] = [];
  private openTargetPool: CompletionEntry[] = [];

  constructor(
    private readonly commands: () => string[] = () => SLASH_COMMANDS.map((c) => c.name),
  ) {}

  setMentions(entries: CompletionEntry[]): void {
    this.mentionPool = entries;
  }

  setOpenTargets(entries: CompletionEntry[]): void {
    this.openTargetPool = entries;
  }

  private findSearchMatch(): string | null {
    const q = this.searchQuery.toLowerCase();
    let seen = 0;
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const entry = this.history[i]!;
      if (!q || entry.toLowerCase().includes(q)) {
        if (seen === this.searchOffset) return entry;
        seen += 1;
      }
    }
    return null;
  }

  private snapshot(partial: Partial<EngineResult> = {}): EngineResult {
    return {
      line: this.line,
      cursor: this.cursor,
      paletteOpen: this.paletteOpen,
      paletteMode: this.paletteMode,
      paletteIndex: this.paletteIndex,
      paletteItems: this.paletteOptions.map((o) => o.label),
      paletteOptions: [...this.paletteOptions],
      historySearch: this.searchActive
        ? { query: this.searchQuery, match: this.findSearchMatch() }
        : null,
      scrollDelta: 0,
      wheelDelta: 0,
      submit: null,
      interrupt: false,
      eof: false,
      cycleMode: false,
      toggleDetails: false,
      clearView: false,
      copyLast: false,
      toggleHelp: false,
      ...partial,
    };
  }

  private dismissPalette(): void {
    this.paletteOpen = false;
    this.paletteOptions = [];
    this.paletteIndex = 0;
    this.paletteNavigated = false;
    this.replaceRange = null;
  }

  /** Re-evaluates command, arg or `@mention` palette from the current buffer. */
  private refreshPalette(): void {
    // 1. `@mention` anywhere around the cursor (when workspace pool is present).
    const mention = findActiveMention(this.line, this.cursor);
    if (mention && this.mentionPool.length > 0) {
      const matches = filterMentions(this.mentionPool, mention.query);
      if (matches.length > 0) {
        this.paletteOpen = true;
        this.paletteMode = 'mention';
        this.replaceRange = { start: mention.start, end: this.cursor };
        this.paletteOptions = matches.map((m) => ({
          kind: 'mention',
          label: m.label,
          description: m.description,
          insertText: `${m.value} `,
        }));
        if (this.paletteIndex >= this.paletteOptions.length) {
          this.paletteIndex = this.paletteOptions.length - 1;
        }
        return;
      }
    }

    // 2. Slash command filtering (first word starting with `/`, single-line).
    if (this.line.startsWith('/') && !this.line.includes(' ') && !this.line.includes('\n')) {
      const cmds = this.commands();
      const prefixMatches = cmds.filter((name) => name.startsWith(this.line));
      const matched =
        prefixMatches.length > 0
          ? prefixMatches
          : cmds.filter((name) => name.toLowerCase().includes(this.line.slice(1).toLowerCase()));
      if (matched.length === 0) {
        this.dismissPalette();
        return;
      }
      this.paletteOpen = true;
      this.paletteMode = 'command';
      this.replaceRange = null;
      this.paletteOptions = matched.map((name) => ({
        kind: 'command',
        label: name,
        description: SLASH_COMMANDS.find((c) => c.name === name)?.description ?? '',
        insertText: name,
      }));
      if (this.paletteIndex >= this.paletteOptions.length) {
        this.paletteIndex = this.paletteOptions.length - 1;
      }
      return;
    }

    // 3. Sub-argument completion after `/cmd ` (e.g. `/mode `, `/models `, `/open `).
    if (this.line.startsWith('/') && this.line.includes(' ') && !this.line.includes('\n')) {
      const spaceAt = this.line.indexOf(' ');
      const head = this.line.slice(0, spaceAt);
      const argText = this.line.slice(spaceAt + 1);
      if (this.cursor >= spaceAt + 1) {
        const args = getSlashArgSuggestions(head, argText, this.openTargetPool);
        const alreadyExact = args.length > 0 && args.some((a) => a.value.trim() === argText.trim());
        if (args.length > 0 && !alreadyExact) {
          this.paletteOpen = true;
          this.paletteMode = 'arg';
          this.paletteNavigated = false;
          this.replaceRange = { start: spaceAt + 1, end: this.line.length };
          this.paletteOptions = args.map((a) => ({
            kind: 'arg',
            label: a.label,
            description: a.description,
            insertText: a.value,
          }));
          if (this.paletteIndex >= this.paletteOptions.length) {
            this.paletteIndex = this.paletteOptions.length - 1;
          }
          return;
        }
      }
    }

    this.dismissPalette();
  }

  private applyPaletteOption(opt: PaletteOption): void {
    if (opt.kind === 'command') {
      this.line = opt.insertText;
      this.cursor = this.line.length;
      return;
    }
    if (this.replaceRange) {
      const before = this.line.slice(0, this.replaceRange.start);
      const after = this.line.slice(this.replaceRange.end);
      this.line = `${before}${opt.insertText}${after}`;
      this.cursor = before.length + opt.insertText.length;
      this.replaceRange = { start: this.replaceRange.start, end: this.cursor };
    }
  }

  private move(delta: number): void {
    const n = this.paletteOptions.length;
    if (n === 0) return;
    this.paletteNavigated = true;
    this.paletteIndex = (((this.paletteIndex + delta) % n) + n) % n;
    const chosen = this.paletteOptions[this.paletteIndex];
    if (chosen && chosen.kind === 'command') {
      this.line = chosen.insertText;
      this.cursor = this.line.length;
    }
  }

  private expandPastes(raw: string): string {
    let out = raw;
    for (const [token, body] of this.pastes.entries()) {
      if (out.includes(token)) {
        out = out.split(token).join(body);
      }
    }
    return out;
  }

  /** Keeps one copy of each submitted line, newest last, bounded. */
  private rememberHistory(entry: string): void {
    const value = entry.trim();
    if (!value) return;
    if (this.history[this.history.length - 1] === value) return;
    this.history.push(value);
    if (this.history.length > 50) this.history.shift();
    this.historyIndex = -1;
    this.draft = '';
  }

  /**
   * ↑/↓ with the palette closed walk submitted input the way a shell does.
   * For multi-line buffers, ↑/↓ first moves across lines inside the buffer.
   */
  private moveVerticalOrHistory(direction: -1 | 1): void {
    if (this.line.includes('\n')) {
      const before = this.line.slice(0, this.cursor);
      const currentLineIdx = before.split('\n').length - 1;
      const lines = this.line.split('\n');
      const targetLineIdx = currentLineIdx + direction;
      if (targetLineIdx >= 0 && targetLineIdx < lines.length) {
        const col = before.length - (before.lastIndexOf('\n') + 1);
        let offset = 0;
        for (let i = 0; i < targetLineIdx; i += 1) {
          offset += lines[i]!.length + 1;
        }
        this.cursor = offset + Math.min(col, lines[targetLineIdx]!.length);
        return;
      }
    }
    this.recall(direction);
  }

  private recall(direction: -1 | 1): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      if (direction === 1) return;
      this.draft = this.line;
      this.historyIndex = this.history.length - 1;
    } else {
      const next = this.historyIndex + direction;
      if (next >= this.history.length) {
        this.historyIndex = -1;
        this.line = this.draft;
        this.cursor = this.line.length;
        this.dismissPalette();
        return;
      }
      if (next < 0) return;
      this.historyIndex = next;
    }
    this.line = this.history[this.historyIndex] ?? '';
    this.cursor = this.line.length;
    this.dismissPalette();
  }

  private handleSearchKey(key: EngineKey): EngineResult {
    const { name, sequence, ctrl } = key;
    if (ctrl && (name === 'r' || sequence === '\x12')) {
      this.searchOffset += 1;
      if (!this.findSearchMatch()) this.searchOffset = 0;
      return this.snapshot();
    }
    if (name === 'escape' || (ctrl && (name === 'c' || name === 'g'))) {
      this.searchActive = false;
      this.line = this.searchDraft;
      this.cursor = this.line.length;
      return this.snapshot();
    }
    if (name === 'return' || name === 'enter' || name === 'tab' || name === 'right') {
      const match = this.findSearchMatch();
      this.searchActive = false;
      if (match) {
        this.line = match;
        this.cursor = match.length;
      }
      if ((name === 'return' || name === 'enter') && match) {
        this.rememberHistory(match);
        const submitted = match;
        this.line = '';
        this.cursor = 0;
        this.dismissPalette();
        return this.snapshot({ submit: submitted });
      }
      return this.snapshot();
    }
    if (name === 'backspace') {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.searchOffset = 0;
      return this.snapshot();
    }
    if (sequence && sequence.length > 0 && !ctrl) {
      // eslint-disable-next-line no-control-regex
      const printable = sequence.replace(/[\x00-\x1F\x7F]/g, '');
      if (printable) {
        this.searchQuery += printable;
        this.searchOffset = 0;
      }
    }
    return this.snapshot();
  }

  handle(key: EngineKey): EngineResult {
    if (this.searchActive) return this.handleSearchKey(key);

    const { name, sequence, ctrl } = key;

    if (ctrl && (name === 'r' || sequence === '\x12')) {
      this.searchActive = true;
      this.searchQuery = '';
      this.searchOffset = 0;
      this.searchDraft = this.line;
      this.dismissPalette();
      return this.snapshot();
    }

    if (ctrl && (name === 'c' || sequence === '\x03')) {
      if (this.line.length > 0) {
        this.line = '';
        this.cursor = 0;
        this.pastes.clear();
        this.refreshPalette();
        return this.snapshot();
      }
      return this.snapshot({ interrupt: true });
    }
    if (ctrl && (name === 'd' || sequence === '\x04')) {
      if (this.line.length === 0) return this.snapshot({ eof: true });
      if (this.cursor < this.line.length) {
        this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
        this.refreshPalette();
      }
      return this.snapshot();
    }
    if (name === 'shiftTab') return this.snapshot({ cycleMode: true });

    switch (name) {
      case 'newline': {
        this.line = `${this.line.slice(0, this.cursor)}\n${this.line.slice(this.cursor)}`;
        this.cursor += 1;
        this.dismissPalette();
        return this.snapshot();
      }
      case 'return':
      case 'enter': {
        if (
          this.paletteOpen &&
          this.paletteNavigated &&
          (this.paletteMode === 'mention' || this.paletteMode === 'arg') &&
          this.paletteOptions[this.paletteIndex]
        ) {
          this.applyPaletteOption(this.paletteOptions[this.paletteIndex]!);
          this.dismissPalette();
          return this.snapshot();
        }
        const expanded = this.expandPastes(this.line);
        if (this.line === '/') {
          this.refreshPalette();
          return this.snapshot({ submit: '/' });
        }
        this.rememberHistory(expanded);
        this.line = '';
        this.cursor = 0;
        this.pastes.clear();
        this.dismissPalette();
        return this.snapshot({ submit: expanded.length > 0 ? expanded : null });
      }
      case 'escape': {
        if (this.paletteOpen) {
          if (this.paletteMode === 'command') {
            // Classic contract: Esc dismisses command palette AND clears input.
            this.line = '';
            this.cursor = 0;
          }
          this.dismissPalette();
        }
        return this.snapshot();
      }
      case 'tab': {
        if (this.paletteOpen && (this.paletteMode === 'mention' || this.paletteMode === 'arg')) {
          const chosen = this.paletteOptions[this.paletteIndex];
          if (chosen) {
            this.applyPaletteOption(chosen);
            this.dismissPalette();
          }
          return this.snapshot();
        }
        if (this.line === '') {
          this.paletteOpen = true;
          this.paletteMode = 'command';
          this.paletteIndex = 0;
          this.paletteOptions = this.commands().map((c) => ({
            kind: 'command',
            label: c,
            description: SLASH_COMMANDS.find((cmd) => cmd.name === c)?.description ?? '',
            insertText: c,
          }));
          return this.snapshot();
        }
        if (!this.line.startsWith('/')) {
          this.refreshPalette();
          return this.snapshot();
        }
        if (this.line.includes(' ')) {
          this.refreshPalette();
          if (this.paletteOpen && this.paletteOptions[this.paletteIndex]) {
            this.applyPaletteOption(this.paletteOptions[this.paletteIndex]!);
            this.dismissPalette();
          }
          return this.snapshot();
        }
        const matches = this.commands().filter((name_) => name_.startsWith(this.line));
        if (matches.length === 1) {
          this.line = matches[0]!;
          this.cursor = this.line.length;
        } else if (matches.length > 1) {
          let prefix = matches[0]!;
          for (const candidate of matches) {
            while (!candidate.startsWith(prefix)) prefix = prefix.slice(0, -1);
          }
          this.line = prefix;
          this.cursor = prefix.length;
        }
        this.refreshPalette();
        if (matches.length > 0) {
          this.paletteOpen = true;
          this.paletteMode = 'command';
          this.paletteIndex = 0;
          this.paletteOptions = matches.map((c) => ({
            kind: 'command',
            label: c,
            description: SLASH_COMMANDS.find((cmd) => cmd.name === c)?.description ?? '',
            insertText: c,
          }));
        }
        return this.snapshot();
      }
      case 'up':
        if (this.paletteOpen) this.move(-1);
        else this.moveVerticalOrHistory(-1);
        return this.snapshot();
      case 'down':
        if (this.paletteOpen) this.move(1);
        else this.moveVerticalOrHistory(1);
        return this.snapshot();
      case 'pageup':
        return this.snapshot({ scrollDelta: 1 });
      case 'pagedown':
        return this.snapshot({ scrollDelta: -1 });
      case 'wheelup':
        return this.snapshot({ wheelDelta: 1 });
      case 'wheeldown':
        return this.snapshot({ wheelDelta: -1 });
      case 'wordleft':
        this.cursor = prevWordBoundary(this.line, this.cursor);
        return this.snapshot();
      case 'wordright':
        this.cursor = nextWordBoundary(this.line, this.cursor);
        return this.snapshot();
      case 'backspace': {
        if (this.cursor > 0) {
          this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
          this.cursor -= 1;
          this.refreshPalette();
        }
        return this.snapshot();
      }
      case 'delete': {
        if (this.cursor < this.line.length) {
          this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
          this.refreshPalette();
        } else if (this.cursor > 0) {
          this.line = this.line.slice(0, this.cursor - 1);
          this.cursor -= 1;
          this.refreshPalette();
        }
        return this.snapshot();
      }
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        return this.snapshot();
      case 'right':
        this.cursor = Math.min(this.line.length, this.cursor + 1);
        return this.snapshot();
      case 'home':
        this.cursor = 0;
        return this.snapshot();
      case 'end':
        this.cursor = this.line.length;
        return this.snapshot();
      default:
        break;
    }

    if (ctrl) {
      switch (name) {
        case 'a':
          this.cursor = 0;
          return this.snapshot();
        case 'e':
          this.cursor = this.line.length;
          return this.snapshot();
        case 'j':
          this.line = `${this.line.slice(0, this.cursor)}\n${this.line.slice(this.cursor)}`;
          this.cursor += 1;
          this.dismissPalette();
          return this.snapshot();
        case 'u': {
          this.line = this.line.slice(this.cursor);
          this.cursor = 0;
          this.refreshPalette();
          return this.snapshot();
        }
        case 'k': {
          this.line = this.line.slice(0, this.cursor);
          this.refreshPalette();
          return this.snapshot();
        }
        case 'w': {
          const trimmed = prevWordBoundary(this.line, this.cursor);
          this.line = this.line.slice(0, trimmed) + this.line.slice(this.cursor);
          this.cursor = trimmed;
          this.refreshPalette();
          return this.snapshot();
        }
        case 'o':
          return this.snapshot({ toggleDetails: true });
        case 'l':
          return this.snapshot({ clearView: true });
        case 'y':
          return this.snapshot({ copyLast: true });
        default:
          return this.snapshot();
      }
    }

    if (EDIT_KEYS.has(name ?? '')) return this.snapshot();

    if (sequence === '?' && this.line === '' && !this.paletteOpen) {
      return this.snapshot({ toggleHelp: true });
    }

    if (sequence && sequence.length > 0) {
      const normalized = sequence.replace(/\r\n?/g, '\n');
      // eslint-disable-next-line no-control-regex
      const printable = normalized.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
      if (printable.length > 0) {
        const lineCount = printable.split('\n').length;
        if (
          lineCount >= PASTE_COLLAPSE_MIN_LINES ||
          (printable.includes('\n') && printable.length >= PASTE_COLLAPSE_MIN_CHARS)
        ) {
          const token = `[Pasted #${this.nextPasteId++} · ${lineCount} lines]`;
          this.pastes.set(token, printable);
          this.line = this.line.slice(0, this.cursor) + token + this.line.slice(this.cursor);
          this.cursor += token.length;
        } else {
          this.line = this.line.slice(0, this.cursor) + printable + this.line.slice(this.cursor);
          this.cursor += printable.length;
        }
        this.refreshPalette();
      }
    }
    return this.snapshot();
  }
}

/**
 * Renderer routing (checkpoint: plain/json/non-TTY stay TUI-free).
 */
export function interactiveRenderer(opts: {
  isTTY: boolean;
  plain: boolean;
  forceTty: boolean;
  forceInk?: boolean;
}): 'ink' | 'classic' {
  if (opts.plain) return 'classic';
  if (opts.forceInk) return 'ink';
  if (opts.forceTty) return 'classic';
  return opts.isTTY ? 'ink' : 'classic';
}

/** Ink key-event shape (`useInput` callback). */
export interface InkKeyLike {
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  backspace?: boolean;
  delete?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

// eslint-disable-next-line no-control-regex
const SGR_MOUSE = /^(?:\x1b)?\[<(\d+);\d+;\d+[Mm]$/;

/** Maps an Ink key event onto the pure ShellEngine key vocabulary. */
export function toEngineKey(input: string, key: InkKeyLike): EngineKey {
  const mouse = SGR_MOUSE.exec(input);
  if (mouse) {
    const button = Number(mouse[1]);
    if (button === 64) return { name: 'wheelup' };
    if (button === 65) return { name: 'wheeldown' };
    return { name: 'unknown' };
  }
  if (input === '\x1b[3~' || input === '\x1b[3;5~') return { name: 'delete' };
  if ((key.shift && key.tab) || input === '\x1b[Z') return { name: 'shiftTab' };
  // Shift+Enter / Alt+Enter / Kitty CSI-u newline insert a literal newline.
  if (
    (key.return && (key.shift || key.meta)) ||
    input === '\x1b\r' ||
    input === '\x1b[13;2u' ||
    input === '\x1b[27;2;13~'
  ) {
    return { name: 'newline' };
  }
  if ((key.ctrl && key.leftArrow) || input === '\x1b[1;5D' || input === '\x1bb') {
    return { name: 'wordleft' };
  }
  if ((key.ctrl && key.rightArrow) || input === '\x1b[1;5C' || input === '\x1bf') {
    return { name: 'wordright' };
  }
  if (key.return) return { name: 'return' };
  if (key.escape) return { name: 'escape' };
  if (key.tab || input === '\t') return { name: 'tab' };
  if (key.upArrow) return { name: 'up' };
  if (key.downArrow) return { name: 'down' };
  if (key.leftArrow) return { name: 'left' };
  if (key.rightArrow) return { name: 'right' };
  if (key.pageUp) return { name: 'pageup' };
  if (key.pageDown) return { name: 'pagedown' };
  if (key.home) return { name: 'home' };
  if (key.end) return { name: 'end' };
  if (key.backspace || input === '\x7f' || input === '\b') return { name: 'backspace' };
  if (key.delete) return { name: 'delete' };
  if ((key.ctrl && (input === '\x03' || input === 'c')) || input === '\x03') {
    return { name: 'c', ctrl: true };
  }
  if ((key.ctrl && (input === '\x04' || input === 'd')) || input === '\x04') {
    return { name: 'd', ctrl: true };
  }
  if (input.length === 1) {
    const code = input.charCodeAt(0);
    if (code >= 1 && code <= 26 && code !== 9 && code !== 13) {
      return { name: String.fromCharCode(code + 96), ctrl: true };
    }
  }
  if (key.ctrl && input.length === 1) return { name: input, ctrl: true };
  if (input.length > 0 && !key.meta) return { sequence: input };
  return { name: 'unknown' };
}
