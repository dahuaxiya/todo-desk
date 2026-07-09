# Todo Desk

Todo Desk 是一个便笺风格的桌面 Todo 工具，用来记录当前正在做的事、待办事项、已完成事项，以及 AI agent 正在处理的工作。

它基于 Electron + React/Vite 构建，数据默认保存在本地 JSON 文件中，支持飞书文档同步，并提供本机 API 让 Codex、Claude、Kimi、Cursor 等 agent 创建和更新任务。

## 截图

主界面：

![Todo Desk 主界面](docs/images/todo-desk-ui.png)

小卡 / 贴边模式：

![Todo Desk 小卡模式](docs/images/todo-desk-mini-prototype.png)

## 功能

- 当前工作、Todo、已完成三段任务视图。
- 正常窗口、小卡模式、置顶、左右贴边。
- 任务标题、详情、优先级、项目/分组、标签、截止时间、提醒时间。
- 添加任务时支持粘贴剪贴板图片，也可以选择本地图片。
- 已完成记录保留，删除任务进入回收站。
- 支持按标题、详情、标签、项目和日期模糊搜索。
- 本地 JSON 存储，方便备份和迁移。
- 勾选完成后可同步到飞书文档。
- macOS 本地提醒和 `.ics` 日历事件导出。
- AI 解析任务文本、图片和时间信息。
- 本机 `127.0.0.1` API，支持 agent/session/repository 元数据。

## 快速开始

```bash
npm install
npm run dev
```

只启动 Web UI：

```bash
npm run web:dev
```

构建：

```bash
npm run build
```

打包 macOS `.app` 目录：

```bash
npm run build
npx electron-builder --mac --dir
```

## 常用命令

```bash
npm run dev             # 启动 Vite 和 Electron
npm run web:dev         # 只启动 Web UI
npm run build           # 类型检查并构建前端产物
npm run dist            # 构建并调用 electron-builder
npm run lint            # 运行 oxlint
npm run test:ai         # 检查 AI 解析和图片/OCR 流程
npm run agent:install   # 安装 Todo Desk agent 接入配置
```

## 数据存储

macOS 下默认数据目录：

```text
~/Library/Application Support/todo-desk/
```

主要内容：

- `todo-desk-data.json`：任务、回收站、同步记录、设置和窗口状态。
- `attachments/`：任务图片附件。

数据文件是普通 JSON，可以手动备份或迁移。

## AI 解析

在应用设置中打开 AI 解析，并配置兼容 OpenAI Chat Completions 的接口：

- Base URL
- Model
- API Key，如果服务需要

添加任务时，可以直接输入自然语言。Todo Desk 会尽量解析标题、详情、状态、优先级、项目、标签、截止时间和提醒时间。

如果任务带图片，桌面端会优先使用模型视觉能力；如果模型或网关不支持图片输入，会退回本机 OCR，再把识别文字交给同一套解析流程。

## 飞书同步

飞书同步依赖本机 `lark-cli`。

先确认已登录：

```bash
lark-cli auth status
```

然后在 Todo Desk 设置中填写飞书文档 URL 或 token。开启“完成后同步”后，勾选任务完成会向文档追加一段 Markdown 快照。

## 本机 API

应用启动后默认监听：

```text
http://127.0.0.1:47731
```

健康检查：

```bash
curl http://127.0.0.1:47731/health
```

创建任务：

```bash
curl -X POST http://127.0.0.1:47731/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "检查发布说明",
    "detail": "发布前确认待合并改动",
    "status": "doing",
    "priority": "medium",
    "project": "Todo Desk",
    "tags": "codex release",
    "origin": {
      "kind": "agent",
      "channel": "local-api",
      "confidence": "explicit"
    }
  }'
```

更新任务：

```bash
curl -X PATCH http://127.0.0.1:47731/tasks/<task-id> \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "done",
    "appendDetail": "已完成本地验证"
  }'
```

`origin.kind` 是任务来源的权威字段。agent 创建的任务应使用 `origin.kind = "agent"`，并尽量带上 agent、session id、repository 和 repository path。

## Agent 接入

仓库内提供了 Todo Desk skill 和自动安装脚本，可以把工作挂载规则写入常见 AI coding agent 的全局配置。

先预览会写哪些文件：

```bash
npm run agent:install -- --dry-run
```

确认后再正式安装：

```bash
npm run agent:install
```

只安装部分 agent：

```bash
npm run agent:install -- --targets codex,claude
```

支持的配置目标：

- `~/.agents`
- `~/.codex`
- `~/.claude`
- `~/.kimi-code`
- `~/.cursor`

完整说明见 [docs/agent-bootstrap.md](docs/agent-bootstrap.md)。

agent 认为任务已经完成但还没有得到用户确认时，应请求完成审批，Todo Desk 会显示红点并要求用户确认。agent 本轮 session 输出完成、但判断任务尚未完成时，可以请求未完成提醒，界面会显示非红色提醒点。

## 项目结构

```text
electron/                 Electron 主进程和 preload
src/                      React 应用
scripts/                  工具脚本和 agent 接入安装脚本
skills/todo-desk/         Todo Desk agent skill
docs/                     文档和截图
```

## 说明

- 浏览器降级模式使用 `localStorage`，不包含原生文件存储、系统通知、本机 OCR 等桌面能力。
- 正式分发 macOS 应用前，需要补齐签名和公证流程。
