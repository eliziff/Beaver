"""Stable JSON identities and atomic retained artifacts."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from typing import Any


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # Windows readers can briefly deny replacement of an otherwise writable file.
        for attempt in range(8):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if os.name != "nt" or attempt == 7:
                    raise
                time.sleep(.005 * 2 ** attempt)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def atomic_json(path: Path, value: Any) -> None:
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    atomic_write(path, gzip.compress(data, mtime=0) if path.suffix == ".gz" else data)


def read_json(path):
    with (gzip.open(path, "rt", encoding="utf-8-sig") if path.suffix == ".gz"
          else path.open(encoding="utf-8-sig")) as stream:
        return json.load(stream, parse_constant=lambda v: (_ for _ in ()).throw(ValueError(v)))


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
