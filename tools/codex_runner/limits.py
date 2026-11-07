"""The ChatGPT account's Codex usage limits, as the Codex CLI reads them (`codex app-server`,
JSON-RPC over stdio: initialize, then account/rateLimits/read)."""
import json
import shutil
import subprocess


def _codex():
    return shutil.which("codex.cmd") or shutil.which("codex") or "codex"


def rate_limits(timeout=60):
    """The account/rateLimits/read result: the rate-limit windows with their used percent and resets."""
    proc = subprocess.Popen([_codex(), "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
    try:
        def send(message):
            proc.stdin.write(json.dumps(message) + "\n"); proc.stdin.flush()

        def answer(request_id):
            for line in proc.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(f"codex app-server: {message['error']}")
                    return message.get("result")
            raise RuntimeError("codex app-server closed without answering")

        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "codex_runner", "version": "1"}}})
        answer(1)
        send({"jsonrpc": "2.0", "method": "initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read"})
        return answer(2)
    finally:
        proc.kill()


def used_percent(limits):
    """The highest used percent across the windows (the binding limit)."""
    best = 0.0
    def walk(value):
        nonlocal best
        if isinstance(value, dict):
            for k, v in value.items():
                if k in ("usedPercent", "used_percent") and isinstance(v, (int, float)):
                    best = max(best, float(v))
                else:
                    walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)
    walk(limits)
    return best


if __name__ == "__main__":
    limits = rate_limits()
    print(json.dumps(limits, indent=1))
    print("used_percent", used_percent(limits))
