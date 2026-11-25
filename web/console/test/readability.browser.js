async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const task = { external_task_id: 'readable-task', kind: 'analyze_paper', stage: 'PAPER_ANALYSIS', status: 'succeeded', attempt: 1, max_attempts: 3,
    started_at: null, ended_at: null, simulated: false, input: [{ label: '论文摘要', value: '已保存的论文摘要', truncated: false }],
    output: [{ label: '方法摘要', value: '可以展开检查的研究材料与产出。', truncated: false }] };
  const stages = ['INIT', 'INPUT_READY', 'CALIBRATING', 'PAPER_ANALYSIS', 'DATA_READY', 'PROTOCOL_PROPOSED', 'PROTOCOL_REVIEW',
    'COMPARISON_DISCOVERY', 'COMPARISON_REPRODUCTION', 'BASELINE_VALIDATED', 'IDEA_GENERATION', 'IDEA_SCREENING', 'EXPERIMENTING', 'IDEA_REVIEW', 'COMPLETED'];
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/auth/me')) body = { ok: true, username: 'browser-review', owner_id: 'owner-review' };
    else if (url.pathname.endsWith('/live')) body = { frames: [] };
    else if (url.pathname.endsWith('/views/project')) body = { ok: true, generated_at: '2026-11-25T00:00:00Z', visibility: 'private', projection_level: 'full', writable: true,
      project: { external_id: 'readability', title: '研究工作区', question: '在清楚的材料和证据基础上，验证新的研究想法。', strategy: 'standard', autonomy: 'guided', last_sync_at: null },
      runs: [{ external_run_id: 'readable-run', phase_tag: 'PAPER_ANALYSIS', status: 'blocked', stage_known: true, started_at: null, finished_at: null,
        block_detail: { kind: 'USER_INPUT_REQUIRED', message: '请补充论文材料，已保存的结果将会保留。', next: '检查材料与成果后继续。' } }],
      stages: stages.map((stage, i) => ({ stage, stage_known: true, state: ['passed', 'active', 'blocked', 'failed', 'QUOTA_EXHAUSTED', 'pending'][i % 6], gate_note: null, blocker_code: null })),
      events: [], unsynced: null, claims: [], protocols: [],
      papers: [{ external_paper_id: 'paper-readable', title: '论文标题与研究问题', question: '实验是否有充分证据？', method_summary: '方法摘要和来源说明应当清楚可读。', parse_status: 'succeeded' }],
      ideas: [{ external_idea_id: 'idea-draft', title: '待核验的草稿想法', mechanism_summary: '这是待验证机制，尚未证明有效。', status: 'DRAFT_COMPOSITION', version: 1, hypothesis_disclosure: 'withheld', paper_sources: [] }],
      experiments: [{ external_spec_id: 'experiment-readable', title: '同次运行的实验记录', idea_id: 'idea-draft', status: 'succeeded', scale: 'quick',
        metric_rows: [{ name: 'accuracy', value: 0.812345678, stdev: 0.01, n: 2, direction: 'higher', controls: [{ method_id: 'control', value: 0.8, stdev: 0, delta: 0.012345678 }] }] },
        { external_spec_id: 'experiment-failed', title: '失败记录', idea_id: null, status: 'failed', scale: null },
        { external_spec_id: 'experiment-simulated', title: '模拟记录', idea_id: null, status: 'simulated', scale: null }],
    };
    else if (url.pathname.endsWith('/views/stage')) body = { ok: true, external_run_id: 'readable-run', stage: 'PAPER_ANALYSIS', tasks: [task], truncated: false };
    else if (url.pathname.endsWith('/views/resources')) body = { ok: true, external_run_id: 'readable-run', tasks: [task], artifacts: [], tasks_truncated: false, artifacts_truncated: false };
    else if (url.pathname.endsWith('/views/index')) body = { ok: true, generated_at: '2026-11-25T00:00:00Z', projects: [], provisioning: [], audit: [] };
    else if (url.pathname.endsWith('/views/commands')) body = { ok: true, commands: [], provisioning: [], audit: [] };
    else throw new Error(`可读性检查不应触发其他请求：${url.pathname}`);
    check(route.request().method() === 'GET', '可读性检查意外执行了写操作');
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  const audit = async (theme) => {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.waitForTimeout(200);
    const result = await page.evaluate(() => {
      const rgb = (color) => {
        const values = color.match(/[\d.]+/g)?.map(Number);
        if (!values || values.length < 3) throw new Error(`无法计算颜色：${color}`);
        return [values[0], values[1], values[2], values.length === 4 ? values[3] : 1];
      };
      const mix = (top, base) => top.slice(0, 3).map((value, i) => value * top[3] + base[i] * (1 - top[3]));
      const background = (el) => {
        const ancestors = [];
        for (let item = el; item; item = item.parentElement) ancestors.unshift(item);
        return ancestors.reduce((base, item) => mix(rgb(getComputedStyle(item).backgroundColor), base), [255, 255, 255]);
      };
      const luminance = (color) => color.map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
      const failures = [];
      let minimum = Infinity;
      let measured = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const el = node.parentElement;
        if (!el || !node.textContent.trim() || el.closest('script,style,[disabled],option')) continue;
        const range = document.createRange(); range.selectNode(node);
        const box = range.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const style = getComputedStyle(el);
        let opacity = 1;
        for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity);
        const base = background(el);
        const color = rgb(style.color); color[3] *= opacity;
        const ratio = contrast(mix(color, base), base);
        const size = Number.parseFloat(style.fontSize);
        measured++; minimum = Math.min(minimum, ratio);
        if (ratio < 4.5 || size < 13) failures.push({ text: node.textContent.trim().slice(0, 45), ratio: Number(ratio.toFixed(2)), size });
      }
      const controls = [...document.querySelectorAll('button.primary,.btn-primary,input,select,textarea')].filter((el) => !el.disabled && el.getBoundingClientRect().width > 0);
      for (const el of controls) {
        const style = getComputedStyle(el);
        const base = background(el);
        const ratio = contrast(mix(rgb(style.color), base), base);
        if (ratio < 4.5 || Number.parseFloat(style.fontSize) < 13) failures.push({ control: el.tagName, ratio, size: style.fontSize });
        if (el.matches('button')) {
          const previous = getComputedStyle(el).backgroundColor;
          if (previous === 'rgba(0, 0, 0, 0)') throw new Error('主按钮缺少背景');
        } else {
          if (Number.parseFloat(style.fontSize) < 16) failures.push({ control: el.tagName, reason: '输入控件字号不足16px' });
          const borderRatio = contrast(mix(rgb(style.borderTopColor), base), base);
          if (borderRatio < 3) failures.push({ control: el.tagName, reason: '边界对比度不足3:1', borderRatio });
        }
      }
      const placeholder = [...document.querySelectorAll('input[placeholder],textarea[placeholder]')].filter((el) => el.getBoundingClientRect().width > 0);
      for (const el of placeholder) {
        const style = getComputedStyle(el, '::placeholder');
        const base = background(el);
        const ratio = contrast(mix(rgb(style.color), base), base);
        if (ratio < 4.5 || style.opacity !== '1') failures.push({ placeholder: el.getAttribute('placeholder'), ratio, opacity: style.opacity });
      }
      return { failures, measured, minimum: Number(minimum.toFixed(2)) };
    });
    check(result.failures.length === 0, `${theme} 可读性不合格：${JSON.stringify(result.failures)}`);
    return { theme, ...result };
  };
  await page.goto('http://127.0.0.1:5174/#/p/readability');
  await page.getByRole('heading', { name: '产出链', exact: true }).waitFor();
  await page.getByRole('button', { name: '4. 论文分析', exact: true }).click();
  await page.getByText('已保存的论文摘要', { exact: true }).waitFor();
  const results = [];
  for (const width of [1440, 1024, 900, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['dark', 'light']) results.push({ width, ...await audit(theme) });
    check(await page.locator('.output-record,.stage-detail').evaluateAll((items) => items.every((el) => el.scrollWidth <= el.clientWidth + 1)), `${width}px 放大字号后产出或详情溢出`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('#output-paper-paper-readable').screenshot({ path: 'output/playwright/readability-narrow-dark.png', timeout: 6000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('.chain').screenshot({ path: 'output/playwright/readability-wide-light.png', timeout: 6000 });
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: '继续运行', exact: true }).hover();
    results.push({ state: 'primary-hover', ...await audit(theme) });
  }
  await page.getByRole('tab', { name: '材料与成果', exact: true }).click();
  await page.getByRole('button', { name: '查看输入与产出', exact: true }).click();
  for (const theme of ['dark', 'light']) results.push({ state: 'resources', ...await audit(theme) });
  // 浏览器缩放后保持内容可读，相当于窄视口中放大文字。
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  check(await page.locator('.resources').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), '200% 放大后材料内容溢出');
  await page.evaluate(() => { document.body.style.zoom = ''; });
  await page.getByRole('tab', { name: '运行', exact: true }).click();
  for (const theme of ['dark', 'light']) results.push({ state: 'event-filters', ...await audit(theme) });
  await page.goto('http://127.0.0.1:5174/#/login');
  await page.getByLabel('用户名').waitFor();
  for (const theme of ['dark', 'light']) results.push({ state: 'login', ...await audit(theme) });
  check(errors.length === 0, `浏览器错误：${errors.join('; ')}`);
  return { passed: 6, results, scenarios: ['浅深主题文字对比度至少4.5:1', '正文及辅助文字字号下限', '主按钮与悬停', '输入与占位文字', '六种宽度与200%放大', '草稿及阶段/材料布局'], mutations: 0 };
}
