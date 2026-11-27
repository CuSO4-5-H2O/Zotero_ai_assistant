"""Async transport from local MCP to ResearchNotebook's existing AI conversation.

The existing backend owns the model, tools, history and write permissions.
Workers run independently of Claude's MCP request timeout.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
JOBS = ROOT / ".runtime" / "claude-assistant-jobs"
JOB_ID = re.compile(r"^[a-f0-9]{32}$")
PAPER_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
TERMINAL = {"completed", "failed"}
MAX_REPLY = 300000


def chat_path(paper_id: str | None) -> str:
    if paper_id is None or paper_id == "workspace":
        return "/api/workspace/chat"
    if not isinstance(paper_id, str) or not PAPER_ID.fullmatch(paper_id):
        raise ValueError("文献编号无效。")
    return "/api/papers/" + paper_id + "/chat"


def job_path(task_id: str) -> Path:
    if not isinstance(task_id, str) or not JOB_ID.fullmatch(task_id):
        raise ValueError("助手任务编号无效。")
    return JOBS / (task_id + ".json")


def save(job: dict[str, Any]) -> None:
    path = job_path(job["task_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        job["updated"] = time.time()
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as temp:
            json.dump(job, temp, ensure_ascii=False)
            temp_path = Path(temp.name)
        temp_path.replace(path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def load(task_id: str) -> dict[str, Any]:
    try:
        return json.loads(job_path(task_id).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError("未找到助手任务，请使用发送任务返回的 task_id。") from exc


def public(job: dict[str, Any]) -> dict[str, Any]:
    result = {k: job.get(k) for k in ("task_id", "status", "paper_id", "phase", "reply", "actions", "tools", "tool_errors", "error", "message_id", "model", "chat_version", "created", "updated")}
    result["finished"] = job["status"] in TERMINAL
    if not result["finished"]:
        result["next_action"] = {"tool": "get_research_assistant_task", "arguments": {"task_id": job["task_id"], "wait_seconds": 12}}
    return result


def start(message: str, paper_id: str | None = None) -> dict[str, Any]:
    if not isinstance(message, str) or not 1 <= len(message.strip()) <= 3900:
        raise ValueError("发送给科研助手的任务须为 1–3,900 字符。")
    chat_path(paper_id)
    scope = paper_id or "workspace"
    # Repeated MCP calls for an active task reuse it instead of making duplicate writes.
    for path in sorted(JOBS.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:30]:
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if existing.get("status") not in TERMINAL and existing.get("paper_id") == scope:
            if existing.get("question") == message.strip():
                return public(existing)
            raise ValueError("该助手还有任务在执行，请先查询 task_id=" + existing["task_id"])
    from research_notebook_mcp import api_request
    # Check local connectivity before accepting a task; this does not invoke a model.
    api_request("GET", chat_path(paper_id))
    job = {"task_id": uuid.uuid4().hex, "paper_id": scope, "question": message.strip(), "status": "queued", "phase": "等待科研助手接收", "reply": "", "actions": [], "tools": [], "tool_errors": [], "created": time.time()}
    save(job)
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        with (JOBS / (job["task_id"] + ".stderr.log")).open("ab") as log:
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--run", job["task_id"]], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, creationflags=flags, close_fds=True, cwd=str(ROOT))
    except OSError as exc:
        job.update(status="failed", error="无法启动助手连接进程：" + str(exc))
        save(job)
    return public(job)


def get(task_id: str, wait_seconds: float = 0) -> dict[str, Any]:
    deadline = time.monotonic() + max(0, min(15, wait_seconds))
    while True:
        job = load(task_id)
        remaining = deadline - time.monotonic()
        if job["status"] in TERMINAL or remaining <= 0:
            return public(job)
        time.sleep(min(0.3, remaining))


def history(paper_id: str | None = None, limit: int = 10) -> dict[str, Any]:
    from research_notebook_mcp import api_request
    data = api_request("GET", chat_path(paper_id))
    rows = data.get("messages", [])[-max(1, min(30, int(limit))):]
    return {"paper_id": paper_id or "workspace", "version": data.get("version"), "messages": [{k: r.get(k) for k in ("id", "role", "content", "time", "actions", "failed")} for r in rows]}


def open_stream(path: str, payload: dict[str, Any]):
    from research_notebook_mcp import STATE_FILE, LOCAL_HTTP
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    request = urllib.request.Request("http://127.0.0.1:" + str(int(state["port"])) + path, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers={"Authorization": "Bearer " + str(state["key"]), "Content-Type": "application/json; charset=utf-8", "X-Notebook-Request": "1"}, method="POST")
    return LOCAL_HTTP.open(request, timeout=180)


def run(task_id: str) -> None:
    from research_notebook_mcp import api_request
    job = load(task_id)
    if job["status"] != "queued":
        return
    job.update(status="running", phase="已连接科研助手")
    save(job)
    path = chat_path(job["paper_id"])
    done = False
    try:
        conversation = api_request("GET", path)
        payload = {"question": "[Claude 转交的任务]\n" + job["question"], "version": conversation["version"]}
        last_saved = time.monotonic()
        with open_stream(path, payload) as response:
            while True:
                line = response.readline(2_000_001)
                if not line:
                    break
                if len(line) > 2_000_000:
                    raise ValueError("助手单条响应过大，请缩小任务范围。")
                event = json.loads(line.decode("utf-8"))
                kind = event.get("type")
                if kind == "phase":
                    job["phase"] = str(event.get("text", ""))[:300]
                elif kind == "delta":
                    job["reply"] = (job["reply"] + str(event.get("text", "")))[:MAX_REPLY]
                elif kind == "tool_status":
                    job["phase"] = "正在调用：" + str(event.get("name", ""))
                    if len(job["tools"]) < 100:
                        job["tools"].append(event.get("name"))
                elif kind == "note_action" and len(job["actions"]) < 100:
                    job["actions"].append({k: v for k, v in event.items() if k != "type"})
                elif kind == "tool_error" and len(job["tool_errors"]) < 100:
                    job["tool_errors"].append(str(event.get("error", ""))[:2000])
                elif kind == "error":
                    raise ValueError(str(event.get("error") or "科研助手返回错误"))
                elif kind == "done":
                    message = event.get("message") or {}
                    job.update(status="completed", phase="科研助手已完成回复", reply=str(message.get("content", ""))[:MAX_REPLY], message_id=message.get("id"), model=message.get("model"), chat_version=event.get("version"), actions=message.get("actions", job["actions"])[:100])
                    if not job["reply"].strip():
                        raise ValueError("科研助手未生成有效回复。")
                    done = True
                    break
                if time.monotonic() - last_saved >= 1:
                    save(job)
                    last_saved = time.monotonic()
        if not done:
            raise ValueError("助手连接在完成回复前中断；已执行的操作保留在 actions 中。")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read(10000).decode("utf-8")).get("error", "")
        except (ValueError, UnicodeDecodeError):
            detail = ""
        job.update(status="failed", error=f"科研助手接口返回 {exc.code}：{detail}")
    except Exception as exc:
        job.update(status="failed", error=str(exc))
    save(job)


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--run":
    try:
        run(sys.argv[2])
    except Exception as exc:
        try:
            job = load(sys.argv[2])
            job.update(status="failed", phase="助手连接进程启动失败", error=str(exc))
            save(job)
        finally:
            print(f"Research assistant worker: {exc}", file=sys.stderr, flush=True)
