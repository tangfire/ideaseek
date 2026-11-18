import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  arisSkillsRoot,
  loadArisSkill,
  readSharedReference,
  referencedSharedFiles,
  renderArisSkill,
  verifyVendoredIntegrity,
} from '../src/aris/skill.js';
import { ARIS_SOURCE, VENDORED_FILES, VENDORED_SKILLS } from '../src/aris/manifest.js';
import { CLI_BIN } from './helpers.js';

/**
 * Vendored ARIS skill manifest + loader (Phase 4.5 foundation): provenance,
 * MIT license, SHA-256 integrity (tamper refuses to load), frontmatter
 * parsing, $ARGUMENTS rendering and the `ideaseek aris` CLI check.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
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
      reject(new Error(`cli ${args.join(' ')} timed out`));
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

async function withTamperedCopy<T>(
  mutate: (root: string) => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'aris-skills-'));
  await cp(arisSkillsRoot(), root, { recursive: true });
  await mutate(root);
  const previous = process.env.IDEASEEK_ARIS_SKILLS;
  process.env.IDEASEEK_ARIS_SKILLS = root;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.IDEASEEK_ARIS_SKILLS;
    else process.env.IDEASEEK_ARIS_SKILLS = previous;
  }
}

describe('ARIS vendored skill manifest', () => {
  it('verifies every vendored file against the pinned hashes', async () => {
    const reports = await verifyVendoredIntegrity();
    expect(reports).toHaveLength(VENDORED_FILES.length);
    expect(reports.every((report) => report.ok)).toBe(true);
    expect(ARIS_SOURCE.license).toBe('MIT');
    expect(ARIS_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('loads all P0 skills with matching frontmatter', async () => {
    for (const name of VENDORED_SKILLS) {
      const skill = await loadArisSkill(name);
      expect(skill.name, name).toBe(name);
      expect(skill.body.length, name).toBeGreaterThan(100);
      expect(skill.allowedTools.length, name).toBeGreaterThan(0);
      expect(skill.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses tampered skill files instead of executing them', async () => {
    await withTamperedCopy(
      async (root) => {
        const file = join(root, 'skills', 'idea-creator', 'SKILL.md');
        await writeFile(file, `${await readFile(file, 'utf8')}\n<!-- tampered -->\n`, 'utf8');
      },
      async () => {
        await expect(loadArisSkill('idea-creator')).rejects.toMatchObject({
          name: 'ArisSkillError',
          code: 'SKILL_TAMPERED',
        });
      },
    );
  });

  it('rejects unknown skills with the vendored list', async () => {
    await expect(loadArisSkill('not-a-skill')).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
    await expect(loadArisSkill('not-a-skill')).rejects.toThrow(/idea-creator/);
  });

  it('renders $ARGUMENTS and {{variables}} into the instruction', () => {
    const skill = {
      name: 'demo',
      description: '',
      allowedTools: [],
      body: 'Direction: $ARGUMENTS\nRound: {{roundId}}',
      sha256: 'x',
      path: '/x',
    };
    expect(
      renderArisSkill(skill, { arguments: 'federated learning', variables: { roundId: 'r1' } }),
    ).toBe('Direction: federated learning\nRound: r1');
  });

  it('resolves shared references the skill body links to', async () => {
    const skill = await loadArisSkill('novelty-check');
    const refs = referencedSharedFiles(skill);
    expect(refs).toContain('citation-discipline.md');
    const content = await readSharedReference('citation-discipline.md');
    expect(content.length).toBeGreaterThan(100);
    await expect(readSharedReference('../LICENSE')).rejects.toMatchObject({
      code: 'SKILL_INVALID',
    });
  });
});

describe('ideaseek aris (CLI)', () => {
  it('reports provenance and intact integrity as JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aris-cli-'));
    const shown = await runCli(dir, ['aris', '--json']);
    expect(shown.code).toBe(0);
    const payload = JSON.parse(shown.stdout) as {
      source: { commit: string; license: string };
      skills: string[];
      fileCount: number;
      integrity: string;
    };
    expect(payload.source.commit).toBe(ARIS_SOURCE.commit);
    expect(payload.source.license).toBe('MIT');
    expect(payload.skills).toHaveLength(VENDORED_SKILLS.length);
    expect(payload.fileCount).toBe(VENDORED_FILES.length);
    expect(payload.integrity).toBe('ok');
  });

  it('prints license, commit and integrity in human output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aris-cli-'));
    const shown = await runCli(dir, ['aris']);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('license: MIT');
    expect(shown.stdout).toContain(ARIS_SOURCE.commit);
    expect(shown.stdout).toContain('integrity: all files match the manifest');
  });

  it('exits 2 with the broken file list on a tampered tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aris-cli-'));
    await withTamperedCopy(
      async (root) => {
        const file = join(root, 'skills', 'ablation-planner', 'SKILL.md');
        await writeFile(file, 'not the vendored skill\n', 'utf8');
      },
      async () => {
        const shown = await runCli(dir, ['aris', '--json'], {
          IDEASEEK_ARIS_SKILLS: process.env.IDEASEEK_ARIS_SKILLS!,
        });
        expect(shown.code).toBe(2);
        const payload = JSON.parse(shown.stdout) as { integrity: string; broken: string[] };
        expect(payload.integrity).toBe('mismatch');
        expect(payload.broken).toContain('skills/ablation-planner/SKILL.md');
      },
    );
  });
});

describe('integrity also walks the directory (#19)', () => {
  it('reports a file that exists in aris-skills/ but is not in the manifest', async () => {
    // The positive control, and the reason it is written as one: before this,
    // `ideaseek aris` compared the manifest against itself, so an unlisted file
    // — one that `readVerified` would refuse at LOAD time — was invisible to the
    // check whose whole job is to catch it, while the command still printed
    // "all match". A guard with no positive control is indistinguishable from a
    // guard that never fires.
    //
    // The probe goes into a TEMP COPY of the tree, not the shared repo one:
    // writing into aris-skills/ raced a concurrent suite's recursive `cp` of
    // the same directory under the full parallel gate (the walker lstat'd the
    // probe a millisecond after this test's finally removed it → ENOENT).
    // arisSkillsRoot() honours IDEASEEK_ARIS_SKILLS, so scanning the copy
    // proves exactly the same property without mutating shared state.
    const root = await mkdtemp(join(tmpdir(), 'aris-probe-'));
    await cp(arisSkillsRoot(), root, { recursive: true });
    const stray = join(root, 'skills', 'zz-integrity-probe.md');
    const saved = process.env.IDEASEEK_ARIS_SKILLS;
    await writeFile(stray, '# probe\n\nnot vendored deliberately\n', 'utf8');
    process.env.IDEASEEK_ARIS_SKILLS = root;
    try {
      const reports = await verifyVendoredIntegrity();
      const found = reports.find((report) => report.path === 'skills/zz-integrity-probe.md');
      expect(found, 'unlisted file was not reported').toBeDefined();
      expect(found!.ok).toBe(false);
      expect(found!.expected).toBeNull();
      expect(found!.detail).toContain('not in VENDORED_FILES');
    } finally {
      if (saved === undefined) delete process.env.IDEASEEK_ARIS_SKILLS;
      else process.env.IDEASEEK_ARIS_SKILLS = saved;
      await rm(root, { recursive: true, force: true });
    }
    // And the tree is clean again: the check goes back to reporting nothing
    // unusual, which is what makes the assertion above about the file rather
    // than about my test's leftovers.
    const after = await verifyVendoredIntegrity();
    expect(after.every((report) => report.ok)).toBe(true);
  });

  it('keeps the two platform-authored files exempt, but only those', async () => {
    // LICENSE and NOTICE.md are ours, not upstream artefacts: pinning their
    // hash to an ARIS commit would be a category error. The exemption is a
    // declared list, so a third unlisted file still gets caught.
    const { PLATFORM_AUTHORED_FILES } = await import('../src/aris/skill.js');
    expect(PLATFORM_AUTHORED_FILES).toEqual(['LICENSE', 'NOTICE.md']);
    const reports = await verifyVendoredIntegrity();
    expect(reports.some((report) => report.path === 'LICENSE')).toBe(false);
    expect(reports.every((report) => report.ok)).toBe(true);
  });

  /**
   * The registry is the gate, so an unlisted skill is a skill that does not
   * exist — even when its files are on disk, hash-pinned and verified.
   *
   * Five skills (figure-spec among them) sat in exactly that state: `aris`
   * reported "21 skills, integrity: all files match" and was truthful about the
   * hashes while undercounting what the project actually carries, and
   * loadArisSkill('figure-spec') refused to load the deterministic renderer
   * whose bytes it had already verified. A parity assertion is the only shape
   * of check that fails when the list and the tree drift apart in either
   * direction.
   */
  it('lists every skill on disk, and nothing that is not on disk', async () => {
    const { readdirSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { arisSkillsRoot } = await import('../src/aris/skill.js');
    const { VENDORED_SKILLS } = await import('../src/aris/manifest.js');
    const skillsDir = join(arisSkillsRoot(), 'skills');
    const onDisk = readdirSync(skillsDir)
      .filter((name) => existsSync(join(skillsDir, name, 'SKILL.md')))
      .sort();
    expect([...VENDORED_SKILLS].sort(), 'VENDORED_SKILLS must be kept sorted').toEqual(
      [...VENDORED_SKILLS].sort(),
    );
    expect([...VENDORED_SKILLS].sort()).toEqual(onDisk);
    // And every registered skill must actually load: a name alone is not
    // capability, which is what made the deterministic figure route unusable.
    for (const name of VENDORED_SKILLS) {
      const skill = await loadArisSkill(name);
      expect(skill.name).toBe(name);
      expect(skill.body.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
