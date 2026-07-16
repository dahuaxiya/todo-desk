#!/usr/bin/env python3
"""Find a small parent-task candidate set before creating an AI task."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Find likely parent tasks through the Todo Desk API.")
    parser.add_argument("--title", required=True)
    parser.add_argument("--detail", default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--tags", default="")
    parser.add_argument("--agent-session-id", default=os.environ.get("TODO_DESK_AGENT_SESSION_ID", ""))
    parser.add_argument("--repository", default=os.environ.get("TODO_DESK_REPOSITORY", ""))
    parser.add_argument("--repository-path", default=os.environ.get("TODO_DESK_REPOSITORY_PATH", os.getcwd()))
    parser.add_argument("--exclude-task-id", default="")
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--port", type=int, default=47731)
    parser.add_argument("--timeout", type=int, default=8)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.agent_session_id:
        print("Current session id is required to search parent candidates.", file=sys.stderr)
        return 2

    payload = {
        "title": args.title,
        "detail": args.detail,
        "project": args.project,
        "tags": args.tags,
        "agentSessionId": args.agent_session_id,
        "repository": args.repository,
        "repositoryPath": args.repository_path,
        "excludeTaskId": args.exclude_task_id,
        "limit": args.limit,
    }
    request = urllib.request.Request(
        f"http://127.0.0.1:{args.port}/tasks/parent-candidates",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        print(f"Todo Desk parent candidate request failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(body, ensure_ascii=False, indent=2))
    return 0 if body.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
