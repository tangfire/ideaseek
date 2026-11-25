async (page) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  let socket;
  let snapshots = 0;
  let rejectedWrites = 0;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const event = {
    seq: 1,
    ts: '2026-11-25T00:00:00Z',
    phase_tag: 'PAPER_ANALYSIS',
    type: 'task_created',
    summary: '复评：同一条事件',
    level: 'info',
    gap_before: 0,
    truncated: false,
  };
  await page.route('**/functions/v1/app/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body;
    if (url.pathname.endsWith('/auth/me'))
      body = { ok: true, username: 'reviewer', owner_id: 'owner' };
    else if (url.pathname.endsWith('/views/project')) {
      snapshots++;
      body = {
        ok: true,
        generated_at: '2026-11-25T00:00:00Z',
        projection_level: 'full',
        writable: true,
        visibility: 'private',
        project: {
          external_id: 'reevaluation',
          title: '修复后复评',
          question: '研究问题',
          strategy: 'standard',
          autonomy: 'guided',
          last_sync_at: null,
        },
        runs: [
          {
            external_run_id: 'review-run',
            phase_tag: 'PAPER_ANALYSIS',
            status: 'blocked',
            stage_known: true,
            started_at: null,
            finished_at: null,
          },
        ],
        stages: [],
        papers: [],
        ideas: [],
        experiments: [],
        claims: [],
        protocols: [],
        events: [event],
        unsynced: null,
      };
    } else if (url.pathname.endsWith('/views/resources'))
      body = {
        ok: true,
        external_run_id: 'review-run',
        tasks: [],
        artifacts: [],
        tasks_truncated: false,
        artifacts_truncated: false,
      };
    else if (url.pathname.endsWith('/views/approvals')) body = { ok: true, approvals: [] };
    else if (url.pathname.endsWith('/views/costs'))
      body = {
        ok: true,
        runs: [],
        summary: { total_usd_micro: 0, total_tokens_in: 0, total_tokens_out: 0, by_route: {} },
      };
    else if (url.pathname.endsWith('/views/egress')) body = { ok: true, runs: [] };
    else if (url.pathname.endsWith('/views/health')) body = { ok: true, projection_level: 'full', health: { latest_batch: null, pending_batches: 0, rejected_reason_distribution: {} } };
    else if (url.pathname.endsWith('/views/tokens') && request.method() === 'GET')
      body = { ok: true, tokens: [] };
    else if (url.pathname.endsWith('/views/tokens') && request.method() === 'POST') {
      rejectedWrites++;
      await route.fulfill({ status: 503, json: { ok: false } });
      return;
    } else if (url.pathname.endsWith('/live')) body = { frames: [] };
    else throw new Error(`复评未声明的请求：${url.pathname}`);
    check(request.method() === 'GET', '复评意外发起其他写请求');
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', (ws) => {
    socket = ws;
  });
  await page.goto('http://127.0.0.1:5174/#/p/reevaluation');
  await page.getByText('自动接收更新', { exact: true }).waitFor();
  check(socket, '未建立复评用更新通道');
  const refreshed = page.waitForResponse((response) => response.url().includes('/views/project'));
  socket.send(
    JSON.stringify({ type: 'events', project_id: 'reevaluation', seq: 1, events: [event] }),
  );
  await refreshed;
  await page.getByRole('tab', { name: '运行', exact: true }).click();
  await page.getByText(event.summary, { exact: true }).first().waitFor();
  await page.waitForTimeout(200);
  const eventCopies = await page.getByText(event.summary, { exact: true }).count();
  check(eventCopies === 1 && snapshots >= 2, '重复推送后没有保持单条已保存事件');
  await page.screenshot({ path: 'output/playwright/reevaluation-events.png', fullPage: true });
  const overview = page.getByRole('tab', { name: '概览', exact: true });
  await overview.focus();
  await page.keyboard.press('ArrowRight');
  const resources = page.getByRole('tab', { name: '材料与成果', exact: true });
  check(
    (await resources.evaluate((el) => document.activeElement === el)) &&
      (await resources.getAttribute('aria-selected')) === 'true',
    '右方向键没有移动焦点并切换页签',
  );
  await page.getByRole('tabpanel', { name: '材料与成果', exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/reevaluation-tabs.png', fullPage: true });
  await page.getByRole('tab', { name: '审计', exact: true }).click();
  const createToken = page.getByRole('button', { name: '签发新 Token', exact: true });
  await createToken.waitFor();
  await createToken.click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (el) => el.textContent.trim() === '签发新 Token' && !el.disabled,
    ),
  );
  check(rejectedWrites === 1, '未执行拦截的服务失败场景');
  await page.getByRole('alert').filter({ hasText: '云端服务暂时不可用' }).waitFor();
  check(
    (await page
      .getByRole('alert')
      .filter({ hasText: '签发未确认：' })
      .filter({ hasText: '请先刷新凭据列表核对' })
      .count()) === 1,
    '失败后未说明需要核对结果',
  );
  await page.screenshot({
    path: 'output/playwright/reevaluation-credential-error.png',
    fullPage: true,
  });
  check(errors.length === 0, errors.join('; '));
  return {
    passed: 3,
    eventCopies,
    arrowKeyMovesAndSelects: true,
    credentialFailureVisible: true,
    interceptedRejectedWrites: rejectedWrites,
  };
}
