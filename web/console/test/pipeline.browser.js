async (page) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const stages = [
    'INIT', 'INPUT_READY', 'CALIBRATING', 'PAPER_ANALYSIS', 'DATA_READY',
    'PROTOCOL_PROPOSED', 'PROTOCOL_REVIEW', 'COMPARISON_DISCOVERY',
    'COMPARISON_REPRODUCTION', 'BASELINE_VALIDATED', 'IDEA_GENERATION',
    'IDEA_SCREENING', 'EXPERIMENTING', 'IDEA_REVIEW', 'COMPLETED',
  ];
  let stepRequests = 0;
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/auth/me')) {
      body = { ok: true, username: 'browser-review', owner_id: 'owner-review' };
    } else if (url.pathname.endsWith('/views/project')) {
      body = {
        ok: true, generated_at: '2026-11-25T00:00:00Z', visibility: 'private',
        projection_level: 'full', writable: true,
        project: { external_id: 'pipeline-review', title: '链路布局测试', question: '研究问题', strategy: 'standard', autonomy: 'guided', last_sync_at: null },
        runs: [{ external_run_id: 'run-review', phase_tag: 'PAPER_ANALYSIS', status: 'blocked', stage_known: true, started_at: null, finished_at: null }],
        stages: stages.map((stage, index) => ({
          stage, stage_known: true, state: index < 3 ? 'passed' : index === 3 ? 'blocked' : 'pending',
          gate_note: index === 3 ? '请补充论文材料' : null, blocker_code: null,
        })),
        events: [], papers: [], ideas: [], experiments: [], claims: [], protocols: [], unsynced: null,
      };
    } else if (url.pathname.endsWith('/live')) {
      body = { frames: [] };
    } else if (url.pathname.endsWith('/app/step')) {
      stepRequests += 1;
      throw new Error('布局测试不应推进真实工作流');
    } else {
      throw new Error(`未声明的测试请求：${url.pathname}`);
    }
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.goto('http://127.0.0.1:5174/#/p/pipeline-review');
  const flow = page.getByRole('list', { name: '研究阶段', exact: true });
  await flow.waitFor();
  const measurements = [];
  for (const width of [1440, 1024, 900, 869, 868, 800, 769, 768, 640, 600, 390, 360, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await flow.evaluate((element) => { element.scrollLeft = 0; });
    const result = await flow.evaluate((element) => {
      const rect = (node) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      };
      return {
        bounds: rect(element), containerWidth: element.parentElement.clientWidth,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        vertical: getComputedStyle(element).flexDirection === 'column',
        nodes: [...element.children].map((node) => ({
          label: node.querySelector('.flow-label').textContent,
          dot: rect(node.querySelector('.flow-dot')),
          link: node.querySelector('.flow-link') ? rect(node.querySelector('.flow-link')) : null,
          done: node.querySelector('.flow-link')?.dataset.done,
        })),
      };
    });
    const near = (a, b) => Math.abs(a - b) <= 1;
    check(result.nodes.length === 15, `${width}px 阶段丢失`);
    check(result.vertical === (result.containerWidth <= 600), `${width}px 未按可用区域选择方向`);
    check(result.bounds.left >= 0 && result.bounds.right <= width + 1, `${width}px 链路超出页面`);
    check(result.nodes[0].label === '1. 初始化' && result.nodes[14].label === '15. 完成', '阶段序号或顺序错误');
    for (let index = 0; index < 14; index += 1) {
      const { dot, link, done } = result.nodes[index];
      const next = result.nodes[index + 1].dot;
      check(link !== null, `${width}px 第 ${index + 1} 条连接缺失`);
      check(done === (index < 3 ? '1' : '0'), '连线错误地表示后续阶段已通过');
      if (result.vertical) {
        check(near(dot.left, next.left) && next.top > dot.bottom, `${width}px 纵向顺序错误`);
        check(near(link.top, dot.bottom) && near(link.bottom, next.top), `${width}px 纵向连线断开`);
        check(near((link.left + link.right) / 2, (dot.left + dot.right) / 2), '纵向连线偏离节点中心');
      } else {
        check(near(dot.top, next.top) && next.left > dot.right, `${width}px 出现折行或阶段逆序`);
        check(near(link.left, dot.right) && near(link.right, next.left), `${width}px 横向连线断开`);
        check(near((link.top + link.bottom) / 2, (dot.top + dot.bottom) / 2), '横向连线偏离节点中心');
      }
    }
    check(result.nodes[14].link === null, '最后阶段后出现多余连线');
    if (result.vertical) {
      check(result.scrollWidth <= result.clientWidth, `${width}px 纵向链路仍需横向滚动`);
    } else {
      check(result.scrollWidth > result.clientWidth, '宽屏应能在链路内滚动查看后续阶段');
      await flow.focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => {
        const element = document.querySelector('.flow');
        return element.scrollLeft > 0;
      }, undefined, { timeout: 3000 });
      await flow.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      const visible = await flow.evaluate((element) => {
        const end = element.querySelector('.flow-node:last-child .flow-dot').getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return end.left >= bounds.left && end.right <= bounds.right;
      });
      check(visible, '横向滚动后无法看到最后阶段');
    }
    measurements.push({ width, vertical: result.vertical, connections: 14 });
  }
  const gateDetails = page.locator('.flow-layout details');
  if (!await gateDetails.evaluate((element) => element.open)) {
    await page.getByText('查看门槛说明', { exact: true }).click();
  }
  await page.getByText('请补充论文材料', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await flow.evaluate((element) => { element.scrollLeft = 0; });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  check(await flow.locator('.flow-node[data-state="blocked"]').count() === 1, '切换主题丢失阻断状态');
  check(stepRequests === 0, '布局检查发出了推进请求');
  return { passed: measurements.length, measurements, keyboardScroll: 'passed', gateNote: 'passed', stepRequests };
}
