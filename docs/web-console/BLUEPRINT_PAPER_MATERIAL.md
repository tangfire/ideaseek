# 论文材料提供 — 蓝图

日期：2026-11-28　依赖：`REQUIREMENTS_ANALYSIS_PAPER_MATERIAL.md`　状态：设计阶段，未实现

## 1. 愿景

把"材料与成果"页从只读陈列升级为**材料中心**：用户在这里回答三个问题——在哪提供、提供了什么、怎么管理——并让 PAPER_ANALYSIS 阻断从死路变成两步可恢复的正常流程。

```text
现在：阻断 → 提示"补充论文材料" → 无处可补 → 死路
目标：阻断 → 阻断卡片[补充论文] → 粘贴/上传 → 自动恢复 → 分析继续
```

## 2. 端到端旅程

### S1 阻断恢复（主旅程）

```text
run 卡在 PAPER_ANALYSIS（block_reason=paper_input_required）
  → 概览页 BlockReasonCard 显示缺口 + [补充论文] 主按钮
  → 打开材料中心的提供表单（预填论文分析所需类型）
  → 用户粘贴正文/摘要（或 P1：上传 PDF）
  → POST /projects/:id/materials（写材料 + 回填 queued analyze_paper 的 payload）
  → 自动调用 POST /app/step
  → step-driver 既有逻辑检测 payload 齐全 → 清除阻断 → 任务入队执行
  → 阶段徽章 blocked → running，事件流记录"材料已补充"
```

### S2 提前登记

材料与成果页 [提供材料] → 表单 → 登记成功进入"待消费"清单 → 开始运行后被分析任务消费 → 状态翻转"已消费"并显示消费任务 ID。

### S3 缺口直达

阶段详情"分析论文"任务的输入清单显示 `缺少：论文正文或摘要 [去提供]` → 同一表单。

## 3. 信息架构

### 3.1 材料与成果页重构（两区）

```text
┌ 材料中心（输入侧，可写）──────────────────────────┐
│ [提供材料]                                        │
│ 材料卡列表：标题/类型/字数/时间/状态[待消费|已消费] │
│            已消费 → 消费任务链接；未消费 →[替换][删除]│
├ 成果陈列（输出侧，只读，现状保留）────────────────┤
│ 论文分析 / 研究想法 / 实验验证 / 文件引用          │
└──────────────────────────────────────────────────┘
```

- 输入与输出分区陈列，用户能一眼分清"我给的"与"系统产的"。
- 现有只读汇总卡与筛选下拉保留，移到成果区。

### 3.2 三处入口收敛到一个组件

`MaterialForm`（单文件组件）被 BlockReasonCard、材料中心、StageDetails 缺口行三处复用，避免三套表单漂移。

### 3.3 阶段详情的输入清单

每个任务下增加"输入清单"三态行（沿用 `.status-chip[data-state]` 与 tokens）：

```text
需要            已有              状态
论文正文或摘要   无 / 材料卡标题    [去提供] / ✓ 已登记
```

## 4. 目标架构

```text
浏览器（web/console）
│  MaterialForm ─ POST /projects/:ext_id/materials
│  MaterialList ← GET  /views/materials?external_id=…
│  缺口行/阻断卡 ← /views/project（已有 block_detail）+ /views/stage（输入清单）
▼
云端 Function（web/functions）
│  routes.ts：materials 写路由（Owner 鉴权、限额、kind 白名单）
│  materials.ts：登记材料 → ① 落材料记录 ② 回填 queued analyze_paper payload
│  views.ts：materials 视图（只读角色脱敏正文）
▼
数据库（app schema，新迁移 0008）
│  app.cloud_material：材料登记表（见概要设计 §2）
│  app.cloud_task.payload：analyze_paper 回填 paper_text/abstract（既有消费契约不变）
▼
引擎（web/functions/engine）
   paperInput() 消费 payload —— 零改动
   step-driver.ts:90-94 自动解阻 —— 零改动
```

**核心决策：适配既有契约，不改引擎。** `paperInput()` 与自动解阻逻辑已存在，新材料链路的终点就是把 payload 填上，引擎侧零改动、零回归面。

## 5. 分期演进

| 期 | 内容 | 依赖 | 交付判断 |
| -- | ---- | ---- | -------- |
| **M0（本期）** | F1–F6：文本材料中心 + 三入口 + 回填恢复 + 缺口清单 | 无外部依赖 | 阻断→两步恢复全链路测试通过 |
| **M1** | F7：PDF 上传 + 服务端提文本 | QODER_STORAGE 可用性 spike（先做探针验收，见 `routes.ts:79-84` 的教训：env 有名字 ≠ 能取值） | 真实 PDF 上传后提取文本进 payload |
| **M2** | F8：数据集/代码包接入材料中心 | M1 存储链路 | kind 扩展，复用清单与权限 |

## 6. 设计原则（约束）

1. **复用契约**：消费端 `paperInput()`、恢复端 `step-driver` 不动；新增只在供给侧。
2. **数据分级红线**：正文只在材料表与任务 payload，不进 Git、不进事件 summary 明文、只读角色不可见（`REQUIREMENTS.md` §3.1）。
3. **诚实标注**：提供材料 ≠ 分析完成；状态只反映真实任务流转。
4. **最小接口面**：M0 只加一个写路由 + 一个视图，不引入通用文件网关。
5. **体例一致**：组件复用 `tokens.css` 的 `--*` 变量、`.panel`、`.status-chip`、`.btn-primary/secondary`，不硬编码色值与间距。

## 7. 风险

| 风险 | 应对 |
| ---- | ---- |
| fake-db 不校验列名（`cloud_task` 排序 bug 的教训，3f4722a） | 材料相关测试必须至少一条打真库语义：列名/约束按迁移文件核对，或在 fake-db 加 schema 校验 |
| QODER_STORAGE 可用性未知 | M1 前先做只读探针 spike，读不到就走"粘贴文本"兜底，不阻塞 M0 |
| 回填与并发 step 竞态 | 回填在同一事务里完成；step 侧本就按 payload 现值判断，最坏结果是多阻断一次再恢复 |
| 正文泄露到公开项目 | 材料视图按 Owner/只读分级脱敏；公开分享不带正文字段 |
