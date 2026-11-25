async (page) => {
  await page.goto('about:blank');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const calls = [];
  let runId = 'detail-run-one';
  let l2 = false;
  let dataStatus = 503;
  let paperStatus = 200;
  let holdPaper = false;
  let releasePaper;
  let stepRequests = 0;
  const stages = ['INIT', 'INPUT_READY', 'CALIBRATING', 'PAPER_ANALYSIS', 'DATA_READY', 'PROTOCOL_PROPOSED', 'PROTOCOL_REVIEW', 'COMPARISON_DISCOVERY', 'COMPARISON_REPRODUCTION', 'BASELINE_VALIDATED', 'IDEA_GENERATION', 'IDEA_SCREENING', 'EXPERIMENTING', 'IDEA_REVIEW', 'COMPLETED'];
  const task = (patch = {}) => ({
    external_task_id: 'paper-task', kind: 'analyze_paper', status: 'succeeded', attempt: 1, max_attempts: 3,
    started_at: null, ended_at: null, simulated: false,
    input: [{ label: '论文摘要', value: '<script>这只是论文内容</script>', truncated: true }],
    output: [{ label: '方法摘要', value: '保存的论文分析结果', truncated: false }], ...patch,
  });
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    let status = 200;
    if (url.pathname.endsWith('/auth/me')) {
      body = { ok: true, username: 'browser-review', owner_id: 'owner-review' };
    } else if (url.pathname.endsWith('/views/project')) {
      const id = url.searchParams.get('external_id');
      body = {
        ok: true, generated_at: '2026-11-25T00:00:00Z', visibility: 'private',
        projection_level: l2 ? 'l2' : 'full', writable: !l2,
        project: { external_id: id, title: `详情 ${id}`, question: '研究问题', strategy: 'standard', autonomy: 'guided', last_sync_at: null },
        runs: [{ external_run_id: runId, phase_tag: 'PAPER_ANALYSIS', status: 'blocked', stage_known: true, started_at: null, finished_at: null }],
        stages: stages.map((stage, index) => ({ stage, stage_known: true, state: index < 3 ? 'passed' : index === 3 ? 'blocked' : 'pending', gate_note: index === 3 ? '需要补充论文材料' : null, blocker_code: null })),
        events: [], papers: [], ideas: [], experiments: [], claims: [], protocols: [], unsynced: null,
      };
    } else if (url.pathname.endsWith('/views/stage')) {
      const stage = url.searchParams.get('stage');
      calls.push(Object.fromEntries(url.searchParams));
      status = stage === 'DATA_READY' ? dataStatus : stage === 'PAPER_ANALYSIS' ? paperStatus : 200;
      if (holdPaper && stage === 'PAPER_ANALYSIS') await new Promise((resolve) => { releasePaper = resolve; });
      body = {
        ok: status === 200, external_run_id: url.searchParams.get('external_run_id'), stage, truncated: stage === 'PAPER_ANALYSIS',
        tasks: stage === 'PAPER_ANALYSIS' ? [task()] : stage === 'EXPERIMENTING'
          ? [task({ kind: 'run_experiment', status: 'simulated', simulated: true, output: [{ label: '模拟指标', value: 0.9997, truncated: false }] })]
          : stage === 'DATA_READY' ? [task({ kind: 'prepare_data', input: [], output: [{ label: '数据计划', value: [{ 名称: '计划数据集', 来源说明: '待确认来源' }], truncated: false }] })] : [],
      };
    } else if (url.pathname.endsWith('/live')) {
      body = { frames: [] };
    } else if (url.pathname.endsWith('/app/step')) {
      stepRequests += 1;
      throw new Error('查看详情不应推进工作流');
    } else {
      throw new Error(`未声明的测试请求：${url.pathname}`);
    }
    await route.fulfill({ status, json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.clock.install();
  await page.goto('http://127.0.0.1:5174/#/p/details-one');
  const stageButton = (name) => page.getByRole('button', { name, exact: true });
  await stageButton('4. 论文分析').waitFor();
  check(calls.length === 0, '未选择阶段就读取了所有任务详情');
  check(await page.locator('.flow-step').count() === 15, '并非每个阶段都有查看入口');
  await stageButton('4. 论文分析').click();
  let region = page.getByRole('region', { name: '论文分析 · 阶段详情', exact: true });
  await region.getByText('保存的论文分析结果', { exact: true }).waitFor();
  await region.getByText('<script>这只是论文内容</script>', { exact: true }).waitFor();
  check(await region.locator('script').count() === 0, '输入内容被执行为页面脚本');
  await region.getByText('内容较长，仅展示部分记录。', { exact: true }).waitFor();
  await region.getByText('仅展示此阶段最新 100 条任务，记录可能不完整。', { exact: true }).waitFor();
  check(calls.at(-1).stage === 'PAPER_ANALYSIS' && calls.at(-1).external_run_id === 'detail-run-one', '请求未指定阶段或运行');
  await region.screenshot({ path: 'output/playwright/stage-detail-wide.png', timeout: 6000 });

  await stageButton('1. 初始化').click();
  await page.getByText('此阶段尚无任务记录；部分阶段仅检查进入条件，不创建独立任务。', { exact: true }).waitFor();
  check(await page.getByText('保存的论文分析结果', { exact: true }).count() === 0, '切换阶段保留了旧阶段产出');

  await stageButton('5. 数据准备').click();
  region = page.getByRole('region', { name: '数据准备 · 阶段详情', exact: true });
  await region.getByRole('alert').waitFor();
  check(await region.getByText('此阶段尚无任务记录', { exact: false }).count() === 0, '查询失败被当作空记录');
  dataStatus = 200;
  await region.getByRole('button', { name: '刷新详情', exact: true }).click();
  await region.getByText('计划数据集', { exact: true }).waitFor();
  await region.getByText('未记录可展示的任务输入。', { exact: true }).waitFor();

  await stageButton('13. 实验执行').click();
  region = page.getByRole('region', { name: '实验执行 · 阶段详情', exact: true });
  await region.getByText('此任务仅演示流程，不提供科研指标或有效性结论。', { exact: true }).waitFor();
  check(await region.getByText('0.9997', { exact: true }).count() === 0, '前端显示了模拟指标');

  await page.setViewportSize({ width: 320, height: 1000 });
  await stageButton('4. 论文分析').focus();
  await page.keyboard.press('Enter');
  region = page.getByRole('region', { name: '论文分析 · 阶段详情', exact: true });
  await region.getByText('保存的论文分析结果', { exact: true }).waitFor();
  const fits = await region.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth;
  });
  check(fits, '320px 下详情内容超出可用区域');
  await region.screenshot({ path: 'output/playwright/stage-detail-narrow.png', timeout: 6000 });
  await stageButton('4. 论文分析').click();
  check(await page.locator('#stage-detail').count() === 0, '再次点击未收起详情');

  holdPaper = true;
  await stageButton('4. 论文分析').click();
  await page.getByRole('status').filter({ hasText: '正在读取任务记录' }).waitFor();
  check(typeof releasePaper === 'function', '慢请求未被捕获');
  await stageButton('1. 初始化').click();
  await page.getByText('此阶段尚无任务记录；部分阶段仅检查进入条件，不创建独立任务。', { exact: true }).waitFor();
  releasePaper();
  holdPaper = false;
  check(await page.getByText('保存的论文分析结果', { exact: true }).count() === 0, '迟到的响应覆盖了新阶段');

  runId = 'detail-run-two';
  await page.clock.runFor(61_000);
  await page.waitForFunction(() => document.querySelector('#stage-detail') === null);
  await stageButton('4. 论文分析').click();
  await page.getByText('保存的论文分析结果', { exact: true }).waitFor();
  check(calls.at(-1).external_run_id === 'detail-run-two', '新运行读到了旧运行的详情');
  paperStatus = 403;
  await page.getByRole('button', { name: '刷新详情', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '读取权限' }).waitFor();
  check(await page.getByText('保存的论文分析结果', { exact: true }).count() === 0, '权限错误后继续显示缓存结果');
  paperStatus = 200;

  await page.evaluate(() => { location.hash = '#/p/details-two'; });
  await page.getByRole('heading', { name: '详情 details-two', exact: true }).waitFor();
  check(await page.locator('#stage-detail').count() === 0, '切换项目未关闭旧详情');
  await stageButton('4. 论文分析').click();
  await page.getByText('保存的论文分析结果', { exact: true }).waitFor();
  check(calls.at(-1).external_id === 'details-two', '切换项目后查询了旧项目');

  l2 = true;
  const before = calls.length;
  await page.reload();
  await page.getByText('当前为公开摘要。', { exact: false }).waitFor();
  check(await page.locator('.flow-step').count() === 0, '降级视图仍提供任务查看入口');
  check(await page.locator('#stage-detail').count() === 0, '降级视图显示了任务详情');
  await page.clock.runFor(6100);
  check(calls.length === before, '降级视图读取了任务详情');
  check(stepRequests === 0, '查看任务详情意外推进工作流');
  return { passed: 10, detailRequests: calls.length, stepRequests, scenarios: ['按需读取与展开', '输入转义与截断说明', '阶段隔离与空记录', '失败重试', '模拟结果保护', '窄屏与键盘收起', '迟到响应隔离', '运行切换与权限错误', '项目隔离', '降级权限'] };
}
