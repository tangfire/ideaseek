/**
 * 出网前的密钥闸门（NFR-15 / WS-13）。
 *
 * 位置是**序列化之前**：命中即整批拒绝，不存在"警告后继续上传"。这条不是风格问题——
 * `PROGRESS.md:485` 证实项目根 `.env` 里就是真 key 形状，而 `.gitignore` 只挡 Git，
 * 挡不住一次把事件摘要投上云的投影器。
 *
 * 两条同样重要的边界：
 * 1. **命中内容不回显**。报错只给规则名、路径、长度和前 4 字符；把命中的字符串本身
 *    写进 message/details，等于用另一条通道把密钥打到终端、日志和 CI 输出里。
 * 2. **不吞掉合法的哈希**。投影里到处是 `sha256:...` 与 64 位十六进制内容哈希，把它们
 *    当密钥拦下会让闸门在第一周就被关掉。所以"高熵串"这条只在字段名不像摘要时启用，
 *    而有名字的形状（`sk-`、`ghp_`、`AKIA`、`xox`、`AIza`、`-----BEGIN ... PRIVATE KEY`、
 *    `key = <值>` 赋值形状）**无条件命中**，不看字段名——攻击面恰恰是"密钥被塞进
 *    一个看起来人畜无害的自由文本字段"。
 */
import { IdeaseekError } from '../core/errors.js';

export interface SecretHit {
  /** 命中的规则名，出现在报错里；不含命中值。 */
  rule: string;
  /** 从批根节点开始的 JSON 路径，如 `$.entities.events[3].summary`。 */
  path: string;
  /** 命中片段的字符数。 */
  length: number;
  /** 片段前 4 个字符，用于人工定位；不足以还原密钥。 */
  head: string;
}

interface Shape {
  rule: string;
  re: RegExp;
  /** true = 只看内容，任何字段命中都算（有名字的密钥形状）。 */
  always: boolean;
}

const SHAPES: Shape[] = [
  { rule: 'openai/deepseek-style-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g, always: true },
  {
    rule: 'github-token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|github_pat_[A-Za-z0-9_]{20,}/g,
    always: true,
  },
  { rule: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{12,}\b/g, always: true },
  { rule: 'aws-secret-access-key', re: /\baws_secret_access_key\s*[:=]\s*\S{16,}/gi, always: true },
  { rule: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, always: true },
  { rule: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, always: true },
  { rule: 'stripe-key', re: /\b[sr]k_(live|test)_[0-9A-Za-z]{16,}\b/g, always: true },
  {
    rule: 'private-key-block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    always: true,
  },
  {
    rule: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g,
    always: true,
  },
  { rule: 'basic-auth-url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]{6,}@/gi, always: true },
  { rule: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{20,}\b/g, always: true },
  { rule: 'npm-token', re: /\bnpm_[A-Za-z0-9]{20,}\b/g, always: true },
  { rule: 'pypi-token', re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g, always: true },
  { rule: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, always: true },
  { rule: 'linear-notion-key', re: /\b(notion|lin_)[A-Za-z0-9_-]{20,}\b/g, always: true },
  {
    rule: 'credential-assignment',
    re: /(?:api[_-]?key|secret|token|password|passwd|credential|access[_-]?key)\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
    always: true,
  },
  { rule: 'bearer-credential', re: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, always: true },
  {
    rule: 'env-assignment',
    re: /^[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*\S{8,}/gm,
    always: true,
  },
  // 只有"字段名不像摘要"才启用：64 位十六进制内容哈希是投影的正常部分。
  { rule: 'long-base64-blob', re: /[A-Za-z0-9+/]{40,}={0,2}/g, always: false },
];

const HASH_FIELD_RE = /(hash|digest|checksum|etag|fingerprint)$/i;
const HEX_DIGEST = /^[0-9a-f]{32,}$/i;

/**
 * 这条只决定"高熵串"规则要不要让路，让路的对象是**内容摘要**：投影里的
 * `sha256:<64hex>` 与 `*_hash` 列是正常数据，一律拦下等于逼人在第一周关掉闸门。
 * 有名字的密钥形状不受这里影响（`always: true`），所以"把 key 存进 hash 字段"
 * 这种形状仍会被抓住。
 */
function looksLikeDigest(field: string, value: string): boolean {
  const bare = value.replace(/^sha\d+:/i, '').trim();
  if (HEX_DIGEST.test(bare)) return true;
  return HASH_FIELD_RE.test(field) && /^[0-9a-f]{16,}$/i.test(bare);
}

/** 走一遍批结构，返回所有命中；纯函数，不做任何 I/O，也不改数据。 */
export function scanSecrets(root: unknown): SecretHit[] {
  const hits: SecretHit[] = [];
  const visit = (value: unknown, path: string, keyName: string): void => {
    if (typeof value === 'string') {
      const digest = looksLikeDigest(keyName, value);
      for (const shape of SHAPES) {
        if (digest && !shape.always) continue;
        const matched = value.match(shape.re);
        if (!matched) continue;
        for (const fragment of matched) {
          hits.push({
            rule: shape.rule,
            path,
            length: fragment.length,
            head: fragment.slice(0, 4),
          });
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, keyName));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        // 字段名本身也可能带密钥（"把 key 当 id 用"是最省事的一种泄漏）。
        visit(key, `${path}.<key>`, key);
        visit(item, `${path}.${key}`, key);
      }
    }
  };
  visit(root, '$', '');
  return hits;
}

/**
 * 命中即拒绝整批。错误信息里只有规则名与路径，永不带命中值。
 */
export function assertProjectionSafe(batch: unknown): void {
  const hits = scanSecrets(batch);
  if (hits.length === 0) return;
  const rules = [...new Set(hits.map((hit) => hit.rule))].sort();
  throw new IdeaseekError(
    'SECRET_GATE_BLOCKED',
    `投影批被密钥闸门整批拒绝：${hits.length} 处命中，规则 ${rules.join(', ')}；` +
      `位置 ${hits
        .slice(0, 5)
        .map((hit) => hit.path)
        .join(' ')}${hits.length > 5 ? ' …' : ''}。` +
      '本批未发送、未落盘为待发送状态；请修正来源数据后重试。',
    { rules, paths: hits.map((hit) => hit.path), count: hits.length },
  );
}
