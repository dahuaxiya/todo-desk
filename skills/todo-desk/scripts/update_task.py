#!/usr/bin/env python3
"""Update a Todo Desk task through the local API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone


def parse_task_ids(value: str) -> list[str]:
    normalized = value.replace("，", ",").replace("、", ",").replace(" ", ",")
    return list(dict.fromkeys(item.strip() for item in normalized.split(",") if item.strip()))[:50]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update a Todo Desk task via its localhost API.")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--status", choices=["doing", "todo", "pending_acceptance", "done"], default="")
    parser.add_argument("--request-completion", action="store_true")
    parser.add_argument("--user-confirmed-completion", action="store_true")
    parser.add_argument("--request-human-input", action="store_true")
    parser.add_argument("--human-input-message", default="")
    parser.add_argument("--request-session-review", action="store_true")
    parser.add_argument("--session-review-message", default="")
    parser.add_argument("--session-review-decision", choices=["", "reviewed", "rework", "dismissed"], default="")
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
    relationship_group = parser.add_mutually_exclusive_group()
    relationship_group.add_argument("--parent-task-id", default=None)
    relationship_group.add_argument("--independent-root", action="store_true")
    relationship_group.add_argument("--parent-unresolved", action="store_true")
    parser.add_argument("--relation-type", choices=["", "subtask_of", "discovered_from"], default="")
    parser.add_argument("--relation-reason", default="")
    parser.add_argument("--parent-decision-reason", default="")
    parser.add_argument("--parent-candidate-ids", default="")
    completion_group = parser.add_mutually_exclusive_group()
    completion_group.add_argument("--affects-parent-completion", dest="affects_parent_completion", action="store_true")
    completion_group.add_argument("--follow-up-only", dest="affects_parent_completion", action="store_false")
    parser.set_defaults(affects_parent_completion=None)
    parser.add_argument("--parent-review-decision", choices=["", "accepted", "kept"], default="")
    parser.add_argument("--port", type=int, default=47731)
    parser.add_argument("--timeout", type=int, default=8)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    parent_task_id = (args.parent_task_id or "").strip()
    if args.parent_task_id is not None and not parent_task_id:
        print("--parent-task-id cannot be empty. Use --parent-unresolved when no parent can be selected.", file=sys.stderr)
        return 2
    status = args.status
    append_detail = args.append_detail
    request_human_input = args.request_human_input
    request_session_review = args.request_session_review
    if args.request_completion or (status == "done" and not args.user_confirmed_completion):
        status = "pending_acceptance"
        request_human_input = False
        request_session_review = False
        completion_message = "实现已完成，等待用户确认是否标记 done"
        append_detail = "\n\n".join(item for item in (append_detail, completion_message) if item)

    parent_link = {
        key: value
        for key, value in {
            "type": args.relation_type,
            "reason": args.relation_reason,
            "affectsParentCompletion": args.affects_parent_completion,
            "createdBy": "agent",
            "confidence": "explicit",
        }.items()
        if value not in ("", None)
    }

    has_relationship_decision = bool(args.parent_task_id is not None or args.independent_root or args.parent_unresolved)
    relationship_state = ""
    relationship_decision = None
    if has_relationship_decision:
        decision_reason = (args.parent_decision_reason or args.relation_reason).strip()
        if not decision_reason:
            print("A relationship decision reason is required. Use --parent-decision-reason or --relation-reason.", file=sys.stderr)
            return 2
        relationship_state = (
            "linked" if parent_task_id
            else "independent_root" if args.independent_root
            else "unresolved"
        )
        candidate_task_ids = parse_task_ids(args.parent_candidate_ids)
        if parent_task_id and parent_task_id not in candidate_task_ids:
            candidate_task_ids.insert(0, parent_task_id)
        relationship_decision = {
            "state": relationship_state,
            "reason": decision_reason,
            "candidateTaskIds": candidate_task_ids,
            "decidedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "decidedBy": "agent",
            "agent": args.agent,
            "agentSessionId": args.agent_session_id,
        }

    payload = {
        "status": status,
        "appendDetail": append_detail,
        "completionDecision": "confirm" if args.user_confirmed_completion else "",
        "requestHumanInput": request_human_input,
        "humanInputMessage": args.human_input_message,
        "requestSessionReview": request_session_review,
        "sessionReviewMessage": args.session_review_message,
        "sessionReviewDecision": args.session_review_decision,
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
        "parentCompletionReviewDecision": args.parent_review_decision,
    }
    payload = {key: value for key, value in payload.items() if value not in ("", None)}
    if has_relationship_decision:
        # Root decisions must send an explicit empty parentTaskId so PATCH clears an old relationship.
        payload["parentTaskId"] = parent_task_id
        payload["parentLink"] = parent_link or None
        payload["relationshipState"] = relationship_state
        payload["relationshipDecision"] = relationship_decision
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
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"Todo Desk API rejected the update ({exc.code}): {body}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"Todo Desk API request failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(body, ensure_ascii=False, indent=2))
    return 0 if body.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
