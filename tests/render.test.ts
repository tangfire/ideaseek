import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN } from './helpers.js';

/**
 * Phase 4.5B render-html: the vendored pure-stdlib ARIS render_html.py
 * turns wiki/plan artifacts into single-file HTML reading views; the
 * command collects targets, writes a nav index and degrades with a clear
 * error when python is unavailable. Source content stays escaped (XSS).
 */

const XSS = '<script>alert("xss")</script>';

function makeCard(ideaId: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: {
      statement: `reweighting improves recall ${XSS}`,
      targetProblem: 'FedAvg dilutes minority classes',
    },
    paperEvidence: [{ paperRef: 'fedavg-paper', statement: 'uniform averaging', evidence: 'p.5' }],
    contradictions: ['paper B reports no gain where paper A does'],
    novelty: {
      claim: 'calibration-error reweighting',
      uncertainty: 'may collapse with balanced clients',
      whyNotRestatement: 'measurable calibration signal instead of sample counts',
    },
    mechanismChain: {
      designPrincipleLink: 'inverts FedAvg weighting assumption',
      steps: [
        { kind: 'observation', text: 'skewed clients show high calibration error' },
        { kind: 'hypothesis', text: 'down-weighting them reduces dilution' },
        { kind: 'intervention', text: 'server weights by exp(-calibration error)' },
        { kind: 'expected-change', text: 'rare-class recall rises' },
        { kind: 'baseline-difference', text: 'vs sample-count weighting' },
        { kind: 'falsifier', text: 'no recall gain on 3 seeds' },
      ],
    },
    nearestComparisons: [{ methodId: 'fedavg', difference: 'weighting rule', evidence: 'p.3' }],
    componentNecessity: [
      { component: 'probe', role: 'necessary-mechanism', removeEffect: 'gain disappears' },
    ],
    competingExplanations: ['lower effective lr'],
    boundaryConditions: ['no benefit without skew'],
    risks: ['extra pass per round'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'data/synthetic.csv',
      baselines: ['fedavg'],
      metrics: ['rare-class recall'],
      ablations: ['no reweighting'],
    },
    falsification: { conditions: ['recall delta < 0 on 3 seeds'] },
    budget: { maxRounds: 3, maxGpuMinutes: 120 },
    stopConditions: ['budget exhausted'],
    createdAt: 1,
  } as IdeaCard;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 180_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...env },
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

interface RenderPayload {
  count: number;
  out: string;
  rendered: { source: string; out: string }[];
}

describe('ideaseek render (ARIS render-html backend)', () => {
  const ideaId = 'calib-reweight';

  async function setupWithWikiAndPlan(): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-render-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(ideaId), null, 2), 'utf8');
    expect((await runCli(project, ['idea', 'create', ideaId, '--from-card', cardPath])).code).toBe(
      0,
    );
    expect((await runCli(project, ['experiment', 'plan', ideaId, '--harness', 'fake'])).code).toBe(
      0,
    );
    const wiki = await runCli(project, ['wiki']);
    expect(wiki.code, wiki.stdout + wiki.stderr).toBe(0);
    return project;
  }

  it('renders wiki and plan artifacts to HTML with an escaped source payload', async () => {
    const project = await setupWithWikiAndPlan();
    const rendered = await runCli(project, ['render', '--json', '--offline']);
    expect(rendered.code, rendered.stderr).toBe(0);
    const payload = JSON.parse(rendered.stdout) as RenderPayload;
    expect(payload.count).toBeGreaterThanOrEqual(3);
    expect(payload.out).toBe('knowledge/render');

    const nav = await readFile(join(project, 'knowledge', 'render', 'index.html'), 'utf8');
    expect(nav).toContain('<!DOCTYPE html>');
    expect(nav).toContain('wiki-index.html');

    const wikiIndex = await readFile(
      join(project, 'knowledge', 'render', 'wiki-index.html'),
      'utf8',
    );
    expect(wikiIndex).toContain('<!DOCTYPE html>');
    expect(wikiIndex).toContain('offline mode'); // --offline skips CDN blocks

    // XSS: the card hypothesis travels into the wiki idea page — the view
    // must escape it, never emit the raw script tag.
    const ideaView = await readFile(
      join(project, 'knowledge', 'render', `ideas-${ideaId}.html`),
      'utf8',
    );
    expect(ideaView).not.toContain(XSS);
    expect(ideaView).toContain('&lt;script&gt;');
  }, 300_000);

  it('reports zero targets on a fresh project', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-render-empty-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const rendered = await runCli(project, ['render', '--json']);
    expect(rendered.code, rendered.stderr).toBe(0);
    expect((JSON.parse(rendered.stdout) as RenderPayload).count).toBe(0);

    const human = await runCli(project, ['render']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('nothing to render yet');
  }, 120_000);

  it('fails clearly when python is unavailable', async () => {
    const project = await setupWithWikiAndPlan();
    const failed = await runCli(project, ['render', '--json'], {
      IDEASEEK_PYTHON: 'definitely-not-a-python-binary',
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('render requires python');
  }, 180_000);
});
