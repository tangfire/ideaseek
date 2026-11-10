import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
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

describe('scan / intake / organize CLI', () => {
  it('scan → intake → organize --apply preserves originals and is idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-inputs-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);

    // User drops mixed material into the entry directories.
    await writeFile(join(dir, 'papers', 'alpha.pdf'), '%PDF-1.4 alpha');
    await writeFile(join(dir, 'papers', 'alpha.zip'), '%PDF-1.4 alpha');
    await mkdir(join(dir, 'datasets', 'd1'), { recursive: true });
    await writeFile(join(dir, 'datasets', 'd1', 'train.csv'), 'a,b\n1,2\n');
    await mkdir(join(dir, 'comparisons', 'method-a'), { recursive: true });
    await writeFile(join(dir, 'comparisons', 'method-a', 'README.md'), '# method a');
    await writeFile(join(dir, 'incoming', 'mystery.xyz'), '???');
    // Files the scan must never touch or read:
    await writeFile(join(dir, '.research', 'private.pdf'), 'do not scan');
    await mkdir(join(dir, 'ideas', 'idea-001'), { recursive: true });
    await writeFile(join(dir, 'ideas', 'idea-001', 'draft.md'), 'do not scan');

    const scan = await runCli(dir, ['scan', '--json']);
    expect(scan.code).toBe(0);
    const scanPayload = JSON.parse(scan.stdout) as {
      files: number;
      groups: number;
      duplicates: number;
      byRole: Record<string, number>;
      manifest: string;
      reusedHashes: number;
    };
    expect(scanPayload.files).toBe(5);
    expect(scanPayload.duplicates).toBe(1);
    expect(scanPayload.byRole.paper).toBe(1);
    expect(scanPayload.byRole.data).toBe(1);
    expect(scanPayload.groups).toBeGreaterThanOrEqual(4);
    expect(scanPayload.reusedHashes).toBe(0);

    const manifestRaw = await readFile(scanPayload.manifest, 'utf8');
    expect(manifestRaw).not.toContain('private.pdf');
    expect(manifestRaw).not.toContain('draft.md');

    // Rescan: hashes are reused for unchanged files.
    const rescan = await runCli(dir, ['scan', '--json']);
    expect(rescan.code).toBe(0);
    expect((JSON.parse(rescan.stdout) as { reusedHashes: number }).reusedHashes).toBe(5);

    // Extra roots only via --path.
    await mkdir(join(dir, 'extra'), { recursive: true });
    await writeFile(join(dir, 'extra', 'notes.md'), 'extra');
    const defaultScan = await runCli(dir, ['scan', '--json']);
    expect((JSON.parse(defaultScan.stdout) as { files: number }).files).toBe(5);
    const extraScan = await runCli(dir, ['scan', '--path', 'extra', '--json']);
    expect((JSON.parse(extraScan.stdout) as { files: number }).files).toBe(6);

    const intake = await runCli(dir, ['intake', '--json']);
    expect(intake.code).toBe(0);
    const intakePayload = JSON.parse(intake.stdout) as {
      unknown: string[];
      groups: { kind: string; needsConfirmation: boolean }[];
      pendingConfirmation: number;
    };
    expect(intakePayload.unknown).toContain('incoming/mystery.xyz');
    expect(intakePayload.pendingConfirmation).toBe(intakePayload.groups.length);
    expect(intakePayload.groups.some((group) => group.kind === 'dataset')).toBe(true);

    const intakeText = await runCli(dir, ['intake']);
    expect(intakeText.code).toBe(0);
    expect(intakeText.stdout).toContain('待分类');

    // Preview creates nothing.
    const preview = await runCli(dir, ['organize', '--json']);
    expect(preview.code).toBe(0);
    expect((JSON.parse(preview.stdout) as { apply: boolean }).apply).toBe(false);
    expect(await exists(join(dir, 'knowledge', 'index', 'sources.json'))).toBe(false);

    const originalBefore = await readFile(join(dir, 'papers', 'alpha.pdf'), 'utf8');

    const apply = await runCli(dir, ['organize', '--apply', '--json']);
    expect(apply.code).toBe(0);
    const applyPayload = JSON.parse(apply.stdout) as {
      created: { source: string; link: string; method: string }[];
      indexEntries: number;
    };
    // The manifest still includes the --path extra file from the last scan.
    expect(applyPayload.created.length).toBe(6);
    expect(applyPayload.indexEntries).toBe(6);

    // Originals are byte-identical and still in place.
    expect(await readFile(join(dir, 'papers', 'alpha.pdf'), 'utf8')).toBe(originalBefore);
    expect(await exists(join(dir, 'incoming', 'mystery.xyz'))).toBe(true);

    // Index entries resolve to the original content.
    const entry = applyPayload.created.find((item) => item.source === 'papers/alpha.pdf')!;
    expect(await readFile(join(dir, ...entry.link.split('/')), 'utf8')).toBe(originalBefore);

    const sources = JSON.parse(
      await readFile(join(dir, 'knowledge', 'index', 'sources.json'), 'utf8'),
    ) as { entries: { source: string; sha256: string | null }[] };
    expect(sources.entries).toHaveLength(6);
    expect(sources.entries.every((item) => item.sha256?.startsWith('sha256:'))).toBe(true);

    // Second apply is a no-op.
    const reapply = await runCli(dir, ['organize', '--apply', '--json']);
    expect(reapply.code).toBe(0);
    const reapplyPayload = JSON.parse(reapply.stdout) as { created: unknown[] };
    expect(reapplyPayload.created).toHaveLength(0);
  }, 40_000);

  it('scan and intake refuse outside a project, intake refuses without a manifest', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ideaseek-inputs-'));
    const scan = await runCli(empty, ['scan']);
    expect(scan.code).toBe(2);
    expect(scan.stderr).toContain('NOT_INITIALIZED');

    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-inputs-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const intake = await runCli(dir, ['intake']);
    expect(intake.code).toBe(2);
    expect(intake.stderr).toContain('ideaseek scan');

    const organize = await runCli(dir, ['organize']);
    expect(organize.code).toBe(2);
    expect(organize.stderr).toContain('ideaseek scan');
  }, 30_000);
});
