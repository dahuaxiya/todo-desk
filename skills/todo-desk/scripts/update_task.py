#!/usr/bin/env python3
"""Update a Todo Desk task through the local API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update a Todo Desk task via its localhost API.")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--status", choices=["doing", "todo", "done"], default="")
    parser.add_argument("--append-detail", default="")
    parser.add_argument("--title", default="")
    parser.add_argument("--detail", default="")
    parser.add_argument("--priority", choices=["", "low", "medium", "high"], default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--tags", default="")
    parser.add_argument("--due-at", default="")
    parser.add_argument("--reminder-at", default="")
    parser.add_argument("--source", default="")
    parser.add_argument("--agent", default=os.environ.get("TODO_DESK_AGENT", "codex"))
    parser.add_argument("--agent-session-id", default=os.environ.get("TODO_DESK_AGENT_SESSION_ID", ""))
    parser.add_argument("--repository", default=os.environ.get("TODO_DESK_REPOSITORY", ""))
    parser.add_argument("--repository-path", default=os.environ.get("TODO_DESK_REPOSITORY_PATH", os.getcwd()))
    parser.add_argument("--port", type=int, default=47731)
    parser.add_argument("--timeout", type=int, default=8)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = {
        "status": args.status,
        "appendDetail": args.append_detail,
        "title": args.title,
        "detail": args.detail,
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
    }
    payload = {key: value for key, value in payload.items() if value not in ("", None)}
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{args.port}/tasks/{args.task_id}",
        data=data,
        method="PATCH",
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
