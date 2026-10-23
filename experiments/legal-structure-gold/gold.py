"""Source-anchored structure state of a parser export, and the shared composition the scorer reads it with."""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from multiprocessing.util import Finalize

_native = None
_native_errors = None
_native_owner = None
_native_lock = threading.Lock()


def require(value, message):
    if not value: raise ValueError(message)


def low_priority():
    """Run this process and its children below normal priority, with UTF-8 output."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"): stream.reconfigure(encoding="utf-8")
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        kernel.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        if not kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x4000): raise ctypes.WinError(ctypes.get_last_error())
    else:
        os.nice(10)


def close_native():
    global _native, _native_errors
    if _native is None: return
    try:
        _native.stdin.close()
        try: _native.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _native.kill(); _native.wait()
    finally:
        _native.stdout.close()
        _native_errors.close()
        _native = _native_errors = None


def native(command, request):
    """Share one loaded native addon for all operations in this Python worker."""
    global _native, _native_errors, _native_owner
    with _native_lock:
        if _native_owner != os.getpid():
            _native = _native_errors = None
        if _native is None:
            _native_errors = tempfile.TemporaryFile(mode='w+t', encoding='utf-8')
            try:
                _native = subprocess.Popen(['node', str(Path(__file__).with_name('extract.mjs')), '--operations'],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=_native_errors,
                    text=True, encoding='utf-8')
            except BaseException:
                _native_errors.close(); _native_errors = None
                raise
            _native_owner = os.getpid()
            Finalize(None, close_native, exitpriority=10)
        try:
            _native.stdin.write(json.dumps({'command': command, 'request': request}, ensure_ascii=False) + '\n')
            _native.stdin.flush()
            line = _native.stdout.readline()
        except (BrokenPipeError, OSError):
            close_native()
            raise
        if not line:
            _native_errors.seek(0)
            error = _native_errors.read().strip()
            close_native()
            raise ValueError(error or 'Native operation helper exited without a response')
        response = json.loads(line)
        require(response['ok'], response.get('error', 'Native operation failed'))
        return response['value']


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


def range_refs(span, lines, structure):
    result = []
    for line in lines.values():
        a, b = max(span["start"], line["range"]["start"]), min(span["end"], line["range"]["end"])
        if a < b:
            raw = line["text"].encode("utf-16-le")
            start = len(raw[:(a-line["range"]["start"])*2].decode("utf-16-le"))
            end = len(raw[:(b-line["range"]["start"])*2].decode("utf-16-le"))
            result.append({"line_id": line["id"], "start": start, "end": end})
    return result


def whole(ids, lines):
    return [{"line_id": i, "start": 0, "end": len(lines[i]["text"])} for i in ids]


def span_anchor(span):
    return f"{span['line_id']}@{span['start']}"


def block_id(block):
    return block.get("id") or span_anchor((block.get("spans") or [{"line_id":block["line_ids"][0],"start":0}])[0])


def compose_structure(state):
    return native("--compose-structure", {key: state[key] for key in ("lines", "groups", "annotations", "reading_order", "continuations")})


def continuations(state):
    return ((ident,link) for layer in state["continuations"].values() for ident,link in layer.items())


def text_links(state):
    """Each block's next fragment in its logical block, from the shared assembly."""
    assembled=compose_structure(state)
    groups={block_id(group):group for group in assembled["groups"]}
    return {left:{"next":right,"kind":"heading" if groups[left]["kind"]=="heading" else "paragraph"}
            for parts in assembled["logical_blocks"].values() for left,right in zip(parts,parts[1:])}


def logical_annotations(state):
    return native("--resolve-annotations", {key: state[key] for key in ("lines", "reading_order", "annotations", "continuations")})["annotations"]


def ownership(state):
    result=compose_structure(state)
    return {g["id"]:g["document"] for g in result["groups"]},[a for a in result["annotations"] if a["kind"]=="document"]


def initial(structure, pages):
    """The parser's blocks and annotations over its source lines, with their page boxes."""
    lines = source_lines(structure)
    evidence = {a["id"]: a for p in pages for a in p["atoms"]}
    require(set(lines) == set(evidence), "Evidence source-ID coverage differs from native structure")
    for ident, line in lines.items():
        line.update(box=evidence[ident]["bbox"], original_text=line["text"], source_id=ident, source_range=[0,len(line["text"])])
    prepared = native("--structure-blocks", {"structure": structure, "lines": list(lines.values())})
    return {"lines":list(lines.values()),"groups":prepared["groups"],"annotations":prepared["annotations"],
            "reading_order":list(lines),"continuations":prepared["continuations"]}
