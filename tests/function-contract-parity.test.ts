import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 云端 Function 的手写形状门与 `cloud-projection-v1.json` 必须是同一份契约。
 *
 * Function 侧（`web/functions/contract.ts`）在完整 ajv 生成物就位之前自己维护
 * 两份名单：顶层键与实体集合。名单一旦与 schema 漂移，最坏的情况不是报错，
 * 而是"schema 里有的集合，云端当成未知字段整批拒绝"或反过来"契约里删掉的键
 * Function 还在收"——两边都绿灯，数据在中间静默消失。
 *
 * 这里刻意用 fs + 正则读源码而不是 import：`web/` 子工程有独立的 tsconfig 与
 * 依赖树（docs/web-console/PLAN.md §2），主线类型检查不该去解析它的 `.ts` 导入。
 */
type Rec = Record<string, unknown>;

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

const schema = JSON.parse(read('../src/core/schema/schemas/cloud-projection-v1.json')) as {
  properties: Rec;
  required: string[];
  definitions: { entities: { properties: Rec } };
};
const contractSource = read('../web/functions/contract.ts');

function setMembers(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`在 contract.ts 里找不到 ${declaration}`);
  const end = source.indexOf(']);', start);
  if (end < 0) throw new Error(`${declaration} 没有闭合`);
  const block = source.slice(start, end + 1);
  return [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!).filter(Boolean);
}

const schemaTopLevel = Object.keys(schema.properties).sort();
const schemaCollections = Object.keys(schema.definitions.entities.properties).sort();

describe('Function 契约门与投影 schema 同源', () => {
  it('顶层键集合逐字相等', () => {
    expect(setMembers(contractSource, 'KNOWN_TOP_LEVEL = new Set(').sort()).toEqual(schemaTopLevel);
  });

  it('实体集合逐字相等（17 类，一类都不能少）', () => {
    const collections = setMembers(contractSource, 'KNOWN_COLLECTIONS = new Set(').sort();
    expect(collections).toEqual(schemaCollections);
    expect(collections).toHaveLength(17);
  });

  it('schema 声明的必填顶层键都在 Function 的必填校验里', () => {
    for (const key of schema.required) {
      expect(contractSource, `Function 没有对 /${key} 做必填校验`).toContain(`batch.${key}`);
    }
  });

  it('external_batch_id 的本地 newId 形状两边写法一致', () => {
    const schemaPattern = (schema.properties.external_batch_id as Rec).pattern as string;
    expect(contractSource).toContain(schemaPattern);
  });

  it('主版本号两边一致', () => {
    const declared = (schema.properties.schema_version as { const?: number }).const;
    expect(contractSource).toContain(`export const SUPPORTED_SCHEMA_MAJOR = ${declared};`);
  });
});
