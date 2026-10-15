"""Cached, metered model calls with task-owned validation and retry policy."""
from dataclasses import dataclass
import gzip
import hashlib
import json
import time
from typing import Any, Callable

from .artifacts import atomic_json, atomic_write, digest, fingerprint, read_json
from .transport import invoke


@dataclass
class CallPolicy:
    instructions: str
    config: dict
    retry_prompt: Callable[[str, str, Any], str]
    retry_error: Callable[[Exception, Any], str | None]
    failure_message: str
    validate_schema: bool = True


class AttemptsExhausted(ValueError):
    def __init__(self, message, error):
        self.error = error
        super().__init__(message + error)


def event_usage(path):
    totals = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") not in ("turn.completed", "turn.failed") or not isinstance(event.get("usage"), dict):
                continue
            for key, value in event["usage"].items():
                if type(value) is int and value >= 0 and "tokens" in key:
                    totals[key] = totals.get(key, 0) + value
    if "input_tokens" in totals and "output_tokens" in totals and "total_tokens" not in totals:
        totals["total_tokens"] = totals["input_tokens"] + totals["output_tokens"]
    return totals


def call_key(prompt, schema, images, args, policy):
    """The exact identity used for a cached task call."""
    return fingerprint({"prompt": prompt, "schema": schema, "instructions": policy.instructions, "config": policy.config,
                        "images": [digest(p) for p in images], "model": args.model, "effort": args.effort})


def call(prompt, schema_path, images, directory, args, validate, dispatch=invoke, budget=None, *, policy, reuse=True):
    schema_path = schema_path.resolve()
    schema = read_json(schema_path)
    key = call_key(prompt, schema, images, args, policy)
    directory = directory / key[:16]
    directory.mkdir(parents=True, exist_ok=True)
    receipt_path = directory / "receipt.json"
    receipt = read_json(receipt_path) if receipt_path.is_file() else {"key": key, "attempts": []}
    if receipt["key"] != key:
        raise ValueError("Call-cache hash collision")
    validator = None
    if policy.validate_schema:
        from jsonschema import Draft202012Validator
        validator = Draft202012Validator(schema)
    response_path = directory / "response.json"
    error = ""
    previous = None
    cached_rejected = False
    if reuse and response_path.is_file() and receipt.get("response_sha256") == digest(response_path):
        response = read_json(response_path)
        try:
            if validator is not None:
                validator.validate(response)
            return validate(response)
        except Exception as exc:
            error = policy.retry_error(exc, response)
            if error is None:
                raise
            previous = response
            cached_rejected = True
            receipt.setdefault("cache_rejections", []).append({
                "response_sha256": digest(response_path), "error": error, "rejected_at": time.time()})
            atomic_json(receipt_path, receipt)
    instructions = directory / "instructions.md"
    instructions.write_text(policy.instructions, encoding="utf-8")
    # A failure its policy would not retry (for example a defect another operation must fix)
    # is not feedback for the next prompt.
    if reuse and receipt["attempts"] and not cached_rejected and receipt["attempts"][-1].get("retryable", True):
        last = receipt["attempts"][-1]
        error = last.get("error", "")
        rejected = directory / f"attempt-{len(receipt['attempts'])}" / "last-message.json"
        if rejected.is_file():
            try:
                previous = read_json(rejected)
            except ValueError:
                pass
    for _ in range(args.attempts):
        if budget is not None:
            if args.max_calls is not None and budget["calls"] >= args.max_calls:
                raise ValueError("Model-call limit reached")
            budget["calls"] += 1
        work = directory / f"attempt-{len(receipt['attempts']) + 1}"
        work.mkdir()
        actual_prompt = policy.retry_prompt(prompt, error, previous)
        atomic_write(work / "prompt.txt.gz", gzip.compress(actual_prompt.encode(), mtime=0))
        extra = ["--ignore-rules", "-c", "model_instructions_file=" + json.dumps(instructions.resolve().as_posix())]
        for name, value in policy.config.items():
            extra.extend(["-c", name + "=" + json.dumps(value)])
        attempt = {"prompt_sha256": hashlib.sha256(actual_prompt.encode()).hexdigest(), "schema_sha256": digest(schema_path),
                   "image_sha256s": [digest(p) for p in images], "model": args.model, "effort": args.effort,
                   "started_at": time.time(), "status": "running", "usage": {}, "usage_reported": False, "seconds": 0}
        receipt["attempts"].append(attempt)
        atomic_json(receipt_path, receipt)
        started = time.perf_counter()
        response = None
        try:
            response = dispatch(prompt=actual_prompt, schema_path=schema_path, image_paths=images,
                                model=args.model, effort=args.effort, work_dir=work.resolve(),
                                timeout_seconds=args.timeout, extra_args=extra)
            previous = response
            if validator is not None:
                validator.validate(response)
            product = validate(response)
            atomic_json(response_path, response)
            receipt["response_sha256"] = digest(response_path)
            attempt["status"] = "complete"
            return product
        except Exception as exc:
            error = policy.retry_error(exc, response)
            if error is None:
                attempt.update(status="failed", error=str(exc) or type(exc).__name__, retryable=False)
                raise
            attempt.update(status="failed", error=error)
        except BaseException as exc:
            attempt.update(status="failed", error=str(exc))
            raise
        finally:
            attempt["usage"] = event_usage(work / "events.jsonl")
            attempt.update(usage_reported=bool(attempt["usage"]), seconds=round(time.perf_counter() - started, 4))
            for name in ("events.jsonl", "stderr.log"):
                path = work / name
                if path.is_file():
                    atomic_write(work / (name + ".gz"), gzip.compress(path.read_bytes(), mtime=0))
                    path.unlink()
            atomic_json(receipt_path, receipt)
        print("Retrying rejected output: " + error, flush=True)
    raise AttemptsExhausted(policy.failure_message, error)


def usage_totals(job):
    usage, attempts, unreported, seconds = {}, 0, 0, 0
    for path in (job / "calls").glob("*/*/receipt.json"):
        for attempt in read_json(path)["attempts"]:
            attempts += 1
            seconds += attempt["seconds"]
            unreported += not attempt["usage_reported"]
            for key, value in attempt["usage"].items():
                usage[key] = usage.get(key, 0) + value
    return {"attempts": attempts, "usage": usage, "usage_unreported_attempts": unreported, "call_seconds": round(seconds, 4)}
