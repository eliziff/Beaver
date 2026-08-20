"""Persistent Python client for Beaver's shipping SourceDoc compiler.

This module contains transport only. Structure detection belongs exclusively
to the shared Rust structure engine.
"""
from __future__ import annotations

import atexit
import json
import subprocess
from pathlib import Path
from typing import Any

SCRIPTS = Path(__file__).resolve().parent
BACKEND = SCRIPTS.parent
BRIDGE = SCRIPTS / "sourcedoc-jsonl.ts"
PROTOCOL = "beaver.sourcedoc.jsonl.v1"
COMPILER = "legal-structure"


class SourceDocClient:
    def __init__(self) -> None:
        self.process = subprocess.Popen(
            ["node", "--import", "tsx", str(BRIDGE)],
            cwd=BACKEND,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    def compile(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("SourceDoc bridge pipes are unavailable")
        self.process.stdin.write(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        )
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            code = self.process.poll()
            raise RuntimeError(f"SourceDoc bridge stopped unexpectedly ({code})")
        response = json.loads(line)
        if response.get("error"):
            raise RuntimeError(f"SourceDoc bridge: {response['error']}")
        if (
            response.get("id") != payload.get("id")
            or response.get("protocol") != PROTOCOL
            or response.get("compiler") != COMPILER
        ):
            raise RuntimeError("SourceDoc bridge returned the wrong response")
        return response

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)


_CLIENT: SourceDocClient | None = None


def compile_document(payload: dict[str, Any]) -> dict[str, Any]:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = SourceDocClient()
    return _CLIENT.compile(payload)


def close_client() -> None:
    global _CLIENT
    if _CLIENT is not None:
        _CLIENT.close()
        _CLIENT = None


atexit.register(close_client)
