async (page) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const calls = [];
  let phase = 'INIT';
  let status = 'created';
  let responseStatus = 200;
  let hold = false;
  let release;
  let stepObserved;
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/auth/me')) {
      body = { ok: true, username: 'browser-review', owner_id: 'owner-review' };
    } else if (url.pathname.endsWith('/views/project')) {
      const id = url.searchParams.get('external_id');
      body = {
        ok: true, generated_at: '2026-11-25T00:00:00Z', visibility: 'private',
        projection_level: 'full', writable: true,
        project: { external_id: id, title: `项目 ${id}`, question: '研究问题', strategy: 'standard', autonomy: 'guided', last_sync_at: null },
        runs: [{ external_run_id: 'run-control', phase_tag: phase, status, stage_known: true, started_at: null, finished_at: null }],
        stages: [], events: [], papers: [], ideas: [], experiments: [], claims: [], protocols: [], unsynced: null,
      };
    } else if (url.pathname.endsWith('/app/step')) {
      calls.push(route.request().postDataJSON());
      stepObserved?.();
      stepObserved = undefined;
      const code = responseStatus;
      const number = calls.length;
      if (hold) await new Promise((resolve) => { release = resolve; });
      if (code === 200) {
        phase = 'PAPER_ANALYSIS';
        status = 'running';
      }
      await route.fulfill({ status: code, json: { ok: code === 200, action: 'claimed', message: `步骤 ${number} 已保存` } });
      return;
    } else if (url.pathname.endsWith('/live')) {
      body = { frames: [] };
    } else {
      throw new Error(`未声明的测试请求：${url.pathname}`);
    }
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.clock.install();
  await page.goto('http://127.0.0.1:5174/#/p/control-one');
  const button = (name) => page.getByRole('button', { name, exact: true });
  const noStep = async () => {
    const before = calls.length;
    await page.clock.runFor(6100);
    check(calls.length === before, '停止推进后仍发出了新请求');
  };
  const startStep = async () => {
    const intercepted = new Promise((resolve) => { stepObserved = resolve; });
    const request = page.waitForRequest((req) => req.url().endsWith('/app/step'));
    await page.clock.runFor(2100);
    await request;
    await intercepted;
  };
  const finishStep = async () => {
    const response = page.waitForResponse((res) => res.url().endsWith('/app/step'));
    await startStep();
    await response;
  };

  await button('开始运行').waitFor();
  await page.getByRole('status').filter({ hasText: '尚未开始' }).waitFor();
  await noStep();
  await button('开始运行').click();
  await button('暂停').click();
  await button('继续运行').waitFor();
  await page.getByRole('status').filter({ hasText: '已暂停推进' }).waitFor();
  await noStep();

  hold = true;
  await button('继续运行').click();
  await startStep();
  const pendingCount = calls.length;
  await page.clock.runFor(8100);
  check(calls.length === pendingCount, '慢请求未返回时重复发起了步骤');
  await button('暂停').click();
  await page.getByText('正在暂停，等待当前步骤返回', { exact: true }).waitFor();
  check(await button('等待当前步骤完成').isDisabled(), '旧请求未完成时允许再次启动');
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  check(await button('等待当前步骤完成').isDisabled(), '切换页签丢失了正在暂停状态');
  await noStep();
  const delayedResponse = page.waitForResponse((res) => res.url().endsWith('/app/step'));
  check(typeof release === 'function', '延迟请求没有被捕获');
  release();
  await delayedResponse;
  await page.getByText(`步骤 ${pendingCount} 已保存`, { exact: true }).waitFor();
  await page.getByText('已暂停推进', { exact: true }).waitFor();
  await button('继续运行').waitFor();
  await noStep();

  hold = false;
  responseStatus = 503;
  await button('继续运行').click();
  await finishStep();
  await page.getByRole('alert').filter({ hasText: '云端服务暂时不可用' }).waitFor();
  await page.getByText('请求失败，推进已停止', { exact: true }).waitFor();
  await noStep();
  responseStatus = 429;
  await button('继续运行').click();
  await finishStep();
  await page.getByRole('alert').filter({ hasText: '请求过于频繁，请稍后点击继续运行' }).waitFor();
  await noStep();

  responseStatus = 200;
  await button('继续运行').click();
  await finishStep();
  await page.getByText(`步骤 ${calls.length} 已保存`, { exact: true }).waitFor();
  check(await page.getByRole('alert').count() === 0, '恢复后仍显示旧请求错误');
  await page.reload();
  await button('继续运行').waitFor();
  await page.getByText('等待继续', { exact: true }).waitFor();
  await noStep();

  await button('继续运行').click();
  await finishStep();
  await page.evaluate(() => { location.hash = '#/p/control-two'; });
  await page.getByRole('heading', { name: '项目 control-two', exact: true }).waitFor();
  await button('继续运行').waitFor();
  await noStep();
  await page.evaluate(() => { location.hash = '#/p/control-one'; });
  await page.getByRole('heading', { name: '项目 control-one', exact: true }).waitFor();
  await button('继续运行').waitFor();
  await noStep();

  await button('继续运行').click();
  await finishStep();
  await page.goto('about:blank');
  await noStep();
  await page.goto('http://127.0.0.1:5174/#/p/control-one');
  await button('继续运行').waitFor();
  await noStep();
  return { passed: 7, stepRequests: calls.length, scenarios: ['首次启动与暂停', '慢请求串行与暂停等待', '服务失败停止', '限流停止及手动恢复', '刷新后手动继续', '离开项目后手动继续', '离开页面后手动继续'] };
}
