import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IDEA_DIAGNOSIS_SCHEMA,
  parseDiagnosisOutput,
  validateIdeaDiagnosis,
  type ImproveContext,
} from '../src/idea/improve.js';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * `idea improve` (docs/IDEA_IMPROVEMENT.md 诊断阶段): scan → confirm →
 * import → diagnose. The diagnosis envelope binds the user question and
 * the registered seed rootHash — a changed source or echoed-question
 * mismatch fails closed with zero writes.
 */

function validDiagnosis(question = 'why does generalization fail?'): Record<string, unknown> {
  return {
    contract: IDEA_DIAGNOSIS_SCHEMA,
    question,
    source: { path: 'idea-seeds/hetero', rootHash: `sha256:${'a'.repeat(64)}` },
    baselineStatus: 'reproduced',
    mechanismSummary: 'The seed averages client updates with a reweighting term.',
    failureCategories: ['data_issue', 'hypothesis_issue'],
    findings: [
      {
        area: 'data',
        finding: 'Label skew concentrates on few clients.',
        evidence: [{ source: 'idea-seeds/hetero/README.md', location: 'dataset section' }],
      },
    ],
    routes: [
      {
        kind: 'engineering',
        summary: 'Fix the reweighting estimator bug.',
        expectedChange: 'Stable quick-slice metrics.',
        risks: 'No scientific claim change.',
        discriminatingExperiment: 'Re-run the quick slice with the patched estimator.',
        stopConditions: ['metric variance unchanged after two runs'],
      },
    ],
  };
}

function improveContext(): ImproveContext {
  return {
    question: 'why does generalization fail?',
    sourceRel: 'idea-seeds/hetero',
    sourceRootHash: `sha256:${'a'.repeat(64)}`,
    files: ['idea-seeds/hetero/README.md'],
    evidenceLines: ['spec:repro-fedavg v1 [succeeded]'],
  };
}

describe('validateIdeaDiagnosis (contract)', () => {
  it('accepts a complete diagnosis', () => {
    const result = validateIdeaDiagnosis(validDiagnosis());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  const rejected: { name: string; value: unknown }[] = [
    { name: 'null', value: null },
    {
      name: 'empty question',
      value: (() => {
        const d = validDiagnosis();
        d.question = ' ';
        return d;
      })(),
    },
    {
      name: 'bad baselineStatus',
      value: (() => {
        const d = validDiagnosis();
        d.baselineStatus = 'maybe';
        return d;
      })(),
    },
    {
      name: 'empty failureCategories',
      value: (() => {
        const d = validDiagnosis();
        d.failureCategories = [];
        return d;
      })(),
    },
    {
      name: 'unknown category',
      value: (() => {
        const d = validDiagnosis();
        d.failureCategories = ['vibes'];
        return d;
      })(),
    },
    {
      name: 'no findings',
      value: (() => {
        const d = validDiagnosis();
        d.findings = [];
        return d;
      })(),
    },
    {
      name: 'finding without evidence',
      value: (() => {
        const d = validDiagnosis();
        (d.findings as Record<string, unknown>[])[0]!.evidence = [];
        return d;
      })(),
    },
    {
      name: 'no routes',
      value: (() => {
        const d = validDiagnosis();
        d.routes = [];
        return d;
      })(),
    },
    {
      name: 'route missing discriminatingExperiment',
      value: (() => {
        const d = validDiagnosis();
        delete (d.routes as Record<string, unknown>[])[0]!.discriminatingExperiment;
        return d;
      })(),
    },
    {
      name: 'route without stopConditions',
      value: (() => {
        const d = validDiagnosis();
        (d.routes as Record<string, unknown>[])[0]!.stopConditions = [];
        return d;
      })(),
    },
    {
      name: 'unknown route kind',
      value: (() => {
        const d = validDiagnosis();
        (d.routes as Record<string, unknown>[])[0]!.kind = 'vibes';
        return d;
      })(),
    },
  ];
  for (const testCase of rejected) {
    it(`rejects: ${testCase.name}`, () => {
      const result = validateIdeaDiagnosis(testCase.value);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  }
});

describe('parseDiagnosisOutput (envelope bindings)', () => {
  it('accepts matching bindings', () => {
    const parsed = parseDiagnosisOutput(JSON.stringify(validDiagnosis()), improveContext());
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.source.rootHash).toBe(improveContext().sourceRootHash);
  });

  it('rejects a wrong contract, stale source and echoed question', () => {
    const wrongContract = { ...validDiagnosis(), contract: 'other-v1' };
    expect(() => parseDiagnosisOutput(JSON.stringify(wrongContract), improveContext())).toThrow(
      /contract must be/,
    );

    const stale = validDiagnosis();
    (stale.source as Record<string, string>).rootHash = `sha256:${'b'.repeat(64)}`;
    expect(() => parseDiagnosisOutput(JSON.stringify(stale), improveContext())).toThrow(
      /source binding/,
    );

    const wrongQuestion = validDiagnosis('different question');
    expect(() => parseDiagnosisOutput(JSON.stringify(wrongQuestion), improveContext())).toThrow(
      /verbatim/,
    );
  });
});

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...env },
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

async function seededProject(): Promise<{ dir: string }> {
  const dir = await makeProjectDir();
  await mkdir(join(dir, 'idea-seeds', 'hetero', 'code'), { recursive: true });
  await writeFile(join(dir, 'idea-seeds', 'hetero', 'README.md'), '# hetero idea\n', 'utf8');
  await writeFile(join(dir, 'idea-seeds', 'hetero', 'idea.md'), 'Hypothesis: ...\n', 'utf8');
  await writeFile(
    join(dir, 'idea-seeds', 'hetero', 'code', 'train.py'),
    'def train():\n    return 1\n',
    'utf8',
  );
  expect((await runCli(dir, ['scan'])).code).toBe(0);
  expect((await runCli(dir, ['intake', '--confirm', 'idea-seeds/hetero/idea.md'])).code).toBe(0);
  expect((await runCli(dir, ['idea', 'import', '--source', 'idea-seeds/hetero'])).code).toBe(0);
  return { dir };
}

describe('ideaseek idea improve (e2e, fake harness)', () => {
  it('runs the gate chain and refuses unconfirmed/unregistered sources', async () => {
    const dir = await makeProjectDir();
    // No manifest at all.
    const noManifest = await runCli(dir, [
      'idea',
      'improve',
      '--source',
      'idea-seeds/x',
      '--question',
      'q',
    ]);
    expect(noManifest.code).not.toBe(0);
    expect(noManifest.stderr).toContain('ideaseek scan');

    // Scanned + confirmed but never imported.
    await mkdir(join(dir, 'idea-seeds', 'lonely'), { recursive: true });
    await writeFile(join(dir, 'idea-seeds', 'lonely', 'note.txt'), 'notes\n', 'utf8');
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    expect((await runCli(dir, ['intake', '--confirm', 'idea-seeds/lonely/note.txt'])).code).toBe(0);
    const unregistered = await runCli(dir, [
      'idea',
      'improve',
      '--source',
      'idea-seeds/lonely',
      '--question',
      'q',
    ]);
    expect(unregistered.code).not.toBe(0);
    expect(unregistered.stderr).toContain('ideaseek idea import');
  }, 180_000);

  it('diagnoses a registered seed, binds question + rootHash, then reuses', async () => {
    const { dir } = await seededProject();

    const first = await runCli(dir, [
      'idea',
      'improve',
      '--source',
      'idea-seeds/hetero',
      '--question',
      'why does generalization fail?',
      '--harness',
      'fake',
    ]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('diagnosis written');
    expect(first.stdout).toContain('route 1 [engineering]');

    const stored = JSON.parse(
      await readFile(join(dir, 'knowledge', 'improve', 'hetero.json'), 'utf8'),
    ) as {
      contract: string;
      inputHash: string;
      diagnosis: {
        question: string;
        source: { path: string; rootHash: string };
        failureCategories: string[];
        routes: { kind: string }[];
      };
    };
    expect(stored.contract).toBe('idea-diagnosis-v1');
    expect(stored.inputHash).toMatch(/^sha256:/);
    expect(stored.diagnosis.question).toBe('why does generalization fail?');
    expect(stored.diagnosis.source.path).toBe('idea-seeds/hetero');

    // rootHash must equal the registered snapshot (envelope binding).
    const registry = JSON.parse(
      await readFile(join(dir, 'knowledge', 'idea-seeds.json'), 'utf8'),
    ) as { seeds: { source: string; snapshot: { rootHash: string } }[] };
    const registration = registry.seeds.find((seed) => seed.source === 'idea-seeds/hetero')!;
    expect(stored.diagnosis.source.rootHash).toBe(registration.snapshot.rootHash);
    expect(stored.diagnosis.failureCategories.length).toBeGreaterThan(0);

    // Same question + same bytes → idempotent reuse.
    const second = await runCli(dir, [
      'idea',
      'improve',
      '--source',
      'idea-seeds/hetero',
      '--question',
      'why does generalization fail?',
      '--harness',
      'fake',
    ]);
    expect(second.stdout).toContain('reused diagnosis');

    // A different question changes inputHash → regenerates.
    const third = await runCli(dir, [
      'idea',
      'improve',
      '--source',
      'idea-seeds/hetero',
      '--question',
      'what about fairness?',
      '--harness',
      'fake',
    ]);
    expect(third.stdout).toContain('diagnosis written');
  }, 300_000);

  it('maps quota blocks to exit 2 with nothing written', async () => {
    const { dir } = await seededProject();
    const blocked = await runCli(
      dir,
      ['idea', 'improve', '--source', 'idea-seeds/hetero', '--question', 'q', '--harness', 'fake'],
      { IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED' },
    );
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('nothing was written');
    await expect(
      readFile(join(dir, 'knowledge', 'improve', 'hetero.json'), 'utf8'),
    ).rejects.toThrow();
  }, 180_000);

  it('rejects contract-violating output with zero writes', async () => {
    const { dir } = await seededProject();
    const failed = await runCli(
      dir,
      ['idea', 'improve', '--source', 'idea-seeds/hetero', '--question', 'q', '--harness', 'fake'],
      { IDEASEEK_FAKE_IMPROVE_OUTPUT: '{"contract":"idea-diagnosis-v1"}' },
    );
    expect(failed.code).not.toBe(0);
    // Envelope binding is checked before the field contract.
    expect(failed.stderr).toContain('source binding');
    await expect(
      readFile(join(dir, 'knowledge', 'improve', 'hetero.json'), 'utf8'),
    ).rejects.toThrow();
  }, 180_000);
});
