import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

/**
 * idea-seed intake (docs/IDEA_IMPROVEMENT.md + CLI_SPEC): scan discovers
 * `idea-seeds/<name>/` as candidate `idea` groups needing confirmation;
 * `idea import` performs the read-only registration — a content snapshot in
 * knowledge/idea-seeds.json — and NEVER touches the user's source tree.
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

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, ...relPath.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else
        out.push(
          abs
            .slice(root.length + 1)
            .split(/[\\/]/)
            .join('/'),
        );
    }
  }
  await walk(root);
  return out.sort();
}

interface ManifestShape {
  groups: { groupId: string; kind: string; files: string[]; needsConfirmation: boolean }[];
  files: { relPath: string; role: string }[];
}

async function readManifest(dir: string): Promise<ManifestShape> {
  return JSON.parse(await readFile(join(dir, 'knowledge', 'input-manifest.json'), 'utf8'));
}

async function seedProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-seeds-'));
  expect((await runCli(dir, ['init'])).code).toBe(0);
  await writeFiles(dir, {
    'idea-seeds/hetero-distillation/README.md': '# hetero distillation idea\n',
    'idea-seeds/hetero-distillation/idea.md': 'Hypothesis: ...\n',
    'idea-seeds/hetero-distillation/code/train.py': 'def train():\n    return 1\n',
    'idea-seeds/other-seed/note.txt': 'loose idea notes\n',
  });
  return dir;
}

describe('idea-seeds scan / intake / read-only import', () => {
  it('scan groups each seed as a candidate `idea` group needing confirmation', async () => {
    const dir = await seedProject();
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    const manifest = await readManifest(dir);

    const ideaGroups = manifest.groups.filter((group) => group.kind === 'idea');
    expect(ideaGroups).toHaveLength(2);
    expect(ideaGroups.every((group) => group.needsConfirmation)).toBe(true);
    // Distinct seeds must get distinct group ids (full-key hash).
    expect(new Set(ideaGroups.map((group) => group.groupId)).size).toBe(2);
    const hetero = ideaGroups.find((group) =>
      group.files.includes('idea-seeds/hetero-distillation/idea.md'),
    )!;
    expect(hetero.files).toHaveLength(3);

    // Files inside a seed keep their natural roles (code stays code).
    const train = manifest.files.find(
      (file) => file.relPath === 'idea-seeds/hetero-distillation/code/train.py',
    );
    expect(train!.role).toBe('code');
  }, 60_000);

  it('intake lists the idea groups alongside the other candidates', async () => {
    const dir = await seedProject();
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    const intake = await runCli(dir, ['intake']);
    expect(intake.code).toBe(0);
    // Group line: `grp-…  idea        conf=… N file(s)  [idea-seed-directory:…]`
    expect(intake.stdout).toMatch(/idea\s{5,}conf=/);
    expect(intake.stdout).toContain('idea-seed-directory:hetero-distillation');
  }, 60_000);

  it('idea import registers a snapshot, is idempotent, and never touches the source', async () => {
    const dir = await seedProject();
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    const seedRoot = join(dir, 'idea-seeds');
    const before = await listTree(seedRoot);

    // Intake confirmation is a prerequisite: the gate refuses first.
    const gated = await runCli(dir, [
      'idea',
      'import',
      '--source',
      'idea-seeds/hetero-distillation',
    ]);
    expect(gated.code).not.toBe(0);
    expect(gated.stderr).toContain('unconfirmed intake group');
    expect(gated.stderr).toContain('ideaseek intake --confirm');

    const confirm = await runCli(dir, [
      'intake',
      '--confirm',
      'idea-seeds/hetero-distillation/idea.md',
    ]);
    expect(confirm.code).toBe(0);
    expect(confirm.stdout).toContain('confirmed idea group');
    const intakeAfter = await runCli(dir, ['intake']);
    expect(intakeAfter.stdout).toContain('[confirmed]');

    const first = await runCli(dir, [
      'idea',
      'import',
      '--source',
      'idea-seeds/hetero-distillation',
    ]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('registered idea seed: idea-seeds/hetero-distillation');
    expect(first.stdout).toContain('source untouched');
    expect(first.stdout).toContain('3 file(s)');

    const registry = JSON.parse(
      await readFile(join(dir, 'knowledge', 'idea-seeds.json'), 'utf8'),
    ) as {
      version: number;
      seeds: {
        name: string;
        source: string;
        snapshot: { fileCount: number; rootHash: string; files: { relPath: string }[] };
        history: unknown[];
      }[];
    };
    expect(registry.version).toBe(1);
    expect(registry.seeds).toHaveLength(1);
    const seed = registry.seeds[0]!;
    expect(seed.name).toBe('hetero-distillation');
    expect(seed.snapshot.fileCount).toBe(3);
    expect(seed.snapshot.rootHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(seed.snapshot.files.map((file) => file.relPath)).toContain(
      'idea-seeds/hetero-distillation/code/train.py',
    );
    expect(seed.history).toHaveLength(0);

    // Read-only guarantee: the user's tree is byte-identical after import.
    expect(await listTree(seedRoot)).toEqual(before);

    // Idempotent: unchanged source rewrites nothing.
    const registryBytes = await readFile(join(dir, 'knowledge', 'idea-seeds.json'), 'utf8');
    const second = await runCli(dir, [
      'idea',
      'import',
      '--source',
      'idea-seeds/hetero-distillation',
    ]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('idea seed unchanged');
    expect(await readFile(join(dir, 'knowledge', 'idea-seeds.json'), 'utf8')).toBe(registryBytes);
    expect(await listTree(seedRoot)).toEqual(before);
  }, 60_000);

  it('a changed source refreshes the snapshot and keeps history', async () => {
    const dir = await seedProject();
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    expect(
      (await runCli(dir, ['intake', '--confirm', 'idea-seeds/other-seed/note.txt'])).code,
    ).toBe(0);
    expect((await runCli(dir, ['idea', 'import', '--source', 'idea-seeds/other-seed'])).code).toBe(
      0,
    );

    // Editing confirmed bytes invalidates the confirmation (content-bound).
    await writeFile(join(dir, 'idea-seeds', 'other-seed', 'note.txt'), 'updated notes\n', 'utf8');
    const blocked = await runCli(dir, ['idea', 'import', '--source', 'idea-seeds/other-seed']);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain('unconfirmed intake group');

    expect(
      (await runCli(dir, ['intake', '--confirm', 'idea-seeds/other-seed/note.txt'])).code,
    ).toBe(0);
    const changed = await runCli(dir, ['idea', 'import', '--source', 'idea-seeds/other-seed']);
    expect(changed.code).toBe(0);
    expect(changed.stdout).toContain('registered idea seed');
    expect(changed.stdout).toContain('previous rootHash kept in history');

    const registry = JSON.parse(
      await readFile(join(dir, 'knowledge', 'idea-seeds.json'), 'utf8'),
    ) as { seeds: { history: { rootHash: string }[]; snapshot: { rootHash: string } }[] };
    expect(registry.seeds[0]!.history).toHaveLength(1);
    expect(registry.seeds[0]!.history[0]!.rootHash).not.toBe(registry.seeds[0]!.snapshot.rootHash);
  }, 60_000);

  it('rejects sources outside the delivery prefixes and missing seeds', async () => {
    const dir = await seedProject();
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    const outside = await runCli(dir, ['idea', 'import', '--source', 'papers']);
    expect(outside.code).not.toBe(0);
    expect(outside.stderr).toContain('must be under idea-seeds/');
    expect(outside.stderr).toContain('incoming/ideas/');

    const missing = await runCli(dir, ['idea', 'import', '--source', 'idea-seeds/does-not-exist']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('nothing scanned under idea-seeds/does-not-exist');
    expect(missing.stderr).toContain('ideaseek scan');
  }, 60_000);
});
