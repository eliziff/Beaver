"""Codex exec transport, reused from legalpdf.codex_repair.

Local corpus callers own prompts, validation, retries and retained receipts.
"""
import json
import gzip
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
from typing import Any, Sequence

def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _atomic_json(path: Path, value: Any) -> None:
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    _atomic_write(path, gzip.compress(data, mtime=0) if path.suffix == ".gz" else data)

def _codex_command() -> str | None:
    return os.environ.get("CODEX_EXEC_COMMAND", "").strip() or shutil.which(
        "codex"
    )


def _terminate(process):
    if process.poll() is not None: return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=10,
                       creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS)
    else:
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=10)

def _invoke(
    *,
    prompt: str,
    schema_path: Path,
    image_paths: list[Path],
    model: str,
    effort: str,
    work_dir: Path,
    timeout_seconds: int,
    extra_args: Sequence[str] = (),
) -> dict[str, Any]:
    executable = _codex_command()
    if not executable:
        raise RuntimeError("codex executable was not found on PATH")
    output_path = work_dir / "last-message.json"
    output_path.unlink(missing_ok=True)
    arguments = [
        executable,
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        model,
        "-c",
        f"model_reasoning_effort={json.dumps(effort)}",
        "--output-last-message",
        str(output_path),
        "--color",
        "never",
        "--json",
    ]
    arguments.extend(extra_args)
    arguments.extend(["--output-schema", str(schema_path)])
    for image_path in image_paths:
        arguments.extend(["--image", str(image_path)])
    arguments.append("-")
    # Keep events observable during long composition calls, not only after exit.
    events_path = work_dir / "events.jsonl"
    stderr_path = work_dir / "stderr.log"
    with events_path.open("w", encoding="utf-8") as events, stderr_path.open("w", encoding="utf-8") as errors:
        process = subprocess.Popen(
            arguments, stdin=subprocess.PIPE, stdout=events, stderr=errors,
            text=True, encoding="utf-8", errors="replace", cwd=work_dir,
            creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 0,
            start_new_session=os.name != "nt",
        )
        try:
            process.communicate(prompt, timeout=timeout_seconds)
        except BaseException:
            _terminate(process)
            raise
    if process.returncode != 0:
        stdout = events_path.read_text(encoding="utf-8", errors="replace")
        stderr = stderr_path.read_text(encoding="utf-8", errors="replace")
        message = "\n".join((stderr.strip(), stdout.strip()))
        raise RuntimeError(
            f"codex exec exited with {process.returncode}: {message[-2000:]}"
        )
    if not output_path.is_file():
        raise RuntimeError("codex exec did not write its final response")
    try:
        response = json.loads(output_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"codex response is not valid JSON: {exc}") from exc
    return response
