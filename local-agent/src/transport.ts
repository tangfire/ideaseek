/**
 * 与云端 Function 的 HTTP 轮询通道。
 *
 * 没有长连接：Sites 的 edge runtime 从未验收过常驻服务端连接，而轮询在断网、进程重启、
 * 租约过期三种情况下都有确定语义（见 web/functions/commands.ts 头注）。
 *
 * 三条本地不变量：
 * 1. token 只出现在请求头里；日志、错误信息、抛出的 Error 一律只能带 `tokenFingerprint`
 *    那种前 4 位掩码（网关会剥 Authorization，所以也不能退回 Bearer）。
 * 2. 4xx 永不重试——4xx 是"这条请求形状/权限不对"，重试只会把限流变成故障。
 * 3. 心跳失败时终态结果不能丢：结果先进 `ResultBuffer`，只有云端答复过的那条才出队。
 */
import {
  AGENT_VERSION,
  MAX_RESULTS_PER_HEARTBEAT,
  redact,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type ResultEnvelope,
} from './protocol.js';

export const SYNC_TOKEN_HEADER = 'x-ideaseek-token';
/**
 * 平台实测：网关对空 UA 直接 403 BOT_DETECTED，`Origin` 缺失会把请求判成跨站写
 * （docs/web-console/TEST_REPORT_M1.md §3.5，引擎侧同一约束落在 src/cloud/client.ts）。
 * 终端客户端不是浏览器，所以这两个头必须由我们自己补上。
 */
export const USER_AGENT = `ideaseek-agent/${AGENT_VERSION}`;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_CAP_MS = 8_000;
/** 429 的 Retry-After 只在合理窗口内采信，否则用本地退避。 */
const MAX_RETRY_AFTER_MS = 60_000;

export type TransportFailureKind = 'timeout' | 'network' | 'http' | 'parse';

export class TransportError extends Error {
  readonly kind: TransportFailureKind;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, kind: TransportFailureKind, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}

/** 与 web/functions/token.ts 的 tokenFingerprint 同一读法：前 4 位，其余不外露。 */
export function maskToken(token: string): string {
  return token.length === 0 ? '(empty)' : `${token.slice(0, 4)}…`;
}

export interface TransportOptions {
  base: string;
  token: string;
  timeoutMs?: number;
  attempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  wait?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class CloudTransport {
  readonly base: string;
  readonly token: string;
  /** 站点自身的 origin：网关用它判同源，缺失即 403。 */
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: TransportOptions) {
    const base = options.base.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]/i.test(base)) {
      // 只校验形状：拼错的 base 必须在离机前失败，而不是变成一条 404 谜团。
      throw new TransportError('invalid_base_url', 'http', null, false);
    }
    if (options.token.length < 32) {
      // 云端对 <32 的 token 直接 401（token.ts），本地先失败，省一轮网络。
      throw new TransportError('invalid_token', 'http', null, false);
    }
    this.base = base;
    this.origin = new URL(base).origin;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffCapMs = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  get fingerprint(): string {
    return maskToken(this.token);
  }

  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    const raw = await this.post('/agent/heartbeat', request);
    if (!raw || typeof raw !== 'object' || !('commands' in raw)) {
      throw new TransportError('heartbeat_unexpected_shape', 'parse', null, true);
    }
    return raw as HeartbeatResponse;
  }

  /** 唯一被接受的续租形状：只报 `running`，不领新命令。 */
  async renewLease(commandId: string): Promise<void> {
    await this.post('/agent/command', { command_id: commandId, status: 'running' });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const payload = JSON.stringify(body ?? {});
    let lastError: TransportError | null = null;

    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      if (attempt > 1) await this.wait(this.backoffMs(attempt));
      try {
        return await this.postOnce(path, payload);
      } catch (error) {
        const failure = error instanceof TransportError ? error : this.wrapError(error);
        if (!failure.retryable) throw failure;
        lastError = failure;
      }
    }
    throw lastError ?? new TransportError('request_failed', 'network', null, true);
  }

  private async postOnce(path: string, payload: string): Promise<unknown> {
    const response = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SYNC_TOKEN_HEADER]: this.token,
        'user-agent': USER_AGENT,
        origin: this.origin,
      },
      body: payload,
      signal: AbortSignal.timeout(this.timeoutMs),
      // 轮询没有缓存价值，且云端每个读数都 no-store；显式关掉本地缓存歧义。
      cache: 'no-store',
    }).catch((error: unknown) => {
      throw this.wrapError(error);
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      // 响应体可能带路径或内部信息：只留 code 形状的一段，且再过一次 redact。
      const detail = redact(text.replace(/\s+/g, ' ').trim().slice(0, 160), [this.token]);
      if (response.status === 429) {
        const after = Number(response.headers.get('retry-after'));
        if (Number.isFinite(after) && after > 0 && after * 1_000 <= MAX_RETRY_AFTER_MS) {
          await this.wait(after * 1_000);
        }
      }
      throw new TransportError(`http_${response.status}:${detail}`, 'http', response.status, retryable);
    }

    try {
      return text.length === 0 ? null : (JSON.parse(text) as unknown);
    } catch {
      throw new TransportError('response_not_json', 'parse', response.status, false);
    }
  }

  private wrapError(error: unknown): TransportError {
    const name = error instanceof Error ? error.name : '';
    const isTimeout = name === 'TimeoutError' || name === 'AbortError';
    if (isTimeout) return new TransportError(`request_timeout_${this.timeoutMs}ms`, 'timeout', null, true);
    const message = error instanceof Error ? redact(error.message, [this.token]) : 'request_failed';
    return new TransportError(`network_${message.slice(0, 120)}`, 'network', null, true);
  }

  /** 指数退避 + 抖动：多个 Agent 同时掉线恢复时不要齐步重试。 */
  private backoffMs(attempt: number): number {
    const exponential = Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** (attempt - 2));
    const jitter = exponential * (0.5 + this.random() * 0.5);
    return Math.round(jitter);
  }
}

/**
 * 待回写的终态结果队列。
 *
 * 语义：`peek` 只读不删——只有云端**答复过**（applied 或给出 reason）的那条才 `settle`。
 * 心跳整体失败时一条都不删，下一轮再带；因此进程重启前未确认的结果会随内存一起消失，
 * 云端那条命令会在 lease_ms 之后自己变成 expired，这是协议的确定性行为，不是本地丢失。
 */
export class ResultBuffer {
  private readonly pending = new Map<string, ResultEnvelope>();

  push(result: ResultEnvelope): void {
    // 同一个 command_id 后写覆盖先写：重试路径上不可能有两个终态。
    this.pending.set(result.command_id, result);
  }

  peek(limit = MAX_RESULTS_PER_HEARTBEAT): ResultEnvelope[] {
    return [...this.pending.values()].slice(0, limit);
  }

  /** 云端已答复（无论接受还是拒绝）的命令_id 出队；未答复的留着重试。 */
  settle(commandIds: Iterable<string>): void {
    for (const id of commandIds) this.pending.delete(id);
  }

  get size(): number {
    return this.pending.size;
  }
}
