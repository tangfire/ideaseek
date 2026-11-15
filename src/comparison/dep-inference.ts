import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import type { HarnessAdapter } from '../dsh/adapter.js';

/**
 * Dependency inference for third-party research code that ships no
 * requirements file — which is most conference code. Without this the repair
 * loop blocks on a missing import it could plainly resolve by reading the
 * repository, so the tool's limitation becomes the product's ceiling.
 *
 * The agent proposes package specs; the platform validates each one against a
 * strict requirement grammar and runs them as a single argv pip call. A model
 * output can never become a shell command.
 */
export const DEP_INSTRUCTION = `You are the Baseline Repair Agent's dependency resolver. A third-party
research repository failed to run because Python packages are missing, and it
ships no requirements file. From the evidence (traceback, entry source, import
lines, README, and any packaging files), list the pip requirement specs needed
to run the entry. Output ONLY one JSON object:
{"packages": [string], "notes": string}
Rules: each spec is a bare distribution name with optional extras and version
constraint, e.g. "torch", "numpy>=1.21,<2", "pillow". No flags, no URLs, no
local paths, no "-e", no "-r", no shell syntax, no comments. Include only what
the evidence shows is imported or documented, plus the obvious runtime needs of
the framework named. Prefer fewer, correct specs over guessing a full stack.
Never invent version pins you cannot justify from the evidence.`;

export const DEP_OUTPUT_SCHEMA = 'dependency-plan-v1';
export const MAX_PACKAGES = 25;

export interface DependencyPlan {
  packages: string[];
  notes: string;
}

/** Name, optional extras, optional first version clause; the tail is checked separately. */
const HEAD_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\[[A-Za-z0-9._,-]{1,64}\])?)(?:(===?|!==?|<=?|>=?|~=)[A-Za-z0-9._*+!-]{1,32})?(.*)$/s;
/** Any remaining text must be a sequence of `,`-separated version clauses. */
const TAIL_PATTERN = /^(?:,(?:===?|!==?|<=?|>=?|~=)[A-Za-z0-9._*+!-]{1,32})*$/s;

/**
 * Clause-by-clause validation rather than one permissive pattern: a real
 * compound spec like `numpy>=1.21,<2` is common in inferred plans, and
 * rejecting it would hurt more than the metacharacters this blocks — those
 * cannot survive the clause character classes regardless.
 */
export function validateRequirementSpec(spec: string): boolean {
  const value = spec.trim();
  if (!value || value.startsWith('-') || value.length > 160) return false;
  if (value.includes('://') || value.includes('@')) return false;
  const head = HEAD_PATTERN.exec(value);
  if (!head) return false;
  return TAIL_PATTERN.test(head[3] ?? '');
}

export function parseDependencyPlan(output: string): DependencyPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `dependency plan is not JSON: ${(error as Error).message}`,
    );
  }
  const record = (parsed ?? {}) as { packages?: unknown; notes?: unknown };
  if (!Array.isArray(record.packages)) {
    throw new IdeaseekError('PARSE_FAILED', 'dependency plan must carry a packages array');
  }
  const rejected: string[] = [];
  const packages: string[] = [];
  for (const raw of record.packages.slice(0, MAX_PACKAGES * 2)) {
    if (typeof raw !== 'string') {
      rejected.push(String(raw).slice(0, 40));
      continue;
    }
    if (!validateRequirementSpec(raw)) {
      // Refusing the whole plan over one bad entry would throw away good
      // guesses; dropping it with a visible reason keeps the repair honest.
      rejected.push(raw.slice(0, 40));
      continue;
    }
    const spec = raw.trim();
    if (!packages.includes(spec)) packages.push(spec);
  }
  if (packages.length === 0) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `no usable requirement specs (rejected: ${rejected.slice(0, 5).join(', ') || 'none'})`,
    );
  }
  return {
    packages: packages.slice(0, MAX_PACKAGES),
    notes:
      (typeof record.notes === 'string' ? record.notes : '').slice(0, 400) +
      (rejected.length > 0
        ? ` | rejected ${rejected.length} unsafe spec(s): ${rejected.slice(0, 3).join(', ')}`
        : ''),
  };
}

const IMPORT_DIRS = new Set(['src', 'utils', 'models', 'networks', 'methods', 'lib', 'code']);
const PACKAGING_FILES = [
  'requirements.txt',
  'requirements-dev.txt',
  'setup.py',
  'setup.cfg',
  'pyproject.toml',
  'environment.yml',
  'Pipfile',
  'poetry.lock',
  'install.sh',
];

/**
 * Bounded evidence bundle. Context is capped deliberately: a 100-page README
 * would crowd out the traceback that actually identifies the missing module.
 */
export async function buildDependencyContext(
  worktreeDir: string,
  entry: string[],
  failureLog: string,
): Promise<string> {
  const parts: string[] = [];
  parts.push(`## failing entry\n${entry.join(' ')}`);
  parts.push(`## traceback (tail)\n${redactSecrets(failureLog).slice(-1500)}`);

  let names: string[] = [];
  try {
    names = (await readdir(worktreeDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    // Unreadable worktree: the caller already refuses repair without one.
  }
  const packaging = names.filter((name) => PACKAGING_FILES.includes(name));
  parts.push(
    `## top-level files\n${names.slice(0, 40).join('\n') || '(none)'}\n## packaging files present\n${packaging.join(', ') || '(none)'}`,
  );

  for (const name of ['README.md', 'readme.md', 'README.rst', 'INSTALL.md']) {
    if (!names.includes(name)) continue;
    try {
      parts.push(
        `## ${name} (first 2000 chars)\n${(await readFile(join(worktreeDir, name), 'utf8')).slice(0, 2000)}`,
      );
    } catch {
      // Unreadable README is evidence of absence, not a failure.
    }
    break;
  }

  const entryFile = entry[entry.length - 1];
  const target = entryFile?.endsWith('.py') ? entryFile : null;
  if (target) {
    try {
      parts.push(
        `## entry source (first 1500 chars)\n${(await readFile(join(worktreeDir, target), 'utf8')).slice(0, 1500)}`,
      );
    } catch {
      // Entry may live in a subdirectory; imports below still help.
    }
  }

  // Import lines are the strongest signal when no packaging file exists.
  const imports = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2 || imports.size >= 60) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of entries) {
      if (item.name === '.venv' || item.name.startsWith('.')) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (depth === 0 || IMPORT_DIRS.has(item.name)) await walk(full, depth + 1);
        continue;
      }
      if (!item.name.endsWith('.py') || imports.size >= 60) continue;
      try {
        const text = await readFile(full, 'utf8');
        for (const match of text.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)) {
          const root = (match[1] ?? '').split('.')[0];
          if (root && root !== '__future__') imports.add(root);
        }
      } catch {
        // Skip unreadable module.
      }
    }
  };
  await walk(worktreeDir, 0);
  parts.push(`## imported module roots\n${[...imports].sort().join(', ') || '(none found)'}`);

  const bounded = parts.join('\n\n');
  return bounded.length > 12_000 ? `${bounded.slice(0, 12_000)}\n(context truncated)` : bounded;
}

/**
 * Python standard-library roots. Used to tell "needs no third-party package"
 * from "the declaration was left empty by mistake" — without this, every
 * stdlib import would look like a dependency to install.
 */
const STDLIB_ROOTS = new Set([
  'abc',
  'argparse',
  'array',
  'ast',
  'asyncio',
  'base64',
  'bisect',
  'builtins',
  'cmath',
  'collections',
  'concurrent',
  'copy',
  'csv',
  'ctypes',
  'datetime',
  'decimal',
  'difflib',
  'enum',
  'errno',
  'fnmatch',
  'fractions',
  'functools',
  'gc',
  'glob',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'importlib',
  'inspect',
  'io',
  'itertools',
  'json',
  'keyword',
  'linecache',
  'locale',
  'logging',
  'math',
  'mimetypes',
  'numbers',
  'operator',
  'os',
  'pathlib',
  'pickle',
  'platform',
  'pprint',
  'random',
  're',
  'readline',
  'reprlib',
  'secrets',
  'shutil',
  'signal',
  'socket',
  'sqlite3',
  'ssl',
  'stat',
  'statistics',
  'string',
  'subprocess',
  'sys',
  'tempfile',
  'termios',
  'textwrap',
  'threading',
  'time',
  'timeit',
  'tokenize',
  'traceback',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uuid',
  'warnings',
  'weakref',
  'xml',
  'zipfile',
]);

/** Import root → pip distribution, where the two differ (the common ones). */
const DISTRIBUTION_NAMES: Record<string, string> = {
  PIL: 'pillow',
  cv2: 'opencv-python',
  sklearn: 'scikit-learn',
  yaml: 'pyyaml',
  dateutil: 'python-dateutil',
  fitz: 'pymupdf',
};

/**
 * Third-party import roots of one Python source. Cross-checks what a blueprint
 * declares: an empty list beside code that imports torch would run checks in an
 * environment that cannot satisfy them, and the reverse wastes an install.
 */
export function deriveImportRoots(source: string): string[] {
  const roots = new Set<string>();
  for (const match of source.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)) {
    const root = (match[1] ?? '').split('.')[0];
    if (!root || STDLIB_ROOTS.has(root)) continue;
    roots.add(root);
  }
  return [...roots].sort();
}

/**
 * Import roots mapped to pip specs, deduplicated and grammar-validated.
 * When a worktree is given, roots that resolve inside it are dropped: they are
 * the repository's own modules, and pip has nothing to install for them (the
 * same distinction that keeps repair from pip-installing an internal package).
 */
/**
 * Which import roots are this tree's own modules rather than pip packages.
 *
 * Only the workspace root was checked, so `from src.geometry import ...` in a
 * generated implementation became a requirement called `geometry` and the
 * platform tried to pip install its own code. Checking under src/ as well
 * keeps local modules local, which is also what made every idea check pay for
 * a venv it did not need.
 */
async function isLocalModule(worktreeDir: string, root: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const name = root.includes('.') ? root.split('.')[root.split('.').length - 1]! : root;
  const candidates = [
    join(worktreeDir, root),
    join(worktreeDir, name),
    join(worktreeDir, 'src', root),
    join(worktreeDir, 'src', name),
  ];
  for (const candidate of candidates) {
    for (const probePath of [candidate, `${candidate}.py`, join(candidate, '__init__.py')]) {
      if (await stat(probePath).then(
        () => true,
        () => false,
      )) {
        return true;
      }
    }
  }
  return false;
}

export async function deriveRequirementsForWorktree(
  source: string,
  worktreeDir: string,
): Promise<string[]> {
  const specs = new Set<string>();
  for (const root of deriveImportRoots(source)) {
    if (await isLocalModule(worktreeDir, root)) continue;
    const spec = DISTRIBUTION_NAMES[root] ?? root.toLowerCase();
    if (validateRequirementSpec(spec)) specs.add(spec);
  }
  return [...specs].sort();
}

/** Import roots mapped to pip specs, without worktree awareness. */
export function deriveRequirements(source: string): string[] {
  const specs = new Set<string>();
  for (const root of deriveImportRoots(source)) {
    const spec = DISTRIBUTION_NAMES[root] ?? root.toLowerCase();
    if (validateRequirementSpec(spec)) specs.add(spec);
  }
  return [...specs].sort();
}

/** Asks the harness for a dependency plan and validates what comes back. */
export async function inferDependencies(opts: {
  harness: HarnessAdapter;
  worktreeDir: string;
  entry: string[];
  failureLog: string;
  runId: string;
  taskId: string;
  now: number;
}): Promise<DependencyPlan> {
  const context = await buildDependencyContext(opts.worktreeDir, opts.entry, opts.failureLog);
  const result = await opts.harness.runTask({
    runId: opts.runId,
    taskId: `${opts.taskId}-deps`,
    // 'demo' is the tool-less reasoning profile: this call reads evidence and
    // returns JSON, and must not gain shell or file tools just to decide what
    // to install. A dedicated 'baseline-repair' capability profile belongs with
    // the DSH-side registry, not smuggled in here.
    profile: 'demo',
    instruction: DEP_INSTRUCTION,
    inputs: [{ kind: 'text', name: 'repository-evidence', content: context }],
    outputSchema: DEP_OUTPUT_SCHEMA,
    budget: { timeoutMs: 120_000, maxOutputTokens: 1024 },
    idempotencyKey: `deps:${opts.taskId}:${opts.now}`,
  });
  return parseDependencyPlan(result.output);
}
