import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256OfFile, type ContentHash } from '../core/hash.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { assessIdeaCard, type IdeaCard, type IdeaStatus } from './card.js';

/**
 * Independent idea workspaces (docs/plan.md 阶段 E, WORKFLOW_SPEC §Idea):
 * every idea owns ideas/<id>/{idea.json, idea.md, workspace.json, versions/,
 * src/, config/, data/, experiments/}. Engineering revisions bump the same
 * idea's version; scientific hypothesis changes must branch to a NEW idea id
 * with parentIdeaId linkage. Nothing here ever writes outside the idea's own
 * directory — papers, datasets and comparison upstreams stay read-only.
 */

export type IdeaRunStatus =
  | 'PROPOSED'
  | 'IMPLEMENTING'
  | 'SMOKE_TESTED'
  | 'RUNNING'
  | 'ANALYZING'
  | 'SUPPORTED'
  | 'NEEDS_REVISION'
  | 'REJECTED'
  | 'INVALID_RUN';

/** Lifecycle graph (docs/WORKFLOW_SPEC §Idea 状态). */
export const IDEA_TRANSITIONS: Record<IdeaRunStatus, readonly IdeaRunStatus[]> = {
  PROPOSED: ['IMPLEMENTING', 'REJECTED'],
  IMPLEMENTING: ['SMOKE_TESTED', 'NEEDS_REVISION', 'REJECTED'],
  SMOKE_TESTED: ['RUNNING', 'NEEDS_REVISION', 'REJECTED'],
  // A failed run can go straight to revision or rejection without waiting for
  // a full analysis pass — the operator already knows it failed.
  RUNNING: ['ANALYZING', 'NEEDS_REVISION', 'REJECTED', 'INVALID_RUN'],
  ANALYZING: ['SUPPORTED', 'NEEDS_REVISION', 'REJECTED', 'INVALID_RUN'],
  NEEDS_REVISION: ['IMPLEMENTING', 'REJECTED'],
  // SUPPORTED and REJECTED are terminal: reopening an idea is done by creating
  // a new version (which starts at PROPOSED), not by mutating the state.
  // This keeps the version chain as the single source of "what changed".
  SUPPORTED: [],
  REJECTED: [],
  INVALID_RUN: ['IMPLEMENTING', 'REJECTED'],
};

export const REASON_REQUIRED_STATUSES: readonly IdeaRunStatus[] = ['REJECTED'];

export interface IdeaStatusHistoryEntry {
  at: number;
  from: IdeaRunStatus | null;
  to: IdeaRunStatus;
  reason: string | null;
}

export interface IdeaWorkspaceMeta {
  ideaId: string;
  /** Set only on scientific branches (new hypothesis = new idea id). */
  parentIdeaId: string | null;
  /** Ideas that branched scientifically from this one. */
  childIdeaIds: string[];
  status: IdeaRunStatus;
  statusReason: string | null;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
  history: IdeaStatusHistoryEntry[];
}

export type IdeaChangeKind = 'initial' | 'engineering' | 'scientific-branch';

export interface IdeaVersionRecord {
  ideaId: string;
  version: number;
  parentVersion: number | null;
  changeKind: IdeaChangeKind;
  /** Cross-idea link, present on scientific branches. */
  parentIdeaId?: string | null;
  /** Content hash of src/ at the last checkpoint (null before first). */
  codeHash: ContentHash | null;
  summary: string;
  createdAt: number;
  checkpoint?: { at: number; message: string; codeHash: ContentHash | null };
}

export interface IdeaDataInput {
  path: string;
  sha256: ContentHash;
}

export interface IdeaDataManifest {
  ideaId: string;
  inputs: IdeaDataInput[];
  recordedAt: number;
}

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

export function assertIdeaId(ideaId: string): void {
  if (typeof ideaId !== 'string' || !KEBAB.test(ideaId)) {
    throw new IdeaseekError('INVALID_ARGUMENT', 'ideaId must be kebab-case');
  }
}

export function ideaDir(projectRoot: string, ideaId: string): string {
  assertIdeaId(ideaId);
  return join(projectRoot, 'ideas', ideaId);
}

/**
 * Cross-idea isolation guard (plan §E: Code Implementer 只在自己的
 * ideas/<id>/ 内写入；papers/datasets/comparisons 只读). Every future write
 * from an idea-scoped agent must pass through this check.
 */
export function assertIdeaWorkspacePath(
  projectRoot: string,
  ideaId: string,
  targetPath: string,
): void {
  assertIdeaId(ideaId);
  const base = resolve(ideaDir(projectRoot, ideaId));
  const target = isAbsolute(targetPath) ? resolve(targetPath) : resolve(projectRoot, targetPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `cross-idea or read-only write refused: ${targetPath} is outside ideas/${ideaId}/ ` +
        '(papers, datasets, comparisons and other ideas are read-only for this idea)',
      { ideaId, targetPath },
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function loadWorkspaceMeta(projectRoot: string, ideaId: string): Promise<IdeaWorkspaceMeta> {
  return readJson<IdeaWorkspaceMeta>(join(ideaDir(projectRoot, ideaId), 'workspace.json'), ideaId);
}

export function loadIdeaCard(projectRoot: string, ideaId: string): Promise<IdeaCard> {
  return readJson<IdeaCard>(join(ideaDir(projectRoot, ideaId), 'idea.json'), ideaId);
}

async function readJson<T>(path: string, ideaId: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IdeaseekError(
        'TASK_NOT_FOUND',
        `idea workspace ${ideaId} not found at ${path} (run: ideaseek idea create ${ideaId} --from-card <file>)`,
      );
    }
    throw new IdeaseekError('PARSE_FAILED', `cannot read ${path}: ${(error as Error).message}`);
  }
}

async function saveWorkspaceMeta(projectRoot: string, meta: IdeaWorkspaceMeta): Promise<void> {
  meta.updatedAt = Date.now();
  await writeFileAtomic(
    join(ideaDir(projectRoot, meta.ideaId), 'workspace.json'),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
}

async function saveVersionRecord(projectRoot: string, record: IdeaVersionRecord): Promise<void> {
  const dir = join(ideaDir(projectRoot, record.ideaId), 'versions');
  await ensureDir(dir);
  await writeFileAtomic(
    join(dir, `v${record.version}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

export async function loadVersionRecords(
  projectRoot: string,
  ideaId: string,
): Promise<IdeaVersionRecord[]> {
  const dir = join(ideaDir(projectRoot, ideaId), 'versions');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => /^v\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const records: IdeaVersionRecord[] = [];
  for (const name of names) {
    const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as IdeaVersionRecord;
    records.push(record);
  }
  records.sort((a, b) => a.version - b.version);
  return records;
}

/**
 * Every file under an idea workspace's `src/` as `src/<rel>` → sha256 of its
 * bytes (caches excluded). One walker because the skip-list is a correctness
 * detail shared with hashIdeaSource: a second copy would drift, and a digest
 * that skips `__pycache__` while the ownership manifest records `.pyc` files
 * would have the generator delete bytecode it never wrote.
 */
export async function listSourceFiles(workspace: string): Promise<Map<string, string>> {
  const srcDir = join(workspace, 'src');
  const files = new Map<string, string>();
  if (!(await pathExists(srcDir))) return files;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === '.git' || entry.name === '__pycache__' || entry.name === '.venv') {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        files.set(
          `src/${rel}`,
          createHash('sha256')
            .update(await readFile(join(dir, entry.name)))
            .digest('hex'),
        );
      }
    }
  };
  await walk(srcDir, '');
  return files;
}

/**
 * Content hash of an idea's src/ tree (path + bytes, sorted; skips caches).
 * Used instead of a nested git repo so idea code versions never collide with
 * the project repository or other ideas.
 */
export async function hashIdeaSource(
  projectRoot: string,
  ideaId: string,
): Promise<ContentHash | null> {
  const entries = await listSourceFiles(ideaDir(projectRoot, ideaId));
  if (entries.size === 0) return null;
  const hash = createHash('sha256');
  for (const [rel, digest] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
    hash.update(`${rel}\0`);
    hash.update(digest);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function renderIdeaMarkdown(
  card: IdeaCard,
  meta: IdeaWorkspaceMeta,
  versions: IdeaVersionRecord[],
): string {
  const chain = versions
    .map(
      (v) => `v${v.version} (${v.changeKind}${v.codeHash ? `, ${v.codeHash.slice(0, 12)}…` : ''})`,
    )
    .join(' → ');
  const lines: (string | null)[] = [
    `# Idea: ${card.ideaId}`,
    '',
    `- lifecycle status: **${meta.status}**${meta.statusReason ? ` — ${meta.statusReason}` : ''}`,
    `- card gate: **${card.status}**`,
    `- version: **v${meta.currentVersion}**${meta.currentVersion > 1 ? ` (parent v${meta.currentVersion - 1})` : ''}`,
    `- parent idea: ${meta.parentIdeaId ?? 'none (root idea)'}`,
    meta.childIdeaIds.length > 0 ? `- child ideas: ${meta.childIdeaIds.join(', ')}` : null,
    `- version chain: ${chain || 'v1'}`,
    '',
    '## Hypothesis',
    '',
    card.hypothesis.statement,
    '',
    `Target problem: ${card.hypothesis.targetProblem}`,
    '',
    '## Mechanism chain',
    '',
    ...card.mechanismChain.steps.map((step) => `- **${step.kind}**: ${step.text}`),
    '',
    '## Nearest comparisons',
    '',
    ...card.nearestComparisons.map(
      (item) => `- \`${item.methodId}\`: ${item.difference} — _${item.evidence}_`,
    ),
    '',
    '## Falsification conditions',
    '',
    ...card.falsification.conditions.map((condition) => `- ${condition}`),
    '',
    '## Budget & stop conditions',
    '',
    `- budget: ${card.budget.maxRounds} rounds · ${card.budget.maxGpuMinutes} GPU-minutes`,
    ...card.stopConditions.map((condition) => `- stop: ${condition}`),
    '',
    '## Reproduce / continue',
    '',
    '```text',
    `ideaseek idea show ${card.ideaId}`,
    `ideaseek idea checkpoint ${card.ideaId} --message "<what changed>"`,
    `ideaseek idea revise ${card.ideaId} --kind engineering --summary "<why>"`,
    `ideaseek idea set-status ${card.ideaId} IMPLEMENTING`,
    `ideaseek idea verify ${card.ideaId}`,
    '```',
    '',
    'Experiments are quick/standard scale only — full training stays in the',
    'handoff package (docs: 不把 full-scale 训练放进 IdeaSeek 自动流程).',
    '',
  ];
  return `${lines.filter((line) => line !== null && line !== undefined).join('\n')}\n`;
}

export function renderWorkspaceReadme(
  ideaId: string,
  meta: IdeaWorkspaceMeta,
  card: IdeaCard,
): string {
  return [
    `# ${ideaId} — idea workspace`,
    '',
    'This directory belongs to ONE idea. Do not write outside it; other ideas,',
    'papers/, datasets/ and comparisons/ are read-only from here.',
    '',
    '```text',
    'idea.json      IdeaCard (authoritative, ideaseek idea validate)',
    'idea.md        human-readable rendering',
    'workspace.json lifecycle status, version pointer, parent/child links',
    'versions/      one record per version (engineering revisions bump here)',
    'src/           idea code — checkpointed via ideaseek idea checkpoint',
    'config/        experiment configuration',
    'data/          derived slices only (regenerable; never original data)',
    'experiments/   ExperimentSpec / RunResult files (quick/standard scale)',
    '```',
    '',
    `Status: ${meta.status} · version: v${meta.currentVersion} · gate: ${card.status}`,
    meta.parentIdeaId ? `Scientific parent: ${meta.parentIdeaId}` : null,
    '',
    'Reproduction commands:',
    '',
    '```text',
    `ideaseek idea show ${ideaId}`,
    `ideaseek idea checkpoint ${ideaId} --message "<what changed>"`,
    `ideaseek idea revise ${ideaId} --kind engineering --summary "<why>"`,
    `ideaseek idea verify ${ideaId}`,
    'ideaseek experiment spec experiments/<spec>.json',
    'ideaseek experiment result experiments/<result>.json',
    '```',
    '',
    'No full-scale training runs here: only quick/standard experiments are',
    'prepared; full runs go through ideaseek experiment handoff.',
    '',
  ].join('\n');
}

export interface CreateWorkspaceInput {
  ideaId: string;
  card: IdeaCard;
  /** Absolute or project-relative data inputs recorded in data/manifest.json. */
  dataPaths?: string[];
  parentIdeaId?: string | null;
  changeKind?: IdeaChangeKind;
}

export interface CreateWorkspaceResult {
  meta: IdeaWorkspaceMeta;
  /** True when a partial (crashed) workspace was completed. */
  resumed: boolean;
}

const STRUCTURE_DIRS = ['src', 'config', 'data', 'experiments', 'versions'] as const;

/**
 * Creates ideas/<id>/ atomically-enough for crash recovery: each artifact is
 * written with writeFileAtomic, and a re-run completes a partial workspace
 * instead of refusing (ALREADY_INITIALIZED only for a complete one).
 */
export async function createWorkspace(
  projectRoot: string,
  input: CreateWorkspaceInput,
): Promise<CreateWorkspaceResult> {
  assertIdeaId(input.ideaId);
  const dir = ideaDir(projectRoot, input.ideaId);
  const cardPath = join(dir, 'idea.json');
  const metaPath = join(dir, 'workspace.json');

  const hasCard = await pathExists(cardPath);
  const hasMeta = await pathExists(metaPath);
  if (hasCard && hasMeta) {
    throw new IdeaseekError(
      'ALREADY_INITIALIZED',
      `idea workspace ${input.ideaId} already exists (ideaseek idea show ${input.ideaId})`,
    );
  }
  const resumed = hasCard || hasMeta;

  // Contract checks before any write.
  if (input.card.ideaId !== input.ideaId) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `card ideaId "${input.card.ideaId}" does not match workspace ${input.ideaId}`,
    );
  }
  if (input.card.version !== 1 || input.card.parentVersion !== null) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      'a workspace starts at card version 1 with parentVersion null',
    );
  }
  const assessment = assessIdeaCard(input.card);
  if (!assessment.ok) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `invalid idea card: ${assessment.validation.errors.join('; ')}`,
    );
  }

  if (input.parentIdeaId) {
    // Parent must exist and be a complete workspace.
    await loadWorkspaceMeta(projectRoot, input.parentIdeaId);
  }

  for (const name of STRUCTURE_DIRS) {
    await ensureDir(join(dir, name));
  }

  const now = Date.now();
  const meta: IdeaWorkspaceMeta = hasMeta
    ? await loadWorkspaceMeta(projectRoot, input.ideaId)
    : {
        ideaId: input.ideaId,
        parentIdeaId: input.parentIdeaId ?? null,
        childIdeaIds: [],
        status: 'PROPOSED',
        statusReason: null,
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
        history: [{ at: now, from: null, to: 'PROPOSED', reason: 'workspace created' }],
      };
  await saveWorkspaceMeta(projectRoot, meta);

  if (!hasCard) {
    await writeFileAtomic(cardPath, `${JSON.stringify(input.card, null, 2)}\n`);
  }

  const versionPath = join(dir, 'versions', 'v1.json');
  if (!(await pathExists(versionPath))) {
    await saveVersionRecord(projectRoot, {
      ideaId: input.ideaId,
      version: 1,
      parentVersion: null,
      changeKind: input.changeKind ?? 'initial',
      parentIdeaId: input.parentIdeaId ?? null,
      codeHash: null,
      summary: input.parentIdeaId
        ? `scientific branch from ${input.parentIdeaId}`
        : 'workspace created',
      createdAt: now,
    });
  }

  // Data input binding (input-change detection on verify).
  const dataPaths = input.dataPaths ?? [];
  if (dataPaths.length > 0) {
    const manifestPath = join(dir, 'data', 'manifest.json');
    if (!(await pathExists(manifestPath))) {
      const inputs: IdeaDataInput[] = [];
      for (const path of dataPaths) {
        const absolute = isAbsolute(path) ? path : resolve(projectRoot, path);
        try {
          inputs.push({ path: absolute, sha256: await sha256OfFile(absolute) });
        } catch (error) {
          throw new IdeaseekError(
            'FILE_NOT_FOUND',
            `cannot hash --data ${path}: ${(error as Error).message}`,
          );
        }
      }
      const manifest: IdeaDataManifest = {
        ideaId: input.ideaId,
        inputs,
        recordedAt: now,
      };
      await writeFileAtomic(
        join(dir, 'data', 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    }
  }

  const card = await loadIdeaCard(projectRoot, input.ideaId);
  const versions = await loadVersionRecords(projectRoot, input.ideaId);
  await writeFileAtomic(join(dir, 'README.md'), renderWorkspaceReadme(input.ideaId, meta, card));
  await writeFileAtomic(join(dir, 'idea.md'), renderIdeaMarkdown(card, meta, versions));

  if (input.parentIdeaId) {
    const parentMeta = await loadWorkspaceMeta(projectRoot, input.parentIdeaId);
    if (!parentMeta.childIdeaIds.includes(input.ideaId)) {
      parentMeta.childIdeaIds.push(input.ideaId);
      parentMeta.childIdeaIds.sort();
      await saveWorkspaceMeta(projectRoot, parentMeta);
    }
  }

  return { meta, resumed };
}

export function assertIdeaTransition(
  from: IdeaRunStatus,
  to: IdeaRunStatus,
  reason: string | undefined,
): void {
  if (!IDEA_TRANSITIONS[from].includes(to)) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `illegal idea transition ${from} → ${to} (allowed: ${IDEA_TRANSITIONS[from].join(', ') || 'none'})`,
      { from, to },
    );
  }
  if (REASON_REQUIRED_STATUSES.includes(to) && !(reason && reason.trim())) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `status ${to} requires --reason (rejected ideas keep their reason for the record)`,
      { status: to },
    );
  }
}

export async function setIdeaStatus(
  projectRoot: string,
  ideaId: string,
  to: IdeaRunStatus,
  reason?: string,
): Promise<IdeaWorkspaceMeta> {
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  assertIdeaTransition(meta.status, to, reason);
  meta.history.push({
    at: Date.now(),
    from: meta.status,
    to,
    reason: reason?.trim() ?? null,
  });
  meta.status = to;
  meta.statusReason = reason?.trim() ?? null;
  await saveWorkspaceMeta(projectRoot, meta);
  await refreshIdeaMarkdown(projectRoot, ideaId);
  return meta;
}

export interface ReviseResult {
  version: IdeaVersionRecord;
  meta: IdeaWorkspaceMeta;
}

/**
 * Engineering revision: bumps the SAME idea to version N+1 (new scientific
 * hypotheses must go through createWorkspace with a fresh idea id).
 * Resumes a crashed revise (version file written, pointer not advanced).
 */
export async function reviseEngineering(
  projectRoot: string,
  ideaId: string,
  summary: string,
): Promise<ReviseResult> {
  if (!summary || !summary.trim()) {
    throw new IdeaseekError('INVALID_ARGUMENT', 'revise requires a non-empty --summary');
  }
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  const card = await loadIdeaCard(projectRoot, ideaId);
  const target = meta.currentVersion + 1;
  const targetPath = join(ideaDir(projectRoot, ideaId), 'versions', `v${target}.json`);

  let record: IdeaVersionRecord;
  if (await pathExists(targetPath)) {
    // Crash recovery: the version file landed but the pointer/card did not.
    record = JSON.parse(await readFile(targetPath, 'utf8')) as IdeaVersionRecord;
    if (record.parentVersion !== target - 1) {
      throw new IdeaseekError(
        'INVALID_STATE',
        `version chain corrupt at v${target} (parentVersion ${String(record.parentVersion)}); repair versions/ manually`,
      );
    }
  } else {
    record = {
      ideaId,
      version: target,
      parentVersion: target - 1,
      changeKind: 'engineering',
      codeHash: await hashIdeaSource(projectRoot, ideaId),
      summary: summary.trim(),
      createdAt: Date.now(),
    };
    await saveVersionRecord(projectRoot, record);
  }

  meta.currentVersion = target;
  await saveWorkspaceMeta(projectRoot, meta);

  const revisedCard: IdeaCard = { ...card, version: target, parentVersion: target - 1 };
  const assessment = assessIdeaCard(revisedCard);
  if (!assessment.ok) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `card became invalid after revision: ${assessment.validation.errors.join('; ')}`,
    );
  }
  await writeFileAtomic(
    join(ideaDir(projectRoot, ideaId), 'idea.json'),
    `${JSON.stringify(revisedCard, null, 2)}\n`,
  );
  await refreshIdeaMarkdown(projectRoot, ideaId);
  return { version: record, meta };
}

/** Refuses scientific revisions in-place (hypothesis change ⇒ new idea id). */
export function assertEngineeringRevision(kind: string): void {
  if (kind !== 'engineering') {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `kind "${kind}" is not an in-place revision; a scientific hypothesis change must create a new idea id: ` +
        `ideaseek idea branch <parent> <new-idea-id> --from-card <file>`,
      { kind },
    );
  }
}

export interface CheckpointResult {
  codeHash: ContentHash | null;
  changed: boolean;
  version: number;
  message: string;
}

/**
 * Binds the current src/ content hash to the current idea version
 * (requirement: every code change records idea_id + idea_version + hash).
 * Idempotent: an unchanged tree reports changed=false without rewriting.
 */
export async function checkpointCode(
  projectRoot: string,
  ideaId: string,
  message: string,
): Promise<CheckpointResult> {
  if (!message || !message.trim()) {
    throw new IdeaseekError('INVALID_ARGUMENT', 'checkpoint requires a non-empty --message');
  }
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  const codeHash = await hashIdeaSource(projectRoot, ideaId);
  const versionPath = join(
    ideaDir(projectRoot, ideaId),
    'versions',
    `v${meta.currentVersion}.json`,
  );
  if (!(await pathExists(versionPath))) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `versions/v${meta.currentVersion}.json missing — run: ideaseek idea revise ${ideaId} --kind engineering --summary "resume"`,
    );
  }
  const record = JSON.parse(await readFile(versionPath, 'utf8')) as IdeaVersionRecord;
  if (record.checkpoint?.codeHash === codeHash && record.codeHash === codeHash) {
    return {
      codeHash,
      changed: false,
      version: meta.currentVersion,
      message: record.checkpoint.message,
    };
  }
  record.codeHash = codeHash;
  record.checkpoint = { at: Date.now(), message: message.trim(), codeHash };
  await saveVersionRecord(projectRoot, record);
  await refreshIdeaMarkdown(projectRoot, ideaId);
  return { codeHash, changed: true, version: meta.currentVersion, message: message.trim() };
}

async function refreshIdeaMarkdown(projectRoot: string, ideaId: string): Promise<void> {
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  const card = await loadIdeaCard(projectRoot, ideaId);
  const versions = await loadVersionRecords(projectRoot, ideaId);
  await writeFileAtomic(
    join(ideaDir(projectRoot, ideaId), 'idea.md'),
    renderIdeaMarkdown(card, meta, versions),
  );
}

export interface VerifyIssue {
  kind:
    | 'structure-missing'
    | 'card-invalid'
    | 'version-chain'
    | 'input-changed'
    | 'input-missing'
    | 'parent-missing';
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
  status: IdeaRunStatus;
  currentVersion: number;
  cardGate: IdeaStatus;
  inputsChanged: string[];
}

/**
 * Workspace integrity check: structure, card validity, contiguous version
 * chain, parent linkage and input-file drift (input change detection).
 */
export async function verifyWorkspace(projectRoot: string, ideaId: string): Promise<VerifyResult> {
  const issues: VerifyIssue[] = [];
  const dir = ideaDir(projectRoot, ideaId);

  for (const name of [...STRUCTURE_DIRS, 'idea.json', 'workspace.json', 'README.md']) {
    if (!(await pathExists(join(dir, name)))) {
      issues.push({ kind: 'structure-missing', detail: `${name} is missing` });
    }
  }

  let meta: IdeaWorkspaceMeta | null = null;
  let card: IdeaCard | null = null;
  try {
    meta = await loadWorkspaceMeta(projectRoot, ideaId);
  } catch (error) {
    issues.push({ kind: 'structure-missing', detail: (error as Error).message });
  }
  try {
    card = await loadIdeaCard(projectRoot, ideaId);
    const assessment = assessIdeaCard(card);
    if (!assessment.ok) {
      issues.push({
        kind: 'card-invalid',
        detail: assessment.validation.errors.join('; '),
      });
    }
  } catch (error) {
    issues.push({ kind: 'structure-missing', detail: (error as Error).message });
  }

  const inputsChanged: string[] = [];
  if (meta && card) {
    // Contiguous version chain v1..currentVersion.
    const versions = await loadVersionRecords(projectRoot, ideaId);
    const byVersion = new Map(versions.map((v) => [v.version, v]));
    for (let v = 1; v <= meta.currentVersion; v += 1) {
      const record = byVersion.get(v);
      if (!record) {
        issues.push({ kind: 'version-chain', detail: `versions/v${v}.json is missing` });
        continue;
      }
      const expectedParent = v === 1 ? null : v - 1;
      if (record.parentVersion !== expectedParent) {
        issues.push({
          kind: 'version-chain',
          detail: `v${v} parentVersion is ${String(record.parentVersion)}, expected ${String(expectedParent)}`,
        });
      }
    }
    // Extra version files beyond the pointer mean a crashed revise.
    for (const record of versions) {
      if (record.version > meta.currentVersion) {
        issues.push({
          kind: 'version-chain',
          detail: `v${record.version} exists but currentVersion is ${meta.currentVersion} (crashed revise? rerun ideaseek idea revise)`,
        });
      }
    }
    if (card.version !== meta.currentVersion) {
      issues.push({
        kind: 'version-chain',
        detail: `card.version ${card.version} != workspace.currentVersion ${meta.currentVersion}`,
      });
    }

    // Parent linkage.
    if (meta.parentIdeaId) {
      try {
        const parent = await loadWorkspaceMeta(projectRoot, meta.parentIdeaId);
        if (!parent.childIdeaIds.includes(ideaId)) {
          issues.push({
            kind: 'parent-missing',
            detail: `parent ${meta.parentIdeaId} does not list ${ideaId} as a child`,
          });
        }
      } catch {
        issues.push({
          kind: 'parent-missing',
          detail: `parent idea ${meta.parentIdeaId} not found`,
        });
      }
    }

    // Input drift detection.
    try {
      const manifest = JSON.parse(
        await readFile(join(dir, 'data', 'manifest.json'), 'utf8'),
      ) as IdeaDataManifest;
      for (const input of manifest.inputs ?? []) {
        try {
          const current = await sha256OfFile(input.path);
          if (current !== input.sha256) inputsChanged.push(input.path);
        } catch {
          inputsChanged.push(`${input.path} (missing)`);
        }
      }
      if (inputsChanged.length > 0) {
        issues.push({
          kind: 'input-changed',
          detail: `input files changed since recording: ${inputsChanged.join(', ')} (re-derive data slices before experiments)`,
        });
      }
    } catch {
      // no manifest → no bound inputs
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    status: meta?.status ?? 'PROPOSED',
    currentVersion: meta?.currentVersion ?? 0,
    cardGate: card?.status ?? 'DRAFT_COMPOSITION',
    inputsChanged,
  };
}

export interface ListedIdea {
  ideaId: string;
  status: IdeaRunStatus;
  currentVersion: number;
  parentIdeaId: string | null;
  childIdeaIds: string[];
}

/** Enumerates complete workspaces under ideas/. */
export async function listWorkspaces(projectRoot: string): Promise<ListedIdea[]> {
  const root = join(projectRoot, 'ideas');
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ListedIdea[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !KEBAB.test(entry.name)) continue;
    try {
      const meta = await loadWorkspaceMeta(projectRoot, entry.name);
      const cardExists = await pathExists(join(root, entry.name, 'idea.json'));
      if (!cardExists) continue; // partial workspace — not listed as complete
      out.push({
        ideaId: meta.ideaId,
        status: meta.status,
        currentVersion: meta.currentVersion,
        parentIdeaId: meta.parentIdeaId,
        childIdeaIds: meta.childIdeaIds,
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.ideaId.localeCompare(b.ideaId));
  return out;
}
