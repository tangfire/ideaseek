# 部署、安全与运维

## 首选部署

Linux 服务器上安装固定版本的 Node、pnpm、Python、容器运行时和 GPU 驱动，并确保可访问配置的模型 API、学术索引、GitHub 和获准的数据源。项目目录与备份放在不同存储位置。首版单机运行：Supervisor、DB、Worker 和实验容器在同一主机，所有任务仍走队列和 checkpoint。IdeaSeek 的正常使用是联网运行；模型 API、外部文献/仓库或数据源暂时不可达时，依赖它们的任务进入明确阻塞状态并等待恢复，不得谎报成功或跳过 required comparison。

Windows 用户优先通过 SSH 或 WSL2 使用 Linux 执行环境；Windows 原生不承诺等价 GPU 容器能力。

## 凭据

使用 DSH credential store、系统 secret manager 或短期环境注入。模型 API key、GitHub token、SSH agent 和私有镜像凭据不得写入配置、git、prompt、事件或日志。GitHub 读操作使用最小细粒度权限；写权限默认关闭。

## 代码隔离

用户 clone 的仓库、Agent 生成代码和依赖脚本都是不可信输入。原始论文、数据和 upstream 只读；修复在 worktree；实验在非 root、限制 CPU/内存/GPU/时间、默认禁网的容器中运行。网络开启要按阶段和域名白名单授权。

## 监控

记录 supervisor 心跳、任务租约、队列长度、模型成本、GPU 使用、OOM、磁盘、容器退出码和 artifact 哈希。日志轮转，终端只显示脱敏摘要。状态异常进入明确状态，不用“仍在运行”掩盖失联。

## 备份与恢复

定期备份数据库、配置（不含 secret）、任务元数据、对象清单和必要 artifact。工作区和备份不能只在同一块磁盘。定期做恢复演练并校验状态和哈希；未演练前不能宣称灾难恢复能力。

## 常见故障

- API key/权限：进入 `AUTH_REQUIRED`，执行 `ideaseek setup`，不重跑成功任务。
- SSH 断开：后台 supervisor 继续，重新 `ideaseek attach`。
- GPU OOM：标记资源失败，降低并发/切片或调整资源，不把它解释为科学失败。
- Python/CUDA 不兼容：锁定镜像或报告环境阻塞，不修改系统环境。
- 磁盘不足：暂停新任务，保留 checkpoint，按登记的缓存策略清理。
- 输入发生变化：创建新快照/run，只失效受影响节点。


