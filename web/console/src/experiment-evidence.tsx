import type { ExperimentResult } from './types';

function number(value: number): string {
  if (!Number.isFinite(value)) throw new Error('实验记录包含无效数值。');
  return String(value);
}

function difference(value: number): string {
  const rounded = Number(number(value)).toPrecision(12);
  return `${value > 0 ? '+' : ''}${Number(rounded)}`;
}

export function ExperimentEvidence({ experiment }: { experiment: ExperimentResult }) {
  if (experiment.status === 'simulated') return null;
  const rows =
    experiment.metric_rows ??
    Object.entries(experiment.metrics ?? {}).map(([name, value]) => ({
      name,
      value,
      direction: null,
      stdev: null,
      n: null,
      controls: [],
    }));
  const context = experiment.context;
  const noMeasurement = experiment.scale === 'handoff_manifest';
  const hasControls = rows.some((row) => row.controls.length > 0);
  const incomplete = rows.some((row) => row.controls.some((control) => control.delta === null));
  return (
    <div className="experiment-evidence">
      {noMeasurement ? (
        <p className="muted">仅交付运行材料，尚无可展示的执行指标。</p>
      ) : rows.length === 0 ? (
        <p className="muted">尚无已记录的实验指标。</p>
      ) : (
        <>
          <table aria-label="实验指标对照">
            <thead>
              <tr>
                <th>指标</th>
                <th>实验值</th>
                <th>方向</th>
                <th>对照方法</th>
                <th>对照值</th>
                <th>差值</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((row) => {
                const controls = row.controls.length > 0 ? row.controls : [null];
                return controls.map((control, index) => (
                  <tr key={JSON.stringify([row.name, index])}>
                    <td data-label="指标">{row.name}</td>
                    <td data-label="实验值">
                      {number(row.value)}
                      {row.stdev !== null ? <small>标准差 {number(row.stdev)}</small> : null}
                      {row.n !== null ? <small>重复 {row.n} 次</small> : null}
                    </td>
                    <td data-label="方向">
                      {row.direction === 'higher'
                        ? '越高越好'
                        : row.direction === 'lower'
                          ? '越低越好'
                          : '未记录'}
                    </td>
                    <td data-label="对照方法">{control ? control.method_id : '未记录'}</td>
                    <td data-label="对照值">
                      {control ? number(control.value) : '未记录'}
                      {control && control.stdev !== null ? (
                        <small>标准差 {number(control.stdev)}</small>
                      ) : null}
                    </td>
                    <td data-label="差值">
                      {control?.delta !== null && control?.delta !== undefined
                        ? difference(control.delta)
                        : '不计算'}
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
          <p className="muted">差值为实验值减对照值，使用指标原始单位；正负不等于有效性结论。</p>
          {!hasControls ? (
            <p className="muted">未记录同次运行的对照值，不计算提升幅度。</p>
          ) : incomplete ? (
            <p className="muted">
              对照已记录，但结果状态、指标方向或复现信息不完整，暂不计算差值。
            </p>
          ) : (
            <p className="muted">
              对照来自此结果的同次运行记录；仍需结合数据划分、重复实验与实验协议解读。
            </p>
          )}
        </>
      )}
      <details className="experiment-source">
        <summary>运行来源与比较条件</summary>
        <dl>
          <div>
            <dt>工作流运行</dt>
            <dd>{context ? context.workflow_run_id : '未记录'}</dd>
          </div>
          <div>
            <dt>结果来源</dt>
            <dd>
              {context?.kind === 'run_result'
                ? '结构化运行结果（RunResult）'
                : '旧指标记录，缺少完整运行来源'}
            </dd>
          </div>
          <div>
            <dt>实验记录编号</dt>
            <dd>{experiment.external_spec_id}</dd>
          </div>
          <div>
            <dt>规格编号</dt>
            <dd>{context?.spec_id ?? '未记录'}</dd>
          </div>
          <div>
            <dt>结果绑定规格</dt>
            <dd>{context?.result_spec_id ?? '未记录'}</dd>
          </div>
          <div>
            <dt>数据快照</dt>
            <dd>{context?.data_snapshot_id ?? '未记录'}</dd>
          </div>
          <div>
            <dt>数据切片</dt>
            <dd>
              {context?.slice_ids && context.slice_ids.length > 0
                ? context.slice_ids.join('、')
                : '未记录'}
            </dd>
          </div>
          <div>
            <dt>代码版本</dt>
            <dd>{context?.code_commit ?? '未记录'}</dd>
          </div>
          <div>
            <dt>实验协议</dt>
            <dd>{context?.protocol_id ?? '未记录'}</dd>
          </div>
          <div>
            <dt>随机种子</dt>
            <dd>
              {context?.seeds && context.seeds.length > 0 ? context.seeds.join('、') : '未记录'}
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
