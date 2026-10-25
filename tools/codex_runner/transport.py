"""Subprocess transport; callers own model instructions and task contracts."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
from typing import Any, Sequence


def terminate(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=10,
                       creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS)
    else:
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=10)


def execute(arguments, *, prompt, timeout_seconds, work_dir=None, env=None,
            stdout_path=None, stderr_path=None, low_priority=False, encoding_errors="replace") -> subprocess.CompletedProcess:
    with ExitStack() as files:
        stdout = files.enter_context(Path(stdout_path).open("w", encoding="utf-8")) if stdout_path is not None else subprocess.PIPE
        stderr = files.enter_context(Path(stderr_path).open("w", encoding="utf-8")) if stderr_path is not None else subprocess.PIPE
        process = subprocess.Popen(
            arguments, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
            text=True, encoding="utf-8", errors=encoding_errors, cwd=work_dir, env=env,
            creationflags=subprocess.IDLE_PRIORITY_CLASS if low_priority and os.name == "nt" else 0,
            start_new_session=os.name != "nt",
        )
        try:
            output, errors = process.communicate(prompt, timeout=timeout_seconds)
        except BaseException:
            terminate(process)
            raise
    return subprocess.CompletedProcess(arguments, process.returncode, output, errors)


def invoke(
    *,
    prompt: str,
    schema_path: Path,
    image_paths: list[Path],
    model: str,
    effort: str,
    work_dir: Path,
    timeout_seconds: int,
    extra_args: Sequence[str] = (),
    instructions: str = "",
    cache_key: str | None = None,
) -> dict[str, Any]:
    # codex exec takes its instructions from extra_args and keys its cache by its own session, so
    # instructions and cache_key have no use here.
    executable = os.environ.get("CODEX_EXEC_COMMAND", "").strip() or shutil.which("codex")
    if not executable:
        raise RuntimeError("codex executable was not found on PATH")
    if os.name == "nt" and not os.environ.get("CODEX_EXEC_COMMAND") and Path(executable).suffix.lower() in (".cmd", ".bat"):
        # Invoke the bundled CLI directly so timeout/cancellation owns the model process.
        package = Path(executable).parent / "node_modules/@openai/codex"
        native = list(package.glob("node_modules/@openai/codex-win32-*/vendor/*/bin/codex.exe"))
        if len(native) == 1:
            executable = str(native[0])
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
        # Relative to the call's working directory, so a call with many pages fits the Windows
        # command line (8,191 characters through the npm shim).
        try: image_path = os.path.relpath(image_path, work_dir)
        except ValueError: pass  # another drive
        arguments.extend(["--image", str(image_path)])
    arguments.append("-")
    # Keep events observable during long composition calls, not only after exit.
    events_path = work_dir / "events.jsonl"
    stderr_path = work_dir / "stderr.log"
    result = execute(arguments, prompt=prompt, timeout_seconds=timeout_seconds, work_dir=work_dir,
                     stdout_path=events_path, stderr_path=stderr_path, low_priority=True)
    if result.returncode != 0:
        stdout = events_path.read_text(encoding="utf-8", errors="replace")
        stderr = stderr_path.read_text(encoding="utf-8", errors="replace")
        message = "\n".join((stderr.strip(), stdout.strip()))
        raise RuntimeError(
            f"codex exec exited with {result.returncode}: {message[-2000:]}"
        )
    if not output_path.is_file():
        raise RuntimeError("codex exec did not write its final response")
    try:
        response = json.loads(output_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"codex response is not valid JSON: {exc}") from exc
    return response
