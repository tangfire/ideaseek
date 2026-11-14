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
  /** Named keys: up/down/left/right/return/tab/escape/backspace/delete/home/end/pageup/pagedown/wheelup/wheeldown. */
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
  /** +1 wheel notch up / -1 wheel notch down (0 = no change). */
  wheelDelta: number;
  /** Line to dispatch (Enter); null when nothing should run. */
  submit: string | null;
  /** Ctrl-C on an empty line → host prints the exit hint. */
  interrupt: boolean;
  /** Ctrl-D on an empty line → host closes (EOF semantics). */
  eof: boolean;
  /** Shift+Tab cycles the session mode through the shared mode command. */
  cycleMode: boolean;
}

const EDIT_KEYS = new Set(['left', 'right', 'home', 'end', 'backspace', 'delete']);

export class ShellEngine {
  private line = '';
  private cursor = 0;
  private paletteOpen = false;
  private paletteIndex = 0;
  private paletteItems: string[] = [];
  /** Submitted input, oldest first. ↑/↓ walk it when the palette is closed. */
  private history: string[] = [];
  private historyIndex = -1;
  private draft = '';

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
      wheelDelta: 0,
      submit: null,
      interrupt: false,
      eof: false,
      cycleMode: false,
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
   * The in-progress line is kept so ↓ back past the newest entry restores it.
   * A recalled line is complete, so the palette stays closed — reopening it
   * would steal the next keystroke from the history walk.
   */
  private recall(direction: -1 | 1): void {
    if (this.history.length === 0) return;
    const dismissPalette = (): void => {
      this.paletteOpen = false;
      this.paletteItems = [];
      this.paletteIndex = 0;
    };
    if (this.historyIndex === -1) {
      if (direction === 1) return; // nothing newer than the live line
      this.draft = this.line;
      this.historyIndex = this.history.length - 1;
    } else {
      const next = this.historyIndex + direction;
      if (next >= this.history.length) {
        this.historyIndex = -1;
        this.line = this.draft;
        this.cursor = this.line.length;
        dismissPalette();
        return;
      }
      if (next < 0) return; // oldest entry stays
      this.historyIndex = next;
    }
    this.line = this.history[this.historyIndex] ?? '';
    this.cursor = this.line.length;
    dismissPalette();
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
    if (name === 'shiftTab') return this.snapshot({ cycleMode: true });

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
          this.rememberHistory(submit);
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
        if (this.line === '') {
          // The footer advertises Tab; on an empty line it must reveal the
          // command list rather than swallow the keystroke.
          this.paletteItems = this.commands();
          this.paletteOpen = this.paletteItems.length > 0;
          this.paletteIndex = 0;
          return this.snapshot();
        }
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
        else this.recall(-1);
        return this.snapshot();
      case 'down':
        if (this.paletteOpen) this.move(1);
        else this.recall(1);
        return this.snapshot();
      case 'pageup':
        return this.snapshot({ scrollDelta: 1 });
      case 'pagedown':
        return this.snapshot({ scrollDelta: -1 });
      case 'wheelup':
        return this.snapshot({ wheelDelta: 1 });
      case 'wheeldown':
        return this.snapshot({ wheelDelta: -1 });
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
          // Users commonly press the physical Delete key at the end of the
          // input line expecting to erase the previous character. Preserve
          // forward-delete semantics in the middle; at end-of-line behave
          // like Backspace so the input remains easy to edit in Windows TTYs.
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
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/**
 * SGR mouse reports (tracking modes 1000+1006). The alternate screen has
 * no scrollback, so the wheel is the only way back up through history —
 * wheel notches scroll, clicks/drags are swallowed (they must never fall
 * through to the paste/sequence branch and type garbage into the line).
 * Ink strips one leading ESC from the sequence before we see it; accept
 * both forms.
 */
// The control character is the point: this matches ESC-prefixed mouse reports.
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
  // Some terminal/IME combinations report Delete as a raw CSI sequence
  // instead of Ink's named key. Check it before `key.escape`, because the
  // sequence begins with ESC and must not merely dismiss the palette.
  if (input === '\x1b[3~' || input === '\x1b[3;5~') return { name: 'delete' };
  if ((key.shift && key.tab) || input === '\x1b[Z') return { name: 'shiftTab' };
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
