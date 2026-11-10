import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveIdeaseekCli, runKnowledgeSearch } from '../src/dsh-plugins/research-tools.js';
import { CLI_BIN } from './helpers.js';

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

describe('knowledge_search tool backing', () => {
  it('resolves the built CLI (env override wins)', async () => {
    const { access } = await import('node:fs/promises');
    const resolved = resolveIdeaseekCli();
    expect(resolved).not.toBeNull();
    await access(resolved!);

    const previous = process.env.IDEASEEK_CLI_PATH;
    process.env.IDEASEEK_CLI_PATH = CLI_BIN;
    try {
      expect(resolveIdeaseekCli()).toBe(CLI_BIN);
    } finally {
      if (previous === undefined) delete process.env.IDEASEEK_CLI_PATH;
      else process.env.IDEASEEK_CLI_PATH = previous;
    }
  });

  it('rejects empty queries', () => {
    expect(() => runKnowledgeSearch({ query: '   ', cwd: process.cwd() })).toThrow(/empty query/);
  });

  it('returns a friendly message when nothing is indexed yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-ktool-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const text = runKnowledgeSearch({ query: 'anything at all', cwd: dir });
    expect(text).toBe('no matching passages in parsed papers');
  });

  it('surfaces CLI failures (e.g. missing project) as tool errors', () => {
    const dir = tmpdir(); // not a project
    expect(() => runKnowledgeSearch({ query: 'x', cwd: dir })).toThrow(/knowledge_search failed/);
  });

  it('extractor allowlist includes both research tools', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const profilePath = join(
      fileURLToPath(new URL('../src/dsh-plugins/extractor-profile.ts', import.meta.url)),
    );
    const source = await readFile(profilePath, 'utf8');
    expect(source).toContain("'project_read'");
    expect(source).toContain("'knowledge_search'");
    const toolsSource = await readFile(
      fileURLToPath(new URL('../src/dsh-plugins/research-tools.ts', import.meta.url)),
      'utf8',
    );
    expect(toolsSource).toContain("name: 'knowledge_search'");
    expect(toolsSource).toContain('spawnSync');
  });

  it('finds indexed passages end to end (skips without python)', async () => {
    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-ktool-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const pdfPath = join(dir, 'incoming', 'attention.pdf');
    try {
      await makeFixturePdf(pdfPath);
    } catch {
      return; // python/pypdf unavailable
    }
    const runResult = await runCli(dir, [
      'run',
      '--question',
      'ktool',
      '--paper',
      pdfPath,
      '--json',
    ]);
    expect(runResult.code).toBe(0);

    const text = runKnowledgeSearch({ query: 'attention', cwd: dir });
    expect(text).toContain('incoming/attention.pdf:p1');
    expect(text).toContain('—');
  }, 90_000);
});
