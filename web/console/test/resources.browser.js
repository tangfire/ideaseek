async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  let l2 = false;
  let error = false;
  let delayed = false;
  let releaseOld;
  let resourceRequests = 0;
  const browserErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const task = (id, patch = {}) => ({ external_task_id: id, kind: 'analyze_paper', stage: 'PAPER_ANALYSIS', status: 'succeeded', attempt: 1,
    max_attempts: 3, started_at: null, ended_at: null, simulated: false,
    input: [{ label: '论文摘要', value: '<img src=x onerror=alert(1)>已保存摘要', truncated: true }],
    output: [{ label: '标题', value: '材料测试论文', truncated: false }, { label: '方法摘要', value: '方法产出', truncated: false }], ...patch });
  const resources = (run) => ({ ok: true, external_run_id: run, tasks_truncated: true, artifacts_truncated: false,
    tasks: run === 'run-two' ? [] : [task('paper-one'), task('paper-missing', { status: 'queued', input: [], output: [] }),
      task('data-plan', { kind: 'prepare_data', input: [], output: [{ label: '数据计划', value: [{ 名称: '计划数据集', 用途: '验证' }], truncated: false }] }),
      task('simulated', { kind: 'run_experiment', status: 'simulated', simulated: true, input: [], output: [{ label: '指标', value: 0.9997, truncated: false }] }),
      task('legacy', { status: 'input_unverified', input: [], output: [] })],
    artifacts: run === 'run-two' ? [] : ['committed', 'staged', 'aborted'].map((status) => ({
      external_artifact_id: `artifact-${status}`, external_task_id: 'paper-one', kind: 'report', status,
      content_hash: `sha256:${'a'.repeat(64)}`, size_bytes: 0, committed_at: null })),
  });
  const view = (id) => ({ ok: true, generated_at: '2026-11-25T00:00:00Z', visibility: 'private', projection_level: l2 ? 'l2' : 'full', writable: !l2,
    project: { external_id: id, title: `材料 ${id}`, question: null, strategy: 'standard', autonomy: 'guided', last_sync_at: null },
    runs: [{ external_run_id: id === 'resources-two' ? 'run-two' : 'run-one', phase_tag: 'COMPLETED', status: 'succeeded', stage_known: true, started_at: null, finished_at: null }],
    stages: [], events: [], papers: [], ideas: [], experiments: [], claims: [], protocols: [], unsynced: null });
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/auth/me')) body = { ok: true, username: 'browser-review', owner_id: 'owner-review' };
    else if (url.pathname.endsWith('/views/project')) body = view(url.searchParams.get('external_id'));
    else if (url.pathname.endsWith('/live')) body = { frames: [] };
    else if (url.pathname.endsWith('/views/resources')) {
      resourceRequests++;
      if (delayed) { delayed = false; await new Promise((resolve) => { releaseOld = resolve; }); }
      if (error) { await route.fulfill({ status: 503, json: { private_error: 'private-error-sentinel' } }); return; }
      body = resources(url.searchParams.get('external_run_id'));
    } else throw new Error(`材料查看不应触发其他请求：${url.pathname}`);
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.goto('http://127.0.0.1:5174/#/p/resources-one');
  const tab = page.getByRole('tab', { name: '材料与成果', exact: true });
  await tab.waitFor();
  check(resourceRequests === 0, '概览提前读取材料正文');
  await tab.click();
  const panel = page.getByRole('region', { name: '材料与成果', exact: true });
  await panel.getByText('尚缺论文正文或摘要', { exact: true }).waitFor();
  check(resourceRequests > 0, '材料没有按需读取');
  await panel.getByText('此处每类最多展示最新 100 条记录，数量不代表运行总量。', { exact: true }).waitFor();
  check((await panel.innerText()).includes('论文上传、数据集接入及代码包/报告下载尚未接通'), '没有解释不可用功能');
  const row = panel.locator('.resource-list > li').filter({ has: page.locator('strong', { hasText: '材料测试论文' }) }).first();
  await row.getByRole('button', { name: '查看输入与产出', exact: true }).focus();
  await page.keyboard.press('Enter');
  await row.getByText('<img src=x onerror=alert(1)>已保存摘要', { exact: true }).waitFor();
  check(await row.locator('img').count() === 0, '材料内容被当成 HTML');
  await row.getByText('内容较长，仅展示部分记录。', { exact: true }).waitFor();
  await row.getByText('方法产出', { exact: true }).waitFor();
  const range = panel.getByLabel('查看范围');
  await range.selectOption('papers');
  check(await panel.locator('#resource-task-detail').count() === 0, '切换筛选后遗留旧详情');
  check(await panel.locator('.resource-list').first().locator(':scope > li').count() === 3, '论文筛选数量错误');
  await range.selectOption('outputs');
  const plan = panel.locator('.resource-list > li').filter({ hasText: '制定数据计划' });
  await plan.getByRole('button').click();
  await plan.getByText('计划数据集', { exact: true }).waitFor();
  await plan.getByRole('button', { name: '收起记录', exact: true }).click();
  const simulated = panel.locator('.resource-list > li').filter({ hasText: '模拟演示，不提供真实实验结果' });
  await simulated.getByRole('button').click();
  check(!(await simulated.innerText()).includes('0.9997'), '模拟详情显示了指标');
  await simulated.getByRole('button', { name: '收起记录', exact: true }).click();
  for (const text of ['已登记提交 · report', '暂存中 · 尚未提交 · report', '已中止 · report']) await panel.getByText(text, { exact: true }).waitFor();
  check(await panel.locator('a,[download],input[type=file]').count() === 0, '生成无法兑现的上传或下载入口');
  const widths = [];
  for (const width of [1440, 1024, 900, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await panel.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1;
    }), `${width}px 材料面板溢出`);
    widths.push(width);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await panel.screenshot({ path: 'output/playwright/resources-narrow.png', timeout: 6000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await panel.screenshot({ path: 'output/playwright/resources-wide.png', timeout: 6000 });
  error = true;
  await panel.getByRole('button', { name: '刷新材料与成果', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  check(await panel.locator('.resource-list').count() === 0, '读取失败仍显示旧材料');
  check(!(await panel.innerText()).includes('private-error-sentinel'), '错误正文泄漏');
  const failedCount = resourceRequests;
  await page.waitForTimeout(1100);
  check(resourceRequests === failedCount, '失败后仍在立即重试');
  error = false;
  await panel.getByRole('button', { name: '刷新材料与成果', exact: true }).click();
  await panel.getByText('尚缺论文正文或摘要', { exact: true }).waitFor();
  delayed = true;
  await panel.getByRole('button', { name: '刷新材料与成果', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.resources')?.getAttribute('aria-busy') === 'true');
  await page.evaluate(() => { location.hash = '#/p/resources-two'; });
  await page.getByRole('heading', { name: '材料 resources-two', exact: true }).waitFor();
  await panel.getByText('当前运行尚无已登记的文件交付物，不能据此下载论文原件、代码包或研究报告。', { exact: true }).waitFor();
  releaseOld();
  await page.waitForTimeout(100);
  check(!(await panel.innerText()).includes('材料测试论文'), '迟到响应串到新项目');
  check((await panel.innerText()).includes('run-two'), '运行标识没有更新');
  const beforeL2 = resourceRequests;
  l2 = true;
  await page.reload();
  await page.getByText('当前为公开摘要。', { exact: false }).waitFor();
  check(await page.getByRole('tab', { name: '材料与成果', exact: true }).count() === 0, 'L2 可进入材料面板');
  check(resourceRequests === beforeL2, 'L2 发起了材料读取');
  check(browserErrors.filter((message) => !message.includes('503 (Service Unavailable)')).length === 0, `浏览器错误：${browserErrors.join('; ')}`);
  return { passed: 8, widths, scenarios: ['按需读取', '键盘详情与转义', '材料和产出筛选', '模拟及文件状态保护', '宽窄屏', '失败与手动恢复', '跨项目及迟到响应隔离', 'L2 权限隔离'], mutations: 0 };
}
