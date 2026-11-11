import { mkdtemp, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_PARSER_VERSION,
  assessArchiveMembers,
  DEFAULT_ARCHIVE_LIMITS,
  detectArchiveFormat,
  mergeArchiveLimits,
  normalizeMemberPath,
  scanArchive,
  type ArchiveMember,
} from '../src/knowledge/archive.js';
import {
  defaultArchiveExtractRoot,
  extractArchive,
  recoverArchiveExtractions,
} from '../src/knowledge/archive-extract.js';
import { buildTar, buildTarGz, buildZip } from './archive-builders.js';
import { isIdeaseekError } from '../src/core/errors.js';

async function makeDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), name));
}

async function writeArchive(dir: string, name: string, data: Buffer | string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

function member(overrides: Partial<ArchiveMember> & { path: string }): ArchiveMember {
  return {
    rawPath: overrides.rawPath ?? overrides.path,
    kind: overrides.kind ?? 'file',
    size: overrides.size ?? 0,
    compressedSize: overrides.compressedSize ?? overrides.size ?? 0,
    encrypted: overrides.encrypted ?? false,
    safe: true,
    ...overrides,
  };
}

describe('detectArchiveFormat', () => {
  it('prefers magic over extension and reports unsupported formats honestly', () => {
    const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    expect(detectArchiveFormat(zipMagic, 'anything.dat').format).toBe('zip');
    const gzipMagic = Buffer.from([0x1f, 0x8b, 0x08, 0]);
    expect(detectArchiveFormat(gzipMagic, 'bundle.tgz').format).toBe('gzip');
    expect(detectArchiveFormat(Buffer.from('plain text here'), 'notes.txt').format).toBe('unknown');
    const sevenZ = detectArchiveFormat(Buffer.from('7z¼¯' + 'x'), 'archive.7z');
    expect(sevenZ.format).toBe('unknown');
    expect(sevenZ.detail).toContain('.7z');
    expect(detectArchiveFormat(Buffer.alloc(0), 'empty.bin').format).toBe('unknown');
  });

  it('falls back to the extension when magic is absent', () => {
    expect(detectArchiveFormat(Buffer.from('not a real zip'), 'old.zip').format).toBe('zip');
    expect(detectArchiveFormat(Buffer.from('no magic'), 'data.tar').format).toBe('tar');
    expect(detectArchiveFormat(Buffer.from('no magic'), 'data.tar.gz').format).toBe('gzip');
  });
});

describe('normalizeMemberPath / assessArchiveMembers (pure safety matrix)', () => {
  it('normalizes separators without hiding traversal or absolute paths', () => {
    expect(normalizeMemberPath('./a/b.txt')).toBe('a/b.txt');
    expect(normalizeMemberPath('a\\b\\c.txt')).toBe('a/b/c.txt');
    expect(normalizeMemberPath('dir/')).toBe('dir');
    expect(normalizeMemberPath('../evil.txt')).toBe('../evil.txt');
    expect(normalizeMemberPath('C:\\Windows\\evil')).toBe('C:/Windows/evil');
    expect(normalizeMemberPath('/etc/passwd')).toBe('/etc/passwd');
    expect(normalizeMemberPath('./')).toBe('');
  });

  const limits = mergeArchiveLimits({ maxDepth: 3, maxMemberBytes: 1000, maxTotalBytes: 2000 });

  it('flags absolute paths, traversal, escaping links, depth and size', () => {
    const violations = assessArchiveMembers(
      [
        member({ path: '/etc/passwd', rawPath: '/etc/passwd' }),
        member({ path: '../evil.txt', rawPath: '../evil.txt' }),
        member({ path: 'safe/../../x.txt', rawPath: 'safe/../../x.txt' }),
        member({ path: 'a\\..\\..\\win.txt', rawPath: 'a\\..\\..\\win.txt' }),
        member({ path: 'deep/a/b/c/d.txt', kind: 'file', size: 10 }),
        member({ path: 'big.bin', kind: 'file', size: 5000 }),
        member({ path: 'lnk', kind: 'symlink', linkTarget: '../../outside' }),
        member({ path: 'abs-lnk', kind: 'symlink', linkTarget: '/etc/passwd' }),
        member({ path: 'dev', kind: 'other', typeFlag: '3' }),
      ],
      { totalUncompressedBytes: 100, archiveBytes: 100 },
      limits,
    );
    const reasons = violations.map((violation) => violation.reason);
    expect(reasons).toContain('absolute-path');
    expect(reasons).toContain('path-traversal');
    expect(reasons).toContain('depth-exceeded');
    expect(reasons).toContain('member-size');
    expect(reasons).toContain('dangerous-symlink');
    expect(reasons).toContain('special-file');
  });

  it('allows safe symlinks, in-root links and small paths', () => {
    const violations = assessArchiveMembers(
      [
        member({ path: 'dir/link', kind: 'symlink', linkTarget: 'target.txt' }),
        member({ path: 'dir/up', kind: 'symlink', linkTarget: '../sibling.txt' }),
        member({ path: 'dir/file.txt', kind: 'file', size: 10 }),
        member({ path: 'dir', kind: 'dir' }),
      ],
      { totalUncompressedBytes: 10, archiveBytes: 100 },
      limits,
    );
    expect(violations).toEqual([]);
  });

  it('enforces total size, compression ratio and member count', () => {
    const bombLimits = mergeArchiveLimits({
      maxTotalBytes: 1000,
      maxCompressionRatio: 10,
      ratioFloorBytes: 100,
      maxMembers: 2,
    });
    const violations = assessArchiveMembers(
      [member({ path: 'a', size: 600 }), member({ path: 'b', size: 600 })],
      { totalUncompressedBytes: 1200, archiveBytes: 50 },
      bombLimits,
    );
    const reasons = violations.map((violation) => violation.reason);
    expect(reasons).toContain('total-size');
    expect(reasons).toContain('compression-ratio');

    const capped = assessArchiveMembers(
      [member({ path: 'a', size: 1 })],
      { totalUncompressedBytes: 1, archiveBytes: 100 },
      bombLimits,
      { memberCountCapped: true },
    );
    expect(capped.some((violation) => violation.reason === 'member-count')).toBe(true);
  });

  it('blocks unsupported compression methods but not on encrypted entries', () => {
    const unsupported = assessArchiveMembers(
      [member({ path: 'x', size: 10, method: 12 })],
      { totalUncompressedBytes: 10, archiveBytes: 100 },
      limits,
    );
    expect(unsupported.map((violation) => violation.reason)).toContain('unsupported-compression');
    const encrypted = assessArchiveMembers(
      [member({ path: 'x', size: 10, method: 99, encrypted: true })],
      { totalUncompressedBytes: 10, archiveBytes: 100 },
      limits,
    );
    expect(encrypted).toEqual([]);
  });
});

describe('scanArchive: happy paths', () => {
  it('scans a zip with nested members and records an ArchiveInput', async () => {
    const dir = await makeDir('ideaseek-archive-');
    const path = await writeArchive(
      dir,
      'repo.zip',
      buildZip([
        { name: 'repo/' },
        { name: 'repo/README.md', data: '# hi' },
        { name: 'repo/src/main.py', data: 'print(1)' },
        { name: 'repo/empty.txt', data: '', method: 0 },
      ]),
    );
    const input = await scanArchive(path, { projectRoot: dir, now: 1000 });
    expect(input.status).toBe('ok');
    expect(input.format).toBe('zip');
    expect(input.parserVersion).toBe(ARCHIVE_PARSER_VERSION);
    expect(input.source.relPath).toBe('repo.zip');
    expect(input.source.bytes).toBe((await stat(path)).size);
    expect(input.source.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(input.memberCount).toBe(4);
    expect(input.members.map((m) => m.path).sort()).toEqual([
      'repo',
      'repo/README.md',
      'repo/empty.txt',
      'repo/src/main.py',
    ]);
    expect(input.totalUncompressedBytes).toBe('# hi'.length + 'print(1)'.length);
    expect(input.safety.violations).toEqual([]);
    expect(input.extraction).toBeNull();
    expect(input.issues[0]).toContain('format-detection: magic:zip');
  });

  it('scans tar, tar.gz and tgz with stable content-addressed ids', async () => {
    const dir = await makeDir('ideaseek-archive-');
    const entries = [
      { name: 'proj/', type: 'dir' as const },
      { name: 'proj/train.py', data: 'x = 1' },
      { name: 'proj/data/split.csv', data: 'a,b\n1,2\n' },
    ];
    const tarPath = await writeArchive(dir, 'bundle.tar', buildTar(entries));
    const tgzPath = await writeArchive(dir, 'bundle.tgz', buildTarGz(entries));

    const tar = await scanArchive(tarPath);
    const tgz = await scanArchive(tgzPath);
    expect(tar.status).toBe('ok');
    expect(tar.format).toBe('tar');
    expect(tgz.status).toBe('ok');
    expect(tgz.format).toBe('tar.gz');
    expect(tgz.memberCount).toBe(3);
    expect(tar.members.map((m) => m.path)).toEqual(tgz.members.map((m) => m.path));

    const again = await scanArchive(tarPath);
    expect(again.archiveId).toBe(tar.archiveId);
    expect(tar.archiveId).not.toBe(tgz.archiveId); // different bytes → different id
    expect(tar.archiveId).toMatch(/^arc-[0-9a-f]{16}$/);
  });

  it('scans a single-file gzip and an empty zip', async () => {
    const dir = await makeDir('ideaseek-archive-');
    const gzPath = await writeArchive(dir, 'note.txt.gz', gzipSync(Buffer.from('hello world')));
    const gz = await scanArchive(gzPath);
    expect(gz.status).toBe('ok');
    expect(gz.format).toBe('gzip');
    expect(gz.members).toHaveLength(1);
    expect(gz.members[0]!.path).toBe('note.txt');
    expect(gz.members[0]!.size).toBe('hello world'.length);
    expect(gz.issues).toContain('gzip-single-file');

    const emptyPath = await writeArchive(dir, 'empty.zip', buildZip([]));
    const empty = await scanArchive(emptyPath);
    expect(empty.status).toBe('ok');
    expect(empty.members).toEqual([]);
  });
});

describe('scanArchive: blocked / corrupted / encrypted / unknown', () => {
  it('blocks absolute paths and ../ traversal (zip and tar)', async () => {
    const dir = await makeDir('ideaseek-archive-');
    const zipPath = await writeArchive(
      dir,
      'evil.zip',
      buildZip([
        { name: 'safe.txt', data: 'ok' },
        { name: '/etc/passwd', data: 'root:x' },
        { name: '../outside.txt', data: 'escape' },
        { name: 'nested\\..\\..\\win.txt', data: 'windows-style' },
      ]),
    );
    const zip = await scanArchive(zipPath);
    expect(zip.status).toBe('ARCHIVE_BLOCKED');
    const reasons = zip.safety.violations.map((violation) => violation.reason);
    expect(reasons).toContain('absolute-path');
    expect(reasons).toContain('path-traversal');
    expect(zip.members.find((m) => m.path === 'safe.txt')?.safe).toBe(true);
    expect(zip.members.find((m) => m.path === '/etc/passwd')?.safe).toBe(false);

    const tarPath = await writeArchive(
      dir,
      'evil.tar',
      buildTar([
        { name: '/abs.txt', data: 'x' },
        { name: '../up.txt', data: 'x' },
      ]),
    );
    const tar = await scanArchive(tarPath);
    expect(tar.status).toBe('ARCHIVE_BLOCKED');
    expect(tar.safety.violations.map((v) => v.reason)).toEqual(
      expect.arrayContaining(['absolute-path', 'path-traversal']),
    );
  });

  it('blocks dangerous symlinks and special files but allows safe links', async () => {
    const dir = await makeDir('ideaseek-archive-');
    const evilPath = await writeArchive(
      dir,
      'links.tar',
      buildTar([
        { name: 'escape', type: 'symlink', linkName: '../../outside.txt' },
        { name: 'abs', type: 'symlink', linkName: '/etc/shadow' },
        { name: 'hard', type: 'hardlink', linkName: '../other' },
        { name: 'dev', type: 'chardev' },
        { name: 'pipe', type: 'fifo' },
      ]),
    );
    const evil = await scanArchive(evilPath);
    expect(evil.status).toBe('ARCHIVE_BLOCKED');
    const reasons = evil.safety.violations.map((v) => v.reason);
    expect(reasons).toContain('dangerous-symlink');
    expect(reasons).toContain('dangerous-hardlink');
    expect(reasons).toContain('special-file');

    const safePath = await writeArchive(
      dir,
      'safe-links.tar',
      buildTar([
        { name: 'dir/target.txt', data: 't' },
        { name: 'dir/link', type: 'symlink', linkName: 'target.txt' },
        { name: 'up', type: 'symlink', linkName: 'dir/target.txt' },
      ]),
    );
    const safe = await scanArchive(safePath);
    expect(safe.status).toBe('ok');
    expect(safe.members.find((m) => m.path === 'dir/link')?.linkTarget).toBe('target.txt');
  });

  it('blocks zip bombs by declared total, ratio, member size, count and depth', async () => {
    const dir = await makeDir('ideaseek-archive-');

    const ratioPath = await writeArchive(
      dir,
      'zeros.zip',
      buildZip([{ name: 'zeros.bin', data: Buffer.alloc(200_000, 0) }]),
    );
    const ratio = await scanArchive(ratioPath, {
      limits: { maxCompressionRatio: 50, ratioFloorBytes: 1024 },
    });
    expect(ratio.status).toBe('ARCHIVE_BLOCKED');
    expect(ratio.safety.violations.map((v) => v.reason)).toContain('compression-ratio');

    const sizePath = await writeArchive(
      dir,
      'big-declared.zip',
      buildZip([{ name: 'big.bin', data: Buffer.alloc(4096, 1) }]),
    );
    const memberSize = await scanArchive(sizePath, { limits: { maxMemberBytes: 1024 } });
    expect(memberSize.status).toBe('ARCHIVE_BLOCKED');
    expect(memberSize.safety.violations.map((v) => v.reason)).toContain('member-size');

    const total = await scanArchive(sizePath, { limits: { maxTotalBytes: 100 } });
    expect(total.status).toBe('ARCHIVE_BLOCKED');
    expect(total.safety.violations.map((v) => v.reason)).toContain('total-size');

    const manyPath = await writeArchive(
      dir,
      'many.zip',
      buildZip([
        { name: 'a.txt', data: '1' },
        { name: 'b.txt', data: '2' },
        { name: 'c.txt', data: '3' },
        { name: 'd.txt', data: '4' },
      ]),
    );
    const many = await scanArchive(manyPath, { limits: { maxMembers: 2 } });
    expect(many.status).toBe('ARCHIVE_BLOCKED');
    expect(many.safety.violations.map((v) => v.reason)).toContain('member-count');
    expect(many.memberCount).toBeLessThanOrEqual(2);

    const deepPath = await writeArchive(
      dir,
      'deep.zip',
      buildZip([{ name: 'a/b/c/d/e/f.txt', data: 'deep' }]),
    );
    const deep = await scanArchive(deepPath, { limits: { maxDepth: 3 } });
    expect(deep.status).toBe('ARCHIVE_BLOCKED');
    expect(deep.safety.violations.map((v) => v.reason)).toContain('depth-exceeded');

    const bombPath = await writeArchive(dir, 'bomb.txt.gz', gzipSync(Buffer.alloc(1_000_000, 0)));
    // Compressed size stays under the cap so the streaming decompression
    // ceiling (not the file-size check) is what blocks the bomb.
    const bomb = await scanArchive(bombPath, { limits: { maxTotalBytes: 5000 } });
    expect(bomb.status).toBe('ARCHIVE_BLOCKED');
    expect(bomb.safety.violations.map((v) => v.reason)).toContain('decompressed-size');
  });

  it('reports corrupted archives without throwing', async () => {
    const dir = await makeDir('ideaseek-archive-');

    const goodZip = buildZip([{ name: 'a.txt', data: 'hello' }]);
    const truncatedPath = await writeArchive(
      dir,
      'truncated.zip',
      goodZip.subarray(0, goodZip.length - 40),
    );
    const truncated = await scanArchive(truncatedPath);
    expect(truncated.status).toBe('corrupted');
    expect(truncated.issues.join(' ')).toContain('corrupt:');

    const textZipPath = await writeArchive(
      dir,
      'text.zip',
      'this is definitely not a zip file at all',
    );
    const textZip = await scanArchive(textZipPath);
    expect(textZip.status).toBe('corrupted');

    const badTarPath = await writeArchive(
      dir,
      'bad.tar',
      buildTar([{ name: 'x.txt', data: 'x', badChecksum: true }]),
    );
    const badTar = await scanArchive(badTarPath);
    expect(badTar.status).toBe('corrupted');
    expect(badTar.issues.join(' ')).toContain('tar-checksum');

    const lyingPath = await writeArchive(
      dir,
      'lying.tar',
      buildTar([{ name: 'x.txt', data: 'short', declaredSizeOverride: 10_000 }], { omitEof: true }),
    );
    const lying = await scanArchive(lyingPath);
    expect(lying.status).toBe('corrupted');

    const notTarGzPath = await writeArchive(
      dir,
      'fake.tgz',
      gzipSync(Buffer.from('just text, not a tar')),
    );
    const notTarGz = await scanArchive(notTarGzPath);
    expect(notTarGz.status).toBe('corrupted');
    expect(notTarGz.issues.join(' ')).toContain('gzip-payload-not-tar');
  });

  it('reports encrypted archives and unknown formats', async () => {
    const dir = await makeDir('ideaseek-archive-');
    const encryptedPath = await writeArchive(
      dir,
      'secret.zip',
      buildZip([
        { name: 'plain.txt', data: 'visible name' },
        { name: 'locked.txt', data: 'pretend encrypted', encrypted: true },
      ]),
    );
    const encrypted = await scanArchive(encryptedPath);
    expect(encrypted.status).toBe('encrypted');
    expect(encrypted.safety.violations).toEqual([]);
    expect(encrypted.members.find((m) => m.path === 'locked.txt')?.encrypted).toBe(true);

    const mysteryPath = await writeArchive(
      dir,
      'mystery.bin',
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    );
    const mystery = await scanArchive(mysteryPath);
    expect(mystery.status).toBe('unknown-format');
    expect(mystery.format).toBe('unknown');
    expect(mystery.issues.join(' ')).toContain('no-magic');

    const sevenPath = await writeArchive(dir, 'archive.7z', 'not really 7z content');
    const seven = await scanArchive(sevenPath);
    expect(seven.status).toBe('unknown-format');
    expect(seven.issues.join(' ')).toContain('format-unsupported:.7z');
  });

  it('throws FILE_NOT_FOUND for a missing archive', async () => {
    await expect(scanArchive(join(tmpdir(), 'definitely-missing-xyz.zip'))).rejects.toThrow(
      /archive not found/,
    );
  });
});

describe('extractArchive: isolation, idempotency and recovery', () => {
  async function extractFixture(): Promise<{
    archivePath: string;
    extractRoot: string;
    projectDir: string;
  }> {
    const projectDir = await makeDir('ideaseek-extract-');
    const archivePath = await writeArchive(
      projectDir,
      'repo.zip',
      buildZip([
        { name: 'repo/' },
        { name: 'repo/README.md', data: '# Extracted repo' },
        { name: 'repo/src/main.py', data: 'print("hi")' },
        { name: 'repo/data.csv', data: 'a,b\n1,2\n', method: 0 },
        { name: 'repo/lnk', unixMode: 0o120777, data: 'src/main.py' },
      ]),
    );
    const extractRoot = defaultArchiveExtractRoot(projectDir);
    return { archivePath, extractRoot, projectDir };
  }

  it('extracts into an isolated directory and leaves the original untouched', async () => {
    const { archivePath, extractRoot, projectDir } = await extractFixture();
    const before = await stat(archivePath);
    const beforeSha = (await readFile(archivePath)).toString('base64');

    const scanned = await scanArchive(archivePath, { projectRoot: projectDir });
    const extracted = await extractArchive(scanned, { extractRoot, now: 2000 });

    expect(extracted.extraction).not.toBeNull();
    expect(extracted.extraction!.reused).toBe(false);
    expect(extracted.extraction!.dir).toBe(join(extractRoot, scanned.archiveId));
    expect(extracted.extraction!.files).toBe(3); // symlink recorded, not materialized
    expect(extracted.extraction!.skippedLinks).toEqual([
      { path: 'repo/lnk', kind: 'symlink', target: 'src/main.py' },
    ]);

    const mainPy = await readFile(
      join(extracted.extraction!.dir, 'repo', 'src', 'main.py'),
      'utf8',
    );
    expect(mainPy).toBe('print("hi")');
    const csv = await readFile(join(extracted.extraction!.dir, 'repo', 'data.csv'), 'utf8');
    expect(csv).toBe('a,b\n1,2\n');

    // Original archive is read-only: same bytes, same mtime.
    const after = await stat(archivePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await readFile(archivePath)).toString('base64')).toBe(beforeSha);

    // Manifest lives beside the tree, not inside it.
    const manifestRaw = await readFile(extracted.extraction!.manifestPath, 'utf8');
    expect(JSON.parse(manifestRaw).rootHash).toBe(extracted.extraction!.rootHash);
    const extractedEntries = await readdir(extracted.extraction!.dir);
    expect(extractedEntries).not.toContain('.ideaseek-extract.json');
    expect(extractedEntries.sort()).toEqual(['repo']);
  });

  it('is idempotent: a verified extraction is reused, a tampered one is rebuilt', async () => {
    const { archivePath, extractRoot } = await extractFixture();
    const scanned = await scanArchive(archivePath);
    const first = await extractArchive(scanned, { extractRoot, now: 2000 });
    const mainPath = join(first.extraction!.dir, 'repo', 'src', 'main.py');

    const second = await extractArchive(scanned, { extractRoot, now: 3000 });
    expect(second.extraction!.reused).toBe(true);
    expect(second.extraction!.rootHash).toBe(first.extraction!.rootHash);

    // Tamper with the extracted tree → reuse fails, extraction is rebuilt.
    await writeFile(mainPath, 'TAMPERED');
    await utimes(mainPath, new Date(0), new Date(0));
    const third = await extractArchive(scanned, { extractRoot, now: 4000 });
    expect(third.extraction!.reused).toBe(false);
    expect(await readFile(mainPath, 'utf8')).toBe('print("hi")');
  });

  it('refuses extraction when the archive changed after scanning', async () => {
    const { archivePath, extractRoot } = await extractFixture();
    const scanned = await scanArchive(archivePath);
    await writeFile(
      archivePath,
      Buffer.concat([Buffer.from(await readFile(archivePath)), Buffer.from('x')]),
    );
    try {
      await extractArchive(scanned, { extractRoot });
      expect.unreachable('extraction should have refused the changed archive');
    } catch (error) {
      expect(isIdeaseekError(error)).toBe(true);
      if (isIdeaseekError(error)) expect(error.code).toBe('OUTPUT_HASH_MISMATCH');
    }
  });

  it('refuses to extract blocked/corrupted/encrypted/unknown archives', async () => {
    const dir = await makeDir('ideaseek-extract-');
    const extractRoot = join(dir, 'extracts');
    const cases: [string, Buffer][] = [
      ['blocked.zip', buildZip([{ name: '/abs.txt', data: 'x' }])],
      ['corrupt.zip', Buffer.from('not a zip at all, really')],
      ['locked.zip', buildZip([{ name: 'a.txt', data: 'x', encrypted: true }])],
      ['mystery.bin', Buffer.from('mystery')],
    ];
    for (const [name, bytes] of cases) {
      const path = await writeArchive(dir, name, bytes);
      const scanned = await scanArchive(path);
      expect(scanned.status).not.toBe('ok');
      try {
        await extractArchive(scanned, { extractRoot });
        expect.unreachable(`extraction should refuse ${name}`);
      } catch (error) {
        expect(isIdeaseekError(error)).toBe(true);
        if (isIdeaseekError(error)) {
          expect(error.code).toBe('INVALID_ARGUMENT');
          expect(error.details?.status).toBe(scanned.status);
        }
      }
    }
    // Nothing was written for refused archives.
    await expect(readdir(extractRoot)).rejects.toThrow();
  });

  it('recovers from crash leftovers: temps, partial dirs and orphan manifests', async () => {
    const extractRoot = await makeDir('ideaseek-recover-');

    // Stale temp from a crashed extraction.
    await mkdir(join(extractRoot, '.tmp-arc-deadbeef-uuid'), { recursive: true });
    await writeFile(join(extractRoot, '.tmp-arc-deadbeef-uuid', 'partial.txt'), 'x');

    // Final dir renamed but manifest never written (crash window).
    await mkdir(join(extractRoot, 'arc-partial'), { recursive: true });
    await writeFile(join(extractRoot, 'arc-partial', 'half.txt'), 'x');

    // Manifest whose directory is gone.
    await writeFile(
      join(extractRoot, 'arc-orphan.extract.json'),
      JSON.stringify({ manifestVersion: 1, archiveId: 'arc-orphan' }),
    );

    // Intact extraction.
    await mkdir(join(extractRoot, 'arc-ok'), { recursive: true });
    await writeFile(join(extractRoot, 'arc-ok', 'file.txt'), 'ok');
    await writeFile(
      join(extractRoot, 'arc-ok.extract.json'),
      JSON.stringify({ manifestVersion: 1, archiveId: 'arc-ok', files: [] }),
    );

    const result = await recoverArchiveExtractions(extractRoot);
    expect(result.removedTemps).toHaveLength(1);
    expect(result.removedPartials).toEqual([join(extractRoot, 'arc-partial')]);
    expect(result.removedOrphans).toEqual([join(extractRoot, 'arc-orphan.extract.json')]);
    expect(result.intact).toEqual([join(extractRoot, 'arc-ok')]);

    const remaining = (await readdir(extractRoot)).sort();
    expect(remaining).toEqual(['arc-ok', 'arc-ok.extract.json'].sort());

    // Recovery on a missing root is a no-op.
    const missing = await recoverArchiveExtractions(join(extractRoot, 'does-not-exist'));
    expect(missing).toEqual({
      removedTemps: [],
      removedPartials: [],
      removedOrphans: [],
      intact: [],
    });
  });

  it('re-extracts after a crash left a directory without its manifest', async () => {
    const { archivePath, extractRoot } = await extractFixture();
    const scanned = await scanArchive(archivePath);

    // Simulate crash-after-rename: dir exists, manifest missing.
    const finalDir = join(extractRoot, scanned.archiveId);
    await mkdir(finalDir, { recursive: true });
    await writeFile(join(finalDir, 'half-written.txt'), 'incomplete');

    const recovered = await extractArchive(scanned, { extractRoot, now: 5000 });
    expect(recovered.extraction!.reused).toBe(false);
    expect(await readFile(join(finalDir, 'repo', 'README.md'), 'utf8')).toBe('# Extracted repo');
    const entries = await readdir(finalDir);
    expect(entries).not.toContain('half-written.txt');
  });

  it('keeps extraction under the provided isolated root', async () => {
    const { archivePath, extractRoot, projectDir } = await extractFixture();
    const scanned = await scanArchive(archivePath, { projectRoot: projectDir });
    const extracted = await extractArchive(scanned, { extractRoot });
    const dir = extracted.extraction!.dir;
    expect(dir.startsWith(extractRoot)).toBe(true);
    expect(dir).toContain(scanned.archiveId);
    // Isolated from user input directories.
    expect(dir.includes('/papers/')).toBe(false);
    expect(dir.includes('/incoming/')).toBe(false);
  });
});

describe('defaults', () => {
  it('exposes stable default limits', () => {
    expect(DEFAULT_ARCHIVE_LIMITS.maxMembers).toBe(50_000);
    expect(DEFAULT_ARCHIVE_LIMITS.maxDepth).toBe(24);
    expect(mergeArchiveLimits({ maxDepth: 5 })).toEqual({ ...DEFAULT_ARCHIVE_LIMITS, maxDepth: 5 });
  });
});
