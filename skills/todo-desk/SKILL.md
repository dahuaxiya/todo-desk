---
name: todo-desk
description: Add or inspect current AI work in the local Todo Desk app. Use when the user asks an AI agent to record current work, add a todo, log ongoing work, or sync work context into the Todo Desk desktop app through its localhost API.
---

# Todo Desk

Use this skill to write AI work items into the user's local Todo Desk app.

## API

Todo Desk exposes a loopback-only HTTP API when the desktop app is running:

- `GET http://127.0.0.1:47731/health`
- `GET http://127.0.0.1:47731/tasks`
- `POST http://127.0.0.1:47731/tasks`
- `PATCH http://127.0.0.1:47731/tasks/<task-id>`

The port can be changed in Todo Desk settings. Default port is `47731`.

## Add Current Work

Prefer the bundled script:

```bash
python3 /Users/dxm/.agents/skills/todo-desk/scripts/add_work.py \
  --title "Implement Feishu sync" \
  --detail "Current agent work summary and next step" \
  --status doing \
  --priority medium \
  --project "AI 工作" \
  --tags codex,todo-desk \
  --agent codex \
  --agent-session-id "current-session-id" \
  --repository "todo-desk" \
  --repository-path "/path/to/repo" \
  --due-at "2026-07-01T18:00:00+08:00" \
  --reminder-at "2026-07-01T17:30:00+08:00"
```

Fields:

- `title` is required.
- `status`: `doing`, `todo`, or `done`; default `doing`.
- `priority`: `low`, `medium`, or `high`; default `medium`.
- `tags` accepts comma or space separated values. For current-work logging, `tags` must include the current `agent` name and the current `session id`.
- `due-at` and `reminder-at` accept ISO 8601 timestamps.
- `source` defaults to the current agent/tool name when supplied by the caller, otherwise `codex`.
- `agent`, `agent-session-id`, `repository`, and `repository-path` attach work to the current agent run and codebase.
- `agent-session-id` is required for current-work logging. If the current session id is unavailable, do not create, update, or complete the Todo Desk task; tell the user that logging is blocked instead of inventing or leaving the value empty.

## Update Work Status

Use this after an agent starts or progresses a task:

```bash
python3 /Users/dxm/.agents/skills/todo-desk/scripts/update_task.py \
  --task-id "<task-id>" \
  --status doing \
  --append-detail "Codex started implementation" \
  --agent codex \
  --agent-session-id "current-session-id" \
  --repository "todo-desk" \
  --repository-path "/path/to/repo"
```

Mark done only after the user explicitly agrees:

```bash
python3 /Users/dxm/.agents/skills/todo-desk/scripts/update_task.py \
  --task-id "<task-id>" \
  --status done \
  --append-detail "Implementation verified" \
  --agent codex \
  --agent-session-id "current-session-id"
```

Before marking a task `done`, ensure the user has explicitly agreed that the task should be completed. Continue to pass the current `agent-session-id` when updating the task.

## When App Is Not Running

If the script cannot connect, tell the user to open Todo Desk first and confirm the API is enabled in settings. Do not fake success.
