import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * Phase 7 workflow chain: plan → figure → write → compile →
 * render-figures must BIND to each other through the stored artifacts —
 * figure ids pinned by the plan, manuscript venue pinned by the plan,
 * compile bound to the manuscript inputHash, render bound to the figure
 * plan inputHash. This is the "ARIS paper-plan → paper-figure →
 * paper-write → paper-compile workflow 接入" evidence: the stages are
 * individually wired AND the provenance chain holds end to end.
 */

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 300_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
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

async function readJson<T>(dir: string, rel: string): Promise<T> {
  return JSON.parse(await readFile(join(dir, rel), 'utf8')) as T;
}

describe('paper delivery workflow chain (plan → figure → write → compile → render)', () => {
  it('every stage binds to the previous one through persisted hashes and ids', async () => {
    const dir = await makeProjectDir();

    // 1) plan — the chain root.
    expect((await runCli(dir, ['paper', 'plan', '--harness', 'fake'])).code).toBe(0);
    const plan = await readJson<{
      inputHash: string;
      plan: { venue: string; figurePlan: { id: string }[] };
    }>(dir, 'reports/paper/plan.json');
    expect(plan.inputHash).toMatch(/^sha256:/);
    expect(plan.plan.figurePlan.length).toBeGreaterThan(0);
    const plannedIds = plan.plan.figurePlan.map((figure) => figure.id);

    // 2) figure — ids pinned to the plan.
    expect((await runCli(dir, ['paper', 'figure', '--harness', 'fake'])).code).toBe(0);
    const figures = await readJson<{
      inputHash: string;
      figures: { figures: { id: string }[] };
    }>(dir, 'reports/paper/figures-plan.json');
    const producedIds = figures.figures.figures.map((figure) => figure.id);
    expect(producedIds.sort()).toEqual([...plannedIds].sort());
    expect(figures.inputHash).toMatch(/^sha256:/);

    // 3) write — venue pinned to the plan.
    expect((await runCli(dir, ['paper', 'write', '--harness', 'fake'])).code).toBe(0);
    const manuscript = await readJson<{
      inputHash: string;
      manuscript: { venue: string };
    }>(dir, 'reports/paper/manuscript.json');
    expect(manuscript.manuscript.venue).toBe(plan.plan.venue);
    expect(manuscript.inputHash).toMatch(/^sha256:/);

    // 4) compile — bound to the manuscript inputHash (tri-state build,
    //    assembly always happens; latexmk outcome depends on the host).
    const compiled = await runCli(dir, ['paper', 'compile', '--json']);
    expect([0, 1, 2]).toContain(compiled.code);
    const compileReport = await readJson<{
      contract: string;
      manuscriptInputHash: string;
      status: string;
      mainPath: string;
    }>(dir, 'reports/paper/compile-report.json');
    expect(compileReport.contract).toBe('paper-compile-v1');
    expect(compileReport.manuscriptInputHash).toBe(manuscript.inputHash);
    expect(['compiled', 'failed', 'blocked']).toContain(compileReport.status);
    if (compileReport.status !== 'blocked') {
      // blocked = no vendored template for the venue → assembly refused.
      const mainTex = await readFile(compileReport.mainPath, 'utf8');
      expect(mainTex).toContain('\\begin{document}');
    }

    // 5) render-figures — bound to the figure plan inputHash.
    const rendered = await runCli(dir, ['paper', 'render-figures', '--json']);
    expect([0, 1]).toContain(rendered.code);
    const renderReport = await readJson<{
      contract: string;
      planInputHash: string;
      status: string;
    }>(dir, 'reports/paper/figure-render.json');
    expect(renderReport.contract).toBe('figure-render-v1');
    expect(renderReport.planInputHash).toBe(figures.inputHash);
    expect(['rendered', 'partial', 'failed']).toContain(renderReport.status);
    if (renderReport.status === 'rendered') {
      expect(rendered.code).toBe(0);
    }

    // Provenance anchors all the way down: skill hashes recorded per stage.
    for (const file of ['plan.json', 'figures-plan.json', 'manuscript.json']) {
      const stored = await readJson<{ skill: { name: string; sha256: string } }>(
        dir,
        `reports/paper/${file}`,
      );
      expect(stored.skill.name).toMatch(/^paper-/);
      expect(stored.skill.sha256).toMatch(/^[0-9a-f]{64}$/); // manifest hashes are bare hex
    }

    // 6) Overleaf export — bundle + zip + sha256 manifest, no secrets.
    const exported = await runCli(dir, ['paper', 'export-overleaf', '--json']);
    expect(exported.code, exported.stdout + exported.stderr).toBe(0);
    const bundle = JSON.parse(exported.stdout) as {
      contract: string;
      bundleDir: string;
      zipPath: string;
      files: { path: string; sha256: string }[];
      provenance: string[];
    };
    expect(bundle.contract).toBe('overleaf-export-v1');
    expect(bundle.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'main.tex',
        'references.bib',
        'README.md',
        'manifest.json',
        'provenance/experiments.json',
        'provenance/protocol-locks.json',
      ]),
    );
    expect(bundle.provenance.length).toBeGreaterThan(0);
    expect(bundle.files.every((file) => file.sha256.startsWith('sha256:'))).toBe(true);
    const main = await readFile(join(bundle.bundleDir, 'main.tex'), 'utf8');
    expect(main).toContain('\\begin{document}');
    const zip = await readFile(bundle.zipPath);
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK');
    for (const file of bundle.files) {
      const content = await readFile(join(bundle.bundleDir, ...file.path.split('/')), 'utf8');
      expect(content).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    }
  }, 600_000);
});
