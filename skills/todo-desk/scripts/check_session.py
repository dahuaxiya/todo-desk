#!/usr/bin/env python3
"""Check whether the current agent session is mounted to Todo Desk correctly."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


SESSION_KEYS = (
    "agentSessionId",
    "agent_session_id",
    "session_id",
    "sessionId",
    "thread-id",
    "thread_id",
    "conversation_id",
    "conversationId",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate Todo Desk coverage for an agent session.")
    parser.add_argument("event_json", nargs="?", default="")
    parser.add_argument("--hook-source", choices=["manual", "codex", "claude", "cursor", "kimi"], default="manual")
    parser.add_argument("--agent", default="")
    parser.add_argument("--agent-session-id", default="")
    parser.add_argument("--port", type=int, default=47731)
    parser.add_argument("--timeout", type=int, default=4)
    parser.add_argument("--delegate-config", default="")
    return parser.parse_args()


def parse_json(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def read_event_payload(event_json: str, has_explicit_session_id: bool) -> tuple[dict[str, Any], str]:
    raw = event_json.strip()
    if not raw and not has_explicit_session_id and not sys.stdin.isatty():
        raw = sys.stdin.read().strip()
    return parse_json(raw), raw


def extract_session_id(payload: dict[str, Any], explicit: str) -> str:
    if explicit.strip():
        return explicit.strip()
    for key in SESSION_KEYS:
        value = payload.get(key)
        if value:
            return str(value).strip()
    for env_name in ("CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "KIMI_SESSION_ID", "CURSOR_SESSION_ID", "TODO_DESK_AGENT_SESSION_ID"):
        value = os.environ.get(env_name, "").strip()
        if value:
            return value
    return ""


def run_delegate(config_path: str, raw_event: str) -> None:
    if not config_path:
        return
    try:
        value = json.loads(Path(config_path).read_text(encoding="utf-8"))
        command = value.get("command") if isinstance(value, dict) else value
        if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
            return
        # Codex only supports one notify command. Run the previous notifier asynchronously so
        # installing Todo Desk does not remove desktop/computer-use notifications the user relies on.
        subprocess.Popen(
            [*command, raw_event],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except (OSError, ValueError, TypeError):
        return


def search_session_tasks(port: int, session_id: str, timeout: int) -> list[dict[str, Any]]:
    payload = json.dumps({"agentSessionId": session_id, "limit": 50}).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/tasks/search",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.loads(response.read().decode("utf-8"))
    if not body.get("ok") or not isinstance(body.get("tasks"), list):
        raise ValueError("Todo Desk search returned an invalid response")
    return body["tasks"]


def has_valid_relationship_decision(task: dict[str, Any]) -> bool:
    decision = task.get("relationshipDecision")
    if not isinstance(decision, dict) or not str(decision.get("reason") or "").strip():
        return False
    state = str(task.get("relationshipState") or "")
    if decision.get("state") != state:
        return False
    parent_task_id = str(task.get("parentTaskId") or "").strip()
    return (state == "linked" and bool(parent_task_id)) or (state in {"independent_root", "unresolved"} and not parent_task_id)


def build_issue(tasks: list[dict[str, Any]], session_id: str) -> str:
    if not tasks:
        return (
            f"Todo Desk 校验：当前 session {session_id} 没有任务。"
            "如果用户交办了明确工作，请先搜索相关任务并用 add_work.py 创建；如果只是普通问答，可以再次结束，本提醒不会循环阻止。"
        )

    invalid_tasks = []
    for task in tasks:
        # Version 2 is the first protocol that requires structured relationship evidence.
        # Legacy tasks remain readable and are organized manually instead of blocking every old session.
        if str(task.get("originClientVersion") or "") != "2":
            continue
        if not has_valid_relationship_decision(task):
            invalid_tasks.append(task)
    if not invalid_tasks:
        return ""

    titles = "、".join(f"{task.get('title') or task.get('id')} ({task.get('id')})" for task in invalid_tasks[:5])
    suffix = f"，另有 {len(invalid_tasks) - 5} 条" if len(invalid_tasks) > 5 else ""
    return (
        f"Todo Desk 校验：当前 session 有 {len(invalid_tasks)} 张新版 AI 卡片缺少有效父任务决策：{titles}{suffix}。"
        "请为每张任务明确 parentTaskId、independent_root 或 parent_unresolved，并记录判断理由。"
    )


def state_path(source: str, session_id: str) -> Path:
    digest = hashlib.sha256(f"{source}:{session_id}".encode("utf-8")).hexdigest()[:24]
    return Path(tempfile.gettempdir()) / "todo-desk-session-check" / f"{digest}.json"


def should_report_once(source: str, session_id: str, issue: str, payload: dict[str, Any]) -> bool:
    if payload.get("stop_hook_active") is True:
        return False
    path = state_path(source, session_id)
    fingerprint = hashlib.sha256(issue.encode("utf-8")).hexdigest()
    try:
        previous = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        previous = {}
    if previous.get("fingerprint") == fingerprint and time.time() - float(previous.get("reportedAt") or 0) < 300:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"fingerprint": fingerprint, "reportedAt": time.time()}), encoding="utf-8")
    return True


def clear_report_state(source: str, session_id: str) -> None:
    try:
        state_path(source, session_id).unlink(missing_ok=True)
    except OSError:
        pass


def notify_macos(message: str) -> None:
    if sys.platform != "darwin" or not shutil.which("osascript"):
        return
    escaped = message.replace("\\", "\\\\").replace('"', '\\"')
    try:
        subprocess.run(
            ["osascript", "-e", f'display notification "{escaped}" with title "Todo Desk session 校验"'],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def main() -> int:
    args = parse_args()
    payload, raw_event = read_event_payload(args.event_json, bool(args.agent_session_id.strip()))
    run_delegate(args.delegate_config, raw_event)
    session_id = extract_session_id(payload, args.agent_session_id)
    if not session_id:
        # A hook without a trustworthy runtime session id cannot make a safe task lookup.
        # Fail open so a tool upgrade cannot trap the user in an uncloseable session.
        print("Todo Desk session check skipped: runtime session id is unavailable", file=sys.stderr)
        return 0

    try:
        tasks = search_session_tasks(args.port, session_id, args.timeout)
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(f"Todo Desk session check skipped: {exc}", file=sys.stderr)
        return 0

    issue = build_issue(tasks, session_id)
    if not issue:
        clear_report_state(args.hook_source, session_id)
        return 0
    if not should_report_once(args.hook_source, session_id, issue, payload):
        return 0

    if args.hook_source == "codex":
        notify_macos(issue)
        print(issue, file=sys.stderr)
        return 0

    print(issue, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
