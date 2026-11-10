import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregateEvaluations,
  evaluateSource,
  sampleSources,
} from '../src/evaluation/papers.js';
import { CLI_BIN } from './helpers.js';

describe('sampleSources', () => {
  const corpus = Array.from({ length: 20 }, (_, i) => `papers/p${String(i).padStart(2, '0')}.pdf`);

  it('is deterministic for a fixed seed and different across seeds', () => {
    const a = sampleSources(corpus, 5, 42);
    const b = sampleSources(corpus, 5, 42);
    const c = sampleSources(corpus, 5, 7);
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
    expect(a).not.toEqual(c);
    expect([...a].sort()).toEqual([...new Set(a)].sort());
  });

  it('clamps sample size and deduplicates input', () => {
    expect(sampleSources([...corpus, corpus[0]!], 1000, 1)).toHaveLength(20);
    expect(sampleSources(corpus, 0, 1)).toHaveLength(1); // min 1
    expect(sampleSources([], 5, 1)).toEqual([]);
  });
});

function fullArtifacts(source: string) {
  return {
    source,
    parsed: { pageCount: 3 },
    card: {
      card: {
        paper_id: 'paper-x',
        document_hash: `sha256:${'a'.repeat(64)}`,
        title: 'T',
        problem: 'P',
        method: { summary: 's', steps: ['a'], motivation: ['b'] },
        datasets: ['d'],
        metrics: ['m'],
        baselines: ['B'],
        limitations: ['l'],
        claims: [
          {
            text: 'claim',
            evidence: [
              { page: 1, quote: 'exact quote here' },
              { page: 2, quote: 'another quote' },
            ],
          },
        ],
        unknowns: [],
        parser_version: 'pypdf/7.0.0',
        prompt_schema_version: 'papercard-v1',
      },
    },
    report: {
      verdict: 'pass' as const,
      hashMatch: true,
      stats: { claims: 1, spans: 2, verified: 2, weak: 0, failed: 0 },
      spanChecks: [
        { claimedPage: 1, foundPage: 1, ok: true, weak: false, quote: 'exact quote here' },
        { claimedPage: 2, foundPage: 2, ok: true, weak: false, quote: 'another quote' },
      ],
    },
  };
}

describe('evaluateSource / aggregateEvaluations', () => {
  it('scores a fully processed source', () => {
    const result = evaluateSource(fullArtifacts('papers/a.pdf'));
    expect(result.processed).toBe(true);
    expect(result.cardValid).toBe(true);
    expect(result.claims).toBe(1);
    expect(result.quotes).toBe(2);
    expect(result.verifiedQuotes).toBe(2);
    expect(result.quotesWithPage).toBe(2);
    expect(result.pageLocatingCorrect).toBe(2);
    expect(result.hashBound).toBe(true);
    expect(result.verdict).toBe('pass');
  });

  it('reports missing pipeline output as unprocessed', () => {
    const result = evaluateSource({
      source: 'papers/b.pdf',
      parsed: null,
      card: null,
      report: null,
    });
    expect(result.processed).toBe(false);
    expect(result.pageCount).toBeNull();

    const cardOnly = evaluateSource({
      source: 'papers/c.pdf',
      parsed: { pageCount: 1 },
      card: fullArtifacts('x').card,
      report: null,
    });
    expect(cardOnly.processed).toBe(false); // report missing ⇒ not fully processed
    expect(cardOnly.cardValid).toBe(true);
  });

  it('flags invalid cards', () => {
    const broken = fullArtifacts('x');
    broken.card = { card: { ...broken.card!.card, claims: [{ text: 'x', evidence: [] }] } };
    const result = evaluateSource(broken);
    expect(result.cardValid).toBe(false);
    expect(result.cardErrors).toBeGreaterThan(0);
  });

  it('aggregates rates with safe division and lists missing sources', () => {
    const now = 123;
    const good = evaluateSource(fullArtifacts('papers/a.pdf'));
    const missing = evaluateSource({ source: 'papers/b.pdf', parsed: null, card: null, report: null });
    const evaluation = aggregateEvaluations([good, missing], now, 42);
    expect(evaluation.sampleSize).toBe(2);
    expect(evaluation.aggregates.processed).toBe(1);
    expect(evaluation.aggregates.coverage).toBeCloseTo(0.5, 5);
    expect(evaluation.aggregates.cardValidRate).toBe(1);
    expect(evaluation.aggregates.evidenceSupportRate).toBe(1);
    expect(evaluation.aggregates.pageLocatingAccuracy).toBe(1);
    expect(evaluation.aggregates.verdictPassRate).toBe(1);
    expect(evaluation.missing).toEqual(['papers/b.pdf']);

    const empty = aggregateEvaluations([], now, 42);
    expect(empty.aggregates.coverage).toBe(0);
    expect(empty.aggregates.evidenceSupportRate).toBe(0);
    expect(empty.aggregates.avgClaims).toBe(0);
  });
});

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
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
  });
}

describe('CLI: evaluate', () => {
  it('measures coverage honestly before and after the pipeline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-eval-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
    try {
      await makeFixturePdf(join(dir, 'papers', 'alpha.pdf'), 'Alpha');
      await makeFixturePdf(join(dir, 'papers', 'beta.pdf'), 'Beta');
    } catch {
      return; // python/pypdf unavailable
    }

    expect((await runCli(dir, ['scan'])).code).toBe(0);

    // Before parse/extract: full sample reported as missing (with the fix hint).
    const before = await runCli(dir, ['evaluate', '--sample', '2', '--json']);
    expect(before.code).toBe(0);
    const beforePayload = JSON.parse(before.stdout) as {
      aggregates: { coverage: number; cardValidRate: number };
      missing: string[];
    };
    expect(beforePayload.aggregates.coverage).toBe(0);
    expect(beforePayload.missing).toHaveLength(2);

    // Drive the pipeline (parse + fake extract + verify), then re-measure.
    expect((await runCli(dir, ['ingest', '--json'])).code).toBe(0);
    expect((await runCli(dir, ['extract', '--parallel', '2', '--json'], 120_000)).code).toBe(0);
    const after = await runCli(dir, ['evaluate', '--sample', '2', '--seed', '42', '--json']);
    expect(after.code).toBe(0);
    const afterPayload = JSON.parse(after.stdout) as {
      aggregates: {
        coverage: number;
        cardValidRate: number;
        evidenceSupportRate: number;
        verdictPassRate: number;
      };
      missing: string[];
      reportPath: string;
    };
    expect(afterPayload.aggregates.coverage).toBe(1);
    expect(afterPayload.aggregates.cardValidRate).toBe(1);
    expect(afterPayload.aggregates.evidenceSupportRate).toBe(1);
    expect(afterPayload.aggregates.verdictPassRate).toBe(1);
    expect(afterPayload.missing).toHaveLength(0);
    await access(afterPayload.reportPath);

    const text = await runCli(dir, ['evaluate', '--sample', '2']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('evidence-support');
    expect(text.stdout).toContain('seed 42');
  }, 240_000);

  it('refuses without a scanned manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-eval-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const result = await runCli(dir, ['evaluate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ideaseek scan');
  }, 60_000);
});

async function access(path: string): Promise<void> {
  const { access: fsAccess } = await import('node:fs/promises');
  await fsAccess(path);
}
