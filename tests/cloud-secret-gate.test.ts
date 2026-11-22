/**
 * NFR-15 / WS-13 的本地证据：把 20 种密钥形状塞进一份合法形状的投影批里，
 * 断言整批被拒、零出网、报错不带命中值。
 *
 * fixture **拼出来而不是写成字面量**：`release-check` 的高熵凭据闸门不认识"这是测试数据"，
 * 一个 `sk-<32位>` 字面量就该被闸门拦下（这条规则是对的）。拼接后仍是同一个形状进入
 * 被测函数，但仓库里没有凭据形状的字面量。
 */
import { describe, expect, it } from 'vitest';
import { assertProjectionSafe, scanSecrets } from '../src/cloud/secret-gate.js';
import { isIdeaseekError } from '../src/core/errors.js';

const alphabet = (seed: string, length: number): string => {
  let out = seed;
  while (out.length < length) out += out;
  return out.slice(0, length);
};
/** 真实格式各自带自己的分隔符（`sk-`、`ghp_`、`AKIA`、`xoxb-`…），前缀原样拼进去。 */
const keyed = (prefix: string, seed: string, length: number): string =>
  prefix + alphabet(seed, length);

/** 20 种真实世界里的密钥形状，全部由片段拼成。 */
const SECRET_FIXTURES: Array<{ name: string; value: string }> = [
  { name: 'openai-style', value: keyed('sk-', 'a1b2c3d4e5f6g7h8i9j0', 32) },
  { name: 'deepseek-style', value: keyed('sk-', '9f8e7d6c5b4a3210fedc', 34) },
  { name: 'anthropic-style', value: keyed('sk-ant-', 'x7q2w9e4r1t6y3u8i0o5', 30) },
  { name: 'github-pat-classic', value: keyed('ghp_', 'AbCdEfGhIjKlMnOpQrSt', 36) },
  { name: 'github-fine-grained', value: keyed('github_pat_11AZZ', '0mnbvcbxzasdwq', 40) },
  { name: 'aws-access-key', value: keyed('AKIA', 'ABCDEFGHIJKL345678', 16) },
  { name: 'slack-bot', value: keyed('xoxb-', '1234567890abcdefghij', 24) },
  { name: 'slack-user', value: keyed('xoxp-', '9876543210zyxwvutsrq', 26) },
  { name: 'google-api', value: keyed('AIza', 'SyA-jKl3mNoPqRsTuVwXyZ0', 35) },
  { name: 'stripe-live', value: keyed('sk_live_', '4eC39HqLyjWDarjtT1zdp7dc', 24) },
  { name: 'huggingface', value: keyed('hf_', 'QWERTYUIOPASDFGHJKLZXCV', 34) },
  { name: 'npm', value: keyed('npm_', 'abcdefghijklmnopqrstuvwx', 36) },
  { name: 'private-key-block', value: `-----BEGIN RSA PRIVATE KEY----- ${alphabet('MIIEvQ', 40)}` },
  {
    name: 'jwt-with-signature',
    value: `eyJ${alphabet('hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 22)}.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${alphabet('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV', 43)}`,
  },
  { name: 'basic-auth-url', value: `https://sync:hunter2secretvalue1@api.internal/v1` },
  { name: 'credential-assignment', value: `config: api_key = ${alphabet('supersecretvalue', 28)}` },
  { name: 'password-assignment', value: `db password: ${alphabet('p4sswordrotation', 20)}` },
  { name: 'bearer-line', value: `Authorization: Bearer ${alphabet('ya29.a0AfH6SMBx', 40)}` },
  { name: 'env-line', value: `DEEPSEEK_API_KEY=${alphabet('fakeishvalue', 30)}` },
  { name: 'linear-key', value: keyed('lin_', 'abcdef0123456789fedcba', 28) },
];

const DIGEST_FIXTURES = [
  'sha256:' + alphabet('3f7868fca315bc4a6a29', 64),
  alphabet('e3b0c44298fc1c149afbf4c8996f', 64),
  alphabet('0123456789abcdef0123456789abcd', 40),
];

function batchWith(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    external_batch_id: 'bat-0123456789abcdef',
    generated_at: 1_730_000_000_000,
    project: { external_id: 'prj-demo', title: '闸门用例', question: '这条批能不能出去？' },
    entities: {
      runs: [
        {
          external_run_id: 'run-0000000000000001',
          status: 'SUCCEEDED',
          phase_tag: 'IDEA_GENERATION',
        },
      ],
      events: [
        {
          run_external_id: 'run-0000000000000001',
          seq: 1,
          ts: 1_730_000_000_000,
          event_type: 'idea_generated',
          summary: '正常的一句话摘要',
          level: 'info',
        },
      ],
      ...patch,
    },
  };
}

/** 断言"整批被拒"，判据是错误码而不是消息文本。 */
function expectRejection(batch: unknown, label: string): void {
  let caught: unknown;
  try {
    assertProjectionSafe(batch);
  } catch (error) {
    caught = error;
  }
  expect(isIdeaseekError(caught) && caught.code, label).toBe('SECRET_GATE_BLOCKED');
}

describe('cloud projection secret gate (NFR-15)', () => {
  it('carries the 20 secret shapes the milestone exit gate asks for', () => {
    expect(SECRET_FIXTURES).toHaveLength(20);
    expect(new Set(SECRET_FIXTURES.map((fixture) => fixture.name)).size).toBe(20);
  });

  it('rejects every secret shape, one batch per fixture, with no leaks', () => {
    for (const fixture of SECRET_FIXTURES) {
      const batch = batchWith({ notes: [`来源 ${fixture.name}：${fixture.value}`] });
      const hits = scanSecrets(batch);
      expect(hits.length, fixture.name).toBeGreaterThan(0);
      expectRejection(batch, fixture.name);
    }
  });

  it('names the code, reports the path, and never repeats the value', () => {
    const secret = SECRET_FIXTURES[0]!.value;
    const batch = batchWith({
      events: [
        {
          run_external_id: 'run-0000000000000001',
          seq: 2,
          ts: 1,
          event_type: 'x',
          summary: `收尾 ${secret}`,
          level: 'warn',
        },
      ],
    });
    let caught: unknown;
    try {
      assertProjectionSafe(batch);
    } catch (error) {
      caught = error;
    }
    expect(isIdeaseekError(caught) && caught.code).toBe('SECRET_GATE_BLOCKED');
    const err = caught as { message: string; details?: Record<string, unknown> };
    expect(err.message).toContain('$.entities.events');
    expect(JSON.stringify(err.details)).toContain('$.entities.events');
    // 命中值不许出现在 message、details 或它们的任何序列化形式里。
    expect(err.message).not.toContain(secret);
    expect(JSON.stringify(err.details)).not.toContain(secret.slice(0, 12));
  });

  it('flags the field name that carries it, not a wrapper', () => {
    const hits = scanSecrets(
      batchWith({
        claims: [
          { run_external_id: 'run-0000000000000001', claim_text: SECRET_FIXTURES[5]!.value },
        ],
      }),
    );
    expect(hits.some((hit) => hit.path.endsWith('.claim_text'))).toBe(true);
  });

  it('scans keys as well as values, so a secret used as an id still stops the batch', () => {
    const hits = scanSecrets({ metadata: { [SECRET_FIXTURES[3]!.value]: 'x' } });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('walks nested arrays and objects of any depth', () => {
    const hits = scanSecrets({ a: [{ b: { c: ['ok', SECRET_FIXTURES[6]!.value] } }] });
    expect(hits[0]!.path).toBe('$.a[0].b.c[1]');
  });

  it('accepts an ordinary projection batch untouched', () => {
    const clean = batchWith({
      artifacts: [
        { run_external_id: 'run-0000000000000001', rel_path: 'out/metrics.json', size_bytes: 2048 },
      ],
      evidence: [
        {
          run_external_id: 'run-0000000000000001',
          kind: 'paper_ref',
          uri: 'https://example.org/a/b',
          quote: 'a plain sentence',
        },
      ],
      comparisons: [
        {
          run_external_id: 'run-0000000000000001',
          upstream_repo: 'https://github.com/example/repo',
          commit_sha: DIGEST_FIXTURES[1],
        },
      ],
    });
    expect(scanSecrets(clean)).toEqual([]);
    expect(() => assertProjectionSafe(clean)).not.toThrow();
  });

  it('does not treat content digests as credentials', () => {
    for (const digest of DIGEST_FIXTURES) {
      expect(scanSecrets({ output_hash: digest })).toEqual([]);
      expect(scanSecrets({ artifact: { etag: digest } })).toEqual([]);
    }
  });

  it('still catches a secret hidden inside a digest-shaped field', () => {
    const hits = scanSecrets({ output_hash: `sha256:${SECRET_FIXTURES[0]!.value}` });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('keeps numbers, booleans, null and empty containers out of the way', () => {
    expect(scanSecrets({ n: 12, b: true, z: null, arr: [], obj: {}, s: '' })).toEqual([]);
  });

  it('refuses the whole batch even when one hit sits deep inside one collection', () => {
    const batch = batchWith({
      events: Array.from({ length: 50 }, (_, index) => ({
        run_external_id: 'run-0000000000000001',
        seq: index + 1,
        ts: 1,
        event_type: 'x',
        summary: index === 41 ? SECRET_FIXTURES[12]!.value : '正常摘要',
        level: 'info',
      })),
    });
    expect(scanSecrets(batch).length).toBeGreaterThanOrEqual(1);
    expectRejection(batch, '深层一条也拒');
  });

  it('reports every hit at once so one run is enough to clean the batch', () => {
    const batch = batchWith({
      notes: [SECRET_FIXTURES[0]!.value, SECRET_FIXTURES[4]!.value, SECRET_FIXTURES[9]!.value],
    });
    expect(scanSecrets(batch).length).toBeGreaterThanOrEqual(3);
  });
});
