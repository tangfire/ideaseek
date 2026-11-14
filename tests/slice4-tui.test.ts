import { describe, expect, it } from 'vitest';
import { createPicker, movePicker, selectedPickerItem } from '../src/cli/shell/pickers.js';
import {
  findTranscriptMatches,
  highlightSearchMatches,
  type WrappedRow,
} from '../src/cli/shell/transcript.js';
import { formatWelcomeLines } from '../src/cli/shell/welcome.js';
import { extractAssistantStepText, formatSubagentLine } from '../src/dsh/session.js';
import { stripAnsi } from '../src/cli/text-width.js';

describe('TUI interactive pickers', () => {
  it('navigates items with wrap-around and resolves selected item', () => {
    const picker = createPicker('provider', 'Pick provider', [
      { id: 'deepseek', label: 'deepseek', detail: 'https://api.deepseek.com' },
      { id: 'local', label: 'local', detail: 'http://127.0.0.1:8000' },
    ])!;
    expect(selectedPickerItem(picker)?.id).toBe('deepseek');
    const down = movePicker(picker, 1);
    expect(selectedPickerItem(down)?.id).toBe('local');
    const wrapped = movePicker(down, 1);
    expect(selectedPickerItem(wrapped)?.id).toBe('deepseek');
    expect(createPicker('provider', 'Empty', [])).toBeNull();
  });
});

describe('In-transcript search and highlight', () => {
  it('finds matching visual rows and highlights matches safely around ANSI SGR', () => {
    const rows: WrappedRow[] = [
      { blockId: 1, text: '\x1b[36mPAPER_ANALYSIS\x1b[0m paper-01' },
      { blockId: 2, text: 'other line' },
      { blockId: 3, text: 'error in Paper-02' },
    ];
    expect(findTranscriptMatches(rows, 'paper')).toEqual([0, 2]);
    const hl = highlightSearchMatches(rows[0]!.text, 'paper', true, false);
    expect(hl).toContain('\x1b[43m\x1b[30mPAPER\x1b[49m\x1b[39m');
    expect(stripAnsi(hl)).toBe('PAPER_ANALYSIS paper-01');
  });
});

describe('Workspace welcome greeting', () => {
  it('renders project and non-project quick-start tips cleanly', () => {
    const projectLines = formatWelcomeLines(
      {
        isProject: true,
        papers: 8,
        datasets: 1,
        comparisons: 2,
        ideas: 3,
        hasKeyEnv: true,
      },
      true,
    );
    expect(projectLines[0]).toContain('papers 8');
    expect(projectLines[0]).toContain('model key: ready');

    const emptyLines = formatWelcomeLines(
      {
        isProject: false,
        papers: 0,
        datasets: 0,
        comparisons: 0,
        ideas: 0,
        hasKeyEnv: false,
      },
      true,
    );
    expect(emptyLines[0]).toContain('no project here');
    expect(emptyLines[1]).toContain('/init');
  });
});

describe('DSH live assistant/subagent step extraction', () => {
  it('extracts visible text blocks while ignoring hidden reasoning blocks', () => {
    const text = extractAssistantStepText('assistant/message', {
      message: {
        content: [
          { type: 'reasoning', text: 'internal hidden chain' },
          { type: 'text', text: 'Checking sk-secret1234567890 in config.' },
        ],
      },
    });
    expect(text).toContain('Checking [redacted] in config.');
    expect(text).not.toContain('internal hidden chain');
    expect(extractAssistantStepText('turn/start', {})).toBeNull();
  });

  it('formats subagent lifecycle notifications', () => {
    expect(
      formatSubagentLine('subagent.started', { childSessionId: 'sub-1234567890abcd' }),
    ).toContain('subagent started');
    expect(
      formatSubagentLine('subagent.finished', { childSessionId: 'sub-1234567890', status: 'ok' }),
    ).toContain('subagent ok');
  });
});
