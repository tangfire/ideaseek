import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  capClusters,
  clusterCards,
  renderResearchMap,
  renderTopicSynthesis,
  validateResearchMap,
  validateTopicSynthesis,
} from '../src/knowledge/synthesis.js';
import type { CompactCard } from '../src/knowledge/synthesis.js';
import { CLI_BIN } from './helpers.js';

function card(source: string, overrides: Partial<CompactCard> = {}): CompactCard {
  return {
    paperId: `paper-${source.replace(/\W/g, '')}`,
    source,
    title: 'Unknown',
    problem: 'unknown',
    methodSummary: 'unknown',
    datasets: [],
    metrics: [],
    topClaims: [],
    limitations: [],
    ...overrides,
  };
}

describe('clusterCards', () => {
  it('joins papers sharing a dataset and separates disjoint groups', () => {
    const clusters = clusterCards([
      card('papers/a.pdf', { datasets: ['MNIST'], title: 'Graph Nets' }),
      card('papers/b.pdf', { datasets: ['MNIST'], title: 'Graph Rewiring' }),
      card('papers/c.pdf', { datasets: ['LibriSpeech'], title: 'Speech Transformers' }),
    ]);
    expect(clusters).toHaveLength(2);
    const mnist = clusters.find((cluster) =>
      cluster.members.some((m) => m.source === 'papers/a.pdf'),
    )!;
    expect(mnist.members.map((m) => m.source).sort()).toEqual(['papers/a.pdf', 'papers/b.pdf']);
    expect(mnist.topicId.startsWith('topic-')).toBe(true);
  });

  it('is deterministic (same input ⇒ identical clusters)', () => {
    const cards = [
      card('papers/x.pdf', { datasets: ['CIFAR'], title: 'Robust Learning' }),
      card('papers/y.pdf', { datasets: ['ImageNet'], title: 'Vision Transformers' }),
    ];
    expect(clusterCards(cards)).toEqual(clusterCards([...cards].reverse()));
  });

  it('caps cluster count by merging the tail', () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      card(`papers/p${index}.pdf`, { datasets: [`DS${index}`], title: `Unique topic ${index}` }),
    );
    const clusters = capClusters(clusterCards(many), 3);
    expect(clusters.length).toBe(3); //2 kept + 1 merged tail
    const total = clusters.reduce((sum, cluster) => sum + cluster.members.length, 0);
    expect(total).toBe(8);
  });
});

describe('synthesis contracts', () => {
  const validTopic = {
    topicId: 'topic-abc12345',
    inputHash: `sha256:${'a'.repeat(64)}`,
    topic: 'graph learning',
    papers: [{ paperId: 'paper-1', title: 'T' }],
    methodLineage: ['lineage one'],
    keyFindings: [{ text: 'finding', source: 'papers/a.pdf', page: 1, quote: 'verbatim' }],
    conflicts: ['none'],
    mechanisms: [{ name: 'm', principle: 'p', conditions: 'c' }],
    openQuestions: ['q'],
    generatedAt: 1,
    generator: 'synthesis-v1-prompt.1',
  };

  it('validates topic synthesis structure and citations', () => {
    expect(validateTopicSynthesis(validTopic).errors).toEqual([]);
    const noPapers = { ...validTopic, papers: [] };
    expect(validateTopicSynthesis(noPapers).errors.join(' ')).toContain('at least one member');
    const badFinding = {
      ...validTopic,
      keyFindings: [{ text: 'no source' }],
    };
    expect(validateTopicSynthesis(badFinding).ok).toBe(false);
    const badMech = { ...validTopic, mechanisms: [{ name: 'm' }] };
    expect(validateTopicSynthesis(badMech).ok).toBe(false);
    expect(validateTopicSynthesis(null).ok).toBe(false);
  });

  it('validates research map citations and lineages', () => {
    const validMap = {
      landscape: 'wide',
      lineages: [{ name: 'l1', summary: 's' }],
      conflicts: [],
      gaps: ['gap'],
      citations: [{ source: 'papers/a.pdf', title: 'A' }],
      generatedAt: 1,
      generator: 'research-map-v1-prompt.1',
    };
    expect(validateResearchMap(validMap).errors).toEqual([]);
    expect(validateResearchMap({ ...validMap, citations: [] }).ok).toBe(false);
    expect(validateResearchMap({ ...validMap, lineages: [] }).ok).toBe(false);
    expect(validateResearchMap('map').ok).toBe(false);
  });

  it('renders synthesis and map markdown with citations and disclaimers', () => {
    const md = renderTopicSynthesis({
      ...validTopic,
      papers: [{ paperId: 'paper-1', title: 'Title' }],
    });
    expect(md).toContain('# graph learning');
    expect(md).toContain('verbatim');
    expect(md).toContain('Mechanisms');
    const map = renderResearchMap({
      inputHash: `sha256:${'b'.repeat(64)}`,
      landscape: 'landscape text',
      lineages: [{ name: 'lineage', summary: 'sum' }],
      conflicts: [{ topic: 't', detail: 'd' }],
      gaps: ['gap one'],
      citations: [{ source: 'papers/a.pdf', title: 'A' }],
      generatedAt: 1,
      generator: 'research-map-v1-prompt.1',
    });
    expect(map).toContain('# Research Map');
    expect(map).toContain('Evidence gap');
    expect(map).toContain('researcher review');
    expect(map).toContain('papers/a.pdf');
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

describe('CLI: synthesize (fake harness end to end)', () => {
  it('exports cards, synthesizes topics and writes the research map; rerun is a no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-synth-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
    try {
      await makeFixturePdf(join(dir, 'papers', 'alpha.pdf'), 'Alpha');
      await makeFixturePdf(join(dir, 'papers', 'beta.pdf'), 'Beta');
    } catch {
      return; // python/pypdf unavailable
    }
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    expect((await runCli(dir, ['ingest', '--json'])).code).toBe(0);
    expect((await runCli(dir, ['extract', '--parallel', '2', '--json'], 120_000)).code).toBe(0);

    const first = await runCli(dir, ['synthesize', '--json'], 120_000);
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.stdout) as {
      status: string;
      clusters: number;
      cardsExported: number;
      topicsWritten: number;
      mapPath: string | null;
      tasks: Record<string, number>;
    };
    expect(payload.status).toBe('COMPLETED');
    expect(payload.cardsExported).toBe(2);
    expect(payload.topicsWritten).toBeGreaterThanOrEqual(1);
    expect(payload.mapPath).not.toBeNull();
    expect(payload.tasks.failed ?? 0).toBe(0);

    const map = await readFile(payload.mapPath!, 'utf8');
    expect(map).toContain('# Research Map');
    expect(map).toContain('researcher review');
    const cardExport = await readdir(join(dir, 'knowledge', 'paper-cards'));
    expect(cardExport.filter((name) => name.endsWith('.md')).length).toBeGreaterThanOrEqual(2);
    const syntheses = await readdir(join(dir, 'knowledge', 'syntheses'));
    expect(syntheses.some((name) => name.endsWith('.md'))).toBe(true);
    await access(
      join(dir, 'knowledge', 'research-map.json').replace('research-map.json', 'research-map.md'),
    );

    // Incremental: everything current → no-op.
    const second = await runCli(dir, ['synthesize', '--json'], 120_000);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as { action?: string; enqueued: number };
    expect(secondPayload.action).toBe('nothing-to-synthesize');
    expect(secondPayload.enqueued).toBe(0);
  }, 300_000);

  it('refuses without extracted cards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-synth-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const result = await runCli(dir, ['synthesize']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ideaseek extract');
  }, 60_000);
});

describe('research-map rejects the shapes that used to render as undefined', () => {
  const baseMap = {
    landscape: 'a field organised around prototype sharing',
    gaps: ['when does shrinkage hurt?'],
    citations: [{ source: 'he13a-imbalanced', title: 'Cost-sensitive FL' }],
    generator: 'test',
  };

  it('refuses string conflicts and unnamed lineages instead of printing undefined', () => {
    // The hole was specific: `citations` was validated element-wise while
    // `lineages` and `conflicts` were only checked as arrays. A model that
    // echoed the topic-synthesis strings back therefore passed validation, and
    // `renderResearchMap` dereferenced `.topic`/`.name` on strings, writing
    // "- **undefined**: undefined" into knowledge/research-map.md as a clean
    // success — an artifact that reads as garbage and reports as fine, which the
    // next stage (idea generation over these gaps) then trusts.
    expect(
      validateResearchMap({
        ...baseMap,
        lineages: [{ name: 'privacy-preserving aggregation', summary: 'shares effects only' }],
        conflicts: ['shrinkage may hurt calibration'],
      }).errors,
    ).toContain('conflicts[0] needs topic and detail');
    expect(
      validateResearchMap({
        ...baseMap,
        lineages: ['weighted aggregation'],
        conflicts: [{ topic: 'a', detail: 'b' }],
      }).errors,
    ).toContain('lineages[0] needs name and summary');
    expect(
      validateResearchMap({
        ...baseMap,
        lineages: [{ name: 'a', summary: 'b' }],
        conflicts: [{ topic: 'a', detail: 'b' }],
      }).ok,
    ).toBe(true);
  });

  it('still accepts a map whose arrays are empty where the contract allows it', () => {
    // `conflicts` may legitimately be empty ("_none recorded_" is a real
    // outcome). Requiring shape on elements must not become requiring presence.
    expect(
      validateResearchMap({
        ...baseMap,
        lineages: [{ name: 'a', summary: 'b' }],
        conflicts: [],
      }).ok,
    ).toBe(true);
  });
});
