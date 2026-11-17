import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One language per sentence in platform-produced text (#16).
 *
 * The recorded complaint was "中英混杂", and sweeping for it showed the
 * complaint was mostly misdirected: a Chinese label carrying a command or a
 * path (`下一条命令：ideaseek idea check alpha`) is not mixing, and translating a
 * command would break the thing the reader is meant to copy. What IS a defect
 * is one sentence changing language halfway, because these lines are quoted
 * into events, JSON artifacts, forensics reports and agent prompts, where a
 * half-translated sentence is noise in whichever language the reader works in.
 *
 * The rule is stated as a test rather than as a style note, with a positive
 * control: a scan that finds nothing is indistinguishable from a pattern that
 * never fires, and that "looks configured, actually inert" shape is the failure
 * this project has now hit four times.
 */
const HAN = /[一-鿿]/;

/**
 * English prose, recognised by function words. Word-count heuristics were tried
 * first and rejected: counting Latin runs flags `ideaseek idea check alpha`.
 */
const ENGLISH_CLAUSE =
  /\b(the|this|these|those|for|with|must|cannot|no\s+silent|requires?|is\s+a|are|away)\b\s+[a-z]+/i;

/**
 * What may stay English inside a Chinese sentence, decided by STRUCTURE rather
 * than by a word list. A list of "machine words" is how this project keeps
 * producing rules that need extending for every new package, and the first
 * draft of this file had one — it swallowed `baseline` and stopped flagging
 * English prose that used the word, which is the defect it exists to catch.
 *
 * So: `<placeholders>`, anything containing path/flag punctuation (`papers/`,
 * `--reason`, `EXCLUDED.md`), an `ideaseek …` command line, and ALL-CAPS
 * identifiers (macro and status names). Ordinary English words are not stripped,
 * because a Chinese sentence importing them is exactly the mixing under test.
 */
const MACHINE_STRUCTURE =
  /ideaseek\s+[a-z-]+(?:\s+[a-z0-9-]+)*|[A-Za-z0-9]+[._/-][A-Za-z0-9._/-]*|(?<![\w])_{0,2}[A-Z]{3,}(?![\w])/g;

/** The rule, factored out so the positive control can exercise it directly. */
export function mixesLanguages(text: string): boolean {
  if (!HAN.test(text)) return false;
  const withoutMachineStructure = text
    .replace(/<[^>]*>/g, ' ')
    .replace(MACHINE_STRUCTURE, ' ');
  return ENGLISH_CLAUSE.test(withoutMachineStructure);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('guidance language (one language inside a sentence)', () => {
  it('produces no sentence that switches language midway', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*') ||
          trimmed.startsWith('import ')
        ) {
          continue;
        }
        // Only text the platform emits or sends to a model.
        if (!/(write|push|throw|detail|reason|summary|message|instruction|prompt)/i.test(trimmed)) {
          continue;
        }
        for (const match of trimmed.matchAll(/['"`]([^'"`]{12,})['"`]/g)) {
          const text = match[1] ?? '';
          if (mixesLanguages(text)) {
            offenders.push(`${file}:${index + 1} — ${text.slice(0, 120)}`);
          }
        }
      }
    }
    expect(offenders, `mixed-language sentences:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('flags English prose embedded in a Chinese sentence', () => {
    // The strings that were in the code before this was addressed, in both of
    // the places the same sentence had been copied to.
    expect(mixesLanguages('缺少有效对照：the baseline result is not available')).toBe(true);
    expect(mixesLanguages('提示：coding turns are one explicit step away <指令>')).toBe(true);
    expect(mixesLanguages('状态 requires --reason (no silent skips; 必须有原因)')).toBe(true);
  });

  it('leaves machine structure alone, which is the point of the rule', () => {
    // Translating these would be the actual defect: a researcher copies them.
    expect(mixesLanguages('下一条命令：ideaseek idea check alpha')).toBe(false);
    expect(mixesLanguages('阻塞：papers 目录为空，先运行 ideaseek scan')).toBe(false);
    expect(mixesLanguages('详情见 docs/AUTONOMY_POLICY 与 EXCLUDED 状态')).toBe(false);
    expect(mixesLanguages('你是论文图表分析师，请描述本页内容')).toBe(false);
    // Purely English or purely Chinese text is never a mix.
    expect(mixesLanguages('the baseline result is not available')).toBe(false);
    expect(mixesLanguages('还缺少基线结果')).toBe(false);
  });
});
