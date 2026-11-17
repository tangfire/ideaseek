import { join, resolve } from 'node:path';
import { tmpdir as osTmp } from 'node:os';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  allowedToolsForRole,
  capabilityDecision,
  pathArgumentsOf,
  platformSegmentViolation,
  readFenceDecision,
  readScopeFromEnv,
} from '../src/dsh-plugins/capability-guard.js';

/** Stand-in for an IdeaSeek install, used by every fence case below. */
const platform = resolve(process.cwd(), 'platform-install');

describe('capabilityDecision (tools/pre-execute guard)', () => {
  it('allows exactly the research tools', () => {
    expect(capabilityDecision('project_read')).toEqual({ kind: 'allow' });
    expect(capabilityDecision('knowledge_search')).toEqual({ kind: 'allow' });
  });

  it('denies base-profile and privileged tools with an auditable reason', () => {
    for (const tool of ['read', 'grep', 'glob', 'bash', 'write', 'edit', 'str_replace_editor']) {
      const decision = capabilityDecision(tool);
      expect(decision.kind).toBe('deny');
      if (decision.kind === 'deny') {
        expect(decision.reason).toContain(tool);
        expect(decision.reason).toContain('capability profile');
        expect(decision.reason).toContain('project_read');
      }
    }
  });

  it('supports role-specific allowlists', () => {
    const role = new Set(['project_read']);
    expect(capabilityDecision('knowledge_search', role).kind).toBe('deny');
    expect(capabilityDecision('project_read', role).kind).toBe('allow');
  });

  it('is wired into the generated capability patch', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../src/dsh-plugins/capability-guard.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain("ctx.on('tools/pre-execute'");
    expect(source).toContain("kind: 'deny'");
    const capability = readFileSync(
      fileURLToPath(new URL('../src/dsh/capability.ts', import.meta.url)),
      'utf8',
    );
    expect(capability).toContain('capability-guard');
    expect(capability).toContain('ideaseek-capability-guard');
  });
});

describe('read fence (a research session reads research, not the platform)', () => {
  // Real evidence this exists for: an FDG implementation session, confined to
  // ideas/<id>, read `D:\IdeaSeek\src\idea\check.ts` and then grepped
  // `D:\IdeaSeek\src`, because a platform gate had refused its output and the
  // agent went to reverse-engineer the gate instead of fixing the code.
  const scope = { allow: [], deny: [join(platform, 'src'), join(platform, 'dist')] };

  it('denies the platform source and says what to do instead', () => {
    const decision = readFenceDecision(join(platform, 'src', 'idea', 'check.ts'), scope);
    expect(decision.kind).toBe('deny');
    if (decision.kind !== 'deny') throw new Error('unreachable');
    expect(decision.reason).toContain('fenced');
    // The remedy is stated as an action the agent can take inside its session,
    // not as a rule it has to go and read source to understand.
    expect(decision.reason).toContain('quote the refusal text');
    expect(decision.reason).toContain('task input');
  });

  it('does not fence a sibling whose name merely starts with the denied segment', () => {
    // `platform-install/src-evil` is not inside `platform-install/src`, and a
    // prefix-string comparison would deny it. A fence with that bug is
    // decorative in one direction and wrong in the other.
    expect(readFenceDecision(join(platform, 'src-evil', 'x.ts'), scope).kind).toBe('allow');
    expect(readFenceDecision(join(platform, 'papers', 'x.pdf'), scope).kind).toBe('allow');
  });

  it('treats an empty allow list as no scope declared, and honours one when set', () => {
    const root = join(process.cwd(), 'ideas', 'probe');
    expect(readFenceDecision(join(tmpdir(), 'elsewhere.csv'), scope).kind).toBe('allow');
    const declared = { allow: [root], deny: [] };
    expect(readFenceDecision(join(root, 'src', 'train.py'), declared).kind).toBe('allow');
    const outside = readFenceDecision(join(tmpdir(), 'elsewhere.csv'), declared);
    expect(outside.kind).toBe('deny');
    if (outside.kind !== 'deny') throw new Error('unreachable');
    // The denial names the roots it wanted, or the reader cannot tell a policy
    // from a bug.
    expect(outside.reason).toContain(root);
  });

  it('takes its roots from the parent environment only', () => {
    expect(readScopeFromEnv({})).toEqual({ allow: [], deny: [] });
    const relative = { IDEASEEK_READ_DENY_ROOTS: 'src;dist' };
    // A relative entry is not a root: honouring one would let the session's own
    // cwd decide what is fenced, which is exactly the ambiguity this avoids.
    expect(readScopeFromEnv(relative)).toEqual({ allow: [], deny: [] });
    const absolute = { IDEASEEK_READ_ROOTS: join(platform, 'papers') };
    expect(readScopeFromEnv(absolute).allow).toEqual([join(platform, 'papers')]);
  });

  it('reads only the path arguments a tool really carries', () => {
    expect(pathArgumentsOf('read', { file_path: 'src/a.py' })).toEqual(['src/a.py']);
    expect(pathArgumentsOf('grep', { pattern: 'x', path: 'D:/FDG/papers' })).toEqual([
      'D:/FDG/papers',
    ]);
    expect(pathArgumentsOf('grep', { pattern: 'x', paths: ['a', 'b'] })).toEqual(['a', 'b']);
    // No invented targets: an unrecognised argument is not guessed at, or a
    // fence would deny legitimate work based on a path nobody asked for.
    expect(pathArgumentsOf('grep', { pattern: 'todo' })).toEqual([]);
    expect(pathArgumentsOf('skill', { name: 'diagnose-acl' })).toEqual([]);
    expect(pathArgumentsOf('read', 'not-an-object')).toEqual([]);
  });
});

describe('capability roles', () => {
  it('never lets the coding role silently lose its file tools', () => {
    // The guard's allowlist rule is what kept the patch off the coding path in
    // the first place: mounting it with the extractor set would have denied
    // write/read/grep outright. An empty set means "visibility is not this
    // guard's job here", and only the read fence applies.
    expect(allowedToolsForRole('coding').size).toBe(0);
    expect(capabilityDecision('write', allowedToolsForRole('coding')).kind).toBe('allow');
    expect(capabilityDecision('bash', allowedToolsForRole('coding')).kind).toBe('allow');
    // The extractor profile keeps refusing exactly what it refused before.
    expect(capabilityDecision('write', allowedToolsForRole('extractor')).kind).toBe('deny');
  });
});

describe('coding session boot mount (the patch finally reaches the flagship path)', () => {
  it('writes a coding patch without the extractor preset and keeps the credential env intact', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { join: pathJoin } = await import('node:path');
    const { tmpdir: osTmp } = await import('node:os');
    const { codingSessionBoot } = await import('../src/dsh/session.js');
    const dshHome = await mkdtemp(pathJoin(osTmp(), 'ideaseek-coding-boot-'));
    const boot = await codingSessionBoot({ cwd: process.cwd(), dshHome });

    // A coding session must keep DSH's own tool visibility: mounting the
    // extractor preset here would deny write/read/grep and break the very path
    // this change is meant to secure. That is why the flagship path historically
    // mounted no patch at all — the fix had to separate the two roles.
    const yaml = await readFile(boot.patchPath, 'utf8');
    expect(yaml).toContain('ideaseek-capability-guard');
    expect(yaml).not.toContain('ideaseek-agent-preset-registry');
    expect(boot.patches).toEqual([boot.patchPath]);
    expect(boot.env.IDEASEEK_CAPABILITY_ROLE).toBe('coding');
    expect(boot.env.IDEASEEK_READ_DENY_ROOTS).toContain('src');

    // `env` replaces the child's whole environment in this SDK, so anything not
    // copied is gone: losing the credential variable would have turned a read
    // fence into "no model calls work any more".
    expect(boot.env.PATH ?? boot.env.Path).toBeDefined();
    expect(boot.env.DEEPSEEK_API_KEY === process.env.DEEPSEEK_API_KEY).toBe(true);

    // And the extractor role keeps its own file, so the two mounts cannot
    // overwrite each other inside one DSH home.
    const { writeCapabilityPatch } = await import('../src/dsh/capability.js');
    const extractor = await writeCapabilityPatch({ dshHome });
    expect(extractor.patchPath).not.toBe(boot.patchPath);
    expect(extractor.yaml).toContain('ideaseek-agent-preset-registry');
  });
});

describe('platform-managed segments are fenced for every tool, not just ours', () => {
  it('catches .research and .env at any depth, and leaves real work alone', () => {
    // The inconsistency this closes: `project_read` already refused these
    // segments, while DSH's own read/grep/glob — the tools a coding session
    // actually uses — did not, so the rule only applied to the path nobody
    // takes any more.
    const scope = { allow: [], deny: [] };
    for (const target of [
      join(platform, '.research', 'events.db'),
      join(platform, 'ideas', 'probe', '.research', 'logs', 'smoke.log'),
      join(platform, '.env'),
      join(platform, '.env.local'),
    ]) {
      const decision = readFenceDecision(target, scope);
      expect(decision.kind).toBe('deny');
      if (decision.kind === 'deny') expect(decision.reason).toContain('platform-managed');
    }
    for (const target of [
      join(platform, 'ideas', 'probe', 'src', 'train.py'),
      join(platform, 'papers', 'attention.pdf'),
      join(platform, 'datasets-derived', 'pacs-smoke', 'domain0.csv'),
      join(platform, 'researched', 'notes.md'),
    ]) {
      expect(readFenceDecision(target, scope).kind).toBe('allow');
    }
    // `researched` and a `.researcher` directory are not the platform tree:
    // matching must be by segment, not by substring, or it denies a
    // researcher's own files and gets removed for being wrong.
    expect(platformSegmentViolation(join(platform, 'researched', 'x.md'))).toBeNull();
    expect(platformSegmentViolation(join(platform, '.researcher', 'x.md'))).toBeNull();
  });
});

describe('the fence must say when it is not armed', () => {
  it('derives real roots for both layouts and warns when it found none', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { codingSessionBoot, projectRootFor } = await import('../src/dsh/session.js');
    const home = await mkdtemp(join(osTmp(), 'ideaseek-fence-boot-'));
    const boot = await codingSessionBoot({ cwd: process.cwd(), dshHome: home });
    // Running from the development checkout, so the platform tree must resolve.
    // An empty deny list here would mean the fence is decorative, and that has
    // already happened once with the installed layout — hence the warning
    // field existing at all instead of the list simply being empty.
    expect(boot.denyRoots.length).toBeGreaterThan(0);
    expect(boot.fenceWarning).toBeNull();
    expect(boot.env.IDEASEEK_READ_DENY_ROOTS).toContain('src');
    // The project (which holds papers/, datasets/, comparisons/) is an allowed
    // root, so fencing the platform cannot accidentally fence the research.
    expect(boot.env.IDEASEEK_READ_ROOTS).toContain(resolve(process.cwd()));
    expect(projectRootFor(join(process.cwd(), 'ideas', 'x', 'src'))).toBe(resolve(process.cwd()));
    // A directory with no ideas/ above it is its own root: no silent escape to
    // some ancestor the operator never intended to open up.
    expect(projectRootFor(osTmp())).toBe(resolve(osTmp()));
  });
});
