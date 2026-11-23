/**
 * 内存版 backend SDK 适配器（`_qoder/backend.mjs` 的最小形状）。
 *
 * dev 入口和本地测试跑的是**同一份** `routes.ts`，靠的就是这里；因此它必须能在
 * Node（type-stripping）里直接 import，不能碰 `Deno` 全局——那是本地没有 Deno 时
 * 唯一还能验证处理器逻辑的路（§8 列出这条缺口，§10 是补齐它的部署读数）。
 *
 * 它证明的是路由与授权逻辑，不证明平台数据库、身份或 WS 握手。
 */
import type { BackendErrorLike, Builder, Db, QueryResult } from '../deps.ts';

export type Row = Record<string, unknown>;

export class FakeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export interface FakeDb {
  db: Db;
  BackendError: BackendErrorLike;
  /** 构造权限错误用（本地入口把它当平台的 BackendError 使）。 */
  FakeError: typeof FakeError;
  /** 直接往表里放种子行，测试用它构造主体，不走 insert 路径。 */
  seed(table: string, row: Row): Row;
  rowsOf(table: string): Row[];
}

export function createFakeDb(): FakeDb {
  const tables = new Map<string, Row[]>();
  let counter = 0;
  const autoId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

  function table(name: string): Row[] {
    const existing = tables.get(name);
    if (existing) return existing;
    const created: Row[] = [];
    tables.set(name, created);
    return created;
  }

  class Query implements Builder {
    private columns = '*';
    private readonly predicates: Array<[string, string, unknown]> = [];
    private orderBy: [string, boolean] | null = null;
    private limitCount = 1000;
    private mutation: { kind: 'insert' | 'insertIfAbsent' | 'update' | 'delete'; value?: unknown; onConflict?: string } | null = null;

    private readonly name: string;

    constructor(name: string) {
      this.name = name;
    }

    select(columns: string): Query {
      this.columns = columns;
      return this;
    }
    eq(column: string, value: unknown): Query {
      this.predicates.push(['eq', column, value]);
      return this;
    }
    gte(column: string, value: unknown): Query {
      this.predicates.push(['gte', column, value]);
      return this;
    }
    order(column: string, options?: { ascending?: boolean }): Query {
      this.orderBy = [column, options?.ascending ?? true];
      return this;
    }
    limit(count: number): Query {
      this.limitCount = count;
      return this;
    }
    insert(value: unknown): Query {
      this.mutation = { kind: 'insert', value };
      return this;
    }
    insertIfAbsent(value: unknown, options: { onConflict: string }): Query {
      this.mutation = { kind: 'insertIfAbsent', value, onConflict: options.onConflict };
      return this;
    }
    update(value: unknown): Query {
      this.mutation = { kind: 'update', value };
      return this;
    }
    /** M2 的 outbox 清理与 token 回收要用；本地 Lane 里没有它，路由测试就测不到那条路径。 */
    delete(): Query {
      this.mutation = { kind: 'delete' };
      return this;
    }

    private matches(row: Row): boolean {
      return this.predicates.every(([kind, column, value]) =>
        kind === 'eq' ? row[column] === value : Number(row[column]) >= Number(value),
      );
    }

    private project(row: Row): Row {
      if (this.columns === '*') return { ...row };
      const out: Row = {};
      for (const column of this.columns.split(',')) out[column.trim()] = row[column.trim()];
      return out;
    }

    then<T1, T2>(
      onfulfilled?: ((value: QueryResult) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
    }

    private execute(): QueryResult {
      const rows = table(this.name);
      const mutation = this.mutation;
      if (mutation) {
        const patch = mutation.value as Row | Row[];
        const added: Row[] = [];
        if (mutation.kind === 'update') {
          // 平台的 `.update(patch).eq(...).select(...)` 回的是**被改过的那几行**，
          // 不是空数组；写成空的会让 ingest 的 upsert 误判成 write_conflict 409。
          for (const row of rows) {
            if (!this.matches(row)) continue;
            Object.assign(row, patch);
            added.push(row);
          }
        } else if (mutation.kind === 'delete') {
          const survivors: Row[] = [];
          for (const row of rows) {
            if (this.matches(row)) {
              added.push(row);
            } else {
              survivors.push(row);
            }
          }
          rows.length = 0;
          rows.push(...survivors);
        } else {
          for (const candidate of Array.isArray(patch) ? patch : [patch]) {
            const conflictKey = (mutation.onConflict ?? '').split(',').map((key) => key.trim()).filter(Boolean);
            const duplicate =
              mutation.kind === 'insertIfAbsent' &&
              conflictKey.length > 0 &&
              rows.some((row) => conflictKey.every((key) => row[key] === candidate[key]));
            if (duplicate) continue;
            const row = { id: autoId(), ...candidate };
            rows.push(row);
            added.push(row);
          }
        }
        this.mutation = null;
        return { data: added.map((row) => this.project(row)) };
      }
      let selected = rows.filter((row) => this.matches(row)).map((row) => this.project(row));
      if (this.orderBy) {
        const [column, ascending] = this.orderBy;
        selected = selected.sort((a, b) => {
          const left = a[column];
          const right = b[column];
          if (left === right) return 0;
          if (left === null || left === undefined) return 1;
          if (right === null || right === undefined) return -1;
          return (left < right ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      return { data: selected.slice(0, this.limitCount) };
    }
  }

  return {
    db: { from: <T>(name: string) => new Query(name) as unknown as Builder<T> },
    BackendError: FakeError as unknown as BackendErrorLike,
    FakeError,
    seed(name, row) {
      const created = { id: autoId(), ...row };
      table(name).push(created);
      return created;
    },
    rowsOf(name) {
      return table(name);
    },
  };
}

/** 与 token.ts 的比对方式一致：库里只存 sha256 十六进制。 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
