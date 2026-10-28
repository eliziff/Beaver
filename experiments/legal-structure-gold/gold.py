"""Source-anchored lines of a parser export, and the helpers the gold scripts share."""
from copy import deepcopy
import os
import subprocess
import sys


def require(value, message):
    if not value: raise ValueError(message)


def low_priority():
    """Run this process and its children at idle priority, so the machine stays usable, with UTF-8 output."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"): stream.reconfigure(encoding="utf-8")
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        kernel.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        if not kernel.SetPriorityClass(kernel.GetCurrentProcess(), subprocess.IDLE_PRIORITY_CLASS): raise ctypes.WinError(ctypes.get_last_error())
    else:
        os.nice(19)


def source_lines(structure):
    """Physical source lines of the native UTF-16 structure contract."""
    require(structure.get("offset_unit") == "utf16", "Expected the native UTF-16 structure contract")
    text, result = structure["text"].encode("utf-16-le"), {}
    if structure.get("source_fragments"):
        for fragment in structure["source_fragments"]:
            ident, extent = fragment["id"], fragment["range"]
            require(ident not in result and 0 <= extent["start"] <= extent["end"] <= len(text) // 2, "Invalid native source fragment")
            result[ident] = {"id": ident, "text": text[extent["start"]*2:extent["end"]*2].decode("utf-16-le"),
                             "page": fragment["page_index"]+1, "range": deepcopy(extent)}
        return result
    for page in (n for n in structure["nodes"] if n["kind"] == "page"):
        start = page["range"]["start"]
        content = text[start*2:page["range"]["end"]*2].decode("utf-16-le").split("\n")
        ids = page.get("line_ids", [])  # a page without lines carries none
        if not ids and not content[0]: continue
        require(len(content) == len(ids), "Native page source IDs do not match its text range")
        for ident, line in zip(ids, content):
            stop = start + len(line.encode("utf-16-le")) // 2
            require(ident not in result, "Duplicate native line ID")
            result[ident] = {"id": ident, "text": line, "page": page["page_indexes"][0] + 1,
                             "range": {"start": start, "end": stop}}
            start = stop + 1
    return result


def span_anchor(span):
    return f"{span['line_id']}@{span['start']}"
