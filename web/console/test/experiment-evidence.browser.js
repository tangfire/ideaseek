async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  let l2 = false;
  let empty = false;
  const context = { workflow_run_id: 'metric-workflow-complete-id', kind: 'run_result', spec_id: 'metric-spec-complete-id',
    result_spec_id: 'metric-spec-complete-id', code_commit: 'recorded-code-commit', data_snapshot_id: 'snapshot-complete-id',
    protocol_id: 'protocol-complete-id', slice_ids: ['quick-slice-one'], seeds: [0, 7] };
  const complete = { external_spec_id: 'experiment-complete-id', title: '同次运行的指标对照', idea_id: null, status: 'succeeded', scale: 'quick', context,
    metric_rows: [
      { name: 'accuracy', value: 0.812345678, direction: 'higher', stdev: 0, n: 2, controls: [
        { method_id: 'control-one', value: 0.8, stdev: 0.01, delta: 0.012345678 },
        { method_id: 'control-zero', value: 0, stdev: null, delta: 0.812345678 }] },
      { name: 'loss', value: 0.2, direction: 'lower', stdev: null, n: null,
        controls: [{ method_id: 'control-one', value: 0.4, stdev: null, delta: -0.2 }] },
    ] };
  const view = (id) => ({
    ok: true, generated_at: '2026-11-25T00:00:00Z', visibility: 'private', projection_level: l2 ? 'l2' : 'full', writable: !l2,
    project: { external_id: id, title: `指标 ${id}`, question: '研究问题', strategy: 'standard', autonomy: 'guided', last_sync_at: null },
    runs: [{ external_run_id: context.workflow_run_id, phase_tag: 'COMPLETED', status: 'succeeded', stage_known: true, started_at: null, finished_at: null }],
    stages: [], events: [], claims: [], protocols: [], unsynced: null,
    ...(!l2 && !empty ? { papers: [], ideas: [], experiments: [complete,
      { ...complete, external_spec_id: 'experiment-partial', title: '条件不足的对照', status: 'partial', context: { ...context, code_commit: null },
        metric_rows: [{ ...complete.metric_rows[0], controls: [{ method_id: 'partial-control', value: 0.8, stdev: null, delta: null }] }] },
      { ...complete, external_spec_id: 'experiment-simulated', title: '模拟实验', status: 'simulated', verdict: 'supported' },
      { ...complete, external_spec_id: 'experiment-handoff', title: '交付材料', scale: 'handoff_manifest', verdict: 'supported' },
      { external_spec_id: 'experiment-legacy', title: '旧记录', status: 'completed', idea_id: null, scale: null, metrics: { error: 0, tiny: 1e-12 } },
      { external_spec_id: 'experiment-empty', title: '空结果', status: 'failed', idea_id: null, scale: null, metrics: null },
    ] } : {}),
  });
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/auth/me')) body = { ok: true, username: 'browser-review', owner_id: 'owner-review' };
    else if (url.pathname.endsWith('/views/project')) body = view(url.searchParams.get('external_id'));
    else if (url.pathname.endsWith('/live')) body = { frames: [] };
    else throw new Error(`指标查看不应发起其他请求：${url.pathname}`);
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.goto('http://127.0.0.1:5174/#/p/metrics-one');
  const card = (id) => page.locator(`[id="output-experiment-${id}"]`);
  const full = card('experiment-complete-id');
  await full.getByRole('table', { name: '实验指标对照' }).waitFor();
  const content = await full.innerText();
  for (const text of ['0.812345678', '标准差 0', '重复 2 次', 'control-zero', '+0.012345678', '-0.2', '越高越好', '越低越好']) check(content.includes(text), `完整指标缺少 ${text}`);
  check(!content.includes('%') && !content.includes('有证据支持'), '指标被转换或误写为支持结论');
  const summary = full.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  check(await full.locator('details').evaluate((el) => el.open), '键盘无法展开来源');
  for (const text of [context.workflow_run_id, context.spec_id, context.code_commit, context.data_snapshot_id, context.protocol_id, '0、7']) {
    await full.getByText(text, { exact: true }).first().waitFor();
  }
  await card('experiment-partial').getByText('对照已记录，但结果状态、指标方向或复现信息不完整，暂不计算差值。', { exact: true }).waitFor();
  check(!(await card('experiment-partial').innerText()).includes('+0.012345678'), '条件不足仍显示差值');
  await card('experiment-partial').locator('summary').click();
  check(await card('experiment-partial').locator('dd').filter({ hasText: '未记录' }).count() > 0, '缺失来源未标注');
  for (const id of ['experiment-simulated', 'experiment-handoff']) {
    const item = card(id);
    check(await item.getByRole('table').count() === 0, `${id} 显示了指标表`);
    check(!(await item.innerText()).includes('0.812345678'), `${id} 泄露模拟或未执行指标`);
    check(!(await item.innerText()).includes('有证据支持'), `${id} 显示了支持结论`);
  }
  check(await card('experiment-simulated').locator('details').count() === 0, '模拟来源泄露');
  await card('experiment-legacy').getByText('未记录同次运行的对照值，不计算提升幅度。', { exact: true }).waitFor();
  await card('experiment-legacy').getByText('1e-12', { exact: true }).waitFor();
  await card('experiment-empty').getByText('尚无已记录的实验指标。', { exact: true }).waitFor();
  const widths = [];
  for (const width of [1440, 1024, 900, 768, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await page.locator('.output-record').evaluateAll((items) => items.every((el) => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1;
    })), `${width}px 指标或来源溢出`);
    check(await full.locator('td').evaluateAll((cells) => cells.every((el) => el.clientWidth >= 70)), `${width}px 指标列挤压难读`);
    const layout = await full.locator('.experiment-evidence').evaluate((el) => ({
      width: el.getBoundingClientRect().width, header: getComputedStyle(el.querySelector('thead')).display,
    }));
    check(width <= 768 || layout.width <= 600 ? layout.header === 'none' : layout.header !== 'none', `${width}px 指标布局未按内容宽度切换`);
    widths.push(width);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await full.screenshot({ path: 'output/playwright/experiment-evidence-narrow.png', timeout: 6000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await summary.click();
  await full.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: 'output/playwright/experiment-evidence-wide.png', timeout: 6000 });
  empty = true;
  await page.evaluate(() => { location.hash = '#/p/metrics-two'; });
  await page.getByRole('heading', { name: '指标 metrics-two', exact: true }).waitFor();
  check(await page.locator('.experiment-evidence').count() === 0, '跨项目残留实验来源');
  l2 = true;
  empty = false;
  await page.reload();
  await page.getByText('当前为公开摘要。', { exact: false }).waitFor();
  check(await page.locator('.experiment-evidence').count() === 0, '降级视图显示实验来源');
  return { passed: 7, widths, scenarios: ['指标与对照', '键盘查看来源', '缺失条件保护', '模拟和交付保护', '旧记录和空结果', '宽窄屏布局', '项目与权限隔离'], stepRequests: 0 };
}
