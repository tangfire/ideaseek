import { mkdtemp, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISCOVERY_SCHEMA, type DatasetCandidate } from '../src/knowledge/dataset-discovery.js';
import { CLI_BIN } from './helpers.js';

/**
 * `ideaseek datasets acquire` policy gates (docs/MODES.md §Full Research).
 * The fetch itself is covered in tests/dataset-acquire.test.ts with an injected
 * transport; nothing here reaches the network — the one case that would is
 * aimed at a closed loopback port on purpose.
 */

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
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

function makeCandidate(overrides: Partial<DatasetCandidate> = {}): DatasetCandidate {
  return {
    candidateId: 'ds-pacs',
    name: 'PACS',
    status: 'recommended',
    task: 'federated domain generalization image classification',
    unit: 'image',
    scale: '9991 images',
    license: { value: 'unknown', confidence: 0.4, note: 'no license stated' },
    access: {
      acquisition: 'public-download',
      restricted: false,
      size: 'small',
      url: 'https://127.0.0.1:1/PACS.zip?sig=SECRET-TOKEN',
      indexId: null,
      instructions: 'download the archive',
    },
    relatedPapers: [],
    relevance: { question: 'fdg', reason: 'standard benchmark' },
    confidence: 0.8,
    confidenceBasis: ['paper table'],
    evidenceIds: [],
    local: null,
    downloadStatus: 'proposed',
    authorization: { state: 'none', decidedBy: null, decidedAt: null, reason: null },
    discoveredAt: 1000,
    notes: [],
    ...overrides,
  };
}

async function project(candidates: DatasetCandidate[], allowNetwork = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-acquire-cli-'));
  const init = await runCli(dir, ['init']);
  expect(init.code, init.stderr).toBe(0);
  await writeFile(
    join(dir, 'research.yaml'),
    [
      'config_version: 1',
      'project:',
      '  name: acquire-test',
      'runtime:',
      `  allow_network: ${allowNetwork}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(dir, 'knowledge', 'dataset-candidates.json'),
    JSON.stringify(
      {
        contract: DISCOVERY_SCHEMA,
        generatedAt: 1000,
        inputHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        mode: 'deterministic',
        harnessRuntime: null,
        question: 'fdg',
        sources: [],
        evidence: [],
        candidates,
        incompleteSources: false,
        notes: [],
      },
      null,
      2,
    ),
    'utf8',
  );
  return dir;
}

const granted = {
  authorization: { state: 'granted' as const, decidedBy: 'researcher', decidedAt: 1, reason: null },
  downloadStatus: 'authorized' as const,
};

describe('ideaseek datasets acquire (gates)', () => {
  it('refuses an ungranted candidate and names the authorize command', async () => {
    const dir = await project([makeCandidate()]);
    const result = await runCli(dir, ['datasets', 'acquire', 'ds-pacs']);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('is not granted');
    expect(result.stderr + result.stdout).toContain('datasets authorize ds-pacs --grant');
  });

  it('refuses non-download acquisition and repeats the recorded instructions', async () => {
    const dir = await project([
      makeCandidate({
        ...granted,
        access: {
          ...makeCandidate().access,
          acquisition: 'registration',
          url: null,
          instructions: 'register at the project site, then request the file',
        },
      }),
    ]);
    const result = await runCli(dir, ['datasets', 'acquire', 'ds-pacs']);
    expect(result.stderr + result.stdout).toContain('not a public download');
    expect(result.stderr + result.stdout).toContain('register at the project site');
  });

  it('refuses a candidate that already has data', async () => {
    const dir = await project([
      makeCandidate({
        ...granted,
        downloadStatus: 'local-present',
        local: { path: 'datasets/pacs', sha256: null, datasetSnapshotId: null },
      }),
    ]);
    const result = await runCli(dir, ['datasets', 'acquire', 'ds-pacs']);
    expect(result.stderr + result.stdout).toContain('already has data');
  });

  it('refuses while runtime.allow_network is false', async () => {
    const dir = await project([makeCandidate(granted)], false);
    const result = await runCli(dir, ['datasets', 'acquire', 'ds-pacs']);
    expect(result.stderr + result.stdout).toContain('allow_network is false');
  });

  it('rejects a nonsense --max-gib before any request', async () => {
    const dir = await project([makeCandidate(granted)]);
    const result = await runCli(dir, ['datasets', 'acquire', 'ds-pacs', '--max-gib', '0']);
    expect(result.stderr + result.stdout).toContain('--max-gib');
  });

  it('fails cleanly when the endpoint is unreachable, leaving nothing staged', async () => {
    const dir = await project([makeCandidate(granted)]);
    const result = await runCli(dir, ['datasets', 'acquire', 'ds-pacs', '--timeout-ms', '3000']);
    expect(result.code).not.toBe(0);
    expect(
      await readFile(join(dir, 'knowledge', 'dataset-acquisitions.json'), 'utf8').catch(() => ''),
    ).toBe('');
    expect(await stat(join(dir, 'datasets', 'PACS.zip')).catch(() => null)).toBeNull();
    expect(await stat(join(dir, 'datasets', 'PACS.zip.part')).catch(() => null)).toBeNull();
  });

  it('never echoes a signed-url token into CLI output', async () => {
    const dir = await project([makeCandidate(granted)]);
    const result = await runCli(dir, ['datasets', 'acquire', 'ds-pacs', '--timeout-ms', '3000']);
    const all = result.stdout + result.stderr;
    expect(all).not.toContain('SECRET-TOKEN');
    expect(all).not.toContain('sig=');
  });

  it('requires --confirm for a large dataset under guided autonomy', async () => {
    const dir = await project([
      makeCandidate({ ...granted, access: { ...makeCandidate().access, size: 'large' } }),
    ]);
    const result = await runCli(dir, ['datasets', 'acquire', 'ds-pacs', '--timeout-ms', '3000']);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/confirm/i);
  });

  it('passes the leftover .part gate only with --resume', async () => {
    const dir = await project([makeCandidate(granted)]);
    await writeFile(join(dir, 'datasets', 'PACS.zip.part'), 'x', 'utf8');
    const blocked = await runCli(dir, ['datasets', 'acquire', 'ds-pacs', '--timeout-ms', '3000']);
    expect(blocked.stderr + blocked.stdout).toContain('leftover partial');
    const resumed = await runCli(dir, [
      'datasets',
      'acquire',
      'ds-pacs',
      '--timeout-ms',
      '3000',
      '--resume',
    ]);
    expect(resumed.code).not.toBe(0);
    // Past the gate it fails at the closed loopback endpoint, not on the .part.
    expect(resumed.stderr + resumed.stdout).not.toContain('leftover partial');
  });
});

describe('ideaseek datasets link: acquisition-ledger hashes', () => {
  const sha = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

  async function writeLedger(dir: string, records: Record<string, unknown>[]): Promise<void> {
    await writeFile(
      join(dir, 'knowledge', 'dataset-acquisitions.json'),
      JSON.stringify({ schemaVersion: 1, records }, null, 2),
      'utf8',
    );
  }

  it('links with the hash the acquisition already established', async () => {
    const dir = await project([makeCandidate(granted)]);
    const rel = 'datasets/pacs-small.csv';
    const payload = 'domain,label\nA,1\nB,0\n';
    await writeFile(join(dir, rel), payload, 'utf8');
    await writeLedger(dir, [
      {
        candidateId: 'ds-pacs',
        name: 'PACS',
        relPath: rel,
        sha256: sha(payload),
        bytes: Buffer.byteLength(payload),
        sourceUrl: 'https://x.test/PACS.zip',
        at: 1,
      },
    ]);
    const result = await runCli(dir, ['datasets', 'link', 'ds-pacs', '--path', rel, '--json']);
    expect(result.code, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout.trim().split('\n').pop() as string);
    expect(out.local.sha256).toBe(sha(payload));
    expect(out.local.datasetSnapshotId).toBe(`data-${sha(payload).slice(7, 19)}`);
  });

  it('links a file above the inline-hash limit when the ledger size matches', async () => {
    const dir = await project([makeCandidate(granted)]);
    const rel = 'datasets/pacs-big.parquet';
    const size = 270 * 1024 * 1024;
    // Sparse on purpose: link checks the recorded size, it never reads bytes.
    await writeFile(join(dir, rel), '');
    await truncate(join(dir, rel), size);
    await writeLedger(dir, [
      {
        candidateId: 'ds-pacs',
        name: 'PACS',
        relPath: rel,
        sha256: `sha256:${'a'.repeat(64)}`,
        bytes: size,
        sourceUrl: 'https://x.test/PACS.parquet',
        at: 1,
      },
    ]);
    const result = await runCli(dir, ['datasets', 'link', 'ds-pacs', '--path', rel]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`snapshot=data-${'a'.repeat(12)}`);
  });

  it('refuses the ledger hash once the file no longer matches its recorded size', async () => {
    const dir = await project([makeCandidate(granted)]);
    const rel = 'datasets/pacs-big.parquet';
    const size = 270 * 1024 * 1024;
    await writeFile(join(dir, rel), '');
    await truncate(join(dir, rel), size);
    await writeLedger(dir, [
      {
        candidateId: 'ds-pacs',
        name: 'PACS',
        relPath: rel,
        sha256: `sha256:${'a'.repeat(64)}`,
        bytes: size - 1,
        sourceUrl: 'https://x.test/PACS.parquet',
        at: 1,
      },
    ]);
    const result = await runCli(dir, ['datasets', 'link', 'ds-pacs', '--path', rel]);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('without a scan hash');
  });
});
