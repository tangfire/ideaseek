# 论文材料与云端文件管理 — 蓝图

日期：2026-11-28　依赖：`REQUIREMENTS_ANALYSIS_PAPER_MATERIAL.md`　状态：设计阶段，未实现

## 1. 愿景

把"材料与成果"页从只读陈列升级为**材料中心**：用户在这里回答三个问题——在哪提供、提供了什么、怎么管理——并让 PAPER_ANALYSIS 阻断从死路变成两步可恢复的正常流程。同时补上缺失的**云端文件管理底座**：文件本体（论文 PDF、数据、报告）在云端首次获得存储与读写接口（现状检查见需求分析 §2.4：上传/下载/列表/删除全部为零实现）。

```text
现在：阻断 → 提示"补充论文材料" → 无处可补 → 死路
      文件 → 云端无任何存储接口 → 只有元数据指纹
目标：阻断 → 阻断卡片[补充论文] → 粘贴/上传 → 自动恢复 → 分析继续
      文件 → 上传/列表/下载/删除 → 材料中心统一管理
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

### S4 文件上传与管理（云端文件管理首次接通）

```text
材料中心 [上传文件] → 选择 PDF（或粘贴后另存）
  → POST /projects/:id/files（multipart，路径 papers/…，Owner 鉴权 + 路径白名单 + 限额）
  → 存储底座写入（QODER_STORAGE 探针通过 → 平台存储；否则 DB 降级并标注）
  → GET /views/files 出现在文件清单（名称/大小/时间/引用状态）
  → 下载 GET /files/:path 返回原始字节；删除 DELETE /files/:path（被引用则拒）
  → （M1）对已上传 PDF 触发提取 → 文本走 S1 同一回填链路
```

## 3. 信息架构

### 3.1 材料与成果页重构（三区）

```text
┌ 材料中心（输入侧，可写）──────────────────────────┐
│ [提供材料]（文本）      [上传文件]（PDF 等）        │
│ 文本材料卡：标题/类型/字数/状态[待消费|已消费]       │
│            已消费 → 消费任务链接；未消费 →[替换][删除]│
│ 文件清单：名称/大小/时间/引用状态 [下载][删除]        │
├ 成果陈列（输出侧，只读，现状保留）────────────────┤
│ 论文分析 / 研究想法 / 实验验证 / 文件引用          │
└──────────────────────────────────────────────────┘
```

- 输入与输出分区陈列，用户能一眼分清"我给的"与"系统产的"。
- 文本材料与文件同属输入侧但分列两卡组：文本直接可消费，文件是待提取的原件（状态标注"待提取/已提取"，不冒充已可用）。
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
│  MaterialForm ─ POST /projects/:ext_id/materials      （文本材料）
│  FileUpload  ─ POST /projects/:ext_id/files           （multipart 文件）
│  MaterialList ← GET  /views/materials?external_id=…
│  FileList    ← GET  /views/files?external_id=… ；下载 GET /files/:path
│  缺口行/阻断卡 ← /views/project（已有 block_detail）+ /views/stage（输入清单）
▼
云端 Function（web/functions）
│  routes.ts：materials + files 写路由（Owner 鉴权、限额、kind/路径白名单）
│  materials.ts：登记材料 → ① 落材料记录 ② 回填 queued analyze_paper payload
│  files.ts：上传/下载/列表/删除 → 存储底座适配器
│  storage.ts：FileStore 接口 —— QODER_STORAGE 优先，DB 降级（能力如实标注）
│  views.ts：materials / files 视图（只读角色脱敏正文与内容）
▼
存储
│  数据库（app schema，新迁移 0008）
│  │  app.cloud_material：材料登记表（见概要设计 §2）
│  │  app.cloud_file：文件元数据表（path/size/hash/引用状态）
│  │  app.cloud_task.payload：analyze_paper 回填 paper_text/abstract（既有消费契约不变）
│  └ FileStore：QODER_STORAGE（探针通过时）或 DB blob 降级（≤1 MB）
▼
引擎（web/functions/engine）
   paperInput() 消费 payload —— 零改动
   step-driver.ts:90-94 自动解阻 —— 零改动
```

**核心决策一：适配既有契约，不改引擎。** `paperInput()` 与自动解阻逻辑已存在，新材料链路的终点就是把 payload 填上，引擎侧零改动、零回归面。

**核心决策二：存储用适配器隔离不确定性。** `QODER_STORAGE` 是否可取值未验证（`routes.ts:79-84`：env 有名字 ≠ 能取值），`FileStore` 接口把这件事隔离在单文件内：探针通过走平台存储，否则降级 DB blob，接口与 UI 不随底座切换而变。

## 5. 分期演进

| 期 | 内容 | 依赖 | 交付判断 |
| -- | ---- | ---- | -------- |
| **M0a 文件底座** | F9–F11：FileStore 适配器 + 上传/列表/下载/删除 + 存储探针 spike | 探针结果决定平台存储或 DB 降级 | 文件全链路验收（需求分析 §5.7）通过 |
| **M0b 文本材料** | F1–F6：文本材料中心 + 三入口 + 回填恢复 + 缺口清单 | 无外部依赖 | 阻断→两步恢复全链路测试通过 |
| **M1** | F7/F12：PDF 上传入口 + 服务端提文本 + 材料联动 | M0a 存储链路 | 真实 PDF 上传后提取文本进 payload |
| **M2** | F8：数据集/代码包接入材料中心 | M0a 存储链路 | kind 扩展，复用清单与权限 |

M0a 先于或平行于 M0b：文件底座是独立垂直切片，不阻塞文本材料的恢复链路（文本材料不依赖文件存储）。

## 6. 设计原则（约束）

1. **复用契约**：消费端 `paperInput()`、恢复端 `step-driver` 不动；新增只在供给侧。
2. **数据分级红线**：正文只在材料表与任务 payload，文件内容只在 FileStore，均不进 Git、不进事件 summary 明文、只读角色不可见（`REQUIREMENTS.md` §3.1）。
3. **诚实标注**：提供材料 ≠ 分析完成；文件"已上传" ≠ "已提取"；状态只反映真实任务流转。
4. **最小接口面**：M0 只加材料写路由 + 文件四路由 + 两个视图，不引入通用文件网关与分片协议。
5. **路径与限额硬边界**：文件路径一律过 `isSafeRelativePath`，单文件/单条文本/每项目条数限额在函数边界硬校验。
6. **体例一致**：组件复用 `tokens.css` 的 `--*` 变量、`.panel`、`.status-chip`、`.btn-primary/secondary`，不硬编码色值与间距。

## 7. 风险

| 风险 | 应对 |
| ---- | ---- |
| fake-db 不校验列名（`cloud_task` 排序 bug 的教训，3f4722a） | 材料/文件相关测试必须至少一条打真库语义：列名/约束按迁移文件核对，或在 fake-db 加 schema 校验 |
| QODER_STORAGE 可用性未知 | FileStore 适配器先行 + 只读探针 spike；读不到走 DB blob 降级（≤1 MB）并如实标注，不阻塞 M0 |
| 上传被滥用（超大文件、路径逃逸、非 Owner） | 函数边界硬校验：限额 400、`isSafeRelativePath`、Owner 401/403，全部进测试 |
| 回填与并发 step 竞态 | 回填在同一事务里完成；step 侧本就按 payload 现值判断，最坏结果是多阻断一次再恢复 |
| 正文/文件泄露到公开项目 | 材料视图与文件下载按 Owner/只读分级；公开分享不带正文与文件内容字段 |
