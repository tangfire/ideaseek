# IdeaSeek 用户旅程验收

这份文档用完全不了解内部架构的新用户模拟一次完整使用。每一步都必须让用户知道当前状态、下一步、预计成本、如何暂停和如何恢复。

## Journey A：空目录首次使用

```text
安装 → ideaseek doctor → ideaseek init → ideaseek start
```

验收：

- 安装命令能确认版本、平台和 DSH runtime；
- `doctor` 用人话说明缺少什么，不打印 secret；
- `init` 幂等，不覆盖已有文件；
- `start` 能发现空项目并提示最小输入；
- 用户能看到一个 demo/fixture 入口，不必先准备真实论文；
- `next` 给出下一条可复制命令。

## 项目上下文

IdeaSeek 采用“当前目录就是项目”的默认模型，类似 Claude Code：

```bash
cd ~/research/fl-model-heterogeneity
ideaseek
ideaseek status
```

CLI 从当前目录向上查找 `.research/` 项目标识；`/status`、`/next`、`/papers`、`/ideas` 和交互中的自然语言默认只作用于当前项目。没有项目上下文时，命令不猜测最近项目，而是提示 `ideaseek init`、`ideaseek projects` 或显式指定项目。

用户也可以从任意目录查看和打开历史项目：

```bash
ideaseek projects
ideaseek open ~/research/fl-model-heterogeneity
ideaseek status --project ~/research/fl-model-heterogeneity
ideaseek attach --project ~/research/fl-model-heterogeneity --run <run-id>
```

`open` 只切换当前 CLI 的项目上下文，不复制或移动项目文件；交互 REPL 中显示当前项目路径和 project ID，避免把命令发到错误项目。后台 run 继续绑定创建它的项目目录，不能因为用户从另一个目录 attach 就改变其输入根。

## Journey B：模型配置

```text
ideaseek → /models → provider/route/model → 隐藏输入 key → test
```

验收：

- 显示 fast/balanced/deep/deterministic 路由和每个 role 的绑定；
- key 只写入 DSH credential store/secret manager；
- 测试失败说明 endpoint、权限、额度或工具能力问题；
- provider 切换不影响已有 run snapshot；
- `models --json` 完全脱敏。

## Journey C：输入论文、代码和数据

```text
放入 papers/datasets/comparisons/incoming
→ ideaseek scan
→ ideaseek intake
→ ideaseek plan --question "..."
```

验收：

- 用户不需要理解 PaperCard、manifest 或 Agent 拓扑；
- 扫描结果按论文、数据、代码、补充材料和歧义分组；
- 识别出重复文件和可能的 comparison 关联；
- 原始文件不移动、不覆盖；
- 计划显示论文数、数据集数、comparison、idea 上限、预计 token/GPU/磁盘；
- 用户能只确认协议歧义，不必确认每个文件。

## Journey D：协议确认与第一次运行

```text
ideaseek start --question "..."
→ 论文分析
→ 数据画像
→ ProtocolProposal
→ 用户确认
→ comparison gate
→ quick 实验
```

验收：

- 终端显示阶段、Agent、任务进度、预算和阻塞；
- 高影响协议变更显示候选、依据、影响和成本；
- `guided` 模式不会静默锁定关键科学语义；
- `starter` 模式在少量论文/单数据集时能得到初步候选，但降低结论等级；
- comparison 未通过时明确停在 comparison gate，不假装进入 idea 阶段。

## Journey E：交互式科研过程

在 `ideaseek ›` 中同时支持命令和自然语言：

```text
/status
为什么 method-b 还没通过？
优先验证 idea-002。
/pause
```

验收：

- 查询类自然语言直接回答并引用状态；
- 改变优先级、预算、comparison、idea 或协议的请求转为待审批 Decision；
- 用户可以暂停一个 idea 而不停止兄弟 idea；
- `--plain`、`--json` 和交互模式语义一致；
- 不显示隐藏思维、完整 prompt 或 secret。

## Journey F：长任务、断线和额度耗尽

```text
start --detach → SSH 断开 → supervisor 继续
→ QUOTA_EXHAUSTED/机器重启/GPU OOM
→ doctor → continue/attach
```

验收：

- 事件、心跳、任务租约和 checkpoint 持久化；
- 已完成论文、comparison、idea 版本和实验结果不重做；
- 额度耗尽不会被标成科学失败；
- GPU OOM 不会被解释成 idea 被否证；
- 用户能看到最后心跳、失败原因、恢复点和预计成本；
- 备份恢复后 artifact hash 和任务状态一致。

## Journey G：idea 迭代与 handoff

```text
idea proposal → code → quick/standard → ablation → Result Analyst
→ revise 或新 idea → HANDOFF_READY
→ export/handoff
```

验收：

- 工程修改产生同一 idea 的新版本；科学假设变化产生新 idea；
- 每个实验能定位到 code/data/protocol/idea version；
- 失败实验永久保留；
- handoff 包含 full-scale 配置、split、环境、命令、资源和风险；
- 只有达到证据门槛才标记 `HANDOFF_READY`；
- 报告区分探索证据和用户自行完成的全量结果。

## Journey H：更新、归档和恢复

```text
ideaseek update → migration preview → backup → upgrade
ideaseek archive/export → 另一台 Linux → restore → doctor → continue
```

验收：

- 配置和数据库迁移有 preview、备份和回滚；
- 旧 run 可读；
- 项目可导出而不包含 secret；
- 另一台机器恢复时验证 DSH、Python、容器、GPU 和 artifact hash；
- 输入/模型/代码版本变化只使依赖图上的下游失效。

## 发现问题时的产品规则

如果用户必须阅读源代码、猜内部状态、手工修数据库、手工清缓存、重新运行已完成任务，或不知道下一步命令，该旅程不算通过。
