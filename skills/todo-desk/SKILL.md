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

The port can be changed in Todo Desk settings. Default port is `47731`.

## Add Current Work

Prefer the bundled script:

```bash
python3 /Users/dxm/.codex/skills/todo-desk/scripts/add_work.py \
  --title "Implement Feishu sync" \
  --detail "Current agent work summary and next step" \
  --status doing \
  --priority medium \
  --project "AI 工作" \
  --tags codex,todo-desk \
  --due-at "2026-07-01T18:00:00+08:00" \
  --reminder-at "2026-07-01T17:30:00+08:00"
```

Fields:

- `title` is required.
- `status`: `doing`, `todo`, or `done`; default `doing`.
- `priority`: `low`, `medium`, or `high`; default `medium`.
- `tags` accepts comma or space separated values.
- `due-at` and `reminder-at` accept ISO 8601 timestamps.
- `source` defaults to the current agent/tool name when supplied by the caller, otherwise `codex`.

## When App Is Not Running

If the script cannot connect, tell the user to open Todo Desk first and confirm the API is enabled in settings. Do not fake success.
