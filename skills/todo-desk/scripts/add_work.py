#!/usr/bin/env python3
"""Add a work item to the local Todo Desk app."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def compact(value: dict) -> dict:
    return {key: item for key, item in value.items() if item not in ("", None, {})}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Add a task to Todo Desk via its localhost API.")
    parser.add_argument("--title", required=True)
    parser.add_argument("--detail", default="")
    parser.add_argument("--status", choices=["doing", "todo", "pending_acceptance", "done"], default="doing")
    parser.add_argument("--priority", choices=["low", "medium", "high"], default="medium")
    parser.add_argument("--project", default="AI 工作")
    parser.add_argument("--tags", default="")
    parser.add_argument("--due-at", default="")
    parser.add_argument("--reminder-at", default="")
    parser.add_argument("--source", default="codex")
    parser.add_argument("--agent", default=os.environ.get("TODO_DESK_AGENT", "codex"))
    parser.add_argument("--agent-session-id", default=os.environ.get("TODO_DESK_AGENT_SESSION_ID", ""))
    parser.add_argument("--repository", default=os.environ.get("TODO_DESK_REPOSITORY", ""))
    parser.add_argument("--repository-path", default=os.environ.get("TODO_DESK_REPOSITORY_PATH", os.getcwd()))
    parser.add_argument("--parent-task-id", default="")
    parser.add_argument("--relation-type", choices=["subtask_of", "discovered_from"], default="subtask_of")
    parser.add_argument("--relation-reason", default="")
    completion_group = parser.add_mutually_exclusive_group()
    completion_group.add_argument("--affects-parent-completion", dest="affects_parent_completion", action="store_true")
    completion_group.add_argument("--follow-up-only", dest="affects_parent_completion", action="store_false")
    parser.set_defaults(affects_parent_completion=None)
    parser.add_argument("--port", type=int, default=47731)
    parser.add_argument("--timeout", type=int, default=8)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    parent_link = compact({
        "type": args.relation_type,
        "reason": args.relation_reason,
        # None means the caller did not choose. Todo Desk then applies its backward-compatible true default.
        "affectsParentCompletion": args.affects_parent_completion,
        "createdBy": "agent",
        "confidence": "explicit",
    }) if args.parent_task_id else None
    origin = {
        "kind": "agent",
        "channel": "todo-desk-skill",
        "createdVia": "todo-desk-skill/add_work",
        "confidence": "explicit",
        "agent": compact({
            "name": args.agent,
            "sessionId": args.agent_session_id,
            "tool": args.agent,
        }),
        "repository": compact({
            "name": args.repository,
            "path": args.repository_path,
        }),
        "client": {
            "name": "todo-desk-skill",
            "version": "1",
        },
    }
    payload = {
        "title": args.title,
        "detail": args.detail,
        "status": args.status,
        "priority": args.priority,
        "project": args.project,
        "tags": args.tags,
        "dueAt": args.due_at,
        "reminderAt": args.reminder_at,
        "source": args.source,
        "agent": args.agent,
        "agentSessionId": args.agent_session_id,
        "repository": args.repository,
        "repositoryPath": args.repository_path,
        "parentTaskId": args.parent_task_id,
        "parentLink": parent_link,
        "origin": origin,
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{args.port}/tasks",
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        print(f"Todo Desk API request failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(body, ensure_ascii=False, indent=2))
    return 0 if body.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
