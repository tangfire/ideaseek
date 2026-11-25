async (page) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let healthMode = 'hold';
  let release;
  let healthRequests = 0;
  let pendingBatches = 7;
  await page.route('**/functions/v1/app/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let body;
    check(req.method() === 'GET', '同步健康评审意外发起写入');
    if (path.endsWith('/auth/me')) body = { ok: true, username: 'reviewer', owner_id: 'owner' };
    else if (path.endsWith('/views/project'))
      body = {
        ok: true,
        projection_level: 'full',
        writable: true,
        visibility: 'private',
        project: {
          external_id: 'health-review',
          title: '同步健康错误路径评审',
          question: '问题',
          strategy: 'standard',
          autonomy: 'guided',
          last_sync_at: null,
        },
        runs: [],
        stages: [],
        papers: [],
        ideas: [],
        experiments: [],
        claims: [],
        protocols: [],
        events: [],
        unsynced: null,
      };
    else if (path.endsWith('/views/approvals')) body = { ok: true, approvals: [] };
    else if (path.endsWith('/views/costs'))
      body = {
        ok: true,
        runs: [],
        summary: { total_usd_micro: 0, total_tokens_in: 0, total_tokens_out: 0, by_route: {} },
      };
    else if (path.endsWith('/views/egress')) body = { ok: true, runs: [] };
    else if (path.endsWith('/views/tokens')) body = { ok: true, tokens: [] };
    else if (path.endsWith('/views/health')) {
      healthRequests++;
      if (healthMode === 'hold')
        await new Promise((resolve) => {
          release = resolve;
        });
      if (healthMode === 'fail' || healthMode === 'forbidden') {
        await route.fulfill({ status: healthMode === 'forbidden' ? 403 : 503, json: { ok: false, message: 'internal-do-not-display' } });
        return;
      }
      body = healthMode === 'public' ? { ok: true, projection_level: 'l2', health: null } : healthMode === 'malformed' ? { ok: true, projection_level: 'full', health: null } : {
        ok: true,
        projection_level: 'full',
        health: { latest_batch: null, pending_batches: pendingBatches, rejected_reason_distribution: {} },
      };
    } else if (path.endsWith('/live')) body = { frames: [] };
    else throw new Error(`评审未声明的请求：${path}`);
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.clock.install();
  await page.goto('http://127.0.0.1:5174/#/p/health-review');
  const audit = page.getByRole('tab', { name: '审计', exact: true });
  await audit.click();
  const panel = page
    .locator('.panel')
    .filter({ has: page.getByRole('heading', { name: '同步健康', exact: true }) });
  await panel.getByRole('status').filter({ hasText: '正在加载同步健康' }).waitFor();
  check(
    (await panel.getByText('公开摘要不展示同步详情。', { exact: true }).count()) === 0 && await panel.getByRole('alert').count() === 0,
    '加载期间误示为权限限制或错误',
  );
  const busy = panel.getByRole('button', { name: '正在刷新同步健康…', exact: true });
  const refresh = panel.getByRole('button', { name: '刷新同步健康', exact: true });
  check(await busy.isDisabled(), '加载期间允许重复刷新');
  check(typeof release === 'function', '未拦截同步健康请求');
  const firstResponse = page.waitForResponse((res) => res.url().includes('/views/health'));
  healthMode = 'fail';
  release();
  await firstResponse;
  await page.clock.runFor(1500);
  await panel.getByRole('alert').filter({ hasText: '同步健康读取失败：云端服务暂时不可用' }).waitFor();
  check(
    (await panel.getByText('公开摘要不展示同步详情。', { exact: true }).count()) === 0 && !(await panel.innerText()).includes('internal-do-not-display'),
    '503 被误示为公开摘要或泄露内部错误',
  );
  await page.screenshot({ path: 'output/playwright/review-health-failure.png', fullPage: true });
  healthMode = 'hold';
  const recovery = page.waitForResponse((res) => res.url().includes('/views/health'));
  await refresh.click();
  await busy.waitFor();
  const beforeRecovery = healthRequests;
  await page.clock.runFor(2100);
  check(healthRequests === beforeRecovery && await busy.isDisabled(), '刷新等待期间重复发起读取');
  healthMode = 'success'; release();
  await recovery;
  await panel.getByText('7', { exact: true }).waitFor();
  check(await panel.getByRole('alert').count() === 0, '恢复后保留旧错误');
  healthMode = 'hold';
  const failedRefresh = page.waitForResponse((res) => res.url().includes('/views/health'));
  await refresh.click();
  await panel.getByRole('status').filter({ hasText: '当前显示上次读取的结果' }).waitFor();
  check(await panel.getByText('7', { exact: true }).count() === 1, '刷新等待时丢失上次统计');
  healthMode = 'fail'; release();
  await failedRefresh;
  await page.clock.runFor(1500);
  await panel.getByRole('alert').filter({ hasText: '上次读取的结果已隐藏，请刷新后核对' }).waitFor();
  check(
    (await panel.getByText('7', { exact: true }).count()) === 0,
    '读取失败后仍展示旧统计',
  );
  await page.screenshot({ path: 'output/playwright/health-stale-error-fixed.png', fullPage: true });
  const read = async (mode) => {
    healthMode = mode;
    const response = page.waitForResponse((res) => res.url().includes('/views/health'));
    await refresh.click(); await response; await page.clock.runFor(1500); await refresh.waitFor();
  };
  pendingBatches = 0; await read('success');
  await panel.getByText('0', { exact: true }).waitFor();
  check(await panel.getByRole('alert').count() === 0, '成功读取零值后保留旧错误');
  await read('public');
  await panel.getByText('公开摘要不展示同步详情。', { exact: true }).waitFor();
  check(await panel.getByText('待处理批次', { exact: true }).count() === 0, '公开摘要仍显示旧统计');
  await read('fail');
  await panel.getByRole('alert').waitFor();
  check(await panel.getByText('公开摘要不展示同步详情。', { exact: true }).count() === 0, '公开摘要缓存掩盖后续故障');
  await read('malformed');
  await panel.getByRole('alert').filter({ hasText: '服务未返回有效的同步健康数据' }).waitFor();
  check(await panel.getByText('公开摘要不展示同步详情。', { exact: true }).count() === 0, '完整响应缺少数据被冒充公开摘要');
  await read('success'); await read('forbidden');
  await panel.getByRole('alert').filter({ hasText: '当前账号没有这个项目的读取权限' }).waitFor();
  check(await panel.getByText('待处理批次', { exact: true }).count() === 0, '权限拒绝后仍展示旧统计');
  await page.setViewportSize({ width: 320, height: 900 });
  check(await panel.evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth && el.scrollWidth <= el.clientWidth), '窄屏同步健康提示溢出');
  await page.screenshot({ path: 'output/playwright/health-error-narrow-fixed.png', fullPage: true });
  check(errors.length === 0, errors.join('; '));
  return {
    passed: 7,
    healthRequests,
    scenarios: ['加载状态不误报权限', '首次503及安全错误', '手动恢复及等待去重', '缓存刷新提示与失败隐藏旧统计', '零值及错误清除', '公开摘要与缺数据响应', '权限拒绝及320px布局'],
    mutations: 0,
  };
}
