async (page) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const calls = [];
  let currentRun = 'run-one';
  let nextAction = 'claimed';
  let phase = 'PAPER_ANALYSIS';
  const projectView = (id) => ({
    ok: true, generated_at: '2026-11-25T00:00:00Z', visibility: 'private',
    projection_level: 'full', writable: true,
    project: { external_id: id, title: `项目 ${id}`, question: '研究问题', strategy: 'standard', autonomy: 'guided', last_sync_at: null },
    runs: [{ external_run_id: currentRun, phase_tag: phase, status: phase === 'COMPLETED' ? 'succeeded' : 'running', stage_known: true, started_at: null, finished_at: null }],
    stages: [], events: [], papers: [], ideas: [], experiments: [], claims: [], protocols: [], unsynced: null,
  });
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/auth/me')) {
      body = { ok: true, username: 'browser-review', owner_id: 'owner-review' };
    } else if (url.pathname.endsWith('/views/project')) {
      body = projectView(url.searchParams.get('external_id'));
    } else if (url.pathname.endsWith('/app/step')) {
      calls.push(route.request().postDataJSON());
      body = { ok: true, action: nextAction, message: `步骤 ${calls.length}：${nextAction}` };
    } else if (url.pathname.endsWith('/live')) {
      body = { frames: [] };
    } else {
      throw new Error(`未声明的测试请求：${url.pathname}`);
    }
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.clock.install();
  await page.goto('http://127.0.0.1:5174/#/p/project-one');
  await page.getByRole('button', { name: '继续运行', exact: true }).waitFor();

  const step = async () => {
    const before = calls.length;
    const response = page.waitForResponse((res) => res.url().endsWith('/app/step'));
    await page.clock.runFor(2100);
    await response;
    await page.getByText(`步骤 ${before + 1}：${nextAction}`, { exact: true }).waitFor();
    check(calls.length === before + 1, '同一周期只能有一个运行驱动');
  };
  const noStep = async () => {
    const before = calls.length;
    await page.clock.runFor(4100);
    check(calls.length === before, '暂停或离开项目后仍发出了推进请求');
  };

  await page.getByRole('button', { name: '继续运行', exact: true }).click();
  await step();
  await page.getByRole('tab', { name: '运行', exact: true }).click();
  check(await page.getByRole('button', { name: '暂停', exact: true }).count() === 1, '切换页签后运行状态丢失或重复');
  await step();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await step();
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await step();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await noStep();
  await page.getByRole('tab', { name: '运行', exact: true }).click();
  await noStep();
  console.log('PASS：切换概览、运行、设置保持单一驱动；暂停后跨页签不自动重启');

  nextAction = 'blocked';
  await page.getByRole('button', { name: '继续运行', exact: true }).click();
  await step();
  await noStep();
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.getByText(`步骤 ${calls.length}：blocked`, { exact: true }).waitFor();
  check(await page.getByRole('button', { name: '暂停', exact: true }).count() === 0, '阻断后没有停止驱动');
  console.log('PASS：阻断后停止推进，跨页签保留原因');

  nextAction = 'claimed';
  await page.getByRole('button', { name: '继续运行', exact: true }).click();
  await step();
  await page.evaluate(() => { location.hash = '#/p/project-two'; });
  await page.getByRole('heading', { name: '项目 project-two', exact: true }).waitFor();
  await page.getByRole('button', { name: '继续运行', exact: true }).waitFor();
  await noStep();
  await page.getByRole('button', { name: '继续运行', exact: true }).click();
  await step();
  check(calls.at(-1).project_id === 'project-two', '切换项目后仍推进旧项目');
  console.log('PASS：切换项目停止旧驱动，新项目需手动启动');

  currentRun = 'run-two';
  await page.clock.runFor(61_000);
  await page.getByRole('button', { name: '继续运行', exact: true }).waitFor();
  await noStep();
  await page.getByRole('button', { name: '继续运行', exact: true }).click();
  nextAction = 'completed';
  await step();
  check(calls.at(-1).external_run_id === 'run-two', '新的运行继承了旧运行的身份');
  await page.getByText('研究流程已完成', { exact: true }).waitFor();
  await noStep();
  await page.getByRole('tab', { name: '运行', exact: true }).click();
  await page.getByText('研究流程已完成', { exact: true }).waitFor();
  console.log('PASS：新运行重置驱动，完成后跨页签保持终态并停止请求');
  currentRun = 'run-three';
  nextAction = 'claimed';
  await page.clock.runFor(61_000);
  await page.getByRole('button', { name: '继续运行', exact: true }).waitFor();
  await page.getByRole('button', { name: '继续运行', exact: true }).click();
  phase = 'COMPLETED';
  await step();
  await page.getByText('研究流程已完成', { exact: true }).waitFor();
  await noStep();
  console.log('PASS：服务端完成状态刷新后停止推进');
  return { passed: 5, stepRequests: calls.length };
}
