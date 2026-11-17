import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { IdeaseekError } from '../core/errors.js';
import { ARIS_SOURCE, VENDORED_FILES, VENDORED_SKILLS } from './manifest.js';

/**
 * Loads vendored ARIS skills for execution through the IdeaSeek harness
 * (docs/ARIS_INTEGRATION_PLAN.md 集成方式 §Skill adapter). Skills are pure
 * Markdown prompts with YAML frontmatter; this module owns integrity
 * verification (manifest SHA-256), frontmatter parsing, `$ARGUMENTS`
 * rendering and shared-reference resolution. It never runs a second agent
 * loop — callers pass the rendered text to HarnessAdapter.runTask.
 */

export type ArisSkillErrorCode = 'SKILL_NOT_FOUND' | 'SKILL_TAMPERED' | 'SKILL_INVALID';

/** IdeaseekError so the CLI prints `error: [SKILL_TAMPERED] …` with exit 2. */
export class ArisSkillError extends IdeaseekError {
  constructor(code: ArisSkillErrorCode, message: string) {
    super(code, message);
    this.name = 'ArisSkillError';
  }
}

/**
 * Root of the vendored tree. Resolved relative to this module so it works
 * from src/ (vitest) and dist/ (published) alike; IDEASEEK_ARIS_SKILLS
 * overrides it to point at a live ARIS checkout for refreshes.
 */
export function arisSkillsRoot(): string {
  const override = process.env.IDEASEEK_ARIS_SKILLS?.trim();
  if (override) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'aris-skills');
}

export interface LoadedArisSkill {
  /** Frontmatter name (must match the registry name). */
  name: string;
  description: string;
  /** Raw `allowed-tools` entries (host policy, not IdeaSeek permissions). */
  allowedTools: string[];
  /** Skill body without the frontmatter fence. */
  body: string;
  sha256: string;
  /** Absolute path of the loaded file. */
  path: string;
}

async function readVerified(relPath: string): Promise<{ raw: string; sha256: string }> {
  const expected = VENDORED_FILES.find((file) => file.path === relPath);
  const abs = join(arisSkillsRoot(), ...relPath.split('/'));
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch {
    throw new ArisSkillError(
      'SKILL_NOT_FOUND',
      `vendored ARIS file missing: ${relPath} (root: ${arisSkillsRoot()})`,
    );
  }
  const sha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
  if (!expected || expected.sha256 !== sha256) {
    throw new ArisSkillError(
      'SKILL_TAMPERED',
      `integrity check failed for ${relPath}: expected ${expected?.sha256 ?? '(unlisted)'}, got ${sha256} — ` +
        `restore aris-skills/ from the pinned commit (${ARIS_SOURCE.commit}) or update the manifest deliberately`,
    );
  }
  return { raw, sha256 };
}

function parseAllowedTools(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

/** Loads and verifies one vendored skill by registry name. */
export async function loadArisSkill(name: string): Promise<LoadedArisSkill> {
  if (!VENDORED_SKILLS.includes(name)) {
    throw new ArisSkillError(
      'SKILL_NOT_FOUND',
      `unknown ARIS skill "${name}" — vendored skills: ${VENDORED_SKILLS.join(', ')}`,
    );
  }
  const relPath = `skills/${name}/SKILL.md`;
  const { raw, sha256 } = await readVerified(relPath);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new ArisSkillError('SKILL_INVALID', `${relPath} has no YAML frontmatter`);
  }
  let meta: Record<string, unknown>;
  try {
    meta = parseYaml(match[1]!) as Record<string, unknown>;
  } catch (error) {
    throw new ArisSkillError(
      'SKILL_INVALID',
      `${relPath} frontmatter: ${(error as Error).message}`,
    );
  }
  const frontName = typeof meta.name === 'string' ? meta.name : name;
  if (frontName !== name) {
    throw new ArisSkillError(
      'SKILL_INVALID',
      `${relPath} frontmatter name "${frontName}" does not match folder "${name}"`,
    );
  }
  return {
    name: frontName,
    description: typeof meta.description === 'string' ? meta.description : '',
    allowedTools: parseAllowedTools(meta['allowed-tools']),
    body: match[2] ?? '',
    sha256,
    path: join(arisSkillsRoot(), ...relPath.split('/')),
  };
}

export interface RenderOptions {
  /** Replaces the literal `$ARGUMENTS` placeholder (ARIS convention). */
  arguments?: string;
  /** Replaces `{{key}}` placeholders with provided values. */
  variables?: Record<string, string>;
}

/** Renders the skill body for a harness instruction (pure string work). */
export function renderArisSkill(skill: LoadedArisSkill, opts: RenderOptions = {}): string {
  let out = skill.body.replaceAll('$ARGUMENTS', opts.arguments ?? '');
  for (const [key, value] of Object.entries(opts.variables ?? {})) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

/** `shared-references/<name>.md` files the skill body links to. */
export function referencedSharedFiles(skill: LoadedArisSkill): string[] {
  const found = new Set<string>();
  for (const match of skill.body.matchAll(/shared-references\/([a-z0-9_-]+)\.md/gi)) {
    found.add(`${match[1]}.md`);
  }
  return [...found].sort();
}

/** Loads and verifies one shared-references file (for inlining). */
export async function readSharedReference(fileName: string): Promise<string> {
  if (!/^[a-z0-9_-]+\.md$/i.test(fileName)) {
    throw new ArisSkillError('SKILL_INVALID', `invalid shared reference name: ${fileName}`);
  }
  const { raw } = await readVerified(`shared-references/${fileName}`);
  return raw;
}

export interface IntegrityReport {
  path: string;
  ok: boolean;
  /** The manifest hash, or null when the file is not in the manifest at all. */
  expected: string | null;
  actual: string | null;
  /** Present for an unlisted file: why it exists but is unverified. */
  detail?: string;
}

/** Verifies every vendored content file against the manifest. */
/**
 * Files that live in `aris-skills/` but are NOT upstream artefacts: the
 * licence text we must ship to satisfy MIT ("the above copyright notice and
 * this permission notice shall be included in all copies"), and our own
 * provenance notice. They are exempt from the manifest requirement because
 * pinning their hash to an upstream commit would be a category error — but the
 * exemption is a declared list, not "anything that fails to match".
 */
export const PLATFORM_AUTHORED_FILES: readonly string[] = ['LICENSE', 'NOTICE.md'];

async function walkVendoredTree(dir = '', out: string[] = []): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(arisSkillsRoot(), dir), { withFileTypes: true });
  } catch {
    // An absent tree is not an empty tree, but the callers report missing files
    // separately (readVerified throws SKILL_NOT_FOUND), so returning what has
    // been collected so far keeps one unreadable subdirectory from erasing the
    // whole inventory.
    return out;
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walkVendoredTree(rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export async function verifyVendoredIntegrity(): Promise<IntegrityReport[]> {
  const reports: IntegrityReport[] = [];
  for (const file of VENDORED_FILES) {
    try {
      const { sha256 } = await readVerified(file.path);
      reports.push({ path: file.path, ok: true, expected: file.sha256, actual: sha256 });
    } catch (error) {
      reports.push({
        path: file.path,
        ok: false,
        expected: file.sha256,
        actual:
          error instanceof ArisSkillError && error.code === 'SKILL_TAMPERED'
            ? (error.message.match(/got ([0-9a-f]{64})/)?.[1] ?? 'unreadable')
            : null,
      });
    }
  }

  // The direction that used to be missing. `verifyVendoredIntegrity` walked the
  // manifest only, so a file copied into `aris-skills/` without a manifest
  // entry was invisible to `ideaseek aris` and to the test that counted
  // reports: the command reported "54 files all match" while an unverified,
  // unpinned file sat in the tree and `readVerified` would have rejected it at
  // LOAD time. Integrity tooling that checks what the list says instead of what
  // the directory holds is the failure shape this project keeps meeting —
  // configured, green, inert.
  const listed = new Set(VENDORED_FILES.map((file) => file.path));
  const onDisk = await walkVendoredTree();
  for (const rel of onDisk) {
    if (listed.has(rel) || PLATFORM_AUTHORED_FILES.includes(rel)) continue;
    reports.push({
      path: rel,
      ok: false,
      expected: null,
      actual: null,
      detail:
        'file exists in aris-skills/ but is not in VENDORED_FILES: it is unverified, not pinned to ' +
        `the upstream commit (${ARIS_SOURCE.commit}) and would be refused at load time; run ` +
        'node scripts/aris-vendor.mjs to register it deliberately',
    });
  }
  return reports;
}
