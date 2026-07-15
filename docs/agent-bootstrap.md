# Agent 自动接入 Todo Desk 设计

从 GitHub 拉下 `todo-desk` 后，不应该靠每个 agent 手工记住“先建任务、结束时更新”。更稳的做法是把接入拆成两件事：把 `todo-desk` skill 装到各 agent 能发现的位置，再把同一段工作挂载规则写进各 agent 的全局指令或规则文件。

这份文档也是给 agent 看的操作手册。agent 只有仓库地址时，可以按这里完成检查和配置准备；是否真的写入用户全局配置，由 agent 的主人决定。

## 安装桌面 App

当用户明确要求 Agent 安装 Todo Desk 桌面 App 时，不要让用户克隆源码、安装 Node.js 或准备 npm。Agent 应先确认仓库地址是：

```text
https://github.com/dahuaxiya/todo-desk
```

然后只下载仓库内的独立安装脚本，检查 shell 语法并执行：

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

`install-macos-release.sh` 只依赖 macOS 内置工具，负责完整流程：

1. 根据 `uname -m` 选择 `arm64` 或 `x64` DMG。
2. 从 GitHub API 获取最新 Release，不拼接或猜测版本文件名。
3. 使用 Release 元数据中的 SHA-256 校验下载文件。
4. 挂载 DMG，要求 `CFBundleIdentifier=com.codex.todo-desk`。
5. 停止旧进程、备份旧 App，再安装到 `/Applications/Todo Desk.app`；复制失败时恢复。
6. Gatekeeper 接受签名版本时保留 quarantine；当前未签名版本才执行 `xattr`。
7. 打开 Todo Desk，等待进程和 `http://127.0.0.1:47731/health` 同时就绪。

Agent 只有看到 `Todo Desk is installed, open, and ready.` 后，才能告诉用户安装完成。如果脚本失败，需要保留并报告实际错误。不要使用 `sudo xattr`、不要全局关闭 Gatekeeper，也不要把移除 quarantine 描述成签名或 Apple 公证。

正式 Release 完成 Developer ID 签名与 Apple 公证后，安装脚本会让 Gatekeeper 正常验收并保留 quarantine，因此 Agent 可以继续使用同一流程。

## 安装 Agent 接入配置（需要源码）

下面的流程不是桌面 App 安装步骤。用户只要求“安装 Todo Desk”时，完成上一节并看到应用界面后就应停止，不得继续克隆源码。只有用户另外要求把 Todo Desk 接入 Codex、Claude、Kimi、Cursor 等 Agent 时，才执行本节。

如果用户只给了 GitHub 地址，agent 先把仓库拉到本地，再读这份文档：

```bash
git clone https://github.com/dahuaxiya/todo-desk.git
cd todo-desk
npm install
```

然后 agent 需要先向主人说明这次配置会写入 home 目录下的全局 agent 配置，并给出 dry-run 结果。不要在未获得明确同意时执行正式安装。

推荐顺序：

```bash
npm run agent:install -- --dry-run
```

确认 dry-run 输出后，如果主人同意，再执行：

```bash
npm run agent:install
```

如果只是先安装规则和 skill，Todo Desk app 暂时没有启动，可以这样跳过 API 检查：

```bash
npm run agent:install -- --skip-api-check
```

如果 Todo Desk 使用了非默认端口：

```bash
npm run agent:install -- --port 47732
```

如果主人只想配置部分工具：

```bash
npm run agent:install -- --targets codex,claude
```

可选 target：

- `generic`：写入通用 `~/.agents` 配置。
- `codex`：写入 Codex skill 和全局 `AGENTS.md`。
- `claude`：写入 Claude skill 和全局 `CLAUDE.md`。
- `kimi`：写入 Kimi skill 目录、`extra_skill_dirs` 和 `AGENTS.md`。
- `cursor`：写入 Cursor skill 和 always-on rule。

## 给主人的确认内容

正式配置前，agent 应该把下面这些信息告诉主人：

- 这不是安装桌面 App 本体，而是让 Codex、Claude、Kimi、Cursor 等 agent 知道如何调用本机 Todo Desk。
- 脚本会写用户 home 目录里的全局配置文件，不会静默执行。
- `--dry-run` 只展示计划改动，不写文件。
- 正式安装是幂等的，重复运行只会更新 `todo-desk-agent-bootstrap` marker 内的内容。
- Todo Desk app 和本机 API 可用时，agent 才能真正创建和更新任务。

可以直接用这段话询问主人：

```text
我已经拉下 todo-desk 仓库。这个仓库提供 agent 自动接入脚本，会把 todo-desk skill 同步到 Codex/Claude/Kimi/Cursor/通用 agent 目录，并在对应全局规则文件里写入工作挂载规则。

我会先运行 dry-run 给你看会写哪些文件；只有你确认后，才执行正式安装。是否继续？
```

## 期望效果

拉库后运行一次：

```bash
npm install
npm run agent:install -- --dry-run
npm run agent:install
```

完成后：

- Codex 能在 `~/.codex/skills/todo-desk` 找到 skill，并在 `~/.codex/AGENTS.md` 里看到工作挂载规则。
- Claude 能在 `~/.claude/skills/todo-desk` 找到 skill，并在 `~/.claude/CLAUDE.md` 里看到同样规则。
- Kimi 能通过 `~/.kimi-code/config.toml` 的 `extra_skill_dirs` 加载 `todo-desk` skill，并在 `~/.kimi-code/AGENTS.md` 里看到同样规则。
- Cursor 能在 `~/.cursor/skills-cursor/todo-desk` 找到 skill，并通过 `~/.cursor/rules/todo-desk.mdc` 应用规则。
- 所有 agent 都有一个兜底共享路径：`~/.agents/skills/todo-desk`。

完整写入位置如下：

| 目标 | skill 位置 | 规则位置 |
| --- | --- | --- |
| 通用 agent | `~/.agents/skills/todo-desk` | `~/.agents/AGENTS.md` |
| Codex | `~/.codex/skills/todo-desk` | `~/.codex/AGENTS.md` |
| Claude | `~/.claude/skills/todo-desk` | `~/.claude/CLAUDE.md` |
| Kimi | `~/.kimi/extra-skills/todo-desk` | `~/.kimi-code/AGENTS.md` 和 `~/.kimi-code/config.toml` |
| Cursor | `~/.cursor/skills-cursor/todo-desk` | `~/.cursor/rules/todo-desk.mdc` |

## 配置模型

每个 agent 做明确用户任务时，需要把一条 Todo Desk 任务挂起来：

- `title`：当前要做的事。
- `detail`：用户原始要求、当前判断和下一步。
- `status`：开始时通常是 `doing`。
- `priority`：默认 `medium`，用户有明确优先级时按用户来。
- `agent`：当前工具名，例如 `codex`、`claude`、`kimi`、`cursor`。
- `agentSessionId`：当前会话/线程 id，必须来自运行时，不允许编造。
- `repository` / `repositoryPath`：当前代码库名和路径。
- `tags`：至少包含 `agent` 和 `agentSessionId`，再补 `todo-desk`、项目标签等。

推进中使用同一个任务追加进展。实现完成但用户还没有确认时，agent 只能请求完成审批，任务会进入 `pending_acceptance` 并显示红点；用户点“确认完成”或明确说 done 后，才允许更新成 `done`。如果当前 session 本轮输出已经完成，但 agent 判断任务尚未完成，agent 应请求未完成提醒，Todo Desk 会用非红色点提示，直到用户点击“已查看”或“查看会话”。如果 Todo Desk 没启动、API 不通、拿不到 session id，agent 需要直接告诉用户阻塞，不能假装已经写入。

## Bootstrap 脚本

脚本位置：

```bash
scripts/install-agent-integration.mjs
```

它做四件事：

1. 检查 `http://127.0.0.1:47731/health`，确认 Todo Desk API 是否可用。
2. 把仓库内 `skills/todo-desk` 同步到各 agent 的 skill 目录。
3. 在各 agent 的全局指令文件里用 marker 写入一段可重复更新的 Todo Desk 规则。
4. 对 Cursor 生成独立的 always-on rule：`~/.cursor/rules/todo-desk.mdc`。

marker 使用：

```md
<!-- todo-desk-agent-bootstrap:start -->
...
<!-- todo-desk-agent-bootstrap:end -->
```

重复运行脚本只会替换 marker 里的内容，不会无限追加。

## 命令

完整安装前，先确认当前仓库脚本能解析：

```bash
node --check scripts/install-agent-integration.mjs
```

先看会改哪些文件：

```bash
npm run agent:install -- --dry-run
```

只配置 Codex 和 Claude：

```bash
npm run agent:install -- --targets codex,claude
```

Todo Desk 不在默认端口时：

```bash
npm run agent:install -- --port 47732
```

跳过 API 检查，只安装规则和 skill：

```bash
npm run agent:install -- --skip-api-check
```

指定测试 home 目录，适合 agent 在临时目录里先验证写入逻辑：

```bash
npm run agent:install -- --home /tmp/todo-desk-agent-home --skip-api-check
```

正式安装后，可以检查这些文件是否存在：

```bash
test -d ~/.agents/skills/todo-desk
test -f ~/.agents/AGENTS.md
test -d ~/.codex/skills/todo-desk
test -f ~/.codex/AGENTS.md
test -d ~/.claude/skills/todo-desk
test -f ~/.claude/CLAUDE.md
test -d ~/.cursor/skills-cursor/todo-desk
test -f ~/.cursor/rules/todo-desk.mdc
test -f ~/.kimi-code/config.toml
test -f ~/.kimi-code/AGENTS.md
```

Todo Desk 已启动时，可以再检查 API：

```bash
curl http://127.0.0.1:47731/health
```

## 为什么不用 git hook 或 npm postinstall

这个配置会写用户 home 目录下的全局 agent 配置，属于有副作用的操作。不能放在 `postinstall` 里静默执行，也不适合用 git hook 自动改。正确入口是显式命令：用户拉库后自己运行 `npm run agent:install`。

## Kimi 的处理

Kimi 当前主要通过 `~/.kimi-code/config.toml` 的 `extra_skill_dirs` 加载额外 skill。脚本会把 `~/.kimi/extra-skills` 放进 `extra_skill_dirs`，并把 `todo-desk` skill 复制进去。

如果某个 Kimi 版本不读取 `~/.kimi-code/AGENTS.md`，仍然可以通过两条路径工作：

- skill 本身在 `extra_skill_dirs` 里可发现；
- 当前项目或全局 `.agents/AGENTS.md` 里有同样的 Todo Desk 规则。

## Agent 配置后的行为要求

配置完成后，各 agent 处理明确用户任务时，应遵循写入的全局规则：

- 开始工作时创建 Todo Desk 任务，状态通常为 `doing`。
- 创建任务必须带 `agent`、`agentSessionId`、`repository`、`repositoryPath`。
- `tags` 至少包含当前 agent 名和当前 session id。
- `session id` 必须来自当前运行时，例如 `CODEX_THREAD_ID`、`CLAUDE_SESSION_ID`、`KIMI_SESSION_ID`、`CURSOR_SESSION_ID` 或等价线程 id。
- 拿不到 session id 时，不得伪造，也不得创建、更新或完成任务。
- 如果新任务是当前 Todo Desk 任务的计划拆分，创建时传 `--parent-task-id <当前任务 id> --relation-type subtask_of`。
- Agent 在执行过程中要主动识别派生任务，不需要等主人再次要求拆分。只有新问题有独立结果、不是当前任务的常规实现步骤，并且可以单独分配/延期/完成或会改变父任务验收时，才自动创建卡片。
- 自动创建前先查询当前父任务已有的未完成子卡；相同问题已经存在时更新原卡，不重复创建。改代码、补测试、跑构建、常规重构、根因记录和即时解决的临时错误仍记录在当前任务进展里。
- 自动派生时传 `--parent-task-id <当前任务 id> --relation-type discovered_from --relation-reason <派生原因>`。立即切换处理用 `status=doing`，暂不处理用 `status=todo`。
- 父任务不解决派生问题就不能验收时使用 `--affects-parent-completion`；不影响父任务交付、可以独立后续处理时使用 `--follow-up-only`。
- 任务层级只能由明确的 Todo Desk task id 建立，不要根据标题、项目、标签、仓库或相同 session 推断。`session id` 只用于记录执行来源，一个分支可以跨多个 session。
- 工作推进时更新同一条 Todo Desk 任务，不要重复创建。
- 实现完成但主人还没有确认时，使用 `--request-completion`，让 Todo Desk 显示红点完成确认。
- 本轮 session 输出完成但任务尚未完成时，使用 `--request-session-review`，让 Todo Desk 显示非红色未完成提醒。
- 只有主人明确同意完成时，才能把任务状态改为 `done`。

## 不配置时怎么处理

主人可以只拉库、不执行 `agent:install`。这种情况下仓库不会改动任何全局 agent 配置。

如果 agent 后续仍需要记录 Todo Desk 任务，可以临时使用仓库内 skill 脚本或本机 API，但仍要满足 session id、agent、repo 信息等要求。没有 Todo Desk app、API 不通或没有 session id 时，agent 应该直接说明阻塞。

## 后续可以补的 MCP 层

现在的方案走本机 HTTP API + skill 脚本，优点是简单、离线、跨 agent。等 Todo Desk 稳定后，可以再加一个 MCP server，把能力暴露成标准工具：

- `todo_desk.create_task`
- `todo_desk.update_task`
- `todo_desk.list_tasks`
- `todo_desk.attach_session`

MCP 更适合工具调用体验，但不替代全局规则。规则仍然需要告诉 agent：什么时候应该调用 Todo Desk、必须带哪些元数据、什么时候不能标完成。
