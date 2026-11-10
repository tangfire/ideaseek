import { access, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Canonical layout of an IdeaSeek project workspace (docs/plan.md §4).
 * All paths are derived from the project root; business code never hardcodes
 * directory names.
 */
export interface ProjectPaths {
  root: string;
  configFile: string;
  readmeFile: string;
  gitignoreFile: string;
  researchDir: string;
  dbFile: string;
  artifactsDir: string;
  artifactTmpDir: string;
  logsDir: string;
  papersDir: string;
  datasetsDir: string;
  comparisonsDir: string;
  incomingDir: string;
  knowledgeDir: string;
  ideasDir: string;
  reportsDir: string;
}

export const RESEARCH_DIR = '.research';
export const DB_FILE = 'workflow.db';

export function projectPaths(root: string): ProjectPaths {
  const abs = resolve(root);
  const researchDir = join(abs, RESEARCH_DIR);
  return {
    root: abs,
    configFile: join(abs, 'research.yaml'),
    readmeFile: join(abs, 'README.md'),
    gitignoreFile: join(abs, '.gitignore'),
    researchDir,
    dbFile: join(researchDir, DB_FILE),
    artifactsDir: join(researchDir, 'artifacts'),
    artifactTmpDir: join(researchDir, 'artifacts', 'tmp'),
    logsDir: join(researchDir, 'logs'),
    papersDir: join(abs, 'papers'),
    datasetsDir: join(abs, 'datasets'),
    comparisonsDir: join(abs, 'comparisons'),
    incomingDir: join(abs, 'incoming'),
    knowledgeDir: join(abs, 'knowledge'),
    ideasDir: join(abs, 'ideas'),
    reportsDir: join(abs, 'reports'),
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function isProjectRoot(root: string): Promise<boolean> {
  try {
    await access(join(root, RESEARCH_DIR));
    return await isDirectory(join(root, RESEARCH_DIR));
  } catch {
    return false;
  }
}

/**
 * Walks up from `startDir` (like git) looking for an initialized project.
 * Returns null when the directory tree has no `.research/`.
 */
export async function findProjectRoot(startDir: string): Promise<string | null> {
  let current = resolve(startDir);
  for (;;) {
    if (await isProjectRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
