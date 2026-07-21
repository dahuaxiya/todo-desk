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
npm run dist:mac:unsigned
```

该命令只用于本机开发测试，不能把生成的未签名应用作为公开 Release。

## macOS 安装

当前 `v0.2.2` 的附件没有 Developer ID 签名和 Apple 公证，从 GitHub 下载后，macOS 可能提示应用“已损坏”。这不是下载文件损坏；该版本不能作为面向普通用户的正式安装包。

后续正式 Release 会通过 GitHub Actions 生成 Apple Silicon 和 Intel 两套安装包，并且只有 Developer ID 签名、公证、staple 和 Gatekeeper 校验全部通过才会上传。发布账号和 Secrets 的配置方法见 [macOS 签名、公证与发布](docs/macos-distribution.md)。

当前未签名版本需要先把 `Todo Desk.app` 拖入 Applications，再移除下载时附加的 quarantine 属性：

```bash
xattr -dr com.apple.quarantine "/Applications/Todo Desk.app"
open "/Applications/Todo Desk.app"
```

如果应用被 Finder 重命名为 `Todo Desk 2.app`，命令中的路径也要使用实际名称。只对从本仓库官方 Release 下载的 Todo Desk 执行该命令；`xattr` 不会补充签名或公证。

### 让 Agent 自动安装，不需要源码

用户只需要把这个仓库链接交给 Agent：

```text
https://github.com/dahuaxiya/todo-desk
```

Agent 读取本节后，应单独下载并执行安装脚本，不得要求用户克隆仓库、安装 Node.js 或运行 `npm install`：

```bash
set -euo pipefail
INSTALLER="$(mktemp -t todo-desk-installer)"
trap 'rm -f "$INSTALLER"' EXIT
curl --fail --location --silent --show-error \
  https://raw.githubusercontent.com/dahuaxiya/todo-desk/main/scripts/install-macos-release.sh \
  --output "$INSTALLER"
bash -n "$INSTALLER"
bash "$INSTALLER"
rm -f "$INSTALLER"
trap - EXIT
```

安装脚本只依赖 macOS 自带命令。它会识别 Mac 架构，从 `dahuaxiya/todo-desk` 最新 GitHub Release 下载对应 DMG，核对 GitHub 提供的 SHA-256，验证 Bundle ID，安装到 Applications，按 Gatekeeper 结果处理 quarantine，最后打开 Todo Desk 并等待本机 API 就绪。任何一步失败时，Agent 必须报告实际错误，不得假装安装成功。完整流程见 [Agent 自动接入 Todo Desk](docs/agent-bootstrap.md#安装桌面-app)。

当前 `v0.2.2` Release 只包含 Apple Silicon `arm64` 安装包；Intel Mac 在 x64 DMG 发布前会明确停止并报告缺少匹配架构，不会尝试安装 arm64 版本。

## 常用命令

```bash
npm run dev             # 启动 Vite 和 Electron
npm run web:dev         # 只启动 Web UI
npm run build           # 类型检查并构建前端产物
npm run dist            # 构建并调用 electron-builder
npm run dist:mac        # 构建签名、公证的 arm64 和 x64 macOS 安装包
npm run mac:allow-open  # 校验 Bundle ID 并移除已安装 App 的 quarantine
npm run verify:mac      # 校验 macOS 签名、公证票据和 Gatekeeper 结果
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

桌面 App 还支持飞书云盘加密备份。首次备份会在飞书云盘创建 `Todo Desk Backups` 专用目录；之后每 30 分钟检查一次，数据和附件没有变化时不会生成重复版本。默认保留最近 4 个高频版本，并额外保留前 2 个自然日各自最新的版本。

备份包含完整任务数据、设置、API Key 和附件，上传前会使用 AES-256-GCM 加密。Todo Desk 每天会从飞书完整下载、解密并校验最新版本；恢复前还会生成本地安全快照，失败时回滚原数据。请把“恢复密钥”和稳定的“备份仓库恢复码”分开保存，新设备先导入密钥，再用恢复码连接仓库并选择版本恢复。

飞书账号需要云盘上传、下载、创建目录、读写文档和删除文档权限。若设置页提示旧文件等待清理，可执行 `lark-cli auth login --scope "space:document:delete"` 补充删除授权；待清理 token 会保存在本地，后续备份会自动重试，不会静默丢失。

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
    "parentTaskId": "可选的父人工任务 id",
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
如果任务是计划拆分或处理过程中发现的新问题，可以传 `parentTaskId` 和 `parentLink.type` 建立显式任务分支。`subtask_of` 表示计划子任务，`discovered_from` 表示处理中派生；不要通过标题、项目、标签、仓库或相同 session 猜测关系。影响上级任务完成的 AI 分支都确认完成后，Todo Desk 会提示用户复核上级任务。

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
- macOS 公共安装包只允许通过带强校验的 Release 工作流发布。
