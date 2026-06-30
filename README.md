# Todo Desk

一个便笺风格的桌面 Todo 工具。它用 Electron 提供桌面窗口、吸边、本地 JSON 存储和飞书 CLI 同步，用 React/Vite 提供跨端 UI。

![Todo Desk UI](docs/images/todo-desk-ui.png)

小卡独立界面原型：

![Todo Desk Mini Prototype](docs/images/todo-desk-mini-prototype.png)

## 已实现

- 当前工作 / Todo / 已完成三段看板
- 任务卡片可在“正在做 / Todo / 已完成”之间拖拽移动
- 正常模式和小卡模式切换；小卡模式只展示一个指定列表
- 拖到左右屏幕边缘后进入贴边长条状态，减少遮挡
- 添加任务支持“只填文本”和“详细表单”两种模式
- 可配置 AI Base URL / Model / API Key，添加任务时自动识别时间、优先级、项目和标签
- 每个任务卡片都会显示时间，优先展示完成、截止、提醒时间，否则展示创建时间
- 左侧勾选完成，完成时可自动同步飞书
- 已完成事项永久保留，按完成时间倒序展示
- 模糊搜索标题、详情、标签、项目和日期
- 本地 JSON 数据恢复，数据文件可从界面按钮直接定位
- 飞书文档 URL/token 配置，调用 `lark-cli docs +update --mode append`
- 截止时间、提醒时间、项目/分组、标签、优先级
- 附加图片，桌面端会复制到应用数据目录
- 置顶和靠近屏幕边缘自动吸边
- 本机 `127.0.0.1` API，方便 Codex/Claude/Cursor 等 AI 把当前工作写入 Todo Desk
- 配套 Codex skill：`/Users/dxm/.codex/skills/todo-desk`
- 浏览器降级模式：没有 Electron 时用 `localStorage`，方便后续扩展 PWA/移动端

## 本地运行

```bash
npm install
npm run dev
```

只看 Web UI：

```bash
npm run web:dev
```

## 打包

生成 macOS 可运行 `.app` 目录包：

```bash
npm run build
npx electron-builder --mac --dir
```

当前产物路径：

```text
/Users/dxm/Documents/Codex/2026-06-30/todo-todo/outputs/todo-desk-release/mac-arm64/Todo Desk.app
```

`npm run dist` 会尝试生成 DMG/zip。当前机器没有有效 Apple Developer ID，签名会跳过；这不影响 `--dir` 生成的 `.app` 在本机打开，但正式分发给别人前需要补签名和公证。

## 数据位置

macOS 下 Electron 数据默认在：

```text
~/Library/Application Support/todo-desk/todo-desk-data.json
~/Library/Application Support/todo-desk/attachments/
```

数据文件是普通 JSON，适合备份和迁移。

## 本机 AI 写入接口

Todo Desk 启动后默认监听：

```text
http://127.0.0.1:47731
```

接口只接受本机回环地址请求。可以在 App 右上角齿轮的“后台设置”里关闭接口或修改端口。

健康检查：

```bash
curl http://127.0.0.1:47731/health
```

添加一条当前工作：

```bash
curl -X POST http://127.0.0.1:47731/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Codex 正在处理 Todo Desk",
    "detail": "记录当前 AI 工作内容和下一步动作",
    "status": "doing",
    "priority": "medium",
    "project": "AI 工作",
    "tags": "codex todo-desk",
    "source": "codex"
  }'
```

也可以直接用配套 skill 脚本：

```bash
python3 /Users/dxm/.codex/skills/todo-desk/scripts/add_work.py \
  --title "当前 AI 工作" \
  --detail "正在处理某个需求" \
  --status doing \
  --priority medium \
  --project "AI 工作" \
  --tags codex,todo \
  --due-at "2026-07-01T18:00:00+08:00" \
  --reminder-at "2026-07-01T17:30:00+08:00"
```

## AI 元数据识别

在右上角齿轮里打开“添加任务时启用 AI 解析”，填写兼容 OpenAI Chat Completions 的 `Base URL`、`Model` 和可选 `API Key`。文本添加模式下输入一句话，例如“明天下午 3 点提醒我整理周报，归到工作，优先级高”，应用会让模型返回结构化 JSON，并自动填充标题、详情、状态、优先级、项目、标签、截止时间和提醒时间。

这部分只在本机 Electron 进程里发起请求，配置保存在本地 JSON 文件中；浏览器降级模式不会调用 AI。

## 飞书同步

先确认本机 `lark-cli` 已登录可用：

```bash
lark-cli auth status
```

在应用里填入飞书文档 URL 或 token，保持“完成后同步”开启。勾选完成任务后，应用会追加一段 Markdown 到飞书文档，内容包括：

- 当前正在做
- 未完成 Todo
- 已完成

当前同步是“应用到飞书文档”的备份/快照，不从飞书文档反向恢复结构化数据。如果后续要做真正双向云同步，建议改用飞书多维表格或云空间 JSON 文件。
