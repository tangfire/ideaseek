import { SLASH_COMMANDS } from '../slash-menu.js';

/**
 * Pure input/state engine for the interactive shell (ADR-010). No I/O, no
 * ANSI — the Ink view renders whatever this returns, so every keyboard
 * rule (palette, completion, editing, scroll, Ctrl-C/D) is unit-testable
 * without a terminal. Semantics mirror the classic readline path where
 * tests already pin behavior (unique-prefix Tab, Esc clears an open
 * palette, arrows fill the input from the palette).
 */

export interface EngineKey {
  /** Named keys: up/down/left/right/return/tab/escape/backspace/delete/home/end/pageup/pagedown. */
  name?: string;
  /** Printable character(s), including paste bursts. */
  sequence?: string;
  ctrl?: boolean;
}

export interface EngineResult {
  line: string;
  cursor: number;
  paletteOpen: boolean;
  paletteIndex: number;
  paletteItems: string[];
  /** +1 page up / -1 page down over the activity pane (0 = no change). */
  scrollDelta: number;
  /** Line to dispatch (Enter); null when nothing should run. */
  submit: string | null;
  /** Ctrl-C on an empty line → host prints the exit hint. */
  interrupt: boolean;
  /** Ctrl-D on an empty line → host closes (EOF semantics). */
  eof: boolean;
}

const EDIT_KEYS = new Set(['left', 'right', 'home', 'end', 'backspace', 'delete']);

export class ShellEngine {
  private line = '';
  private cursor = 0;
  private paletteOpen = false;
  private paletteIndex = 0;
  private paletteItems: string[] = [];

  constructor(
    private readonly commands: () => string[] = () => SLASH_COMMANDS.map((c) => c.name),
  ) {}

  private snapshot(partial: Partial<EngineResult> = {}): EngineResult {
    return {
      line: this.line,
      cursor: this.cursor,
      paletteOpen: this.paletteOpen,
      paletteIndex: this.paletteIndex,
      paletteItems: [...this.paletteItems],
      scrollDelta: 0,
      submit: null,
      interrupt: false,
      eof: false,
      ...partial,
    };
  }

  /** Re-evaluates the palette from the current line (filter-on-type). */
  private refreshPalette(): void {
    const filterable = this.line.startsWith('/') && !this.line.includes(' ');
    const items = filterable ? this.commands().filter((name) => name.startsWith(this.line)) : [];
    if (items.length === 0) {
      this.paletteOpen = false;
      this.paletteItems = [];
      this.paletteIndex = 0;
      return;
    }
    this.paletteOpen = true;
    this.paletteItems = items;
    if (this.paletteIndex >= items.length) this.paletteIndex = items.length - 1;
  }

  private move(delta: number): void {
    const n = this.paletteItems.length;
    if (n === 0) return;
    this.paletteIndex = (((this.paletteIndex + delta) % n) + n) % n;
    this.line = this.paletteItems[this.paletteIndex]!;
    this.cursor = this.line.length;
  }

  handle(key: EngineKey): EngineResult {
    const { name, sequence, ctrl } = key;

    if (ctrl && (name === 'c' || sequence === '\x03')) {
      if (this.line.length > 0) {
        this.line = '';
        this.cursor = 0;
        this.refreshPalette();
        return this.snapshot();
      }
      return this.snapshot({ interrupt: true });
    }
    if (ctrl && (name === 'd' || sequence === '\x04')) {
      if (this.line.length === 0) return this.snapshot({ eof: true });
      // non-empty: delete forward (readline semantics)
      if (this.cursor < this.line.length) {
        this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
        this.refreshPalette();
      }
      return this.snapshot();
    }

    switch (name) {
      case 'return':
      case 'enter': {
        const submit = this.line;
        // Bare '/' keeps the full menu open (classic contract: Enter on '/'
        // shows the menu again — never an error); anything else submits and
        // clears the input for the next command.
        if (submit === '/') {
          this.refreshPalette();
        } else {
          this.line = '';
          this.cursor = 0;
          this.paletteOpen = false;
          this.paletteItems = [];
          this.paletteIndex = 0;
        }
        return this.snapshot({ submit: submit.length > 0 ? submit : null });
      }
      case 'escape': {
        if (this.paletteOpen) {
          // Classic contract: Esc dismisses the palette AND the input line.
          this.line = '';
          this.cursor = 0;
          this.paletteOpen = false;
          this.paletteItems = [];
          this.paletteIndex = 0;
        }
        return this.snapshot();
      }
      case 'tab': {
        if (!this.line.startsWith('/')) return this.snapshot();
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
          this.paletteItems = matches;
          this.paletteIndex = 0;
        }
        return this.snapshot();
      }
      case 'up':
        if (this.paletteOpen) this.move(-1);
        return this.snapshot();
      case 'down':
        if (this.paletteOpen) this.move(1);
        return this.snapshot();
      case 'pageup':
        return this.snapshot({ scrollDelta: 1 });
      case 'pagedown':
        return this.snapshot({ scrollDelta: -1 });
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
          const before = this.line.slice(0, this.cursor);
          const trimmed = before.replace(/\S+\s*$/, '');
          this.line = trimmed + this.line.slice(this.cursor);
          this.cursor = trimmed.length;
          this.refreshPalette();
          return this.snapshot();
        }
        default:
          return this.snapshot();
      }
    }

    if (EDIT_KEYS.has(name ?? '')) return this.snapshot(); // handled above

    if (sequence && sequence.length > 0) {
      this.line = this.line.slice(0, this.cursor) + sequence + this.line.slice(this.cursor);
      this.cursor += sequence.length;
      this.refreshPalette();
    }
    return this.snapshot();
  }
}

/**
 * Renderer routing (checkpoint: plain/json/non-TTY stay TUI-free).
 * Real interactive TTY → Ink (the sole interactive renderer). `forceTty`
 * keeps the classic line path over pipes (legacy keypress tests); `forceInk`
 * is the test/driver hook that runs the Ink TUI over piped stdio.
 */
export function interactiveRenderer(opts: {
  isTTY: boolean;
  plain: boolean;
  forceTty: boolean;
  forceInk?: boolean;
}): 'ink' | 'classic' {
  if (opts.plain) return 'classic';
  if (opts.forceInk) return 'ink';
  if (opts.forceTty) return 'classic'; // pipes: line-mode + forced key handling
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
  ctrl?: boolean;
  meta?: boolean;
}

/** Maps an Ink key event onto the pure ShellEngine key vocabulary. */
export function toEngineKey(input: string, key: InkKeyLike): EngineKey {
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
  if (key.ctrl && input === '\x03') return { name: 'c', ctrl: true };
  if (key.ctrl && input === '\x04') return { name: 'd', ctrl: true };
  if (key.ctrl && input.length === 1) return { name: input, ctrl: true };
  if (input.length > 0 && !key.meta) return { sequence: input };
  return { name: 'unknown' };
}
