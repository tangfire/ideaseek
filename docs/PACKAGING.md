# IdeaSeek 安装与发布规范

IdeaSeek 当前处于源码开发阶段；正式发布后，普通用户不需要 clone 源码或手工启动 TypeScript/Python 文件。安装方式以 README 中的发布版本说明为准。

## 普通用户安装（目标体验）

Linux 服务器优先使用 npm 全局 CLI：

```bash
npm install -g ideaseek
ideaseek doctor
ideaseek init
```

也可以提供版本固定的安装脚本：

```bash
curl -fsSL https://ideaseek.example/install.sh | sh
```

安装脚本必须展示下载源、版本、校验和和安装路径；生产环境支持离线包或内部镜像。不要在没有用户确认的情况下执行系统级提权。

## 开发安装

```bash
git clone https://github.com/tangfire/ideaseek.git
cd ideaseek
pnpm install
pnpm build
pnpm link --global
ideaseek doctor
```

开发安装要求读取仓库根目录 `AGENTS.md` 和 `docs/` 文档。DSH 上游作为独立仓库或锁定依赖使用，不复制进 IdeaSeek 业务目录。

## 安装后检查

`ideaseek doctor` 检查并报告：

- IdeaSeek、Node、Python 和 DSH 版本；
- DSH commit/provider/profile；
- Docker/Apptainer；
- CUDA、GPU、CPU、内存和磁盘；
- Python Worker 和可选本地 embedding 模型；
- 凭据引用的脱敏状态；
- 当前用户是否有项目目录读写权限。

检查失败应给出具体的修复命令，不打印 secret，也不自动修改全局环境。

## Python Worker

Python 依赖由受控 venv、锁文件、容器镜像或服务器内部镜像管理。普通用户不应被要求手工安装所有科学计算依赖。`ideaseek setup` 可以在用户确认后创建/更新 Worker 环境；缺少可选依赖时，平台应明确回退能力。

## 更新与回滚

```bash
ideaseek update
ideaseek version
ideaseek doctor
```

更新前保存当前版本、DSH commit、配置 schema 和数据库备份；升级失败可以回滚。破坏兼容的配置/数据库迁移必须先展示迁移摘要并保留备份。

## Windows

Windows 用户首选 WSL2 或 SSH 连接 Linux 服务器。Windows 原生 CLI 可以支持轻量项目管理和报告查看，但 GPU/容器能力只有通过对应适配器并完成验收后才能标记为支持。

## 发布检查

每个版本必须通过 `RELEASE_CHECKLIST.md`、CLI smoke test、最小 workflow、checkpoint 恢复、secret scan、依赖/许可证检查和 DSH 兼容性测试。发布包不得包含论文、数据、模型权重、实验 artifact 或凭据。
