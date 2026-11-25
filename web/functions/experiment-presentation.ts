import { ContractError } from './contract.ts';

type RecordValue = Record<string, unknown>;

function object(value: unknown, field: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ContractError(`实验${field}记录格式错误。`, 500);
  return value as RecordValue;
}

function text(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim())
    throw new ContractError(`实验${field}记录格式错误。`, 500);
  return value;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new ContractError(`实验${field}必须是有限数值。`, 500);
  return value;
}

function optionalNumber(value: unknown, field: string, integer: boolean): number | null {
  if (value === undefined || value === null) return null;
  const number = finite(value, field);
  if (number < 0 || (integer && (!Number.isInteger(number) || number < 1)))
    throw new ContractError(`实验${field}记录格式错误。`, 500);
  return number;
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ContractError(`实验${field}记录格式错误。`, 500);
  return value;
}

export function experimentEvidence(
  detail: RecordValue | null,
  workflowRunId: string,
  nodeStatus: string,
) {
  const rawResult = detail?.result;
  const result = rawResult === undefined || rawResult === null ? null : object(rawResult, '结果');
  const syntheticEntry = [result?.metrics, result?.baselines].some(
    (entries) =>
      Array.isArray(entries) &&
      entries.some(
        (entry) => entry !== null && typeof entry === 'object' && entry.is_synthetic === true,
      ),
  );
  const simulated =
    nodeStatus === 'simulated' ||
    detail?.status === 'simulated' ||
    result?.status === 'simulated' ||
    detail?.is_synthetic === true ||
    result?.is_synthetic === true ||
    syntheticEntry;
  if (simulated) return { status: 'simulated', metrics: null, metric_rows: [], context: null };

  const rawSpec = detail?.spec;
  const spec = rawSpec === undefined || rawSpec === null ? null : object(rawSpec, '规格');
  const source = {
    workflow_run_id: workflowRunId,
    kind: result ? 'run_result' : 'legacy',
    spec_id: spec ? text(spec.specId, '规格编号') : null,
    result_spec_id: result ? text(result.specId, '结果规格编号') : null,
    code_commit: spec ? text(spec.codeCommit, '代码版本') : null,
    data_snapshot_id: spec ? text(spec.dataSnapshotId, '数据快照') : null,
    protocol_id: spec ? text(spec.protocolId, '协议编号') : null,
    slice_ids:
      spec?.sliceIds === undefined || spec.sliceIds === null
        ? null
        : list(spec.sliceIds, '数据切片').map((id) => {
            const value = text(id, '数据切片编号');
            if (value === null) throw new ContractError('实验数据切片编号缺失。', 500);
            return value;
          }),
    seeds:
      spec?.seeds === undefined || spec.seeds === null
        ? null
        : list(spec.seeds, '随机种子').map((seed) => {
            const value = finite(seed, '随机种子');
            if (!Number.isInteger(value)) throw new ContractError('实验随机种子必须是整数。', 500);
            return value;
          }),
  };
  if (source.spec_id && source.result_spec_id && source.spec_id !== source.result_spec_id) {
    throw new ContractError('实验结果与规格编号不匹配。', 500);
  }
  const status = result ? text(result.status, '结果状态') : nodeStatus;
  if (result && !['succeeded', 'failed', 'partial', 'invalid'].includes(String(status))) {
    throw new ContractError('实验结果状态缺失或无效。', 500);
  }
  if (detail?.scale === 'handoff_manifest') {
    return { status, metrics: null, metric_rows: [], context: source };
  }
  const comparable =
    status === 'succeeded' &&
    source.spec_id !== null &&
    source.result_spec_id !== null &&
    source.code_commit !== null &&
    source.data_snapshot_id !== null &&
    source.protocol_id !== null &&
    source.slice_ids !== null &&
    source.slice_ids.length > 0 &&
    source.seeds !== null &&
    source.seeds.length > 0;
  const targets = new Map<string, 'higher' | 'lower'>();
  if (spec?.metrics !== undefined) {
    for (const value of list(spec.metrics, '指标定义')) {
      const metric = object(value, '指标定义');
      const name = text(metric.name, '指标名称');
      if (
        name === null ||
        (metric.direction !== 'higher' && metric.direction !== 'lower') ||
        targets.has(name)
      ) {
        throw new ContractError('实验指标定义缺失、重复或方向无效。', 500);
      }
      targets.set(name, metric.direction);
    }
  }
  const controls =
    result?.baselines === undefined
      ? []
      : list(result.baselines, '同次运行对照').map((value) => {
          const baseline = object(value, '对照');
          const method = text(baseline.methodId, '对照方法');
          const metric = text(baseline.metric, '对照指标');
          if (method === null || metric === null)
            throw new ContractError('实验对照方法或指标缺失。', 500);
          return {
            method_id: method,
            metric,
            value: finite(baseline.value, '对照指标'),
            stdev: optionalNumber(baseline.stdev, '对照标准差', false),
          };
        });
  const controlKeys = controls.map((control) =>
    JSON.stringify([control.method_id, control.metric]),
  );
  if (new Set(controlKeys).size !== controlKeys.length)
    throw new ContractError('实验对照指标重复。', 500);

  const recorded = result
    ? list(result.metrics, '指标').map((value) => {
        const metric = object(value, '指标');
        const name = text(metric.name, '指标名称');
        if (name === null) throw new ContractError('实验指标名称缺失。', 500);
        return {
          name,
          value: finite(metric.value, '指标值'),
          stdev: optionalNumber(metric.stdev, '标准差', false),
          n: optionalNumber(metric.n, '重复次数', true),
        };
      })
    : detail?.metrics === undefined || detail.metrics === null
      ? []
      : Object.entries(object(detail.metrics, '旧指标')).map(([name, value]) => ({
          name,
          value: finite(value, '指标值'),
          stdev: null,
          n: null,
        }));
  if (new Set(recorded.map((metric) => metric.name)).size !== recorded.length)
    throw new ContractError('实验指标重复。', 500);
  const metricRows = recorded.map((metric) => ({
    ...metric,
    direction: targets.get(metric.name) ?? null,
    controls: controls
      .filter((control) => control.metric === metric.name)
      .map((control) => {
        const difference = metric.value - control.value;
        const delta =
          comparable && targets.has(metric.name) ? finite(difference, '指标差值') : null;
        return { method_id: control.method_id, value: control.value, stdev: control.stdev, delta };
      }),
  }));
  return {
    status,
    metrics:
      recorded.length > 0
        ? Object.fromEntries(recorded.map((metric) => [metric.name, metric.value]))
        : null,
    metric_rows: metricRows,
    context: source,
  };
}
