#!/usr/bin/env python3
"""
Local PinchBench runner with OpenClaw state-dir and new-session fixes.
"""
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pyyaml>=6.0.1",
# ]
# ///

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional
import shutil


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("pinchbench-local-runner")
OPENCLAW_BIN = os.environ.get("OPENCLAW_BIN", "openclaw.cmd" if os.name == "nt" else "openclaw")


def main() -> None:
    args = _parse_args()
    pinchbench_dir = Path(args.pinchbench_dir).resolve()
    scripts_dir = pinchbench_dir / "scripts"
    tasks_dir = pinchbench_dir / "tasks"

    if not scripts_dir.exists():
        raise SystemExit(f"PinchBench scripts directory not found: {scripts_dir}")
    if not tasks_dir.exists():
        raise SystemExit(f"PinchBench tasks directory not found: {tasks_dir}")

    sys.path.insert(0, str(scripts_dir))

    import lib_agent  # type: ignore
    import lib_grading  # type: ignore
    from lib_agent import ModelValidationError, cleanup_agent_sessions, ensure_agent_exists, slugify_model, validate_openrouter_model  # type: ignore
    from lib_grading import GradeResult, grade_task  # type: ignore
    from lib_tasks import Task, TaskLoader  # type: ignore

    _patch_lib_agent(lib_agent)
    _patch_lib_grading(lib_grading)

    task_loader = TaskLoader(tasks_dir)
    tasks: List[Task] = task_loader.load_all_tasks()
    task_ids = _select_task_ids(tasks, args.suite)
    tasks_to_run = tasks if task_ids is None else [task for task in tasks if task.task_id in task_ids]
    tasks_by_id = {task.task_id: task for task in tasks_to_run}

    model_slug = slugify_model(args.model)
    run_root = Path(args.output_dir).resolve()
    run_root.mkdir(parents=True, exist_ok=True)
    run_id = _next_run_id(run_root)
    agent_id = f"bench-{model_slug}"
    workspace_root = run_root / "_workspaces" / run_id
    workspace_root.mkdir(parents=True, exist_ok=True)
    os.environ["PINCHBENCH_WORKSPACE_ROOT"] = str(workspace_root)
    agent_workspace = workspace_root / "agent-home"

    try:
        validate_openrouter_model(args.model)
    except ModelValidationError as exc:
        logger.error("Model validation failed: %s", exc)
        raise SystemExit(1)

    ensure_agent_exists(agent_id, args.model, agent_workspace)
    _sync_agent_runtime_state(agent_id)
    cleanup_agent_sessions(agent_id)

    results: List[Dict[str, Any]] = []
    grades_by_task_id: Dict[str, Dict[str, Any]] = {}
    sanity_task_id = "task_00_sanity"
    runs_per_task = max(1, args.runs)

    for task_index, task in enumerate(tasks_to_run, 1):
        task_grades: List[GradeResult] = []
        task_results: List[Dict[str, Any]] = []

        for run_index in range(runs_per_task):
            logger.info("")
            logger.info("%s", "=" * 80)
            logger.info(
                "Task %s/%s (%s run %s/%s)",
                task_index,
                len(tasks_to_run),
                task.task_id,
                run_index + 1,
                runs_per_task,
            )
            logger.info("%s", "=" * 80)

            execution_error: Optional[str] = None
            try:
                result = execute_openclaw_task_local(
                    lib_agent=lib_agent,
                    task=task,
                    agent_id=agent_id,
                    model_id=args.model,
                    run_id=f"{run_id}-{run_index + 1}",
                    timeout_multiplier=args.timeout_multiplier,
                    skill_dir=pinchbench_dir,
                    verbose=args.verbose,
                )
            except Exception as exc:  # pragma: no cover - defensive fallback
                execution_error = "".join(traceback.format_exception(exc)).strip()
                logger.warning("Task execution failed for %s: %s", task.task_id, exc)
                result = {
                    "agent_id": agent_id,
                    "task_id": task.task_id,
                    "status": "error",
                    "transcript": [],
                    "usage": {},
                    "workspace": "",
                    "exit_code": -1,
                    "timed_out": False,
                    "execution_time": 0.0,
                    "stdout": "",
                    "stderr": execution_error,
                    "exception": execution_error,
                }

            try:
                grade_kwargs: Dict[str, Any] = {
                    "task": task,
                    "execution_result": result,
                    "skill_dir": pinchbench_dir,
                    "verbose": args.verbose,
                }
                if args.judge:
                    grade_kwargs["judge_model"] = args.judge
                grade = grade_task(**grade_kwargs)
            except Exception as exc:  # pragma: no cover - defensive fallback
                note = (
                    f"Execution failed: {execution_error}; Grading failed: {exc}"
                    if execution_error
                    else f"Grading failed: {exc}"
                )
                logger.warning("Task grading failed for %s: %s", task.task_id, exc)
                grade = GradeResult(
                    task_id=task.task_id,
                    score=0.0,
                    max_score=1.0,
                    grading_type=task.grading_type,
                    breakdown={},
                    notes=note,
                )

            task_grades.append(grade)
            task_results.append(result)
            results.append(result)

            score_pct = grade.score / grade.max_score * 100 if grade.max_score > 0 else 0
            status_label = "PASS" if grade.score >= grade.max_score else "PARTIAL" if grade.score > 0 else "FAIL"
            logger.info(
                "%s %s: %.1f/%.1f (%.0f%%) - %s",
                status_label,
                task.task_id,
                grade.score,
                grade.max_score,
                score_pct,
                grade.grading_type,
            )
            if grade.notes:
                logger.info("   Notes: %s", grade.notes[:200])

        task_scores = [grade.score for grade in task_grades]
        grades_by_task_id[task.task_id] = {
            "runs": [grade.to_dict() for grade in task_grades],
            "mean": statistics.mean(task_scores),
            "std": statistics.stdev(task_scores) if len(task_scores) > 1 else 0.0,
            "min": min(task_scores),
            "max": max(task_scores),
        }

        all_runs_missing_transcript = all(not run_result.get("transcript") for run_result in task_results)
        if (
            task.task_id == sanity_task_id
            and grades_by_task_id[task.task_id]["mean"] == 0.0
            and not args.no_fail_fast
            and not all_runs_missing_transcript
        ):
            logger.error("FAIL FAST: sanity task scored 0%%. Aborting run.")
            raise SystemExit(3)

    task_entries = [
        {
            "task_id": result["task_id"],
            "status": result["status"],
            "timed_out": result["timed_out"],
            "execution_time": result["execution_time"],
            "transcript_length": len(result["transcript"]),
            "usage": result.get("usage", {}),
            "workspace": result["workspace"],
            "exit_code": result.get("exit_code"),
            "stdout": result.get("stdout", ""),
            "stderr": result.get("stderr", ""),
            "exception": result.get("exception", ""),
            "grading": grades_by_task_id[result["task_id"]],
            "frontmatter": tasks_by_id[result["task_id"]].frontmatter,
        }
        for result in results
    ]

    efficiency = _compute_efficiency_summary(task_entries, grades_by_task_id)
    aggregate = {
        "model": args.model,
        "benchmark_version": _get_git_version(pinchbench_dir),
        "run_id": run_id,
        "timestamp": time.time(),
        "suite": args.suite,
        "runs_per_task": runs_per_task,
        "tasks": task_entries,
        "efficiency": efficiency,
    }

    output_path = run_root / f"{run_id}_{model_slug}.json"
    output_path.write_text(json.dumps(aggregate, indent=2), encoding="utf-8")
    logger.info("Saved results to %s", output_path)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local PinchBench runner with OpenClaw fixes")
    parser.add_argument("--pinchbench-dir", required=True, help="Path to the PinchBench skill checkout")
    parser.add_argument("--model", required=True, help="Model identifier")
    parser.add_argument("--suite", default="all", help='Task selection: "all", "automated-only", or comma-separated IDs')
    parser.add_argument("--output-dir", required=True, help="Results directory")
    parser.add_argument("--timeout-multiplier", type=float, default=1.0, help="Scale task timeouts")
    parser.add_argument("--runs", type=int, default=1, help="Number of runs per task")
    parser.add_argument("--judge", default=None, help="Judge model")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")
    parser.add_argument("--no-fail-fast", action="store_true", help="Continue even if sanity task scores 0")
    parser.add_argument("--no-upload", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def _patch_lib_agent(lib_agent: Any) -> None:
    original_subprocess_run = lib_agent.subprocess.run

    def patched_subprocess_run(args: Any, *run_args: Any, **run_kwargs: Any) -> Any:
        if run_kwargs.get("text") is True:
            run_kwargs.setdefault("encoding", "utf-8")
            run_kwargs.setdefault("errors", "replace")
        result = original_subprocess_run(_rewrite_openclaw_args(args), *run_args, **run_kwargs)
        if hasattr(result, "stdout"):
            result.stdout = _coerce_subprocess_output(getattr(result, "stdout", ""))
        if hasattr(result, "stderr"):
            result.stderr = _coerce_subprocess_output(getattr(result, "stderr", ""))
        return result

    def patched_get_agent_store_dir(agent_id: str) -> Path:
        state_root = os.environ.get("OPENCLAW_STATE_DIR")
        if state_root:
            base_dir = Path(state_root).expanduser().resolve() / "agents"
        else:
            base_dir = Path.home() / ".openclaw" / "agents"

        normalized_id = agent_id.replace(":", "-").lower()
        direct_dir = base_dir / agent_id
        if direct_dir.exists():
            return direct_dir
        normalized_dir = base_dir / normalized_id
        if normalized_dir.exists():
            return normalized_dir
        return direct_dir

    def patched_prepare_task_workspace(skill_dir: Path, run_id: str, task: Any, agent_id: str) -> Path:
        workspace_root = Path(
            os.environ.get("PINCHBENCH_WORKSPACE_ROOT")
            or (Path(tempfile.gettempdir()) / "pinchbench-workspaces")
        ).expanduser().resolve()
        workspace = workspace_root / task.task_id / f"{run_id}-{int(time.time() * 1000)}"
        if workspace.exists():
            shutil.rmtree(workspace, ignore_errors=True)
        workspace.mkdir(parents=True, exist_ok=True)

        for file_spec in task.workspace_files:
            if "content" in file_spec:
                dest = workspace / file_spec["path"]
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(file_spec["content"], encoding="utf-8")
                continue

            source = skill_dir / "assets" / file_spec["source"]
            dest = workspace / file_spec["dest"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(source.read_bytes())

        for bootstrap_file in ("BOOTSTRAP.md", "SOUL.md", "USER.md", "IDENTITY.md"):
            bootstrap_path = workspace / bootstrap_file
            if bootstrap_path.exists():
                try:
                    bootstrap_path.unlink()
                except OSError as exc:
                    logger.warning("Failed to remove %s from benchmark workspace: %s", bootstrap_file, exc)

        state_root = os.environ.get("OPENCLAW_STATE_DIR")
        source_skills_dir: Optional[Path] = None
        if state_root:
            state_root_path = Path(state_root).expanduser().resolve()
            candidate = state_root_path / "workspace" / "skills"
            if candidate.exists():
                source_skills_dir = candidate

        if source_skills_dir is None:
            fallback = Path.home() / ".openclaw" / "workspace" / "skills"
            if fallback.exists():
                source_skills_dir = fallback

        if source_skills_dir is None:
            return workspace

        dest_skills_dir = workspace / "skills"
        dest_skills_dir.mkdir(parents=True, exist_ok=True)
        for skill_src in source_skills_dir.iterdir():
            if not skill_src.is_dir():
                continue
            dest_skill_dir = dest_skills_dir / skill_src.name
            if dest_skill_dir.exists():
                shutil.rmtree(dest_skill_dir, ignore_errors=True)
            shutil.copytree(skill_src, dest_skill_dir)
        return workspace

    lib_agent.subprocess.run = patched_subprocess_run
    lib_agent._get_agent_store_dir = patched_get_agent_store_dir
    lib_agent.prepare_task_workspace = patched_prepare_task_workspace


def _patch_lib_grading(lib_grading: Any) -> None:
    original_ensure_judge_agent = lib_grading._ensure_judge_agent

    def patched_ensure_judge_agent(
        judge_agent_prefix: str,
        judge_model: str,
        skill_dir: Path,
    ) -> str:
        agent_id = original_ensure_judge_agent(judge_agent_prefix, judge_model, skill_dir)
        _sync_agent_runtime_state(agent_id)
        return agent_id

    lib_grading._ensure_judge_agent = patched_ensure_judge_agent


def _sync_agent_runtime_state(agent_id: str) -> None:
    state_root = os.environ.get("OPENCLAW_STATE_DIR")
    if not state_root:
        return

    destination_root = Path(state_root).expanduser().resolve() / "agents" / agent_id
    if not destination_root.exists():
        normalized = agent_id.replace(":", "-").lower()
        candidate = Path(state_root).expanduser().resolve() / "agents" / normalized
        destination_root = candidate if candidate.exists() else destination_root

    destination_agent_dir = destination_root / "agent"
    destination_agent_dir.mkdir(parents=True, exist_ok=True)

    source_override = os.environ.get("OPENCLAW_SOURCE_MAIN_AGENT_DIR")
    source_agent_dir = Path(source_override).expanduser().resolve() if source_override else Path.home() / ".openclaw" / "agents" / "main" / "agent"
    if not source_agent_dir.exists():
        return

    for filename in ("auth-profiles.json", "models.json"):
        source_path = source_agent_dir / filename
        destination_path = destination_agent_dir / filename
        if not source_path.exists():
            continue
        destination_path.write_bytes(source_path.read_bytes())


def execute_openclaw_task_local(
    *,
    lib_agent: Any,
    task: Any,
    agent_id: str,
    model_id: str,
    run_id: str,
    timeout_multiplier: float,
    skill_dir: Path,
    verbose: bool = False,
) -> Dict[str, Any]:
    logger.info("Agent [%s] starting task: %s", agent_id, task.task_id)
    logger.info("   Task: %s", task.name)
    logger.info("   Category: %s", task.category)
    if verbose:
        preview = task.prompt[:500] + "..." if len(task.prompt) > 500 else task.prompt
        logger.info("   Prompt: %s", preview)

    lib_agent.cleanup_agent_sessions(agent_id)

    start_time = time.time()
    workspace = lib_agent.prepare_task_workspace(skill_dir, run_id, task, agent_id)
    lib_agent.ensure_agent_exists(agent_id, model_id, workspace)
    _sync_agent_runtime_state(agent_id)
    lib_agent.cleanup_agent_sessions(agent_id)
    timeout_seconds = task.timeout_seconds * timeout_multiplier
    stdout_parts: List[str] = []
    stderr_parts: List[str] = []
    exit_code = -1
    timed_out = False

    sessions = task.frontmatter.get("sessions", [])
    session_order: List[str] = []
    session_transcripts: Dict[str, List[Dict[str, Any]]] = {}
    session_started_at: Dict[str, float] = {}
    current_session_id: Optional[str] = None
    base_session_id = f"{task.task_id}_{int(time.time() * 1000)}"

    if sessions:
        logger.info("   Multi-session task with %d session prompts", len(sessions))
        for session_index, session_entry in enumerate(sessions, 1):
            session_prompt = _extract_session_prompt(session_entry)
            if not session_prompt:
                logger.warning("   Skipping empty session prompt at index %d", session_index)
                continue

            starts_new_session = _session_requires_new_session(session_entry)
            if starts_new_session and current_session_id is not None:
                logger.info("   Resetting stored OpenClaw sessions before fresh session prompt")
                lib_agent.cleanup_agent_sessions(agent_id)

            if current_session_id is None or starts_new_session:
                label = _session_label(session_entry, session_index)
                current_session_id = f"{base_session_id}_{label}"
                session_order.append(current_session_id)
                session_started_at[current_session_id] = time.time()
                if starts_new_session:
                    logger.info("   Session %d/%d starts a fresh OpenClaw session", session_index, len(sessions))
                else:
                    logger.info("   Session %d/%d starts the initial OpenClaw session", session_index, len(sessions))
            else:
                logger.info("   Session %d/%d continues the current OpenClaw session", session_index, len(sessions))

            elapsed = time.time() - start_time
            remaining = timeout_seconds - elapsed
            if remaining <= 0:
                timed_out = True
                break

            result = _run_openclaw_prompt(
                agent_id=agent_id,
                session_id=current_session_id,
                prompt=session_prompt,
                workspace=workspace,
                timeout_seconds=remaining,
            )
            stdout_parts.append(result["stdout"])
            stderr_parts.append(result["stderr"])
            exit_code = result["exit_code"]
            if result["timed_out"]:
                timed_out = True
                break
            session_transcripts[current_session_id] = lib_agent._load_transcript(
                agent_id,
                current_session_id,
                session_started_at[current_session_id],
            )
            if exit_code not in (0, -1):
                break
    else:
        current_session_id = base_session_id
        session_order.append(current_session_id)
        session_started_at[current_session_id] = time.time()
        result = _run_openclaw_prompt(
            agent_id=agent_id,
            session_id=current_session_id,
            prompt=task.prompt,
            workspace=workspace,
            timeout_seconds=timeout_seconds,
        )
        stdout_parts.append(result["stdout"])
        stderr_parts.append(result["stderr"])
        exit_code = result["exit_code"]
        timed_out = result["timed_out"]
        session_transcripts[current_session_id] = lib_agent._load_transcript(
            agent_id,
            current_session_id,
            session_started_at[current_session_id],
        )

    transcript: List[Dict[str, Any]] = []
    for session_id in session_order:
        transcript.extend(session_transcripts.get(session_id, []))

    transcript = _normalize_transcript_for_grading(transcript, workspace)
    _normalize_workspace_text_encodings(workspace)
    usage = _extract_usage_from_transcript_safe(transcript)
    execution_time = time.time() - start_time
    stdout = "".join(stdout_parts)
    stderr = "".join(stderr_parts)

    status = "success"
    if timed_out:
        status = "timeout"
    if not transcript:
        status = "error"
    if exit_code not in (0, -1) and not timed_out:
        status = "error"
    if stderr and "openclaw command not found" in str(stderr):
        status = "error"

    return {
        "agent_id": agent_id,
        "task_id": task.task_id,
        "status": status,
        "transcript": transcript,
        "usage": usage,
        "workspace": str(workspace),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "execution_time": execution_time,
        "stdout": stdout,
        "stderr": stderr,
        "model_id": model_id,
    }


def _normalize_workspace_text_encodings(workspace: Path) -> None:
    text_suffixes = {
        ".gitignore",
        ".md",
        ".txt",
        ".py",
        ".json",
        ".yml",
        ".yaml",
        ".toml",
        ".csv",
        ".ics",
    }

    for path in workspace.rglob("*"):
        if not path.is_file():
            continue
        suffix = path.suffix.lower()
        name = path.name.lower()
        if suffix not in text_suffixes and name not in {".gitignore"}:
            continue
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        if len(raw) == 0 or len(raw) > 1_000_000:
            continue

        decoded: Optional[str] = None
        if raw.startswith(b"\xff\xfe"):
            try:
                decoded = raw[2:].decode("utf-16-le")
            except UnicodeDecodeError:
                decoded = None
        elif raw.startswith(b"\xfe\xff"):
            try:
                decoded = raw[2:].decode("utf-16-be")
            except UnicodeDecodeError:
                decoded = None

        if decoded is None:
            continue

        try:
            path.write_text(decoded, encoding="utf-8")
        except OSError:
            continue


def _normalize_transcript_for_grading(
    transcript: List[Dict[str, Any]],
    workspace: Path,
) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for event in transcript:
        if event.get("type") != "message":
            normalized.append(event)
            continue

        message = event.get("message")
        if not isinstance(message, dict):
            normalized.append(event)
            continue

        content = message.get("content")
        if not isinstance(content, list):
            normalized.append(event)
            continue

        normalized_items = [_normalize_content_item(item, workspace) for item in content]
        normalized_event = dict(event)
        normalized_message = dict(message)
        normalized_message["content"] = normalized_items
        normalized_event["message"] = normalized_message
        normalized.append(normalized_event)
    return normalized


def _normalize_content_item(item: Any, workspace: Path) -> Any:
    if not isinstance(item, dict) or item.get("type") != "toolCall":
        return item

    normalized_item = dict(item)
    arguments = item.get("arguments")
    params = item.get("params")
    normalized_arguments = dict(arguments) if isinstance(arguments, dict) else {}
    normalized_params = dict(params) if isinstance(params, dict) else dict(normalized_arguments)
    normalized_name = str(item.get("name", ""))

    if normalized_name == "read":
        normalized_name = "read_file"
        if "files" not in normalized_params:
            files = _extract_tool_paths(normalized_arguments or normalized_params, workspace)
            if files:
                normalized_params["files"] = files
    elif normalized_name == "write":
        normalized_name = "write_file"
        if "file" not in normalized_params:
            files = _extract_tool_paths(normalized_arguments or normalized_params, workspace)
            if files:
                normalized_params["file"] = files[0]
    elif normalized_name == "exec":
        if "command" not in normalized_params and "command" in normalized_arguments:
            normalized_params["command"] = normalized_arguments["command"]

    normalized_item["name"] = normalized_name
    normalized_item["arguments"] = normalized_arguments
    normalized_item["params"] = normalized_params
    return normalized_item


def _extract_tool_paths(payload: Dict[str, Any], workspace: Path) -> List[str]:
    raw_paths: List[Any] = []
    for key in ("files", "paths", "path", "file"):
        value = payload.get(key)
        if value is None:
            continue
        if isinstance(value, list):
            raw_paths.extend(value)
        else:
            raw_paths.append(value)

    normalized_paths: List[str] = []
    for raw_path in raw_paths:
        if not isinstance(raw_path, str) or not raw_path.strip():
            continue
        normalized_paths.append(_normalize_tool_path(raw_path, workspace))
    return normalized_paths


def _normalize_tool_path(path_value: str, workspace: Path) -> str:
    try:
        candidate = Path(path_value)
        workspace_resolved = workspace.resolve()
        if candidate.is_absolute():
            resolved = candidate.resolve()
            try:
                relative = resolved.relative_to(workspace_resolved)
            except ValueError:
                return str(resolved)
            return str(relative).replace("\\", "/")
        return str(candidate).replace("\\", "/")
    except OSError:
        return path_value.replace("\\", "/")


def _extract_usage_from_transcript_safe(transcript: List[Dict[str, Any]]) -> Dict[str, Any]:
    totals = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 0,
        "cost_usd": 0.0,
        "request_count": 0,
        "estimated": False,
    }

    for entry in transcript:
        if entry.get("type") != "message":
            continue
        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue

        totals["request_count"] += 1
        usage = message.get("usage")
        if not isinstance(usage, dict):
            usage = {}
        cost = usage.get("cost")
        if not isinstance(cost, dict):
            cost = {}

        totals["input_tokens"] += _safe_int(usage.get("input"))
        totals["output_tokens"] += _safe_int(usage.get("output"))
        totals["cache_read_tokens"] += _safe_int(usage.get("cacheRead"))
        totals["cache_write_tokens"] += _safe_int(usage.get("cacheWrite"))
        totals["total_tokens"] += _safe_int(usage.get("totalTokens"))
        totals["cost_usd"] += _safe_float(cost.get("total"))

    if totals["total_tokens"] == 0 and transcript:
        estimated_input = 0
        estimated_output = 0
        for entry in transcript:
            if entry.get("type") != "message":
                continue
            message = entry.get("message")
            if not isinstance(message, dict):
                continue
            role = str(message.get("role", ""))
            content_text = _stringify_content_for_estimate(message.get("content"))
            if not content_text:
                continue
            token_estimate = _estimate_token_count(content_text)
            if role == "assistant":
                estimated_output += token_estimate
            elif role in ("user", "toolResult"):
                estimated_input += token_estimate

        if estimated_input > 0 or estimated_output > 0:
            totals["input_tokens"] = estimated_input
            totals["output_tokens"] = estimated_output
            totals["total_tokens"] = estimated_input + estimated_output
            totals["estimated"] = True

    return totals


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _safe_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _stringify_content_for_estimate(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [_stringify_content_for_estimate(item) for item in content]
        return "\n".join(part for part in parts if part)
    if isinstance(content, dict):
        item_type = content.get("type")
        if item_type == "text":
            return str(content.get("text", ""))
        if item_type == "thinking":
            return str(content.get("thinking", ""))
        if item_type == "toolCall":
            return json.dumps({
                "name": content.get("name"),
                "arguments": content.get("arguments") or content.get("params") or {},
            }, ensure_ascii=False)
        if item_type == "toolResult":
            return str(content.get("text", ""))
        if "text" in content:
            return str(content.get("text", ""))
    return ""


def _estimate_token_count(text: str) -> int:
    normalized = text.strip()
    if not normalized:
        return 0
    return max(1, round(len(normalized) / 4))


def _run_openclaw_prompt(
    *,
    agent_id: str,
    session_id: str,
    prompt: str,
    workspace: Path,
    timeout_seconds: float,
) -> Dict[str, Any]:
    stdout = ""
    stderr = ""
    exit_code = -1
    timed_out = False
    chunks = _chunk_openclaw_prompt(prompt)
    started_at = time.time()
    for chunk in chunks:
        remaining = max(1.0, timeout_seconds - (time.time() - started_at))
        try:
            result = subprocess.run(
                _rewrite_openclaw_args([
                    "openclaw",
                    "agent",
                    "--agent",
                    agent_id,
                    "--session-id",
                    session_id,
                    "--message",
                    chunk,
                ]),
                capture_output=True,
                text=True,
                cwd=str(workspace),
                timeout=remaining,
                check=False,
            )
            stdout += _coerce_subprocess_output(result.stdout)
            stderr += _coerce_subprocess_output(result.stderr)
            exit_code = result.returncode
            if result.returncode not in (0, -1):
                break
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            stdout += _coerce_subprocess_output(exc.stdout)
            stderr += _coerce_subprocess_output(exc.stderr)
            break
        except FileNotFoundError as exc:
            stderr += f"openclaw command not found: {exc}"
            break

    return {
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": exit_code,
        "timed_out": timed_out,
    }


def _chunk_openclaw_prompt(prompt: str) -> List[str]:
    sanitized = re.sub(r"\s+", " ", prompt).strip()
    if not sanitized:
        return [""]

    max_chars = 3000
    parts = [sanitized[i : i + max_chars] for i in range(0, len(sanitized), max_chars)]
    if len(parts) == 1:
        return parts

    total_parts = len(parts)
    wrapped_parts: List[str] = []
    for index, part in enumerate(parts, 1):
        if index < total_parts:
            wrapped_parts.append(
                f"You are receiving a long prompt in {total_parts} parts. Ignore and do not respond until the final part. Part {index}/{total_parts}: {part}"
            )
        else:
            wrapped_parts.append(
                f"Part {index}/{total_parts} (final). All parts received. Proceed with the full request now. {part}"
            )
    return wrapped_parts


def _extract_session_prompt(session_entry: Any) -> str:
    if isinstance(session_entry, str):
        return session_entry
    if isinstance(session_entry, dict):
        value = session_entry.get("prompt") or session_entry.get("message") or ""
        return value if isinstance(value, str) else ""
    return ""


def _session_requires_new_session(session_entry: Any) -> bool:
    return isinstance(session_entry, dict) and session_entry.get("new_session") is True


def _session_label(session_entry: Any, session_index: int) -> str:
    if isinstance(session_entry, dict):
        raw = session_entry.get("id")
        if isinstance(raw, str) and raw.strip():
            return raw.strip().replace(" ", "_")
    return f"session_{session_index}"


def _compute_efficiency_summary(
    task_entries: List[Dict[str, Any]],
    grades_by_task_id: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    total_input_tokens = 0
    total_output_tokens = 0
    total_tokens = 0
    total_cost_usd = 0.0
    total_requests = 0
    total_execution_time = 0.0
    tasks_with_usage = 0

    for entry in task_entries:
        usage = entry.get("usage", {})
        inp = int(usage.get("input_tokens", 0))
        out = int(usage.get("output_tokens", 0))
        tot = int(usage.get("total_tokens", 0))
        cost = float(usage.get("cost_usd", 0.0) or 0.0)
        reqs = int(usage.get("request_count", 0))
        exec_time = float(entry.get("execution_time", 0.0) or 0.0)

        total_input_tokens += inp
        total_output_tokens += out
        total_tokens += tot
        total_cost_usd += cost
        total_requests += reqs
        total_execution_time += exec_time
        if tot > 0:
            tasks_with_usage += 1

    all_scores = [float(g.get("mean", 0.0)) for g in grades_by_task_id.values()]
    total_score = sum(all_scores)
    num_tasks = len(all_scores)

    return {
        "total_tokens": total_tokens,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "total_cost_usd": round(total_cost_usd, 6),
        "total_requests": total_requests,
        "total_execution_time_seconds": round(total_execution_time, 2),
        "tasks_with_usage_data": tasks_with_usage,
        "tokens_per_task": round(total_tokens / num_tasks, 1) if num_tasks > 0 else 0,
        "cost_per_task_usd": round(total_cost_usd / num_tasks, 6) if num_tasks > 0 else 0,
        "score_per_1k_tokens": round(total_score / (total_tokens / 1000), 6) if total_tokens > 0 else None,
        "score_per_dollar": round(total_score / total_cost_usd, 4) if total_cost_usd > 0 else None,
    }


def _next_run_id(run_root: Path) -> str:
    existing = []
    for entry in run_root.iterdir():
        prefix = entry.stem.split("_", 1)[0] if entry.is_file() else entry.name
        if prefix.isdigit():
            existing.append(int(prefix))
    next_id = (max(existing) + 1) if existing else 1
    return f"{next_id:04d}"


def _select_task_ids(tasks: List[Any], suite: str) -> Optional[List[str]]:
    if suite == "all":
        return None
    if suite == "automated-only":
        return [task.task_id for task in tasks if task.grading_type == "automated"]
    return [task_id.strip() for task_id in suite.split(",") if task_id.strip()]


def _get_git_version(root: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
            cwd=root,
        )
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def _coerce_subprocess_output(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _rewrite_openclaw_args(args: Any) -> Any:
    if isinstance(args, list) and args and args[0] == "openclaw":
        return [OPENCLAW_BIN, *args[1:]]
    if isinstance(args, tuple) and args and args[0] == "openclaw":
        return (OPENCLAW_BIN, *args[1:])
    return args


if __name__ == "__main__":
    main()
