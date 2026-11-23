/**
 * 平台注入的 `_qoder/backend.mjs` 没有随包发布类型声明，这里按安装目录里
 * `function-backend/routes.mjs` 的实际用法写一份**最小**结构类型。
 *
 * 只声明确实用到的构造器方法：链式查询本身是 thenable（`await db.from(...)`
 * 直接得到 `{data,error}`），没有 `then()` 之外的执行入口。将来用到 `.in()`
 * 之类再补，不要预先写一份没验证过的 SDK 形状。
 */
export interface QueryError {
  code?: string;
  status?: number;
  message?: string;
}

export interface QueryResult<T = Record<string, unknown>> {
  data?: T[];
  error?: QueryError;
}

export interface Builder<T = Record<string, unknown>> extends PromiseLike<QueryResult<T>> {
  select(columns: string): Builder<T>;
  eq(column: string, value: unknown): Builder<T>;
  gte(column: string, value: unknown): Builder<T>;
  order(column: string, options?: { ascending?: boolean }): Builder<T>;
  limit(count: number): Builder<T>;
  insert(rows: unknown): Builder<T>;
  insertIfAbsent(row: unknown, options: { onConflict: string }): Builder<T>;
  update(patch: unknown): Builder<T>;
  delete(): Builder<T>;
}

export interface Db {
  from<T = Record<string, unknown>>(table: string): Builder<T>;
}

export interface BackendErrorLike {
  new (code: string, status: number): Error;
}

/**
 * 查询失败一律抛回平台错误对象，不在这里翻译成 200 + `data: null`。
 * "读不到就显示空列表"正是本仓库一路在收口的静默降级。
 */
export function rows<T>(result: QueryResult<T>, BackendError: BackendErrorLike): T[] {
  if (result.error) throw new BackendError(result.error.code ?? 'service_unavailable', result.error.status ?? 503);
  return result.data ?? [];
}
