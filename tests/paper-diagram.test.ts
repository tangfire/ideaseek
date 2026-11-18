import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderDiagram } from '../src/paper/diagram.js';
import { arisSkillsRoot } from '../src/aris/skill.js';
import { sha256OfFile } from '../src/core/hash.js';
import { CLI_BIN } from './helpers.js';

/**
 * The deterministic FigureSpec route.
 *
 * Two things are easy to get wrong here, and both look like success. First, a
 * renderer that exits 0 after writing garbage (the vendored tool prints an
 * emoji on success, which under a Windows code page it cannot encode raises
 * UnicodeEncodeError AFTER the SVG is complete) — so the assertions below are
 * about the bytes on disk, not about the exit code. Second, a module that works
 * when called from a test but is not reachable by a user: `renderDiagram` sat
 * unwired for a whole slice with zero importers, which is the "configured,
 * green, inert" shape this project keeps finding. The CLI case is therefore the
 * main event, and the hash assertions compare the recorded digests against the
 * actual files rather than against each other.
 */

const SPEC = {
  canvas: { width: 620, height: 300 },
  nodes: [
    { id: 'ingest', label: 'papers/ corpus', x: 90, y: 80, shape: 'rounded' },
    { id: 'ladder', label: 'idea check ladder', x: 310, y: 80, shape: 'rect' },
    { id: 'record', label: 'RunResult (percent, controls)', x: 520, y: 200, shape: 'rounded' },
  ],
  edges: [
    { from: 'ingest', to: 'ladder', label: 'evidence' },
    { from: 'ladder', to: 'record', label: 'admitted' },
  ],
};

const BROKEN_SPEC = {
  canvas: { width: 620, height: 300 },
  nodes: [{ id: 'oops', label: 'no coordinates' }],
  edges: [],
};

let dir: string;
let specPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diagram-'));
  specPath = join(dir, 'pipeline.json');
  await writeFile(specPath, JSON.stringify(SPEC, null, 2), 'utf8');
}, 60_000);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 120_000): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
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
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('paper diagram (deterministic FigureSpec route)', () => {
  it('renders a real SVG whose content comes from the spec', async () => {
    const out = join(dir, 'figures', 'pipeline.svg');
    const render = await renderDiagram({ specPath, outputPath: out, cwd: dir });
    const svg = await readFile(out, 'utf8');
    expect(svg).toContain('<svg');
    expect(render.bytes).toBe(svg.length);
    expect(render.sha256).toBe(await sha256OfFile(out));
    // Every label and every edge has to be in the drawing: a header-only file
    // would satisfy "is SVG" while being an empty figure.
    for (const node of SPEC.nodes) {
      expect(svg, `node ${node.id}`).toContain(node.label);
    }
    for (const edge of SPEC.edges) {
      expect(svg, `edge ${edge.label}`).toContain(edge.label!);
    }
    expect(render.rendererPath.replace(/\\/g, '/')).toContain(
      'figure-spec/scripts/figure_renderer.py',
    );
  }, 180_000);

  it('is byte-identical for the same spec, and records which renderer ran', async () => {
    const a = join(dir, 'figures', 'a.svg');
    const b = join(dir, 'figures', 'b.svg');
    const first = await renderDiagram({ specPath, outputPath: a, cwd: dir });
    const second = await renderDiagram({ specPath, outputPath: b, cwd: dir });
    expect(first.sha256).toBe(second.sha256);
    expect(first.specSha256).toBe(await sha256OfFile(specPath));
    // The determinism promise is (spec, renderer) → bytes, so the renderer
    // digest must be the vendored file's own digest, not a constant.
    expect(first.rendererSha256).toBe(
      await sha256OfFile(
        join(arisSkillsRoot(), 'skills', 'figure-spec', 'scripts', 'figure_renderer.py'),
      ),
    );
    expect(second.rendererSha256).toBe(first.rendererSha256);
  }, 180_000);

  it('refuses a malformed spec through the upstream validator and writes nothing', async () => {
    const badSpec = join(dir, 'broken.json');
    await writeFile(badSpec, JSON.stringify(BROKEN_SPEC), 'utf8');
    const out = join(dir, 'figures', 'broken.svg');
    await expect(renderDiagram({ specPath: badSpec, outputPath: out, cwd: dir })).rejects.toThrow(
      /FigureSpec validation failed/,
    );
    // "validate first" only means something if the artefact is absent
    // afterwards; a renderer that writes before it checks would leave a figure
    // that the report says does not exist.
    await expect(readFile(out)).rejects.toThrow();
  }, 120_000);

  it('is reachable as a command and persists digests that match the files', async () => {
    const project = await mkdtemp(join(tmpdir(), 'diagram-cli-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    await mkdir(join(project, 'reports', 'paper'), { recursive: true });
    const cliSpec = join(project, 'reports', 'paper', 'pipeline.json');
    await writeFile(cliSpec, JSON.stringify(SPEC, null, 2), 'utf8');

    const run = await runCli(project, [
      'paper',
      'diagram',
      '--spec',
      'reports/paper/pipeline.json',
      '--json',
    ]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const entry = JSON.parse(run.stdout) as {
      outputPath: string;
      sha256: string;
      specSha256: string;
      bytes: number;
    };
    expect(entry.outputPath).toBe(join(project, 'figures', 'pipeline.svg'));
    expect(entry.sha256).toBe(await sha256OfFile(entry.outputPath));
    expect(entry.specSha256).toBe(await sha256OfFile(cliSpec));

    const record = JSON.parse(
      await readFile(join(project, 'reports', 'paper', 'diagram-render.json'), 'utf8'),
    ) as { contract: string; renders: { outputPath: string }[] };
    expect(record.contract).toBe('diagram-render-v1');
    expect(record.renders).toHaveLength(1);

    // Re-running replaces the entry for that output rather than accumulating a
    // "history" of identical renders.
    const again = await runCli(project, [
      'paper',
      'diagram',
      '--spec',
      'reports/paper/pipeline.json',
      '--json',
    ]);
    expect(again.code, again.stdout + again.stderr).toBe(0);
    const reread = JSON.parse(
      await readFile(join(project, 'reports', 'paper', 'diagram-render.json'), 'utf8'),
    ) as { renders: unknown[] };
    expect(reread.renders).toHaveLength(1);
  }, 240_000);
});
