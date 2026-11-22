/**
 * 出境批的**入口最小校验**。
 *
 * 这里刻意不是完整的契约校验器：`cloud-projection-v1.json` 才是唯一真源，
 * 完整校验器由构建期 ajv standalone 生成（SPIKE_SITES_RUNTIME.md §1 的方案 2），
 * 生成物落在 `generated/validate.ts`。本模块只承担两件在生成物就位之前
 * 必须成立的事：
 *
 * 1. 版本协商：主版本不认识就整批拒绝，不能"尽力解析"——那是静默降级的起点。
 * 2. 形状门：批量大小/字节数上限与"未知顶层键"必须先挡掉，否则后面每个
 *    写路径都要各自赌一把。
 *
 * 真正的字段级不变量（长度、`sha256:` 形状、withheld 假设不得带全文）由
 * ingest.ts 的逐字段构造负责；`tests/function-contract-parity.test.ts` 钉住
 * 本模块的键集合与 `cloud-projection-v1.json` 完全一致，防止两处各说各话。
 */
export const SUPPORTED_SCHEMA_MAJOR = 1;

export class ContractError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ContractError';
    this.status = status;
  }
}

/** 与 cloud-projection-v1 的 maxItems 保持一致；收紧时两边一起改。 */
const MAX_EVENTS = 5_000;
const MAX_COLLECTION_ROWS = 50_000;

export interface BatchEnvelope {
  schema_version: number;
  external_batch_id: string;
  generated_at: number;
  local_schema_version: number;
  project: Record<string, unknown> & { external_id: string };
  entities: Record<string, unknown[]>;
}

const KNOWN_TOP_LEVEL = new Set([
  'schema_version',
  'external_batch_id',
  'generated_at',
  'local_schema_version',
  'project',
  'entities',
]);

/**
 * 允许出现在批次里的实体集合。**未知集合一律拒绝**——新增一类实体是一次
 * 契约变更，必须显式登记；把它当"多余字段忽略掉"会让一整类数据静默消失。
 */
const KNOWN_COLLECTIONS = new Set([
  'runs',
  'stages',
  'tasks',
  'events',
  'artifacts',
  'papers',
  'claims',
  'evidence',
  'protocols',
  'comparisons',
  'rounds',
  'ideas',
  'experiments',
  'metrics',
  'approvals',
  'costs',
  'egress',
]);

export function parseEnvelope(raw: unknown): BatchEnvelope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContractError('批次必须是 JSON 对象');
  }
  const batch = raw as Record<string, unknown>;

  for (const key of Object.keys(batch)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      // additionalProperties:false 的等价物。多带一个键说明投影器越界了，
      // 最坏的情况是它把正文/凭据形状的字段也带了上来。
      throw new ContractError(`未知的顶层字段：/${key}`);
    }
  }

  const major = Number(batch.schema_version);
  if (!Number.isInteger(major) || major <= 0) {
    throw new ContractError('schema_version 必须是正整数');
  }
  if (major !== SUPPORTED_SCHEMA_MAJOR) {
    throw new ContractError(
      `本 Function 只实现 cloud-projection-v1，收到 v${major}`,
      415,
    );
  }

  const id = batch.external_batch_id;
  if (typeof id !== 'string' || !/^[a-z]+-[0-9a-f]{16}$/.test(id)) {
    // 与 cloud-projection-v1 的 `external_batch_id` pattern 同一份写法：
    // 本地 `core/ids.ts` 的 newId 形状（前缀 + 16 hex），不是 UUID。
    throw new ContractError('/external_batch_id 必须是本地 newId 形状（`<前缀>-<16 hex>`）');
  }
  if (typeof batch.generated_at !== 'number' || !Number.isInteger(batch.generated_at)) {
    throw new ContractError('/generated_at 必须是本地 epoch 毫秒整数');
  }
  if (!Number.isInteger(batch.local_schema_version)) {
    throw new ContractError('/local_schema_version 必须是整数（本地 workflow.sqlite 的 schema 版本）');
  }

  const project = batch.project as Record<string, unknown> | undefined;
  if (!project || typeof project.external_id !== 'string' || !project.external_id) {
    throw new ContractError('/project/external_id 缺失');
  }

  const entities = batch.entities as Record<string, unknown[]> | undefined;
  if (!entities || typeof entities !== 'object' || Array.isArray(entities)) {
    throw new ContractError('/entities 缺失：省略某个集合不等于删除它');
  }
  for (const [name, rows] of Object.entries(entities)) {
    if (!KNOWN_COLLECTIONS.has(name)) {
      throw new ContractError(`未知的实体集合：/entities/${name}`);
    }
    if (!Array.isArray(rows)) {
      throw new ContractError(`/entities/${name} 必须是数组`);
    }
    const limit = name === 'events' ? MAX_EVENTS : MAX_COLLECTION_ROWS;
    if (rows.length > limit) {
      throw new ContractError(`/entities/${name} 超过 ${limit} 行上限`, 413);
    }
  }

  return batch as unknown as BatchEnvelope;
}

/** 绝对路径 / `..` / 盘符：本地路径本身就是泄露（用户名、挂载布局）。 */
export function isSafePathHint(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string' || value.length > 300) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}

export function isSha256(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/** 带凭据的 URL：`scheme://user:secret@host`。`ssh://git@` 的 git 是协议用户名，不算。 */
export function hasCredentialUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (/:\/\/[^/@\s]+:[^/@\s]+@/.test(value)) return true;
  return /(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16})/.test(value);
}
