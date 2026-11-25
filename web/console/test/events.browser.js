async (page) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let socket;
  let connections = 0;
  let snapshotRequests = 0;
  let run = 'run-one';
  let limited = false;
  const event = (seq, summary) => ({
    seq,
    ts: '2026-11-25T00:00:00Z',
    phase_tag: 'PAPER_ANALYSIS',
    type: 'task_created',
    summary,
    level: 'info',
    gap_before: 0,
    truncated: false,
  });
  let events = [event(1, '同一事件'), event(2, '相同摘要'), event(3, '相同摘要')];
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/auth/me'))
      body = { ok: true, username: 'reviewer', owner_id: 'owner' };
    else if (url.pathname.endsWith('/views/project')) {
      snapshotRequests++;
      const id = url.searchParams.get('external_id');
      body = {
        ok: true,
        projection_level: limited ? 'l2' : 'full',
        writable: !limited,
        visibility: 'private',
        project: {
          external_id: id,
          title: `事件项目 ${id}`,
          question: '问题',
          strategy: 'standard',
          autonomy: 'guided',
          last_sync_at: null,
        },
        runs: [
          {
            external_run_id: run,
            phase_tag: 'PAPER_ANALYSIS',
            status: limited ? undefined : 'blocked',
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
        events: limited ? [] : events,
        unsynced: null,
      };
    } else if (url.pathname.endsWith('/live')) body = { frames: [] };
    else throw new Error(`未声明的测试请求：${url.pathname}`);
    check(route.request().method() === 'GET', '事件测试不得执行写操作');
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', (ws) => {
    socket = ws;
    connections++;
  });
  await page.goto('http://127.0.0.1:5174/#/p/events-one');
  await page.getByText('自动接收更新', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '运行', exact: true }).click();
  const send = async (payload, seq) => {
    const before = snapshotRequests;
    const response = page.waitForResponse((res) => res.url().includes('/views/project'));
    socket.send(JSON.stringify({ type: 'events', project_id: 'events-one', seq, events: payload }));
    await response;
    await page.waitForTimeout(80);
    check(snapshotRequests > before, '推送未刷新已保存事件');
  };
  await send([events[0]], 1);
  check((await page.getByText('同一事件', { exact: true }).count()) === 1, '快照和推送重复');
  check(
    (await page.getByText('相同摘要', { exact: true }).count()) === 2,
    '不同序号的相同摘要被错误去重',
  );
  await send([events[0]], 2);
  check((await page.getByText('同一事件', { exact: true }).count()) === 1, '重复推送再次叠加');
  events = [...events, event(4, '新保存事件')];
  await send([events[3]], 3);
  await page.getByText('新保存事件', { exact: true }).waitFor();
  check((await page.locator('tr').filter({ hasText: '#4' }).count()) === 1, '新事件重复或遗漏');
  await send([event(99, '未保存的推送')], 4);
  check(
    (await page.getByText('未保存的推送', { exact: true }).count()) === 0,
    '未定位到运行的推送被当成保存记录',
  );
  const beforeReconnect = connections;
  socket.close({ code: 1000, reason: 'test-reconnect' });
  for (let attempt = 0; attempt < 40 && connections === beforeReconnect; attempt++)
    await page.waitForTimeout(100);
  check(connections > beforeReconnect, '未在退避后重新建立连接');
  await send([events[0]], 5);
  check((await page.getByText('同一事件', { exact: true }).count()) === 1, '重连重放重复');
  run = 'run-two';
  events = [event(1, '新运行事件')];
  await send([event(1, '旧运行的迟到消息')], 6);
  await page.getByText('新运行事件', { exact: true }).waitFor();
  check((await page.getByText('同一事件', { exact: true }).count()) === 0, '运行切换保留旧事件');
  check(
    (await page.getByText('旧运行的迟到消息', { exact: true }).count()) === 0,
    '跨运行序号碰撞被拼接',
  );
  events = [event(1, '另一个项目事件')];
  await page.goto('http://127.0.0.1:5174/#/p/events-two');
  await page.getByRole('heading', { name: '事件项目 events-two', exact: true }).waitFor();
  await page.getByRole('tab', { name: '运行', exact: true }).click();
  await page.getByText('另一个项目事件', { exact: true }).waitFor();
  check((await page.getByText('新运行事件', { exact: true }).count()) === 0, '跨项目混合事件');
  await page.reload();
  await page.getByRole('tab', { name: '运行', exact: true }).click();
  check(
    (await page.getByText('另一个项目事件', { exact: true }).count()) === 1,
    '刷新后记录重复或丢失',
  );
  limited = true;
  await send([event(1, '不可公开的推送摘要')], 7);
  await page.getByText('当前为公开摘要。', { exact: false }).waitFor();
  check(
    (await page.getByText('另一个项目事件', { exact: true }).count()) === 0 &&
      (await page.getByText('不可公开的推送摘要', { exact: true }).count()) === 0,
    '降级后事件仍可见',
  );
  check(errors.length === 0, errors.join('; '));
  return {
    passed: 6,
    scenarios: [
      '快照/重复推送去重与同摘要保留',
      '新保存事件与未保存推送隔离',
      '重连重放',
      '运行切换和迟到消息',
      '项目隔离及刷新',
      '公开摘要隔离',
    ],
    snapshotRequests,
    mutations: 0,
  };
}
