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

## Resolve the Parent Before Creating AI Work

Before every `POST /tasks` or `add_work.py` call that creates an AI task, inspect the complete task list from `GET /tasks` and independently decide whether an existing task is its direct parent.

1. Consider all non-trashed tasks as candidates, regardless of whether `origin.kind` is `human` or `agent`. Prefer active tasks, but allow a completed task when the new work is clearly a follow-up derived from it.
2. Judge the direct relationship from the task goal, acceptance scope, detail, relation history, the user's current request, the task currently selected in Todo Desk, and any explicit task id supplied by the caller. Repository, project, title similarity, tags, source type, and session id are supporting context only; none proves a relationship by itself.
3. When one candidate is clearly the direct parent, create the AI task with its id in `--parent-task-id`. Use `subtask_of` for planned decomposition within the parent's scope, or `discovered_from` for an independent issue exposed while executing the parent.
4. Preserve the nearest direct relationship. Do not skip an AI parent and attach its child directly to a human ancestor, and do not flatten a multi-level branch merely because another task has broader or more similar wording.
5. If the available task list does not support a confident direct-parent judgment, create the AI task without a parent instead of inventing a relationship. Record enough detail for the relationship to be added later.

This parent check is mandatory even when the user only asks the agent to "record the current work." Its purpose is to let the agent use the full Todo Desk context to keep related AI work connected without forcing every AI task under a human card.

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
  --parent-task-id "optional-direct-parent-task-id" \
  --relation-type discovered_from \
  --relation-reason "The issue discovered while handling the parent task" \
  --affects-parent-completion \
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
- `parent-task-id` records the task that directly led to this work. Pass it only when the parent is explicit; do not infer it from a similar title, project, tag, repository, or session.
- `relation-type=subtask_of` means planned decomposition. `relation-type=discovered_from` means a new issue found while executing the parent task.
- For a derived issue, use `relation-reason` to explain how it arose. Use `--affects-parent-completion` when it blocks the parent, or `--follow-up-only` when the parent may finish independently.
- The script also sends `origin.kind=agent`, `origin.channel=todo-desk-skill`, and `origin.confidence=explicit`. Todo Desk uses `origin.kind` as the authoritative source classification for UI styling and avoids guessing from metadata fields.
- `agent-session-id` is required for current-work logging. If the current session id is unavailable, do not create, update, or complete the Todo Desk task; tell the user that logging is blocked instead of inventing or leaving the value empty.

## Create a Derived Branch

When the current task exposes a new problem, use the current Todo Desk task id from the earlier `add_work.py` response as the direct parent. Do not create an unrelated task just because another agent or session will handle it.

### Detect derived work automatically

While executing a Todo Desk task, continuously evaluate newly discovered work instead of waiting for the user to ask for a split. Create a `discovered_from` child automatically only when all of these are true:

- it has a concrete outcome that can be tracked independently, such as a separate fix, investigation, migration, or document;
- it is not merely an expected implementation step, test, refactor, or verification already required to finish the current task;
- it can reasonably be assigned, postponed, or completed separately, or it changes whether the parent task can be accepted;
- the current Todo Desk task id is known from the original `add_work.py` response or explicit task context.

Do not create a derived card for a restatement of the same issue, a root-cause note, a transient tool/build error fixed inline, or every small coding step. Before creating one, inspect the current parent's existing active children through `GET /tasks`; if an equivalent child already exists, update that task instead of creating a duplicate.

Create the child as soon as the independent work is recognized:

- use `status=doing` when switching to it now, otherwise use `status=todo`;
- set `relation-type=discovered_from` and write a specific `relation-reason` describing what in the parent exposed it;
- use `--affects-parent-completion` only when the parent cannot be accepted without it; otherwise use `--follow-up-only`;
- keep the returned child task id if work continues on that child, so further discoveries attach to the correct direct parent.

If the current task id is unavailable, do not infer the parent from title, repository, tags, or session id. Report that automatic relationship creation is blocked and continue updating only the task whose id is explicitly known.

```bash
python3 /Users/dxm/.agents/skills/todo-desk/scripts/add_work.py \
  --title "Fix concurrent token refresh overwrite" \
  --detail "Found while investigating the customer login failure" \
  --status doing \
  --priority high \
  --project "Todo Desk" \
  --tags codex,current-session-id,todo-desk \
  --agent codex \
  --agent-session-id "current-session-id" \
  --repository "todo-desk" \
  --repository-path "/path/to/repo" \
  --parent-task-id "current-todo-task-id" \
  --relation-type discovered_from \
  --relation-reason "Token refresh races were found while tracing the login failure" \
  --affects-parent-completion
```

`agent-session-id` identifies who is doing the work; it must not be used to infer task hierarchy. A session may handle several tasks, and one task branch may continue across several sessions.

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
  --repository-path "/path/to/repo" \
  --parent-task-id "optional-direct-parent-task-id" \
  --relation-type discovered_from \
  --relation-reason "Why this task was derived" \
  --affects-parent-completion
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

If the user explicitly decides a parent task review, use:

```bash
python3 /Users/dxm/.agents/skills/todo-desk/scripts/update_task.py \
  --task-id "<parent-task-id>" \
  --parent-review-decision kept \
  --agent codex \
  --agent-session-id "current-session-id"
```

Use `accepted` only when the user confirms the parent task is complete. Todo Desk automatically creates this parent review after all linked agent child tasks are confirmed done.

Before marking a task `done`, ensure the user has explicitly agreed that the task should be completed and pass `--user-confirmed-completion`. Continue to pass the current `agent-session-id` when updating the task.

## When App Is Not Running

If the script cannot connect, tell the user to open Todo Desk first and confirm the API is enabled in settings. Do not fake success.
