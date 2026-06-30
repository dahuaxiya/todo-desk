#!/usr/bin/env python3
"""Add a work item to the local Todo Desk app."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Add a task to Todo Desk via its localhost API.")
    parser.add_argument("--title", required=True)
    parser.add_argument("--detail", default="")
    parser.add_argument("--status", choices=["doing", "todo", "done"], default="doing")
    parser.add_argument("--priority", choices=["low", "medium", "high"], default="medium")
    parser.add_argument("--project", default="AI 工作")
    parser.add_argument("--tags", default="")
    parser.add_argument("--source", default="codex")
    parser.add_argument("--port", type=int, default=47731)
    parser.add_argument("--timeout", type=int, default=8)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = {
        "title": args.title,
        "detail": args.detail,
        "status": args.status,
        "priority": args.priority,
        "project": args.project,
        "tags": args.tags,
        "source": args.source,
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
