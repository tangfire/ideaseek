import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRepository, REPOSITORY_PARSER_VERSION } from '../src/knowledge/repository.js';
import { isIdeaseekError } from '../src/core/errors.js';

/**
 * Codebase Analyst fixtures use an *arbitrary* repository layout on purpose:
 * no `src/train.py`, no assumed top-level scripts. Every conclusion must come
 * from filename/content evidence, and ambiguity must surface as openQuestions.
 */

async function makeRepo(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), name));
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, ...relPath.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

const ARBITRARY_REPO: Record<string, string> = {
  'README.md': [
    '# ML Pipeline',
    '',
    'Trains and evaluates a scikit-learn baseline on tabular data; api_key: sk-abcdefghijklmno123456 is required.',
    '',
    '## Usage',
    '',
    'Run the experiment script in pipeline/.',
    '',
  ].join('\n'),
  'requirements.txt': 'numpy==1.26.4\nscikit-learn==1.5.0\n',
  '.env': 'DEEPSEEK_API_KEY=sk-realsecretvalue999\n',
  'pipeline/run_experiment.py': [
    'import argparse',
    '',
    'def train_one_epoch(optimizer):',
    '    loss = 0',
    '    optimizer.step()',
    '    return loss',
    '',
    'def main():',
    '    parser = argparse.ArgumentParser()',
    '    parser.add_argument("--epochs", type=int, default=3)',
    '    parser.add_argument("--batch-size", type=int, default=32)',
    '    args = parser.parse_args()',
    '    optimizer = None',
    '    train_one_epoch(optimizer)',
    '',
    'if __name__ == "__main__":',
    '    main()',
    '',
  ].join('\n'),
  'pipeline/evaluate.py': [
    'from sklearn.metrics import accuracy_score, f1_score',
    '',
    'def evaluate(y_true, y_pred):',
    '    acc = accuracy_score(y_true, y_pred)',
    '    f1 = f1_score(y_true, y_pred)',
    '    return {"accuracy": acc, "f1": f1}',
    '',
  ].join('\n'),
  'pipeline/data_io.py': [
    'import pandas as pd',
    '',
    'def load_frame(path):',
    '    return pd.read_csv(path)',
    '',
  ].join('\n'),
  'pipeline/metrics_impl.py': [
    'from sklearn.metrics import accuracy_score, precision_score, recall_score',
    '',
    'def compute_metrics(y_true, y_pred):',
    '    return accuracy_score(y_true, y_pred)',
    '',
  ].join('\n'),
  'configs/default.yaml': 'train:\n  epochs: 10\n  batch_size: 32\n',
  'scripts/start.sh': 'python pipeline/run_experiment.py --epochs 5\n',
  'tests/test_pipeline.py': 'import pytest\n\ndef test_sum():\n    assert 1 + 1 == 2\n',
  'samples/train.csv': 'a,b\n1,2\n3,4\n',
};

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else out.push(full);
    }
  };
  await visit(root);
  return out.sort();
}

describe('analyzeRepository: arbitrary-structure codebase', () => {
  it('discovers README, deps, train/eval/test entries, data interfaces and metrics without fixed paths', async () => {
    const repo = await makeRepo('ideaseek-repo-');
    await writeFiles(repo, ARBITRARY_REPO);

    const understanding = await analyzeRepository(repo, { now: 1000 });

    expect(understanding.understandingVersion).toBe(1);
    expect(understanding.parserVersion).toBe(REPOSITORY_PARSER_VERSION);
    expect(understanding.analyzedAt).toBe(1000);
    expect(understanding.source.files).toBe(Object.keys(ARBITRARY_REPO).length);
    expect(understanding.source.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // README found at root with headings and summary.
    expect(understanding.readme.path).toBe('README.md');
    expect(understanding.readme.headings).toContain('Usage');
    expect(understanding.readme.summary).toContain('Trains and evaluates');

    // Dependencies parsed from requirements.txt (no fixed layout assumption).
    expect(understanding.dependencies.manifests).toEqual(['requirements.txt']);
    const depNames = understanding.dependencies.records.map((record) => record.name);
    expect(depNames).toContain('numpy');
    expect(depNames).toContain('scikit-learn');
    expect(understanding.dependencies.unparsedManifests).toEqual([]);

    // Training entry discovered via content signals, NOT src/train.py.
    const trainPaths = understanding.entrypoints.training.map((candidate) => candidate.path);
    expect(trainPaths).toContain('pipeline/run_experiment.py');
    const train = understanding.entrypoints.training.find(
      (candidate) => candidate.path === 'pipeline/run_experiment.py',
    )!;
    expect(train.confidence).toBeGreaterThanOrEqual(0.6);
    expect(train.signals).toContain('c:epochs-flag');
    expect(train.evidence.length).toBeGreaterThan(0);
    expect(train.evidence[0]!.field).toBe('entrypoints.training');
    expect(train.evidence[0]!.line).toBeGreaterThan(0);

    // Evaluation entry.
    const evalPaths = understanding.entrypoints.evaluation.map((candidate) => candidate.path);
    expect(evalPaths).toContain('pipeline/evaluate.py');

    // Test entry from tests/ + pytest signals.
    const testPaths = understanding.entrypoints.test.map((candidate) => candidate.path);
    expect(testPaths).toContain('tests/test_pipeline.py');

    // Data interfaces: loader code + committed data file with split name.
    const dataPaths = understanding.dataInterfaces.map((candidate) => candidate.path);
    expect(dataPaths).toContain('pipeline/data_io.py');
    expect(dataPaths).toContain('samples/train.csv');
    const split = understanding.dataInterfaces.find(
      (candidate) => candidate.path === 'samples/train.csv',
    )!;
    expect(split.kind).toBe('split');
    const loader = understanding.dataInterfaces.find(
      (candidate) => candidate.path === 'pipeline/data_io.py',
    )!;
    expect(loader.kind).toBe('dataset-loader');
    expect(loader.signals).toContain('c:tabular-read');

    // Metrics with concrete names.
    const metric = understanding.metrics.find(
      (candidate) => candidate.path === 'pipeline/metrics_impl.py',
    );
    expect(metric).toBeDefined();
    expect(metric!.names).toContain('accuracy_score');
    expect(metric!.confidence).toBeGreaterThan(0.5);

    // Configs in an arbitrary configs/ directory.
    expect(understanding.configs).toContain('configs/default.yaml');

    // Languages and evidence.
    const languages = understanding.languages.map((stat) => stat.language);
    expect(languages).toContain('Python');
    expect(languages).toContain('Shell');
    expect(languages).toContain('YAML');
    expect(understanding.evidence.length).toBeGreaterThan(0);
    expect(understanding.evidence.length).toBeLessThanOrEqual(150);

    // No blocking open questions for a complete repository.
    for (const question of understanding.openQuestions) {
      expect(question).not.toContain('no training entry');
      expect(question).not.toContain('no evaluation entry');
      expect(question).not.toContain('no README');
      expect(question).not.toContain('no dependency manifest');
    }
    expect(understanding.needsConfirmation).toBe(true);
    expect(understanding.confidence).toBeGreaterThan(0.7);
  });

  it('keeps secrets out of the output (redacted snippets, no .env content)', async () => {
    const repo = await makeDirSecretRepo();
    const understanding = await analyzeRepository(repo, { now: 1000 });
    const serialized = JSON.stringify(understanding);
    expect(serialized).not.toContain('sk-abcdefghijklmno123456');
    expect(serialized).not.toContain('realsecretvalue999');
    expect(serialized).toContain('***'); // README snippet was redacted, not dropped
    // .env contributes path+hash to the snapshot only, never content.
    expect(understanding.source.files).toBeGreaterThan(0);
    expect(understanding.evidence.some((item) => item.path === '.env')).toBe(false);
  });

  async function makeDirSecretRepo(): Promise<string> {
    const repo = await makeRepo('ideaseek-secret-');
    await writeFiles(repo, ARBITRARY_REPO);
    return repo;
  }

  it('is deterministic and read-only', async () => {
    const repo = await makeRepo('ideaseek-determinism-');
    await writeFiles(repo, ARBITRARY_REPO);
    const before = await listTree(repo);

    const first = await analyzeRepository(repo, { now: 42 });
    const second = await analyzeRepository(repo, { now: 42 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const after = await listTree(repo);
    expect(after).toEqual(before);
    // Re-analyzing unchanged content yields the same snapshot identity.
    expect(second.source.snapshotHash).toBe(first.source.snapshotHash);
  });

  it('changes the snapshot hash when repository content changes', async () => {
    const repo = await makeRepo('ideaseek-snap-');
    await writeFiles(repo, { 'a.py': 'x = 1\n' });
    const first = await analyzeRepository(repo, { now: 1 });
    await writeFile(join(repo, 'a.py'), 'x = 2\n', 'utf8');
    const second = await analyzeRepository(repo, { now: 1 });
    expect(second.source.snapshotHash).not.toBe(first.source.snapshotHash);
  });
});

describe('analyzeRepository: failure and ambiguity paths', () => {
  it('reports an empty repository honestly', async () => {
    const repo = await makeRepo('ideaseek-empty-');
    const understanding = await analyzeRepository(repo, { now: 5 });
    expect(understanding.source.files).toBe(0);
    expect(understanding.readme.path).toBeNull();
    expect(understanding.entrypoints.training).toEqual([]);
    expect(understanding.openQuestions).toContain('repository contains no files');
    expect(understanding.openQuestions).toContain('no README found anywhere in the repository');
    expect(understanding.openQuestions).toContain('no dependency manifest detected');
    expect(understanding.openQuestions).toContain(
      'no training entry detected; confirm how training is launched',
    );
    expect(understanding.confidence).toBe(0);
    expect(understanding.needsConfirmation).toBe(true);
  });

  it('flags a missing README and unparsed dependency manifests', async () => {
    const repo = await makeRepo('ideaseek-no-readme-');
    await writeFiles(repo, {
      'setup.py': 'from setuptools import setup\nsetup(install_requires=["requests"])\n',
      'main.py': 'def main():\n    pass\n',
    });
    const understanding = await analyzeRepository(repo, { now: 6 });
    expect(understanding.readme.path).toBeNull();
    expect(understanding.openQuestions).toContain('no README found anywhere in the repository');
    expect(understanding.dependencies.manifests).toEqual(['setup.py']);
    expect(understanding.dependencies.unparsedManifests).toEqual(['setup.py']);
    expect(understanding.openQuestions.join(' ')).toContain('not statically parsed: setup.py');
    expect(understanding.openQuestions).toContain(
      'no training entry detected; confirm how training is launched',
    );
  });

  it('asks the user to disambiguate multiple training entries', async () => {
    const repo = await makeRepo('ideaseek-multi-train-');
    await writeFiles(repo, {
      'train.py':
        'import argparse\ndef train():\n    optimizer = None\n    optimizer.step()\nif __name__ == "__main__":\n    train()\n',
      'fine_tune.py':
        'import argparse\ndef train():\n    optimizer = None\n    optimizer.step()\nif __name__ == "__main__":\n    train()\n',
      'README.md': '# two entries\n',
      'requirements.txt': 'torch==2.0.0\n',
    });
    const understanding = await analyzeRepository(repo, { now: 7 });
    const paths = understanding.entrypoints.training.map((candidate) => candidate.path);
    expect(paths).toContain('train.py');
    expect(paths).toContain('fine_tune.py');
    const question = understanding.openQuestions.find((q) => q.includes('multiple training entry'));
    expect(question).toBeDefined();
    expect(question).toContain('train.py');
    expect(question).toContain('fine_tune.py');
  });

  it('still finds entries in a conventional layout (no false negative)', async () => {
    const repo = await makeRepo('ideaseek-standard-');
    await writeFiles(repo, {
      'train.py':
        'import argparse\ndef train():\n    optimizer = None\n    optimizer.step()\nif __name__ == "__main__":\n    train()\n',
      'eval.py':
        'from sklearn.metrics import accuracy_score\ndef run_eval():\n    return accuracy_score([1], [1])\n',
      'tests/test_train.py': 'def test_ok():\n    assert True\n',
      'requirements.txt': 'scikit-learn\n',
      'README.md': '# standard\n',
    });
    const understanding = await analyzeRepository(repo, { now: 8 });
    expect(understanding.entrypoints.training.map((c) => c.path)).toContain('train.py');
    expect(understanding.entrypoints.evaluation.map((c) => c.path)).toContain('eval.py');
    expect(understanding.entrypoints.test.map((c) => c.path)).toContain('tests/test_train.py');
  });

  it('rejects missing paths and non-directories', async () => {
    try {
      await analyzeRepository(join(tmpdir(), 'definitely-missing-repo-xyz'));
      expect.unreachable('missing repo should throw');
    } catch (error) {
      expect(isIdeaseekError(error)).toBe(true);
      if (isIdeaseekError(error)) expect(error.code).toBe('FILE_NOT_FOUND');
    }

    const repo = await makeRepo('ideaseek-file-not-dir-');
    const filePath = join(repo, 'a-file.py');
    await writeFile(filePath, 'x = 1\n', 'utf8');
    try {
      await analyzeRepository(filePath);
      expect.unreachable('file path should throw');
    } catch (error) {
      expect(isIdeaseekError(error)).toBe(true);
      if (isIdeaseekError(error)) expect(error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('honors the file budget and records it as an open question', async () => {
    const repo = await makeRepo('ideaseek-budget-');
    const files: Record<string, string> = { 'README.md': '# many files\n' };
    for (let index = 0; index < 20; index++) files[`src/mod${index}.py`] = `x${index} = ${index}\n`;
    await writeFiles(repo, files);

    const understanding = await analyzeRepository(repo, { now: 9, maxFiles: 5 });
    expect(understanding.source.files).toBe(5);
    expect(understanding.openQuestions.join(' ')).toContain('file budget exceeded (5)');
  });

  it('skips binary files for content signals but keeps them in the snapshot', async () => {
    const repo = await makeRepo('ideaseek-binary-');
    await writeFiles(repo, { 'model.bin': 'placeholder' });
    await writeFile(join(repo, 'model.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
    const understanding = await analyzeRepository(repo, { now: 10 });
    expect(understanding.source.files).toBe(1);
    expect(understanding.evidence).toEqual([]);
  });
});
