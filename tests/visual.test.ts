import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, REPO_ROOT, makeProjectDir } from './helpers.js';
import { resolveImageCapability } from '../src/models/image-capability.js';
import { renderPagePng, analyzePageVisual } from '../src/knowledge/visual.js';
import { FakeHarnessAdapter } from '../src/dsh/fake-adapter.js';
import type { HarnessTaskRequest } from '../src/dsh/adapter.js';
import { pythonBinary } from '../src/knowledge/pdf.js';

/**
 * Phase 2 vision slice: DSH image attachment reuse — a rendered PDF page
 * travels as an SDK image block ONLY when the routed model's capability
 * says so (declared routing > pinned DSH catalog > text-only); otherwise
 * a low-confidence text fallback with needsUserReview. Results bind
 * paperHash/page/attachment/model/route — never model-claimed.
 */

describe('resolveImageCapability (actual capability, never name inference)', () => {
  it('honors explicit route declarations first', () => {
    expect(resolveImageCapability({ model: 'anything', declaredImageInput: true })).toMatchObject({
      supported: true,
      basis: 'route-declaration',
    });
    expect(
      resolveImageCapability({ model: 'deepseek-flash', declaredImageInput: false }),
    ).toMatchObject({ supported: false, basis: 'declared-text-only' });
  });

  it('reads the pinned DSH catalog facts', () => {
    expect(resolveImageCapability({ model: 'deepseek-flash' })).toMatchObject({
      supported: true,
      basis: 'pinned-dsh-catalog',
    });
    expect(resolveImageCapability({ model: 'deepseek-v4-pro' })).toMatchObject({
      supported: false,
      basis: 'pinned-dsh-catalog',
    });
  });

  it('treats uncatalogued ids as text-only (DSH rule)', () => {
    const capability = resolveImageCapability({ model: 'deepseek-v4-flash' });
    expect(capability.supported).toBe(false);
    expect(capability.basis).toBe('uncatalogued-text-only');
    expect(capability.detail).toContain('text-only');
  });
});

async function fixturePdf(): Promise<{ dir: string; pdf: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'visual-pdf-'));
  const python = await pythonBinary();
  // make-fixture needs the worker package on sys.path → run from worker dir.
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      python,
      ['-m', 'ideaseek_worker', 'make-fixture', join(dir, 'fixture.pdf'), '--marker', 'Vision'],
      { cwd: workerCwd(), env: process.env, stdio: 'ignore' },
    );
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`make-fixture exit ${code}`)),
    );
  });
  return { dir, pdf: join(dir, 'fixture.pdf') };
}

function workerCwd(): string {
  return join(REPO_ROOT, 'worker', 'python');
}

describe('renderPagePng', () => {
  it('renders page 1 of a real PDF to a hashed PNG', async () => {
    const { pdf } = await fixturePdf();
    const rendered = await renderPagePng(pdf, 1);
    expect(rendered.png.length).toBeGreaterThan(1000);
    expect(rendered.png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    expect(rendered.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 60_000);

  it('fails with the stable taxonomy on corrupt/missing/invalid input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'visual-bad-'));
    const badPdf = join(dir, 'bad.pdf');
    await writeFile(badPdf, 'this is not a pdf at all');
    await expect(renderPagePng(badPdf, 1)).rejects.toMatchObject({ code: 'PARSE_FAILED' });
    await expect(renderPagePng(join(dir, 'missing.pdf'), 1)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
    const { pdf } = await fixturePdf();
    await expect(renderPagePng(pdf, 0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  }, 60_000);
});

/** Fake that records the inputs it received (image-block assertions). */
class RecordingFake extends FakeHarnessAdapter {
  lastRequest: HarnessTaskRequest | null = null;
  override async runTask(
    request: HarnessTaskRequest,
    ...rest: unknown[]
  ): Promise<Awaited<ReturnType<FakeHarnessAdapter['runTask']>>> {
    this.lastRequest = request;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return super.runTask(request, ...(rest as [])) as any;
  }
}

describe('analyzePageVisual (capability-gated paths)', () => {
  const capability = {
    supported: true,
    basis: 'pinned-dsh-catalog' as const,
    detail: 'test route',
  };
  const unsupported = {
    supported: false,
    basis: 'uncatalogued-text-only' as const,
    detail: 'text-only route',
  };

  it('vision path sends an image block and stamps platform bindings', async () => {
    const { pdf } = await fixturePdf();
    const harness = new RecordingFake();
    await harness.initialize();
    const result = await analyzePageVisual({
      paperHash: `sha256:${'a'.repeat(64)}`,
      page: 1,
      pdfPath: pdf,
      capability,
      harness,
    });
    await harness.shutdown();

    // The image block actually reached the harness.
    const imageInputs = (harness.lastRequest?.inputs ?? []).filter((i) => i.kind === 'image');
    expect(imageInputs).toHaveLength(1);
    expect(imageInputs[0]!.mimeType).toBe('image/png');
    expect(imageInputs[0]!.source?.page).toBe(1);

    // Platform-stamped bindings + model reported by the runtime.
    expect(result.source).toBe('vision');
    expect(result.paperHash).toBe(`sha256:${'a'.repeat(64)}`);
    expect(result.page).toBe(1);
    expect(result.attachmentSha256).toMatch(/^sha256:/);
    expect(result.model).toBe('fake-model');
    expect(result.route).toBe('test route');
    expect(result.caption.length).toBeGreaterThan(0);
    expect(result.needsUserReview).toBe(false); // fake confidence 0.82 ≥ 0.7
  }, 60_000);

  it('low confidence flags user review', async () => {
    const { pdf } = await fixturePdf();
    process.env.IDEASEEK_FAKE_VISUAL_OUTPUT = JSON.stringify({
      caption: 'blurry figure',
      confidence: 0.4,
      uncertainty: 'low resolution',
      observations: ['hard to read'],
    });
    try {
      const harness = new FakeHarnessAdapter();
      await harness.initialize();
      const result = await analyzePageVisual({
        paperHash: `sha256:${'b'.repeat(64)}`,
        page: 1,
        pdfPath: pdf,
        capability,
        harness,
      });
      await harness.shutdown();
      expect(result.needsUserReview).toBe(true);
    } finally {
      delete process.env.IDEASEEK_FAKE_VISUAL_OUTPUT;
    }
  }, 60_000);

  it('unsupported route degrades to text fallback without any model call', async () => {
    const { pdf } = await fixturePdf();
    const harness = new RecordingFake();
    const result = await analyzePageVisual({
      paperHash: `sha256:${'c'.repeat(64)}`,
      page: 1,
      pdfPath: pdf,
      capability: unsupported,
      harness, // must stay unused
      pageTextFallback: 'Figure 1 shows accuracy bars for two methods.',
    });
    expect(harness.lastRequest).toBeNull(); // no model call at all
    expect(result.source).toBe('text-fallback');
    expect(result.needsUserReview).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.5);
    expect(result.attachmentSha256).toBeNull();
    expect(result.model).toBeNull();
    expect(result.uncertainty).toContain('NOT verified');
    expect(result.caption).toContain('Figure 1');
  }, 60_000);

  it('quota blocks propagate as typed blocks', async () => {
    const { pdf } = await fixturePdf();
    const harness = new FakeHarnessAdapter({ block: 'QUOTA_EXHAUSTED', blockTimes: 1 });
    await harness.initialize();
    await expect(
      analyzePageVisual({
        paperHash: `sha256:${'d'.repeat(64)}`,
        page: 1,
        pdfPath: pdf,
        capability,
        harness,
      }),
    ).rejects.toMatchObject({ name: 'HarnessBlockError', block: 'QUOTA_EXHAUSTED' });

    // Recovery: the next call succeeds (block consumed).
    const recovered = await analyzePageVisual({
      paperHash: `sha256:${'d'.repeat(64)}`,
      page: 1,
      pdfPath: pdf,
      capability,
      harness,
    });
    expect(recovered.source).toBe('vision');
    await harness.shutdown();
  }, 60_000);

  it('abort cancels the vision call', async () => {
    const { pdf } = await fixturePdf();
    const harness = new FakeHarnessAdapter({ latencyMs: 5_000 });
    await harness.initialize();
    const controller = new AbortController();
    const promise = analyzePageVisual({
      paperHash: `sha256:${'e'.repeat(64)}`,
      page: 1,
      pdfPath: pdf,
      capability,
      harness,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await harness.shutdown();
  }, 30_000);

  it('a corrupt PDF fails closed on the vision path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'visual-corrupt-'));
    const badPdf = join(dir, 'bad.pdf');
    await writeFile(badPdf, 'not a pdf');
    const harness = new FakeHarnessAdapter();
    await harness.initialize();
    await expect(
      analyzePageVisual({
        paperHash: `sha256:${'f'.repeat(64)}`,
        page: 1,
        pdfPath: badPdf,
        capability,
        harness,
      }),
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
    await harness.shutdown();
  }, 60_000);
});

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 120_000,
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

describe('ideaseek paper visual (e2e)', () => {
  it('falls back with low confidence on the default (uncatalogued) route', async () => {
    const dir = await makeProjectDir();
    const { pdf } = await fixturePdf();
    const rel = 'papers/vision-fixture.pdf';
    const { copyFile } = await import('node:fs/promises');
    await copyFile(pdf, join(dir, rel));

    // Default fast-tier model is uncatalogued → text-only capability.
    const fallback = await runCli(dir, ['paper', 'visual', '--pdf', rel, '--page', '1', '--json']);
    expect(fallback.code, fallback.stdout + fallback.stderr).toBe(0);
    const payload = JSON.parse(fallback.stdout) as {
      capability: { supported: boolean; basis: string };
      result: { source: string; needsUserReview: boolean; route: string };
      path: string;
    };
    expect(payload.capability.supported).toBe(false);
    expect(payload.capability.basis).toBe('uncatalogued-text-only');
    expect(payload.result.source).toBe('text-fallback');
    expect(payload.result.needsUserReview).toBe(true);
    expect(payload.result.route).toContain('text-only');
    const stored = JSON.parse(await readFile(join(dir, payload.path), 'utf8')) as {
      contract: string;
      paperHash: string;
    };
    expect(stored.contract).toBe('page-visual-v1');
    expect(stored.paperHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 120_000);

  it('runs the vision path when the routed model is image-capable (catalog fact)', async () => {
    const dir = await makeProjectDir();
    const { pdf } = await fixturePdf();
    const rel = 'papers/vision-fixture.pdf';
    const { copyFile } = await import('node:fs/promises');
    await copyFile(pdf, join(dir, rel));

    // deepseek-flash IS in the pinned DSH catalog with ['text','image'] —
    // capability comes from the catalog, not from the name alone.
    const vision = await runCli(dir, ['paper', 'visual', '--pdf', rel, '--page', '1', '--json'], {
      IDEASEEK_MODEL_FAST: 'deepseek-flash',
    });
    expect(vision.code, vision.stdout + vision.stderr).toBe(0);
    const payload = JSON.parse(vision.stdout) as {
      capability: { supported: boolean; basis: string };
      result: { source: string; attachmentSha256: string | null; model: string | null };
    };
    expect(payload.capability.supported).toBe(true);
    expect(payload.capability.basis).toBe('pinned-dsh-catalog');
    expect(payload.result.source).toBe('vision');
    expect(payload.result.attachmentSha256).toMatch(/^sha256:/);
    expect(payload.result.model).toBe('fake-model');
  }, 120_000);

  it('real DSH vision turn with an image-capable route (keyed; self-skips)', async () => {
    if (!process.env.DEEPSEEK_API_KEY) return; // contract covered by fake tests
    const dir = await makeProjectDir();
    const { pdf } = await fixturePdf();
    const rel = 'papers/vision-fixture.pdf';
    const { copyFile } = await import('node:fs/promises');
    await copyFile(pdf, join(dir, rel));

    // deepseek-flash is image-capable in the pinned DSH catalog — the
    // ONLY model id this test will send pixels to.
    const vision = await runCli(
      dir,
      ['paper', 'visual', '--pdf', rel, '--page', '1', '--harness', 'dsh', '--json'],
      { IDEASEEK_MODEL_FAST: 'deepseek-flash' },
      240_000,
    );
    expect(vision.code, vision.stdout + vision.stderr).toBe(0);
    const payload = JSON.parse(vision.stdout) as {
      capability: { supported: boolean };
      result: {
        source: string;
        model: string | null;
        caption: string;
        attachmentSha256: string | null;
      };
    };
    expect(payload.capability.supported).toBe(true);
    expect(payload.result.source).toBe('vision');
    expect(payload.result.model).toBeTruthy();
    expect(payload.result.model).not.toBe('fake-model');
    expect(payload.result.attachmentSha256).toMatch(/^sha256:/);
    expect(payload.result.caption.length).toBeGreaterThan(0);
  }, 300_000);

  it('rejects a missing PDF and an invalid page', async () => {
    const dir = await makeProjectDir();
    const missing = await runCli(dir, [
      'paper',
      'visual',
      '--pdf',
      'papers/nope.pdf',
      '--page',
      '1',
    ]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('PDF not found');
    const badPage = await runCli(dir, ['paper', 'visual', '--pdf', 'papers/x.pdf', '--page', '0']);
    expect(badPage.code).not.toBe(0);
    expect(badPage.stderr).toContain('--page');
  }, 60_000);
});
