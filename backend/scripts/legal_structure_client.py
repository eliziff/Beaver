"""Persistent transport to Beaver's shipping legal-structure adapter."""
from __future__ import annotations

import atexit
import json
import subprocess
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parent.parent
BRIDGE = Path(__file__).with_name("legal-structure-jsonl.ts")


class Client:
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

    def paragraphs(self, request: dict[str, Any]) -> list[tuple[str, list[str], int, int]]:
        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("legal-structure bridge pipes are unavailable")
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"legal-structure bridge stopped ({self.process.poll()})")
        response = json.loads(line)
        if response.get("id") != request["id"] or response.get("error"):
            raise RuntimeError(response.get("error") or "legal-structure response mismatch")
        return response["paragraphs"]

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)


_client: Client | None = None


def paragraph_blocks(citation: str, text: str, dataset: str | None):
    global _client
    if _client is None:
        _client = Client()
    return _client.paragraphs({
        "id": citation or f"text:{len(text)}",
        "citation": citation,
        "text": text,
        "dataset": dataset,
    })


def close() -> None:
    global _client
    if _client:
        _client.close()
        _client = None


atexit.register(close)
