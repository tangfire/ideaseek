async (page) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let socket;
  let level = 'owner';
  let steps = 0;
  await page.route('**/functions/v1/app/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let body;
    if (path.endsWith('/auth/me')) body = { ok: true, username: 'reviewer', owner_id: 'owner' };
    else if (path.endsWith('/views/project'))
      body = {
        ok: true,
        projection_level: level === 'public' ? 'l2' : 'full',
        writable: level === 'owner',
        visibility: 'private',
        project: {
          external_id: 'tabs',
          title: '页签键盘测试',
          question: '问题',
          strategy: 'standard',
          autonomy: 'guided',
          last_sync_at: null,
        },
        runs: [
          {
            external_run_id: 'tabs-run',
            phase_tag: 'PAPER_ANALYSIS',
            status: level === 'public' ? undefined : 'blocked',
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
        events: [],
        unsynced: null,
      };
    else if (path.endsWith('/views/resources'))
      body = {
        ok: true,
        external_run_id: 'tabs-run',
        tasks: [],
        artifacts: [],
        tasks_truncated: false,
        artifacts_truncated: false,
      };
    else if (path.endsWith('/views/approvals')) body = { ok: true, approvals: [] };
    else if (path.endsWith('/views/costs'))
      body = {
        ok: true,
        runs: [],
        summary: { total_usd_micro: 0, total_tokens_in: 0, total_tokens_out: 0, by_route: {} },
      };
    else if (path.endsWith('/views/egress')) body = { ok: true, runs: [] };
    else if (path.endsWith('/views/health')) body = { ok: true, health: null };
    else if (path.endsWith('/views/tokens')) body = { ok: true, tokens: [] };
    else if (path.endsWith('/views/access')) body = { ok: true, grants: [], shares: [] };
    else if (path.endsWith('/app/step') && req.method() === 'POST') {
      steps++;
      body = { ok: true, action: 'claimed', message: `键盘切换后步骤 ${steps}` };
    } else if (path.endsWith('/live')) body = { frames: [] };
    else throw new Error(`未声明的测试请求：${path}`);
    check(req.method() === 'GET' || path.endsWith('/app/step'), '键盘测试意外发起写入');
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', (ws) => {
    socket = ws;
  });
  await page.clock.install();
  await page.goto('http://127.0.0.1:5174/#/p/tabs');
  await page.getByRole('tab', { name: '概览', exact: true }).waitFor();
  const current = async (name) => {
    const tab = page.getByRole('tab', { name, exact: true });
    check((await tab.getAttribute('aria-selected')) === 'true', `${name} 未选中`);
    check(await tab.evaluate((el) => document.activeElement === el), `${name} 未获得焦点`);
    check((await page.locator('[role="tab"][tabindex="0"]').count()) === 1, '页签有多个 Tab 入口');
    const panel = page.getByRole('tabpanel', { name, exact: true });
    check(
      (await panel.getAttribute('id')) === (await tab.getAttribute('aria-controls')),
      '页签未关联当前面板',
    );
    check(
      (await panel.getAttribute('aria-labelledby')) === (await tab.getAttribute('id')),
      '面板未关联页签',
    );
  };
  await page.getByRole('tab', { name: '概览', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await current('材料与成果');
  await page.keyboard.press('ArrowRight');
  await current('运行');
  await page.keyboard.press('ArrowLeft');
  await current('材料与成果');
  await page.keyboard.press('Home');
  await current('概览');
  await page.keyboard.press('ArrowLeft');
  await current('协作');
  await page.keyboard.press('ArrowRight');
  await current('概览');
  await page.keyboard.press('End');
  await current('协作');
  await page.keyboard.press('Tab');
  check(
    await page
      .getByRole('button', { name: '继续运行', exact: true })
      .evaluate((el) => document.activeElement === el),
    'Tab 未按页面顺序进入公共运行控件',
  );
  await page.keyboard.press('Tab');
  check(
    await page
      .getByRole('tabpanel', { name: '协作', exact: true })
      .evaluate((el) => document.activeElement === el),
    'Tab 未离开页签进入内容',
  );
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await current('协作');
  await page.setViewportSize({ width: 320, height: 900 });
  await page.keyboard.press('Home');
  await current('概览');
  await page.keyboard.press('ArrowRight');
  await current('材料与成果');
  check(page.url().endsWith('#/p/tabs'), '键盘切换改变路由');
  await page.getByRole('button', { name: '继续运行', exact: true }).click();
  await page.getByRole('tab', { name: '材料与成果', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await current('运行');
  const firstStep = page.waitForResponse((res) => res.url().endsWith('/app/step'));
  await page.clock.runFor(2100);
  await firstStep;
  await page.getByText('键盘切换后步骤 1', { exact: true }).waitFor();
  check(
    steps === 1 && (await page.getByRole('button', { name: '暂停', exact: true }).count()) === 1,
    '键盘切换丢失或重复运行驱动',
  );
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const before = steps;
  await page.clock.runFor(4100);
  check(steps === before, '暂停后仍推进');
  const refreshPermissions = async (next) => {
    level = next;
    const response = page.waitForResponse((res) => res.url().includes('/views/project'));
    socket.send(JSON.stringify({ type: 'events', project_id: 'tabs', seq: 9, events: [] }));
    await response;
    await page.clock.runFor(50);
  };
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await refreshPermissions('reader');
  await page.getByText('当前为只读访问，运行操作由项目所有者执行。', { exact: true }).waitFor();
  await current('概览');
  check((await page.getByRole('tab').count()) === 3, '只读读者显示所有者页签');
  await page.keyboard.press('End');
  await current('运行');
  await page.keyboard.press('ArrowRight');
  await current('概览');
  await page.keyboard.press('ArrowRight');
  await current('材料与成果');
  await refreshPermissions('public');
  await page.getByText('当前为公开摘要。', { exact: false }).waitFor();
  await current('概览');
  check((await page.getByRole('tab').count()) === 2, '公开摘要显示私有页签');
  await page.keyboard.press('ArrowLeft');
  await current('运行');
  check(errors.length === 0, errors.join('; '));
  return {
    passed: 6,
    scenarios: [
      '左右键及首尾循环',
      'Home/End',
      '焦点/面板/Tab入口',
      '320px及路由保持',
      '切换保持运行驱动与暂停',
      '读者/公开摘要及权限变化',
    ],
    interceptedSteps: steps,
  };
}
