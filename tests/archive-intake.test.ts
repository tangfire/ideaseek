import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';
import { buildZip } from './archive-builders.js';

/**
 * Archive intake wiring (CLI_SPEC scan/intake 压缩包): scan inspects every
 * archive into the manifest (members + safety status), intake shows them
 * with a concrete next step, and `intake --extract` safely extracts only
 * status=ok archives into the isolated platform root — blocked, corrupted,
 * encrypted and unknown-format archives are refused with exit 2 and the
 * original file is never touched.
 */

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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface ManifestFileArchive {
  relPath: string;
  role: string;
  sha256: string | null;
  archive?: {
    status: string;
    format: string;
    memberCount: number;
    blockReason: string | null;
    extraction: { dir: string; fileCount: number; rootHash: string; reused: boolean } | null;
  };
}

async function readManifestFiles(dir: string): Promise<ManifestFileArchive[]> {
  const raw = await readFile(join(dir, 'knowledge', 'input-manifest.json'), 'utf8');
  return (JSON.parse(raw) as { files: ManifestFileArchive[] }).files;
}

describe('archive scan / intake / extract wiring', () => {
  it('scan records member manifests and safety statuses for every archive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-arc-scan-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);

    await writeFile(
      join(dir, 'incoming', 'good.zip'),
      buildZip([
        { name: 'readme.txt', data: 'hello archive' },
        { name: 'nested/data.csv', data: 'a,b\n1,2\n' },
      ]),
    );
    await writeFile(
      join(dir, 'incoming', 'evil.zip'),
      buildZip([{ name: '../escape.txt', data: 'x' }]),
    );
    // Wrong magic for a .7z name → unknown-format, never silently accepted.
    await writeFile(join(dir, 'incoming', 'fake.7z'), Buffer.from('not-a-7z-archive'));

    expect((await runCli(dir, ['scan'])).code).toBe(0);
    const files = await readManifestFiles(dir);
    const good = files.find((file) => file.relPath === 'incoming/good.zip')!;
    const evil = files.find((file) => file.relPath === 'incoming/evil.zip')!;
    const fake = files.find((file) => file.relPath === 'incoming/fake.7z')!;

    expect(good.role).toBe('archive');
    expect(good.archive).toMatchObject({ status: 'ok', format: 'zip', memberCount: 2 });
    expect(evil.archive).toMatchObject({ status: 'ARCHIVE_BLOCKED' });
    expect(evil.archive!.blockReason).toBe('path-traversal');
    expect(fake.archive).toMatchObject({ status: 'unknown-format' });
    expect(fake.archive!.memberCount).toBe(0);
  }, 60_000);

  it('intake lists archives with statuses and a concrete next step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-arc-intake-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    await writeFile(join(dir, 'incoming', 'good.zip'), buildZip([{ name: 'a.txt', data: 'aaa' }]));
    await writeFile(join(dir, 'incoming', 'evil.zip'), buildZip([{ name: '../x', data: 'x' }]));
    expect((await runCli(dir, ['scan'])).code).toBe(0);

    const text = await runCli(dir, ['intake']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('[ok] incoming/good.zip');
    expect(text.stdout).toContain('incoming/good.zip  zip · 1 members');
    expect(text.stdout).toContain('[ARCHIVE_BLOCKED] incoming/evil.zip');
    expect(text.stdout).toContain('unsafe members refused');
    expect(text.stdout).toContain('ideaseek intake --extract <path>');

    const json = await runCli(dir, ['intake', '--json']);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      archives: { relPath: string; status: string }[];
    };
    expect(payload.archives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relPath: 'incoming/good.zip', status: 'ok' }),
        expect.objectContaining({ relPath: 'incoming/evil.zip', status: 'ARCHIVE_BLOCKED' }),
      ]),
    );
  }, 60_000);

  it('intake --extract extracts a safe archive idempotently and records it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-arc-extract-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    await writeFile(
      join(dir, 'incoming', 'good.zip'),
      buildZip([
        { name: 'a.txt', data: 'aaa' },
        { name: 'sub/b.txt', data: 'bbb' },
      ]),
    );
    expect((await runCli(dir, ['scan'])).code).toBe(0);

    const first = await runCli(dir, ['intake', '--extract', 'incoming/good.zip']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('extracted incoming/good.zip: 2 file(s)');
    expect(first.stdout).toContain('rootHash: sha256:');
    expect(first.stdout).toContain('original archive untouched');

    const files = await readManifestFiles(dir);
    const good = files.find((file) => file.relPath === 'incoming/good.zip')!;
    const extraction = good.archive!.extraction!;
    expect(extraction.fileCount).toBe(2);
    expect(extraction.reused).toBe(false);
    expect(await exists(join(extraction.dir, 'a.txt'))).toBe(true);
    expect(await exists(join(extraction.dir, 'sub', 'b.txt'))).toBe(true);

    // Idempotent: a second extract reuses the verified tree.
    const second = await runCli(dir, ['intake', '--extract', 'incoming/good.zip']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('reused verified extraction');
    const after = await readManifestFiles(dir);
    expect(
      after.find((file) => file.relPath === 'incoming/good.zip')!.archive!.extraction!.reused,
    ).toBe(true);

    // The platform extract root holds only managed content.
    const extractRoot = join(dir, '.research', 'archive-extracts');
    const entries = await readdir(extractRoot);
    expect(entries.some((name) => name.endsWith('.extract.json'))).toBe(true);
  }, 60_000);

  it('refuses blocked archives with exit 2, a next step and zero extraction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-arc-blocked-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const evilBytes = buildZip([{ name: '../../escape.txt', data: 'x' }]);
    await writeFile(join(dir, 'incoming', 'evil.zip'), evilBytes);
    expect((await runCli(dir, ['scan'])).code).toBe(0);

    const refused = await runCli(dir, ['intake', '--extract', 'incoming/evil.zip']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('ARCHIVE_BLOCKED');
    expect(refused.stderr).toContain('fix or remove the archive');

    // Nothing was extracted; the original bytes are untouched.
    const extractRoot = join(dir, '.research', 'archive-extracts');
    const entries = (await exists(extractRoot)) ? await readdir(extractRoot) : [];
    expect(entries.filter((name) => !name.startsWith('.'))).toEqual([]);
    expect(await readFile(join(dir, 'incoming', 'evil.zip'))).toEqual(evilBytes);
  }, 60_000);

  it('refuses non-archives and unknown formats with actionable errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-arc-unknown-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    await writeFile(join(dir, 'incoming', 'paper.pdf'), '%PDF-1.4');
    await writeFile(join(dir, 'incoming', 'weird.7z'), Buffer.from('nope'));
    expect((await runCli(dir, ['scan'])).code).toBe(0);

    const notArchive = await runCli(dir, ['intake', '--extract', 'incoming/paper.pdf']);
    expect(notArchive.code).toBe(2);
    expect(notArchive.stderr).toContain('not a scanned archive');

    const unknown = await runCli(dir, ['intake', '--extract', 'incoming/weird.7z']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('status=unknown-format');
    expect(unknown.stderr).toContain('convert to zip / tar / tar.gz');
  }, 60_000);
});
