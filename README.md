# IdeaSeek

**从研究问题，到可验证发现。** 给它一个研究问题、一批论文和数据集，它自动整理证据、验证想法、跑实验、写论文。

> 📖 **[打开文档站](docs/site/index.html)**（浏览器直接可读） · [分步教程](docs/USER_GUIDE.md) · [命令参考](docs/CLI_SPEC.md)

## 这是什么？

IdeaSeek 是一个**多 Agent 科研工作流平台**。你提供研究材料，它用多个 AI Agent 角色分工完成整条研究链：

| 你提供 | IdeaSeek 做 | 你得到 |
| --- | --- | --- |
| 研究问题 + 论文 PDF | 解析证据、生成候选 idea | 可验证的实验假设 |
| 对比方法代码 / 数据集 | 复现基线、锁定协议、跑实验 | 可复现的实验结果 |
| 认可的 idea | 分析、消融、写论文 | PDF 论文 + Overleaf 工程 + 复现包 |

**关键特性**：每个结论可追溯到证据页码 · 原始文件永远只读 · 断线自动恢复 · 全量训练由你自行执行

## 安装

一条命令（缺 Node ≥24.9 或 pnpm 会自动补齐；npm 镜像默认走国内源，`IDEASEEK_NPM_REGISTRY` 可覆盖；Python 3 为实验所需，缺失仅告警）：

```bash
git clone <repo> ideaseek && cd ideaseek
bash setup.sh                # 自举 Node/pnpm → 依赖 → 构建 → 全局 ideaseek
ideaseek doctor              # 验证安装
```

已有 Node ≥24.9 的环境也可用安装器：`node scripts/install.mjs`（见 [docs/PACKAGING.md](docs/PACKAGING.md)）。

## 5 分钟上手

```bash
# 1. 创建项目
mkdir my-research && cd my-research
ideaseek init

# 2. 放入论文（PDF 丢进 papers/），然后：
ideaseek start --question "你的研究问题"

# 3. 日常使用：直接敲 ideaseek 打开交互界面
ideaseek
```

**在 TUI 里配置模型**：输入 `/models setup` → 粘贴 API key（输入自动隐藏）。

**交互方式**：
- 输入 `/` 打开命令面板，支持模糊匹配
- 直接输入自然语言提问，如 "为什么这个 idea 还没通过"
- `Shift+Tab` 切换 Research / Analysis 模式
- `/docs` 打开文档站

## 命令速查

```bash
ideaseek start --question "..."    # 一键启动
ideaseek next                      # 下一步建议
ideaseek status                    # 运行状态
ideaseek idea generate             # 生成研究 idea
ideaseek idea check <id>           # 检查 idea
ideaseek paper compile             # 编译论文 PDF
ideaseek report                    # 生成报告
```

完整命令见 [docs/CLI_SPEC.md](docs/CLI_SPEC.md)，或在 TUI 里输入 `/help`。

## 开发者

```bash
pnpm install --frozen-lockfile && pnpm build
pnpm test             # 运行测试
pnpm release-check    # 依赖许可 + 安全扫描
```

入口文档：[docs/AGENTS.md](docs/AGENTS.md) → [docs/README.md](docs/README.md) · 设计与进度：[docs/plan.md](docs/plan.md) · [docs/PROGRESS.md](docs/PROGRESS.md)
