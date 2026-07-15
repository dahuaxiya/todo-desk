---
name: todo-desk
description: Add or inspect current AI work in the local Todo Desk app, or prepare the macOS desktop app after installation. Use when the user asks an AI agent to install Todo Desk, record current work, add a todo, log ongoing work, or sync work context through its localhost API.
---

# Todo Desk

Use this skill to write AI work items into the user's local Todo Desk app.

## Install The macOS App

When the user explicitly asks the agent to install Todo Desk on macOS, do not require a source checkout, Node.js, npm, or Homebrew. Confirm the repository is:

```text
https://github.com/dahuaxiya/todo-desk
```

Download only the standalone installer from that repository, validate its shell syntax, and run it:

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

The installer selects the matching architecture, resolves the latest official GitHub Release, verifies its SHA-256 digest and `CFBundleIdentifier`, installs the app, handles quarantine only when Gatekeeper rejects the current unsigned build, opens Todo Desk, and waits for the local API. Do not ask the user to run `xattr`, do not use `sudo xattr`, and do not disable Gatekeeper globally. Claim success only after the script prints `Todo Desk is installed, open, and ready.`

The full install and health-check procedure is in `docs/agent-bootstrap.md#安装桌面-app` in the repository.

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
- `status`: `doing`, `todo`, `pending_acceptance`, or `done`; default `doing`.
- `priority`: `low`, `medium`, or `high`; default `medium`.
- `tags` accepts comma or space separated values. For current-work logging, `tags` must include the current `agent` name and the current `session id`.
- `due-at` and `reminder-at` accept ISO 8601 timestamps.
- `source` defaults to the current agent/tool name when supplied by the caller, otherwise `codex`.
- `agent`, `agent-session-id`, `repository`, and `repository-path` attach work to the current agent run and codebase.
- The script also sends `origin.kind=agent`, `origin.channel=todo-desk-skill`, and `origin.confidence=explicit`. Todo Desk uses `origin.kind` as the authoritative source classification for UI styling and avoids guessing from metadata fields.
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
  --user-confirmed-completion \
  --append-detail "Implementation verified" \
  --agent codex \
  --agent-session-id "current-session-id"
```

When implementation is finished but the user has not confirmed completion, request completion approval instead of marking `done`:

```bash
python3 /Users/dxm/.agents/skills/todo-desk/scripts/update_task.py \
  --task-id "<task-id>" \
  --request-completion \
  --append-detail "实现已完成，等待用户确认是否标记 done" \
  --agent codex \
  --agent-session-id "current-session-id"
```

When the current session turn is complete but the agent believes the task itself is not finished, request an unfinished-session reminder. This is separate from completion approval: Todo Desk shows a non-red dot until the user chooses `已查看` or `查看会话`.

```bash
python3 /Users/dxm/.agents/skills/todo-desk/scripts/update_task.py \
  --task-id "<task-id>" \
  --request-session-review \
  --session-review-message "本轮 session 输出完成，但任务尚未完成" \
  --agent codex \
  --agent-session-id "current-session-id" \
  --repository "todo-desk" \
  --repository-path "/path/to/repo"
```

If the user explicitly handles the unfinished-session reminder through an agent command, clear it with:

```bash
python3 /Users/dxm/.agents/skills/todo-desk/scripts/update_task.py \
  --task-id "<task-id>" \
  --session-review-decision reviewed \
  --agent codex \
  --agent-session-id "current-session-id"
```

Before marking a task `done`, ensure the user has explicitly agreed that the task should be completed and pass `--user-confirmed-completion`. Continue to pass the current `agent-session-id` when updating the task.

## When App Is Not Running

If the script cannot connect, tell the user to open Todo Desk first and confirm the API is enabled in settings. Do not fake success.
