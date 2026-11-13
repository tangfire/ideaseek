import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * Report export (PROGRESS: 报告全文 JSON + 引用/BibTeX): the factual run
 * report gains full structured JSON (every md assertion, machine-readable)
 * and a BibTeX bibliography (run + corpus cards). Authors/years the
 * extractor never captured are NOT invented — note fields say so. The md
 * path stays byte-compatible with the original behavior.
 */

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end();
  });
}

async function projectWithRun(): Promise<{ dir: string; runId: string }> {
  const dir = await makeProjectDir();
  const created = await runCli(dir, ['run', '--question', 'export me', '--json']);
  expect(created.code, created.stdout + created.stderr).toBe(0);
  const payload = JSON.parse(created.stdout) as { runId?: string };
  // Inline execution path may omit runId in some envelopes — read latest.
  const status = await runCli(dir, ['status', '--json']);
  const latest = JSON.parse(status.stdout) as { run?: { runId?: string } | null; runId?: string };
  const runId = payload.runId ?? latest.run?.runId ?? latest.runId;
  expect(runId, status.stdout).toBeTruthy();
  return { dir, runId: runId as string };
}

async function seedPaperCard(dir: string): Promise<void> {
  await mkdir(join(dir, 'knowledge', 'paper-cards'), { recursive: true });
  await writeFile(
    join(dir, 'knowledge', 'paper-cards', 'paper-x.json'),
    JSON.stringify({
      artifactId: 'paper-x',
      source: 'x.pdf',
      card: {
        title: '50% {great} & _weird_ title',
        paper_id: 'paper-x',
        document_hash: 'sha256:' + 'e'.repeat(64),
      },
    }),
    'utf8',
  );
}

describe('ideaseek report exports', () => {
  it('json format: full structured report file + envelope, round-trips exactly', async () => {
    const { dir, runId } = await projectWithRun();
    await seedPaperCard(dir);

    const result = await runCli(dir, ['report', '--format', 'json', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      format: string;
      reportPath: string;
      tasks: number;
      events: number;
      references: number;
      report: {
        contract: string;
        run: { runId: string; question: string; status: string };
        stats: Record<string, number>;
        tasks: { taskId: string; status: string }[];
        events: { seq: number; summary: string }[];
        references: { paperId: string; title: string }[];
        provenance: { statement: string };
      };
    };
    expect(envelope.format).toBe('json');
    expect(envelope.report.contract).toBe('run-report-v1');
    expect(envelope.report.run.runId).toBe(runId);
    expect(envelope.report.run.question).toBe('export me');
    expect(envelope.report.tasks.length).toBe(envelope.tasks);
    expect(envelope.report.events.length).toBe(envelope.events);
    const statsSum = Object.values(envelope.report.stats).reduce((a, b) => a + b, 0);
    expect(statsSum).toBe(envelope.report.tasks.length);
    expect(envelope.report.provenance.statement).toContain('no model-generated claims');
    expect(envelope.report.references.map((r) => r.paperId)).toContain('paper-x');
    expect(envelope.report.references[0]!.title.length).toBeGreaterThan(0);

    // The written file is byte-identical to the reported object.
    const file = JSON.parse(await readFile(envelope.reportPath, 'utf8')) as typeof envelope.report;
    expect(file).toEqual(envelope.report);
  }, 180_000);

  it('bibtex format: run + corpus entries, LaTeX-escaped, no invented authors', async () => {
    const { dir } = await projectWithRun();
    await seedPaperCard(dir);

    const result = await runCli(dir, ['report', '--format', 'bibtex']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('@misc{ideaseek-run-');
    expect(result.stdout).toContain('@misc{paper-x,');
    // LaTeX specials escaped in the title.
    expect(result.stdout).toContain('50\\% \\{great\\} \\& \\_weird\\_ title');
    // Honest gaps: no invented author/year fields for corpus cards.
    expect(result.stdout).toContain('authors/year not extracted');
    expect(result.stdout).not.toMatch(/author\s*=/);
    // Bibliography written next to the other report formats.
    expect(result.stdout).toContain('bibliography written:');
    const bibPath = /bibliography written: (.+)\n/.exec(result.stdout)?.[1]?.trim();
    expect(bibPath).toBeTruthy();
    const bib = await readFile(bibPath!, 'utf8');
    expect(bib).toContain('@misc{ideaseek-run-');
  }, 180_000);

  it('md format stays the default and unknown formats are refused', async () => {
    const { dir } = await projectWithRun();

    const md = await runCli(dir, ['report']);
    expect(md.code, md.stdout + md.stderr).toBe(0);
    expect(md.stdout).toContain('# IdeaSeek Run Report');
    expect(md.stdout).toContain('report written:');

    const bad = await runCli(dir, ['report', '--format', 'pdf']);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('md | json | bibtex');
  }, 180_000);
});
