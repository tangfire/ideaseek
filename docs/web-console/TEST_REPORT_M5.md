# M5 测试报告：深视图（Idea 看板/版本树、证据链、实验与协议）

**日期**：2026-11-23  
**分支**：`feat/web-console`  
**里程碑**：M5（深视图）

---

## 1. 交付内容

### 1.1 Idea 看板与版本树（F8.1-F8.6）

**文件**：`web/console/src/app.tsx`、`web/console/src/types.ts`

- **F8.1 Idea 卡片列表**：`IdeaCard` 组件
  - 显示标题、机制摘要、状态、结论
  - `DRAFT_COMPOSITION` 状态灰显（opacity: 0.6）
  - 版本号显示（v1, v2...）

- **F8.2 版本树**：`VersionTree` 组件
  - 按 `parent_idea_id` 递归构建树结构
  - 显示 idea 的演化历史
  - 可折叠详情区块

- **F8.3 DRAFT_COMPOSITION 徽标**：
  - 蓝色 chip 标注"DRAFT_COMPOSITION"
  - 与有效候选视觉分离

- **F8.4 多轮次视图**：未实现（P2，推迟）

- **F8.5 Idea 详情**：假设全文按 `hypothesis_disclosure` 分级
  - `full`：可折叠查看全文
  - `structure`：显示"假设结构已公开，全文需 Owner 授权"
  - `withheld`：显示"假设全文未公开"

- **F8.6 结论徽章**：`VerdictBadge`
  - SUPPORTED → 绿色
  - NEEDS_REVISION → 黄色
  - REJECTED/INVALID_RUN → 红色
  - 无结论 → 灰色

- **F8 Idea 看板**：`IdeaBoard` 组件
  - 三列网格布局：有效候选 / 草稿拼接 / 已拒绝
  - 每列显示计数
  - 底部可折叠版本树

### 1.2 证据链追溯（F9.1-F9.5）

**文件**：`web/console/src/app.tsx`、`web/console/src/types.ts`

- **F9.1 论文卡片列表**：`PaperCardList` 组件
  - 显示标题、问题、方法摘要、解析状态
  - 解析状态用 chip 标注（parsed=绿，其他=黄）
  - 网格布局

- **F9.2 claim → 页码定位**：`ClaimList` 组件
  - 显示结论陈述文本
  - 支持级别 chip（supported=绿，uncertain=黄，其他=灰）
  - 出处显示：论文 ID + 页码 + 章节

- **F9.3 unknown/uncertain 呈现**：
  - 缺失出处时显示"出处：未确认"
  - 不编造、不猜测

- **F9.4 结论—证据—实验三跳**：
  - 当前实现为论文卡片 + 结论陈述两个独立列表
  - 互链导航待后续里程碑（需要后端 API 支持）

- **F9.5 原文正文请求**：未实现（P2，推迟）
  - 需要后端存储支持

- **F9 EvidenceChain 组件**：
  - 组合论文卡片列表 + 结论陈述列表
  - L1 字段，L2 降级时不显示

### 1.3 实验结果与协议对比（F10.1-F10.7）

**文件**：`web/console/src/app.tsx`、`web/console/src/types.ts`

- **F10.1 指标表**：`ExperimentResults` 组件
  - 显示实验 ID、规模标签、状态
  - 指标键值对显示（mono 字体）
  - 结论 chip（supported=绿，rejected=红，其他=黄）

- **F10.2 baseline 对比**：未实现（需要后端 API 支持）
  - 当前只显示单个实验结果
  - 对比视图待后续里程碑

- **F10.3 数据规模标签**：
  - `standard` → 绿色
  - `quick` → 蓝色
  - `smoke` → 黄色
  - `handoff_manifest` → 灰色 + "未执行"标注

- **F10.4 协议详情**：`ProtocolList` 组件
  - 显示协议 ID、锁定时间、来源
  - 未锁定显示黄色 chip

- **F10.5 失败分类**：未实现（需要后端 API 支持）
  - failure-diagnosis 层级展示待后续里程碑

- **F10.6 消融视图**：未实现（P2，推迟）

- **F10.7 趋势图**：未实现（P2，推迟）

- **F10 ExperimentView 组件**：
  - 组合实验结果 + 协议列表
  - L1 字段，L2 降级时不显示

### 1.4 类型定义扩展

**文件**：`web/console/src/types.ts`

- `IdeaSummary`：idea 卡片数据
- `IdeationRound`：想法轮次数据
- `ClaimRow`：结论陈述数据
- `PaperCard`：论文卡片数据
- `ExperimentResult`：实验结果数据
- `ProtocolSummary`：协议摘要数据
- `ProjectView` 扩展：`ideas?`、`papers?`、`claims?`、`experiments?`、`protocols?`

---

## 2. 测试覆盖

### 2.1 单元测试

**未新增前端单测**：M5 主要是 UI 组件，现有 Function 测试覆盖后端逻辑。

### 2.2 集成测试

**未新增集成测试**：需要在真实部署环境中验证。

### 2.3 手动验证清单

- [ ] Idea 卡片显示正确（标题、机制、状态、结论）
- [ ] DRAFT_COMPOSITION 灰显且带徽标
- [ ] 版本树递归渲染正确
- [ ] Idea 看板三列布局显示
- [ ] 假设全文按 disclosure 分级显示
- [ ] 结论徽章颜色正确
- [ ] 论文卡片列表显示正确
- [ ] 结论陈述出处定位正确
- [ ] 缺失出处显示"未确认"
- [ ] 实验结果显示指标和规模标签
- [ ] handoff_manifest 显示"未执行"
- [ ] 协议列表显示锁定状态
- [ ] L2 降级时深视图不显示

---

## 3. 已知限制

1. **后端 API 未实现**：Function 侧 `projectView` 未查询 ideas/papers/claims/experiments/protocols 表
2. **F8.4 多轮次视图**：P2，推迟
3. **F9.4 三跳互链**：需要后端 API 支持
4. **F9.5 原文正文请求**：P2，推迟
5. **F10.2 baseline 对比**：需要后端 API 支持
6. **F10.5 失败分类**：需要后端 API 支持
7. **F10.6 消融视图**：P2，推迟
8. **F10.7 趋势图**：P2，推迟

---

## 4. 安全与合规

- **L2 降级合规**：深视图字段（ideas/papers/claims/experiments/protocols）在 L2 路径不显示
- **F8.5 合规**：假设全文按 disclosure 分级，withheld 时不显示
- **F10.3 合规**：handoff_manifest 显式标注"未执行"
- **NFR-13 合规**：`is_synthetic` 指标在界面上未被当作结果

---

## 5. 下一步

M5 完成后，进入 M6：审批信箱 + 成本 + 外发台账 + token 管理。

M6 出口门禁：
- F11/F12/F16 的 P1 项
- 审批信箱（两阶段确认）
- 成本与额度
- token 管理
