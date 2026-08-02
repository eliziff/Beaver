"""Literal coding tools for the visible-development harness ablation.

Both candidate arms use this executor.  The legal arm only enables optional
scope selectors; calls without a selector take the exact same path as the
plain arm.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import shlex
from pathlib import Path

from harness.tools import ToolExecutor, get_all_tool_definitions
from sandbox.sandbox import DOCUMENTS_PATH, OUTPUT_PATH, WORKSPACE_PATH, Sandbox


SOURCES_PATH = f"{WORKSPACE_PATH}/sources"
SCOPE_PATH = f"{WORKSPACE_PATH}/.scopes"
MAX_TOOL_LINES = 2000
PARSER_SOURCE = Path(__file__).resolve().parent.parent / "sandbox" / "parsers" / "parse_doc.py"


def get_ablation_tool_definitions(*, legal_scopes: bool) -> list[dict]:
    """Return the shared six-tool schema, adding only honest rg controls."""
    tools = copy.deepcopy(get_all_tool_definitions())
    by_name = {tool["name"]: tool for tool in tools}

    by_name["glob"]["description"] = (
        "List files with the installed ripgrep executable (`rg --files`). "
        "Defaults to the deterministic text projections in /workspace/sources."
    )
    by_name["glob"]["parameters"]["properties"].update(
        {
            "hidden": {
                "type": "boolean",
                "description": "Include hidden files, equivalent to rg --hidden.",
            },
            "follow": {
                "type": "boolean",
                "description": "Follow symbolic links, equivalent to rg --follow.",
            },
            "head_limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": MAX_TOOL_LINES,
                "description": "Maximum file paths to return (default 200).",
            },
        }
    )

    by_name["grep"]["description"] = (
        "Search deterministic source projections with the installed ripgrep "
        "executable. Defaults to /workspace/sources. Advanced rg flags remain "
        "available through bash."
    )
    by_name["grep"]["parameters"]["properties"].update(
        {
            "case_sensitive": {
                "type": "boolean",
                "description": "Use false for rg --ignore-case; default true.",
            },
            "fixed_strings": {
                "type": "boolean",
                "description": "Treat the pattern literally (rg --fixed-strings).",
            },
            "word_regexp": {
                "type": "boolean",
                "description": "Match whole words (rg --word-regexp).",
            },
            "context": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100,
                "description": "Context lines before and after each match (rg -C).",
            },
            "before_context": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100,
                "description": "Context lines before each match (rg -B).",
            },
            "after_context": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100,
                "description": "Context lines after each match (rg -A).",
            },
            "hidden": {
                "type": "boolean",
                "description": "Include hidden files (rg --hidden).",
            },
            "follow": {
                "type": "boolean",
                "description": "Follow symbolic links (rg --follow).",
            },
            "offset": {
                "type": "integer",
                "minimum": 0,
                "description": "Skip this many result lines for continuation.",
            },
            "head_limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": MAX_TOOL_LINES,
                "description": "Maximum result lines to return (default 250).",
            },
        }
    )

    if legal_scopes:
        scope_properties = {
            "section": {
                "type": "string",
                "description": "Optional exact legal heading or section label.",
            },
            "pages": {
                "type": "array",
                "items": {"type": "integer", "minimum": 1},
                "maxItems": 20,
                "description": "Optional 1-based page ordinals when the projection has page markers.",
            },
            "references": {
                "type": "string",
                "description": "Optional provision label; select lines that reference it.",
            },
            "table": {
                "type": "string",
                "description": "Optional sheet/table label or 1-based table number.",
            },
        }
        by_name["read"]["parameters"]["properties"].update(scope_properties)
        by_name["read"]["description"] += (
            " Optional section/pages/references/table selectors address exact "
            "spans in the same projection bytes used by grep."
        )
        by_name["grep"]["parameters"]["properties"].update(scope_properties)
        by_name["grep"]["description"] += (
            " Optional legal selectors constrain rg to exact spans from the "
            "same projection; calls without them are identical to the plain arm."
        )
    return tools


_HEADING_RE = re.compile(
    r"^(?:#{1,6}\s+.+|(?:ARTICLE|PART|DIVISION|SECTION|SCHEDULE|EXHIBIT)\b.+|"
    r"(?:Section\s+)?\d{1,4}(?:\.\d{1,4})+(?:\([A-Za-z0-9ivxIVX]+\))*\b.*)$",
    re.IGNORECASE,
)
_PAGE_RE = re.compile(r"^\[page\s+(\d+)\]$", re.IGNORECASE)
_REFERENCE_RE = re.compile(
    r"\b(Section|Article|Part|Schedule|Exhibit)\s+([A-Za-z0-9][A-Za-z0-9.()\-]*)",
    re.IGNORECASE,
)


def _normal(value: object) -> str:
    return " ".join(str(value).strip().lower().split())


def _structure(text: str) -> dict:
    lines = text.splitlines(keepends=True)
    starts: list[int] = []
    cursor = 0
    for line in lines:
        starts.append(cursor)
        cursor += len(line)

    headings: list[dict] = []
    pages: list[dict] = []
    references: list[dict] = []
    tables: list[dict] = []
    sheets: list[dict] = []
    table_start: int | None = None
    table_label = ""
    for index, line_with_end in enumerate(lines):
        line = line_with_end.rstrip("\r\n")
        start = starts[index]
        end = start + len(line_with_end)
        stripped = line.strip()
        is_heading = bool(stripped and _HEADING_RE.match(stripped))
        if is_heading:
            headings.append({"label": stripped.lstrip("# "), "start": start, "end": len(text)})
        page = _PAGE_RE.match(stripped)
        if page:
            pages.append({"label": page.group(1), "ordinal": len(pages) + 1, "start": start, "end": len(text)})
        if not is_heading:
            for match in _REFERENCE_RE.finditer(line):
                references.append(
                    {
                        "target": f"{match.group(1)} {match.group(2)}",
                        "start": start,
                        "end": end,
                        "line": index + 1,
                    }
                )
        table_line = "\t" in line or (stripped.startswith("|") and stripped.endswith("|"))
        sheet = stripped.startswith("=== Sheet:")
        if sheet:
            sheets.append({"label": stripped, "start": start, "end": len(text)})
        if table_line and not sheet and table_start is None:
            table_start = start
            table_label = f"table {len(tables) + 1}"
        elif not table_line and table_start is not None:
            tables.append({"label": table_label, "start": table_start, "end": start})
            table_start = None
            table_label = ""
    if table_start is not None:
        tables.append({"label": table_label, "start": table_start, "end": len(text)})
    for index, sheet in enumerate(sheets):
        sheet["end"] = sheets[index + 1]["start"] if index + 1 < len(sheets) else len(text)
    tables.extend(sheets)
    for items in (headings, pages):
        for index, item in enumerate(items):
            item["end"] = items[index + 1]["start"] if index + 1 < len(items) else len(text)
    return {
        "characters": len(text),
        "lines": len(lines),
        "sections": headings,
        "pages": pages,
        "tables": tables,
        "references": references,
    }


class AblationToolExecutor(ToolExecutor):
    """Shared plain/structured executor backed by literal in-container rg."""

    def __init__(self, *, legal_scopes: bool, **kwargs):
        self.legal_scopes = legal_scopes
        self.projection_manifest: list[dict] = []
        self._projection_by_original: dict[str, str] = {}
        self._structure_by_projection: dict[str, dict] = {}
        self.rg_commands: list[str] = []
        self.files_grep_matched: set[str] = set()
        self.legal_scope_calls = 0
        super().__init__(**kwargs)
        self.projection_parser = f"{WORKSPACE_PATH}/.ablation/parse_doc.py"
        parser_bytes = PARSER_SOURCE.read_bytes()
        self.projection_parser_sha256 = hashlib.sha256(parser_bytes).hexdigest()
        self.sandbox.write_file(self.projection_parser, parser_bytes)
        self._prepare_projections()

    def _parse_in_sandbox(self, ext: str, sb_path: str) -> str:
        result = self.sandbox.exec(
            f"python {shlex.quote(self.projection_parser)} {ext} {shlex.quote(sb_path)}",
            timeout=120,
        )
        if result.timed_out:
            return f"Error: parser timed out on {sb_path} ({ext})"
        if result.returncode != 0:
            errors = (result.stderr or "").strip().splitlines()
            tail = errors[-1] if errors else f"exit {result.returncode}"
            return f"Error: failed to parse {sb_path} ({ext}): {tail}"
        return result.stdout

    def _prepare_projections(self) -> None:
        rg_version = self.sandbox.exec("rg --version", timeout=10)
        self.rg_version = rg_version.stdout.splitlines()[0] if rg_version.ok else "unavailable"
        for original in self.sandbox.list_files(DOCUMENTS_PATH):
            relative = original[len(DOCUMENTS_PATH) + 1 :]
            projection = f"{SOURCES_PATH}/{relative}.txt"
            raw = self.sandbox.read_file(original)
            text = self._read_and_parse(original)
            self.sandbox.write_file(projection, text.encode("utf-8"))
            projection_bytes = self.sandbox.read_file(projection)
            projection_text = projection_bytes.decode("utf-8", errors="replace")
            structure = _structure(projection_text)
            self._projection_by_original[original] = projection
            self._structure_by_projection[projection] = structure
            self.projection_manifest.append(
                {
                    "original": original,
                    "projection": projection,
                    "original_bytes": len(raw),
                    "original_sha256": hashlib.sha256(raw).hexdigest(),
                    "projection_characters": len(projection_text),
                    "projection_bytes": len(projection_bytes),
                    "projection_sha256": hashlib.sha256(projection_bytes).hexdigest(),
                    "lines": structure["lines"],
                    "pages": len(structure["pages"]),
                    "sections": len(structure["sections"]),
                    "tables": len(structure["tables"]),
                }
            )
        manifest = {
            "format": "lab-source-projections-v1",
            "rg_version": self.rg_version,
            "parser_sha256": self.projection_parser_sha256,
            "documents": self.projection_manifest,
        }
        self.sandbox.write_file(
            f"{SOURCES_PATH}/manifest.json",
            json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8"),
        )

    def _resolve_read_path(self, path_str: str) -> str:
        if path_str.startswith("/"):
            Sandbox.assert_sandbox_path(path_str)
            return path_str
        for mount in (WORKSPACE_PATH, SOURCES_PATH, DOCUMENTS_PATH, OUTPUT_PATH):
            candidate = f"{mount}/{path_str}"
            if self.sandbox.exists(candidate):
                return candidate
        return f"{SOURCES_PATH}/{path_str}"

    def _resolve_search_path(self, path_str: str | None) -> str:
        if not path_str:
            return SOURCES_PATH
        if path_str.startswith("/"):
            Sandbox.assert_sandbox_path(path_str)
            return path_str
        for mount in (SOURCES_PATH, WORKSPACE_PATH, DOCUMENTS_PATH, OUTPUT_PATH):
            candidate = f"{mount}/{path_str}"
            if self.sandbox.exists(candidate):
                return candidate
        return f"{SOURCES_PATH}/{path_str}"

    def execute(self, tool_name: str, arguments: str | dict) -> str:
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                return f"Error: invalid JSON arguments: {arguments}"
        try:
            if tool_name == "glob":
                return self._literal_glob(arguments)
            if tool_name == "grep":
                return self._literal_grep(arguments)
            if tool_name == "read":
                if self.legal_scopes and self._has_scope(arguments):
                    return self._scoped_read(arguments)
                result = super().execute(tool_name, arguments)
                if not result.startswith(("Error:", "SecurityError:")):
                    try:
                        self._mark_exposed(self._resolve_read_path(str(arguments.get("file_path", ""))))
                    except (ValueError, PermissionError):
                        pass
                return result
            return super().execute(tool_name, arguments)
        except (OSError, ValueError, PermissionError, RuntimeError) as error:
            prefix = "SecurityError" if isinstance(error, PermissionError) else "Error"
            return f"{prefix}: {type(error).__name__}: {error}"

    @staticmethod
    def _has_scope(arguments: dict) -> bool:
        return any(arguments.get(name) not in (None, "", []) for name in ("section", "pages", "references", "table"))

    def _literal_glob(self, arguments: dict) -> str:
        pattern = str(arguments.get("pattern", "")).strip()
        if not pattern:
            return "Error: pattern is required"
        search = self._resolve_search_path(arguments.get("path"))
        if not self.sandbox.exists(search):
            return f"Error: path does not exist: {arguments.get('path')}"
        argv = ["rg", "--no-config", "--files", "--glob", pattern]
        if arguments.get("hidden"):
            argv.append("--hidden")
        if arguments.get("follow"):
            argv.append("--follow")
        argv.extend(["--", search])
        command = " ".join(shlex.quote(item) for item in argv)
        self.rg_commands.append(command)
        self.glob_count += 1
        result = self.sandbox.exec(command, timeout=self.shell_timeout)
        if result.timed_out:
            return f"Error: rg --files timed out after {self.shell_timeout}s"
        if result.returncode not in (0, 1):
            return f"Error: ripgrep: {(result.stderr or result.stdout).strip()}"
        lines = result.stdout.splitlines()
        limit = max(1, min(int(arguments.get("head_limit") or 200), MAX_TOOL_LINES))
        shown = lines[:limit]
        if len(lines) > limit:
            shown.append(f"[truncated: {len(lines) - limit} more paths; increase head_limit]")
        return "\n".join(shown) if shown else f"No files matching '{pattern}' in {search}"

    def _literal_grep(self, arguments: dict) -> str:
        pattern = str(arguments.get("pattern", ""))
        if not pattern:
            return "Error: pattern is required"
        search = self._resolve_search_path(arguments.get("path"))
        scope_note = ""
        scope_projection: str | None = None
        if self.legal_scopes and self._has_scope(arguments):
            selected = self._select_scope(search, arguments)
            if isinstance(selected, str):
                return selected
            search, spans, descriptor, projection = selected
            scope_projection = projection
            source = self.sandbox.read_file(projection).decode("utf-8", errors="replace")
            materialized = "\n\n".join(
                f"=== {descriptor} | chars {start}-{end} ===\n{source[start:end]}"
                for start, end in spans
            )
            digest = hashlib.sha256(
                (projection + json.dumps(spans) + descriptor).encode("utf-8")
            ).hexdigest()[:20]
            search = f"{SCOPE_PATH}/{digest}.txt"
            self.sandbox.write_file(search, materialized.encode("utf-8"))
            self.legal_scope_calls += 1
            scope_note = f"scope={descriptor}; source={projection}; spans={spans}\n"
        if not self.sandbox.exists(search):
            return f"Error: path does not exist: {arguments.get('path')}"

        mode = arguments.get("output_mode") or "files_with_matches"
        argv = ["rg", "--no-config", "--color", "never"]
        if mode == "content":
            argv.extend(["--line-number", "--with-filename"])
        elif mode == "files_with_matches":
            argv.append("--files-with-matches")
        elif mode == "count":
            argv.append("--count")
        else:
            return f"Error: unsupported output_mode: {mode}"
        if arguments.get("case_sensitive") is False:
            argv.append("--ignore-case")
        if arguments.get("fixed_strings"):
            argv.append("--fixed-strings")
        if arguments.get("word_regexp"):
            argv.append("--word-regexp")
        if arguments.get("hidden"):
            argv.append("--hidden")
        if arguments.get("follow"):
            argv.append("--follow")
        if arguments.get("glob"):
            argv.extend(["--glob", str(arguments["glob"])])
        for key, flag in (("context", "--context"), ("before_context", "--before-context"), ("after_context", "--after-context")):
            if arguments.get(key) is not None:
                argv.extend([flag, str(max(0, min(int(arguments[key]), 100)))])
        argv.extend(["--", pattern, search])
        command = " ".join(shlex.quote(item) for item in argv)
        self.rg_commands.append(command)
        self.grep_count += 1
        result = self.sandbox.exec(command, timeout=self.shell_timeout)
        if result.timed_out:
            return f"Error: ripgrep timed out after {self.shell_timeout}s"
        if result.returncode == 2:
            return f"Error: ripgrep: {(result.stderr or result.stdout).strip()}"
        if result.returncode not in (0, 1):
            return f"Error: ripgrep exited {result.returncode}: {(result.stderr or result.stdout).strip()}"
        lines = result.stdout.splitlines()
        if result.returncode == 0:
            if scope_projection:
                self._mark_exposed(scope_projection)
            elif search in self._structure_by_projection:
                self._mark_exposed(search)
            else:
                for line in lines:
                    candidate = line.split(":", 1)[0]
                    if candidate in self._structure_by_projection:
                        self._mark_exposed(candidate)
        offset = max(0, int(arguments.get("offset") or 0))
        limit = max(1, min(int(arguments.get("head_limit") or 250), MAX_TOOL_LINES))
        shown = lines[offset : offset + limit]
        if offset + limit < len(lines):
            next_args = dict(arguments)
            next_args["offset"] = offset + limit
            shown.append(f"[continuation: grep({json.dumps(next_args, sort_keys=True)})]")
        if not shown:
            return f"No matches for '{pattern}'"
        if offset == 0 and len(lines) <= limit:
            return scope_note + result.stdout.rstrip("\r\n")
        return scope_note + "\n".join(shown)

    def _projection_for(self, sb_path: str) -> str | None:
        if sb_path in self._structure_by_projection:
            return sb_path
        if sb_path in self._projection_by_original:
            return self._projection_by_original[sb_path]
        return None

    def _mark_exposed(self, sb_path: str) -> None:
        projection = self._projection_for(sb_path)
        if projection:
            self.files_grep_matched.add(projection)

    def _select_scope(self, sb_path: str, arguments: dict):
        projection = self._projection_for(sb_path)
        if projection is None:
            return "Error: legal scope requires a task document or its deterministic projection"
        structure = self._structure_by_projection[projection]
        requested = [name for name in ("section", "pages", "references", "table") if arguments.get(name) not in (None, "", [])]
        if len(requested) != 1:
            return "Error: choose exactly one of section, pages, references, or table"
        name = requested[0]
        spans: list[tuple[int, int]] = []
        descriptor = ""
        if name == "pages":
            ordinals = sorted({int(page) for page in arguments["pages"] if int(page) > 0})
            by_ordinal = {page["ordinal"]: page for page in structure["pages"]}
            missing = [page for page in ordinals if page not in by_ordinal]
            if missing:
                return f"Error: page ordinal(s) unavailable: {missing}; available={len(by_ordinal)}"
            spans = [(by_ordinal[page]["start"], by_ordinal[page]["end"]) for page in ordinals]
            descriptor = f"pages {','.join(map(str, ordinals))}"
        elif name == "references":
            query = _normal(arguments[name])
            matches = [item for item in structure["references"] if query in _normal(item["target"])]
            if not matches:
                return f"Error: no references matching {arguments[name]!r}"
            spans = [(item["start"], item["end"]) for item in matches]
            descriptor = f"references to {arguments[name]}"
        else:
            collection = structure["sections" if name == "section" else "tables"]
            query = _normal(arguments[name])
            exact = [item for item in collection if _normal(item["label"]) == query]
            matches = exact or [item for item in collection if query in _normal(item["label"])]
            if len(matches) != 1:
                labels = [item["label"] for item in matches[:12]]
                return f"Error: {name} selector resolved {len(matches)} spans; matches={labels}"
            spans = [(matches[0]["start"], matches[0]["end"])]
            descriptor = f"{name} {matches[0]['label']}"
        return sb_path, spans, descriptor, projection

    def _scoped_read(self, arguments: dict) -> str:
        file_path = str(arguments.get("file_path", ""))
        if not file_path:
            return "Error: file_path is required"
        sb_path = self._resolve_read_path(file_path)
        selected = self._select_scope(sb_path, arguments)
        if isinstance(selected, str):
            return selected
        _, spans, descriptor, projection = selected
        source = self.sandbox.read_file(projection).decode("utf-8", errors="replace")
        chunks = [source[start:end] for start, end in spans]
        selected_text = "\n\n".join(chunks)
        lines = selected_text.splitlines()
        offset = max(0, int(arguments.get("offset") or 0))
        limit = max(1, min(int(arguments.get("limit") or 400), 4000))
        returned = "\n".join(lines[offset : offset + limit])
        next_read = None
        if offset + limit < len(lines):
            next_read = {key: value for key, value in arguments.items() if key not in ("offset", "limit")}
            next_read.update({"offset": offset + limit, "limit": limit})
        self.files_read.append(projection[len(SOURCES_PATH) + 1 :])
        self._mark_exposed(projection)
        self.legal_scope_calls += 1
        return json.dumps(
            {
                "ok": True,
                "source": projection,
                "selection": descriptor,
                "source_spans": spans,
                "offset_line": offset,
                "returned_lines": len(lines[offset : offset + limit]),
                "total_selected_lines": len(lines),
                "text": returned,
                "truncated": next_read is not None,
                **({"next_read": next_read} if next_read else {}),
            },
            ensure_ascii=False,
        )

    def get_metrics(self) -> dict:
        metrics = super().get_metrics()
        projection_json = json.dumps(self.projection_manifest, sort_keys=True)
        reverse = {
            projection: original[len(DOCUMENTS_PATH) + 1 :]
            for original, projection in self._projection_by_original.items()
        }
        exposed = sorted(reverse[path] for path in self.files_grep_matched if path in reverse)
        metrics.update(
            {
                "tool_surface": "coding_legal_v1" if self.legal_scopes else "coding_plain_v1",
                "rg_version": self.rg_version,
                "projection_parser_sha256": self.projection_parser_sha256,
                "rg_command_count": len(self.rg_commands),
                "rg_commands": self.rg_commands,
                "legal_scope_calls": self.legal_scope_calls,
                "projection_count": len(self.projection_manifest),
                "projection_manifest_sha256": hashlib.sha256(projection_json.encode("utf-8")).hexdigest(),
                "projection_original_bytes": sum(item["original_bytes"] for item in self.projection_manifest),
                "projection_bytes": sum(item["projection_bytes"] for item in self.projection_manifest),
                "projection_characters": sum(item["projection_characters"] for item in self.projection_manifest),
                "projection_manifest": self.projection_manifest,
                "documents_read": len(exposed),
                "documents_read_list": exposed,
                "documents_skipped": len(self.projection_manifest) - len(exposed),
                "documents_skipped_list": sorted(
                    item["original"][len(DOCUMENTS_PATH) + 1 :]
                    for item in self.projection_manifest
                    if item["projection"] not in self.files_grep_matched
                ),
            }
        )
        return metrics
