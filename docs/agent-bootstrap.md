# Agent 自动接入 Todo Desk 设计

从 GitHub 拉下 `todo-desk` 后，不应该靠每个 agent 手工记住“先建任务、结束时更新”。更稳的做法是把接入拆成两件事：把 `todo-desk` skill 装到各 agent 能发现的位置，再把同一段工作挂载规则写进各 agent 的全局指令或规则文件。

## 期望效果

拉库后运行一次：

```bash
npm run agent:install -- --dry-run
npm run agent:install
```

完成后：

- Codex 能在 `~/.codex/skills/todo-desk` 找到 skill，并在 `~/.codex/AGENTS.md` 里看到工作挂载规则。
- Claude 能在 `~/.claude/skills/todo-desk` 找到 skill，并在 `~/.claude/CLAUDE.md` 里看到同样规则。
- Kimi 能通过 `~/.kimi-code/config.toml` 的 `extra_skill_dirs` 加载 `todo-desk` skill，并在 `~/.kimi-code/AGENTS.md` 里看到同样规则。
- Cursor 能在 `~/.cursor/skills-cursor/todo-desk` 找到 skill，并通过 `~/.cursor/rules/todo-desk.mdc` 应用规则。
- 所有 agent 都有一个兜底共享路径：`~/.agents/skills/todo-desk`。

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

推进中使用同一个任务追加进展，用户明确同意完成时才更新成 `done`。如果 Todo Desk 没启动、API 不通、拿不到 session id，agent 需要直接告诉用户阻塞，不能假装已经写入。

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

## 为什么不用 git hook 或 npm postinstall

这个配置会写用户 home 目录下的全局 agent 配置，属于有副作用的操作。不能放在 `postinstall` 里静默执行，也不适合用 git hook 自动改。正确入口是显式命令：用户拉库后自己运行 `npm run agent:install`。

## Kimi 的处理

Kimi 当前主要通过 `~/.kimi-code/config.toml` 的 `extra_skill_dirs` 加载额外 skill。脚本会把 `~/.kimi/extra-skills` 放进 `extra_skill_dirs`，并把 `todo-desk` skill 复制进去。

如果某个 Kimi 版本不读取 `~/.kimi-code/AGENTS.md`，仍然可以通过两条路径工作：

- skill 本身在 `extra_skill_dirs` 里可发现；
- 当前项目或全局 `.agents/AGENTS.md` 里有同样的 Todo Desk 规则。

## 后续可以补的 MCP 层

现在的方案走本机 HTTP API + skill 脚本，优点是简单、离线、跨 agent。等 Todo Desk 稳定后，可以再加一个 MCP server，把能力暴露成标准工具：

- `todo_desk.create_task`
- `todo_desk.update_task`
- `todo_desk.list_tasks`
- `todo_desk.attach_session`

MCP 更适合工具调用体验，但不替代全局规则。规则仍然需要告诉 agent：什么时候应该调用 Todo Desk、必须带哪些元数据、什么时候不能标完成。
