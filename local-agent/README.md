# IdeaSeek Local Agent

本地执行节点，负责接收云端命令并在本地执行 CLI/Git/文件操作。

## 架构

```
云端 (Qoder Sites)
    │ WebSocket
    ▼
Local Agent
    ├── WebSocket 客户端 (接收命令/发送状态)
    ├── 命令路由器 (分发到处理器)
    ├── CLI 执行器 (执行 ideaseek/git 命令)
    └── 状态同步器 (读取本地 SQLite → 云端)
```

## 安装

```bash
cd local-agent
npm install
npm run build
```

## 使用

### 启动 Agent

```bash
npm start -- start <wsUrl> <token> <projectId> [projectDir]
```

参数：
- `wsUrl`: WebSocket 服务器地址
- `token`: 认证令牌
- `projectId`: 项目 ID
- `projectDir`: 项目目录（默认当前目录）

### 开发模式

```bash
npm run dev
```

## 命令类型

| 命令 | 说明 |
|------|------|
| `start_run` | 启动运行 |
| `pause_run` | 暂停运行 |
| `continue_run` | 继续运行 |
| `cancel_run` | 取消运行 |
| `git_commit` | Git 提交 |
| `git_push` | Git 推送 |
| `git_pull` | Git 拉取 |
| `git_branch` | 创建分支 |
| `file_save` | 保存文件 |
| `file_delete` | 删除文件 |
| `create_project` | 创建项目 |

## 配置

配置文件：`.ideaseek/agent.yaml`

```yaml
wsUrl: ws://cloud.example.com/agent
token: your-sync-token
projectId: your-project-id
projectDir: ./my-research
heartbeatInterval: 30000
reconnectInterval: 5000
maxReconnectAttempts: 10
```

## 开发

```bash
# 构建
npm run build

# 运行测试
npm test

# 代码检查
npm run lint
```

## 许可证

MIT
