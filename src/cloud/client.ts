/**
 * 投影的出网通道（F1.7 / F1.8 / F1.10 / F1.11）。
 *
 * 这条链路有两类失败，处理方式完全相反，所以这里把它们做成**判别式联合**而不是抛异常：
 *
 * - **契约性拒绝**（400 / 403 非鉴权 / 415 / 501）：云端明确不要这一批。重试同一条
 *   字节不会得到不同结果，反而会把同一份不该出网的东西再推一次。调用方必须停下来，
 *   把原因报给人看。
 * - **可用性失败**（超时、连接错误、5xx、429）：结果未知，同一批稍后可能成功。
 *   这正是幂等重放要保护的场景——`external_batch_id` 不变，云端要么 `accepted`
 *   要么 `replay`，不会落双份。
 *
 * 因此本模块**自己不重试、不排队、不动游标**，只如实报告一次投递的结局；
 * 重试策略属于 `buffer.ts`，游标推进属于 `push.ts`。
 *
 * 两条平台实测约束（docs/web-console/TEST_REPORT_M1.md §3.5）也在这里落实：
 * 网关剥掉 `Authorization`，机器凭据只能走 `x-ideaseek-token`；站点默认拦空 UA，
 * 所以显式带 `User-Agent`。`Origin` 缺失会被网关判成跨站写（403）。
 */
import { IdeaseekError } from '../core/errors.js';

/** 注入点：测试用桩替换真 fetch，也便于以后换传输。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 与 `web/functions/token.ts` 的 `SYNC_TOKEN_HEADER` 必须逐字一致。 */
export const SYNC_TOKEN_HEADER = 'x-ideaseek-token';
/** 平台网关对空 UA 返回 403 BOT_DETECTED（M1 实测）。 */
export const USER_AGENT = 'ideaseek-cli/1.0 (cloud-push)';
/**
 * 单次投递的挂钟上限。Function 执行预算 ∈ (50s, 60s]（M1 实测），本地不能比云端
 * 更耐心：30s 之后连接还悬着就当它失败，交由队列按同一 `external_batch_id` 重放。
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 一个投影批次的落库回执。 */
export interface BatchReceipt {
  externalBatchId: string;
  counts: Record<string, number>;
}

export type SendOutcome =
  | { kind: 'accepted'; receipt: BatchReceipt }
  /** 同 `external_batch_id` 云端已经收过：算成功，但什么都没再写。 */
  | { kind: 'replay'; receipt: { externalBatchId: string } }
  /** 401 / 403 鉴权类：令牌缺失、撤销、越权。重试无意义，必须人工换 token。 */
  | { kind: 'unauthorized'; status: number; code: string | null }
  /** 批次声明的 schema 大版本云端不认识（实测 415）。 */
  | { kind: 'version-unsupported'; status: number; message: string }
  /** 批次里带了云端尚未实装的集合（实测 501）。 */
  | { kind: 'collections-unsupported'; collections: string[] }
  /** 其余 4xx：契约形状不合法。字节级确定性，不许重试。 */
  | { kind: 'rejected'; status: number; code: string | null; message: string }
  /** 结果未知的失败，可以且应当以同一批次重放。 */
  | {
      kind: 'unavailable';
      reason: 'timeout' | 'network' | 'server' | 'rate';
      status: number | null;
      detail: string;
    };

/** 站点基址（`https://<name>.qoder.site`）→ 批次投递端点。 */
export function ingestUrl(site: string): string {
  const base = site.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `站点地址必须以 http(s):// 开头：${base.slice(0, 60)}`,
    );
  }
  return `${base}/functions/v1/app/ingest`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 解析响应体里的错误码。Function 的契约错误给 `{ok:false, code:'invalid_projection',
 * message}`，平台错误给 `{code, message, request_id}`，网关还会额外带
 * `x-qoder-error` 头。三者都可能是空体或非 JSON，所以解析失败只降级成 `null`，
 * 绝不把"读不懂响应"当成"投递成功"。
 */
async function readErrorBody(
  response: Response,
): Promise<{ code: string | null; message: string }> {
  const header = response.headers.get('x-qoder-error');
  let code: string | null = header;
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    if (typeof body.code === 'string' && body.code) code = body.code;
    if (typeof body.message === 'string' && body.message) message = body.message;
  } catch {
    if (header) message = header;
  }
  return { code, message };
}

function isTimeout(error: unknown): boolean {
  const e = error as { name?: string; cause?: { code?: string } };
  return e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.cause?.code === 'ETIMEDOUT';
}

/**
 * 投递一个批次。`site` 里绝不含令牌，`token` 只走请求头——因此调用方可以放心把
 * URL、`ExternalBatchId` 和状态码写进事件与日志（F1.4 允许出网的字段）。
 */
export async function sendBatch(
  batch: Readonly<Record<string, unknown>>,
  opts: { site: string; token: string; fetch?: FetchLike; timeoutMs?: number },
): Promise<SendOutcome> {
  const externalBatchId = String(batch.external_batch_id ?? '');
  if (!opts.token || opts.token.length < 32) {
    // 短 token 一律不出网：Function 侧同样拒绝，但在那里已经算一次真实请求了。
    return { kind: 'unauthorized', status: 0, code: 'missing_or_short_sync_token' };
  }
  const url = ingestUrl(opts.site);
  const body = JSON.stringify(batch);
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SYNC_TOKEN_HEADER]: opts.token,
        'user-agent': USER_AGENT,
        origin: hostOf(url),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: isTimeout(error) ? 'timeout' : 'network',
      status: null,
      detail: isTimeout(error) ? `超过 ${timeoutMs}ms 未返回` : '无法连接站点',
    };
  }

  if (response.status === 401 || response.status === 403) {
    const { code } = await readErrorBody(response);
    return { kind: 'unauthorized', status: response.status, code };
  }
  if (response.ok) {
    let parsed: { status?: unknown; external_batch_id?: unknown; counts?: unknown };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      return {
        kind: 'unavailable',
        reason: 'server',
        status: response.status,
        detail: '回执不是 JSON：不确定是否落库，按未知结局重放',
      };
    }
    // 回执状态读不出来就当未知：绝不能把"看不懂"记成已同步，否则游标会跳过这批。
    if (parsed.status === 'accepted') {
      const counts = (parsed.counts ?? {}) as Record<string, unknown>;
      return {
        kind: 'accepted',
        receipt: {
          externalBatchId: String(parsed.external_batch_id ?? externalBatchId),
          counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
        },
      };
    }
    if (parsed.status === 'replay') {
      return {
        kind: 'replay',
        receipt: { externalBatchId: String(parsed.external_batch_id ?? externalBatchId) },
      };
    }
    return {
      kind: 'unavailable',
      reason: 'server',
      status: response.status,
      detail: `回执状态无法识别：${String(parsed.status).slice(0, 40)}`,
    };
  }

  if (response.status === 501) {
    const { code } = await readErrorBody(response);
    const prefix = 'projection_collections_not_implemented:';
    const collections = code?.startsWith(prefix) ? code.slice(prefix.length).split(',') : [];
    return { kind: 'collections-unsupported', collections };
  }
  if (response.status === 415) {
    const { message } = await readErrorBody(response);
    return { kind: 'version-unsupported', status: 415, message };
  }
  if (response.status === 429) {
    return { kind: 'unavailable', reason: 'rate', status: 429, detail: '云端限流' };
  }
  if (response.status >= 500) {
    return { kind: 'unavailable', reason: 'server', status: response.status, detail: '云端错误' };
  }
  const { code, message } = await readErrorBody(response);
  return { kind: 'rejected', status: response.status, code, message };
}
