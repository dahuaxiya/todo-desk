#!/usr/bin/env python3
"""Search Todo Desk tasks without loading the complete task list."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Search Todo Desk tasks through its localhost API.")
    parser.add_argument("--query", default="")
    parser.add_argument("--status", default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--tags", default="")
    parser.add_argument("--agent", default="")
    parser.add_argument("--agent-session-id", default=os.environ.get("TODO_DESK_AGENT_SESSION_ID", ""))
    parser.add_argument("--repository", default="")
    parser.add_argument("--repository-path", default="")
    parser.add_argument("--origin-kind", default="")
    parser.add_argument("--exclude-task-id", default="")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--port", type=int, default=47731)
    parser.add_argument("--timeout", type=int, default=8)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = {
        "query": args.query,
        "status": args.status,
        "project": args.project,
        "tags": args.tags,
        "agent": args.agent,
        "agentSessionId": args.agent_session_id,
        "repository": args.repository,
        "repositoryPath": args.repository_path,
        "originKind": args.origin_kind,
        "excludeTaskId": args.exclude_task_id,
        "limit": args.limit,
    }
    if not any(value for key, value in payload.items() if key != "limit"):
        print("At least one query or exact filter is required.", file=sys.stderr)
        return 2

    request = urllib.request.Request(
        f"http://127.0.0.1:{args.port}/tasks/search",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            error_body = json.loads(exc.read().decode("utf-8"))
            message = error_body.get("error") or str(exc)
        except (json.JSONDecodeError, UnicodeDecodeError):
            message = str(exc)
        print(f"Todo Desk task search failed: {message}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"Todo Desk task search failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(body, ensure_ascii=False, indent=2))
    return 0 if body.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
