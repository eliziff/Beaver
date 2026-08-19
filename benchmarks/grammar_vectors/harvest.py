#!/usr/bin/env python
"""Harvest citation-grammar test vectors from two READ-ONLY reference repos.

Sources (never written to):
  1. ALR-Quote-Verifier  tests/test_deterministic_splitter.py  -> kind "splitter-io"
                         tests/test_pure_ref_prefilter.py      -> kind "pure-ref"
                         tests/test_pinpoint_kind_guards.py    -> kind "guard-negative"
                         tests/test_quote_fragments.py         -> kind "raw-string"
  2. AuthoritiesHelper tests/test_toa_maker.py           -> kind "toa-io"

Extraction is AST-based (no regex scraping of source text): each test function
is walked with a literal-only mini evaluator that resolves plain constants,
implicit concatenation, f-strings over known locals, str methods
(index/replace/...), len(), and expands `for` loops over literal iterables so
parametrized vectors come out one row per parameter. Assertions that reference
a harvested call's result are folded into that vector's "expect" object;
anything the evaluator cannot resolve is skipped (counted) rather than guessed.

Output: harvested.jsonl next to this script, one JSON object per vector:
  {"source": "<repo-short>/<file>:<line>", "kind": ..., "input": ...,
   "expect": {...} | null, "note": "<test function name>"}
Rows are deduped on (kind, input); a duplicate that differs only in which
splitter function was exercised merges into a sorted "splitter" list.

Usage:
  python -X utf8 harvest.py [ALR_QUOTE_VERIFIER_ROOT] [TOA_MAKER_ROOT]

Exits nonzero if any source file is missing.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

DEFAULT_ALR = r"C:\Users\elias\Desktop\Martys Qote Verifier\ALR-Quote-Verifier"
DEFAULT_TOA = r"C:\Users\elias\Desktop\MikeOSS Fork\AuthoritiesHelper"

UNRESOLVED = object()
STR_METHODS = {
    "index", "replace", "capitalize", "removesuffix", "removeprefix",
    "lower", "upper", "strip", "format", "join", "title",
}


class FuncRef:
    """A test-local name bound to one of the harvested target functions."""

    def __init__(self, name: str):
        self.name = name


def resolve(node, env):
    """Best-effort literal evaluation; UNRESOLVED on anything dynamic."""
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        value = env.get(node.id, UNRESOLVED)
        return UNRESOLVED if isinstance(value, FuncRef) else value
    if isinstance(node, ast.JoinedStr):
        parts = []
        for piece in node.values:
            if isinstance(piece, ast.Constant):
                parts.append(str(piece.value))
            elif isinstance(piece, ast.FormattedValue):
                if piece.format_spec is not None or piece.conversion not in (-1, 115):
                    return UNRESOLVED
                value = resolve(piece.value, env)
                if value is UNRESOLVED:
                    return UNRESOLVED
                parts.append(str(value))
            else:
                return UNRESOLVED
        return "".join(parts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Mult, ast.Sub)):
        left, right = resolve(node.left, env), resolve(node.right, env)
        if left is UNRESOLVED or right is UNRESOLVED:
            return UNRESOLVED
        try:
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Mult):
                return left * right
            return left - right
        except Exception:
            return UNRESOLVED
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        value = resolve(node.operand, env)
        return -value if isinstance(value, (int, float)) else UNRESOLVED
    if isinstance(node, (ast.Tuple, ast.List)):
        items = [resolve(item, env) for item in node.elts]
        return UNRESOLVED if any(item is UNRESOLVED for item in items) else items
    if isinstance(node, ast.Dict):
        out = {}
        for key_node, value_node in zip(node.keys, node.values):
            if key_node is None:
                return UNRESOLVED
            key, value = resolve(key_node, env), resolve(value_node, env)
            if key is UNRESOLVED or value is UNRESOLVED:
                return UNRESOLVED
            out[key] = value
        return out
    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Name) and func.id == "len" and len(node.args) == 1:
            value = resolve(node.args[0], env)
            if value is UNRESOLVED:
                return UNRESOLVED
            try:
                return len(value)
            except Exception:
                return UNRESOLVED
        if isinstance(func, ast.Attribute) and func.attr in STR_METHODS:
            base = resolve(func.value, env)
            if base is UNRESOLVED or not isinstance(base, str):
                return UNRESOLVED
            args = [resolve(arg, env) for arg in node.args]
            if any(arg is UNRESOLVED for arg in args) or node.keywords:
                return UNRESOLVED
            try:
                return getattr(base, func.attr)(*args)
            except Exception:
                return UNRESOLVED
    return UNRESOLVED


def resolve_dict_loose(node, env):
    """Resolve a dict literal, marking unresolvable values '<dynamic>'."""
    if not isinstance(node, ast.Dict):
        return None
    out = {}
    for key_node, value_node in zip(node.keys, node.values):
        if key_node is None:
            continue
        key = resolve(key_node, env)
        if key is UNRESOLVED:
            continue
        value = resolve(value_node, env)
        out[key] = "<dynamic>" if value is UNRESOLVED else value
    return out


def call_name(call: ast.Call) -> str:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


FRIENDLY_EXACT = {
    "result.status": "status",
    "len(result.parts)": "parts_len",
    "len(result)": "parts_len",
    "result.reasons": "reasons",
    "result": "returns",
    "[part.text for part in result.parts]": "parts_text",
    "[part.anchors for part in result.parts]": "parts_anchors",
}
FRIENDLY_RULES = [
    (re.compile(r"^\[extract_fields\(part\)\.(\w+) for part in result\.parts\]$"), r"parts_\1"),
    (re.compile(r"^extract_fields\(result\.parts\[(-?\d+)\]\)\."), r"fields(parts[\1])."),
    (re.compile(r"^result\.parts\["), "parts["),
    (re.compile(r"^result\["), "parts["),
    (re.compile(r"^result\."), ""),
]


def friendly(probe: str) -> str:
    if probe in FRIENDLY_EXACT:
        return FRIENDLY_EXACT[probe]
    for pattern, replacement in FRIENDLY_RULES:
        new = pattern.sub(replacement, probe, count=1)
        if new != probe:
            return new
    return probe


class Vector:
    __slots__ = ("kind", "input", "expect", "note", "line", "label")

    def __init__(self, kind, value, note, line, label=""):
        self.kind = kind
        self.input = value
        self.expect = {}
        self.note = note
        self.line = line
        self.label = label

    def raw(self, text):
        self.expect.setdefault("asserts", []).append(text)


class Harvester:
    """Walks the test functions of one file with a restricted interpreter."""

    def __init__(self, kind, targets, label, capture_env=False):
        self.kind = kind
        self.targets = targets
        self.label = label  # "alr/test_x.py"
        self.capture_env = capture_env  # record composed (f-string/concat) locals
        self.rows: list[Vector] = []
        self.skipped = 0

    # -- entry ------------------------------------------------------------
    def harvest(self, tree):
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name.startswith("test"):
                state = {"env": {}, "aliases": {}, "note": node.name, "last": None}
                self.walk_body(node.body, state)
        return self.rows

    # -- statements --------------------------------------------------------
    def walk_body(self, body, state):
        for stmt in body:
            self.walk_stmt(stmt, state)

    def walk_stmt(self, stmt, state):
        if isinstance(stmt, ast.Assign):
            self.handle_assign(stmt, state)
        elif isinstance(stmt, ast.Expr):
            if isinstance(stmt.value, ast.Call):
                self.handle_expr_call(stmt.value, state)
        elif isinstance(stmt, ast.Assert):
            made = self.create_vectors_in(stmt.test, state)
            self.parse_condition(stmt.test, state, made, positive=True)
        elif isinstance(stmt, ast.For):
            self.handle_for(stmt, state)
        elif isinstance(stmt, ast.With):
            self.walk_body(stmt.body, state)
        elif isinstance(stmt, ast.If):
            self.walk_body(stmt.body, state)
            self.walk_body(stmt.orelse, state)
        elif isinstance(stmt, ast.Try):
            self.walk_body(stmt.body, state)
            self.walk_body(stmt.finalbody, state)

    def handle_assign(self, stmt, state):
        value = stmt.value
        made = self.create_vectors_in(value, state)
        target = stmt.targets[0] if len(stmt.targets) == 1 else None
        if isinstance(target, ast.Name):
            name = target.id
            if isinstance(value, ast.Call) and id(value) in made:
                state["aliases"][name] = (made[id(value)], "result")
                return
            if (isinstance(value, ast.Attribute) and isinstance(value.value, ast.Call)
                    and id(value.value) in made):
                vec = made[id(value.value)]
                state["aliases"][name] = (vec, "result." + value.attr)
                return
            spec = self.targets.get(call_name(value)) if isinstance(value, ast.Call) else None
            if spec is not None and spec.get("alias_only") and value.args:
                vec = self.vec_for(value.args[0], state, made)
                if vec is not None:
                    canon = self.normalize(value.args[0], state, made)
                    state["aliases"][name] = (vec, f"extract_fields({canon})")
                    return
            resolved = resolve(value, state["env"])
            if resolved is not UNRESOLVED:
                state["env"][name] = resolved
                if (self.capture_env and isinstance(resolved, str)
                        and not isinstance(value, ast.Constant)
                        and keep_raw_string(resolved)):
                    self.rows.append(Vector(self.kind, resolved, state["note"],
                                            stmt.lineno, self.label))
                return
            vec = self.vec_for(value, state, made)
            if vec is not None:
                probe = self.normalize(value, state, made)
                if len(probe) <= 60:
                    state["aliases"][name] = (vec, probe)
                else:
                    state["aliases"][name] = (vec, name)  # derived helper var

    def handle_expr_call(self, call, state):
        name = call_name(call)
        if name.startswith("assert"):
            self.parse_assert_method(name, call, state)
        else:
            self.create_vectors_in(call, state)

    def handle_for(self, stmt, state):
        env = state["env"]
        iterable = stmt.iter
        # for f in (split_footnote, split_footnote_recall_first):
        if isinstance(iterable, (ast.Tuple, ast.List)) and iterable.elts and all(
                isinstance(el, ast.Name) and el.id in self.targets for el in iterable.elts):
            for el in iterable.elts:
                if isinstance(stmt.target, ast.Name):
                    env[stmt.target.id] = FuncRef(el.id)
                    self.walk_body(stmt.body, state)
            return
        items = UNRESOLVED
        if isinstance(iterable, ast.Call) and call_name(iterable) == "items":
            mapping = resolve(iterable.func.value, env)
            if mapping is not UNRESOLVED and isinstance(mapping, dict):
                items = [list(pair) for pair in mapping.items()]
        else:
            items = resolve(iterable, env)
        if items is not UNRESOLVED and isinstance(items, list):
            for item in items:
                if isinstance(stmt.target, ast.Name):
                    env[stmt.target.id] = item
                elif isinstance(stmt.target, ast.Tuple) and isinstance(item, (list, tuple)) \
                        and len(stmt.target.elts) == len(item):
                    for sub, val in zip(stmt.target.elts, item):
                        if isinstance(sub, ast.Name):
                            env[sub.id] = val
                else:
                    break
                self.walk_body(stmt.body, state)
            return
        # for p in parts:  (iterating a tracked result)
        vec = self.vec_for(iterable, state, {})
        if vec is not None and isinstance(stmt.target, ast.Name):
            canon = self.normalize(iterable, state, {})
            state["aliases"][stmt.target.id] = (vec, canon + "[*]")
        self.walk_body(stmt.body, state)

    # -- vector creation ----------------------------------------------------
    def create_vectors_in(self, expr, state):
        """Create vectors for every harvest-target call inside expr."""
        made = {}
        for node in ast.walk(expr):
            if not isinstance(node, ast.Call):
                continue
            name = call_name(node)
            if isinstance(node.func, ast.Name):
                bound = state["env"].get(node.func.id)
                if isinstance(bound, FuncRef):
                    name = bound.name
            spec = self.targets.get(name)
            if spec is None or spec.get("alias_only"):
                continue
            vec = self.make_vector(name, spec, node, state)
            if vec is not None:
                made[id(node)] = vec
                state["last"] = vec
        return made

    def make_vector(self, name, spec, call, state):
        env = state["env"]
        if "input_json" in spec:
            values = {}
            for field, arg in zip(spec["input_json"], call.args):
                value = resolve(arg, env)
                if value is UNRESOLVED:
                    self.skipped += 1
                    return None
                values[field] = value
            text = json.dumps(values, ensure_ascii=False)
            vec = Vector(self.kind, text, state["note"], call.lineno, self.label)
        elif "input_dict_key" in spec:
            loose = resolve_dict_loose(call.args[0], env) if call.args else None
            if not loose or not isinstance(loose.get(spec["input_dict_key"]), str):
                self.skipped += 1
                return None
            vec = Vector(self.kind, loose[spec["input_dict_key"]],
                         state["note"], call.args[0].lineno, self.label)
            rest = {key: value for key, value in loose.items()
                    if key != spec["input_dict_key"]}
            if rest:
                vec.expect["call"] = rest
        else:
            index = spec.get("input_arg", 0)
            if index >= len(call.args):
                self.skipped += 1
                return None
            node = call.args[index]
            value = resolve(node, env)
            if value is UNRESOLVED or not isinstance(value, str):
                self.skipped += 1
                return None
            vec = Vector(self.kind, value, state["note"], node.lineno, self.label)
        if spec.get("record_func"):
            vec.expect["splitter"] = name
        for field, arg_index in spec.get("extra", {}).items():
            if arg_index < len(call.args):
                value = resolve(call.args[arg_index], env)
                if value is not UNRESOLVED:
                    vec.expect[field] = value
        for keyword in call.keywords:
            if keyword.arg:
                value = resolve(keyword.value, env)
                if value is not UNRESOLVED:
                    vec.expect[keyword.arg] = value
        self.rows.append(vec)
        return vec

    # -- probes ---------------------------------------------------------------
    def vec_for(self, expr, state, made):
        for node in ast.walk(expr):
            if isinstance(node, ast.Call) and id(node) in made:
                return made[id(node)]
            if isinstance(node, ast.Name) and node.id in state["aliases"]:
                return state["aliases"][node.id][0]
        return None

    def normalize(self, expr, state, made):
        src = ast.unparse(expr)
        for node in ast.walk(expr):
            if isinstance(node, ast.Call) and id(node) in made:
                src = src.replace(ast.unparse(node), "result")
        for var, (_vec, canon) in state["aliases"].items():
            src = re.sub(rf"\b{re.escape(var)}\b", canon, src)
        return src

    # -- assertions -------------------------------------------------------------
    def parse_assert_method(self, method, call, state):
        made = self.create_vectors_in(call, state)
        args = call.args
        if method in ("assertEqual", "assertIs", "assertAlmostEqual") and len(args) >= 2:
            if not self.expect_pair(args[0], args[1], state, made):
                self.expect_pair(args[1], args[0], state, made)
        elif method == "assertTrue" and args:
            self.parse_condition(args[0], state, made, positive=True)
        elif method == "assertFalse" and args:
            self.parse_condition(args[0], state, made, positive=False)
        elif method in ("assertIn", "assertNotIn") and len(args) >= 2:
            member = resolve(args[0], state["env"])
            vec = self.vec_for(args[1], state, made)
            if vec is not None and member is not UNRESOLVED:
                key = friendly(self.normalize(args[1], state, made))
                suffix = ".contains" if method == "assertIn" else ".not_contains"
                vec.expect.setdefault(key + suffix, []).append(member)
        elif method == "assertIsNone" and args:
            self.condition_is_none(args[0], state, made, none_result=True)
        elif method == "assertIsNotNone" and args:
            self.condition_is_none(args[0], state, made, none_result=False)
        elif method == "assertNotEqual" and len(args) >= 2:
            vec = self.vec_for(args[0], state, made) or self.vec_for(args[1], state, made)
            if vec is not None:
                vec.raw(self.normalize(args[0], state, made) + " != "
                        + self.normalize(args[1], state, made))

    def expect_pair(self, probe, value_node, state, made):
        vec = self.vec_for(probe, state, made)
        if vec is None:
            return False
        value = resolve(value_node, state["env"])
        if value is UNRESOLVED:
            other = self.normalize(value_node, state, made)
            vec.raw(self.normalize(probe, state, made) + " == " + other)
            return True
        if isinstance(value, str) and value == vec.input:
            vec.raw(self.normalize(probe, state, made) + " == <input>")
            return True
        vec.expect[friendly(self.normalize(probe, state, made))] = value
        return True

    def parse_condition(self, expr, state, made, positive):
        if isinstance(expr, ast.BoolOp) and isinstance(expr.op, ast.And) and positive:
            for value in expr.values:
                self.parse_condition(value, state, made, positive=True)
            return
        if isinstance(expr, ast.Compare) and len(expr.ops) == 1:
            op, left, right = expr.ops[0], expr.left, expr.comparators[0]
            if isinstance(op, (ast.Is, ast.IsNot)) and isinstance(right, ast.Constant) \
                    and right.value is None and positive:
                self.condition_is_none(left, state, made,
                                       none_result=isinstance(op, ast.Is))
                return
            if isinstance(op, ast.Eq) and positive:
                if self.expect_pair(left, right, state, made):
                    return
                if self.expect_pair(right, left, state, made):
                    return
            vec = self.vec_for(expr, state, made)
            if vec is not None:
                text = self.normalize(expr, state, made)
                vec.raw(text if positive else f"not ({text})")
            return
        if isinstance(expr, ast.Call) and isinstance(expr.func, ast.Attribute) \
                and expr.func.attr in ("startswith", "endswith") and expr.args and positive:
            vec = self.vec_for(expr.func.value, state, made)
            argument = resolve(expr.args[0], state["env"])
            if vec is not None and argument is not UNRESOLVED:
                key = friendly(self.normalize(expr.func.value, state, made))
                vec.expect[key + "." + expr.func.attr] = argument
                return
        vec = self.vec_for(expr, state, made)
        if vec is not None:
            text = self.normalize(expr, state, made)
            vec.raw(text if positive else f"not ({text})")

    def condition_is_none(self, expr, state, made, none_result):
        vec = self.vec_for(expr, state, made)
        if vec is None:
            return
        probe = friendly(self.normalize(expr, state, made))
        if probe == "returns":
            if self.kind == "pure-ref":
                vec.expect["prefilter"] = "fail" if none_result else "pass"
            else:
                vec.expect["returns"] = None if none_result else "<not none>"
        else:
            vec.raw(probe + (" is None" if none_result else " is not None"))


# --- raw-string sweep for test_quote_fragments.py -----------------------------

RAW_MIN_LEN = 25
RAW_URLISH = (".xml", ".html", ".pdf", ".do", ".php", ".docx", ".json")


def keep_raw_string(text):
    if not isinstance(text, str) or len(text) < RAW_MIN_LEN or " " not in text:
        return False
    stripped = text.strip()
    if stripped.startswith(("http://", "https://", "<", "#", "{", "?", "//", "w:")):
        return False
    if "://" in stripped or ":~:text=" in stripped or "%2" in stripped:
        return False
    if "</" in stripped or "/>" in stripped:
        return False
    if stripped.endswith(RAW_URLISH):
        return False
    return True


def sweep_raw_strings(tree, kind, existing_keys, label):
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node

    def excluded(node):
        current, nearest_call_seen = node, False
        while current in parents:
            current = parents[current]
            if isinstance(current, (ast.JoinedStr, ast.BinOp)):
                return True  # piece of a composed string, not a whole vector
            if isinstance(current, ast.Call):
                source = ast.unparse(current.func)
                if source.endswith("etree.HTML") or source.endswith(".append"):
                    return True
                if not nearest_call_seen and source.rsplit(".", 1)[-1].startswith("assert"):
                    return True  # expectation-side constant, not an input
                nearest_call_seen = True
        return False

    def context(node):
        current = node
        while current in parents:
            current = parents[current]
            if isinstance(current, ast.FunctionDef):
                return current.name
        return "<module>"

    rows = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
            continue
        parent = parents.get(node)
        if isinstance(parent, ast.Expr):  # docstring
            continue
        if not keep_raw_string(node.value) or excluded(node):
            continue
        if (kind, node.value) in existing_keys:
            continue
        rows.append(Vector(kind, node.value, context(node), node.lineno, label))
    return rows


# --- wiring ---------------------------------------------------------------------

ALR_SPLITTER_TARGETS = {
    "split_footnote": {"input_arg": 0, "record_func": True},
    "split_footnote_recall_first": {"input_arg": 0, "record_func": True},
    "extract_text_fields": {"input_arg": 0},
    "extract_fields": {"alias_only": True},
}
PURE_REF_TARGETS = {
    "_parts": {"input_arg": 0},
    "_prefilter_pure_ref_parts": {"input_arg": 0},
    "_reanchor_ref_link": {"input_arg": 1, "extra": {"base_link": 0}},
}
GUARD_TARGETS = {
    "extract_text_fields": {"input_arg": 0},
    "_pinpoints_for_source_kind": {
        "input_json": ["source_kind", "pinpoint_fragments", "page_pinpoints"],
    },
    "cited_scopes": {"input_dict_key": "citation_with_style"},
}
QUOTE_FRAGMENT_TARGETS = {
    "_a2aj_query_citation": {"input_arg": 0},
    "_canlii_doc_citation_from_url": {"input_arg": 0},
}
TOA_TARGETS = {
    "split_citations": {"input_arg": 0},
    "extract_text_fields": {"input_arg": 0},
    "extract_fields": {"alias_only": True},
    "_docx_with_footnote": {"input_arg": 1},
    "_docx_with_quote_and_footnote": {"input_arg": 2, "extra": {"body_quote": 1}},
    "editorial_quote": {"input_arg": 0, "extra": {"source_passage": 1}},
    "TextUnit": {"input_arg": 4},
}

FILES = [
    ("alr", "tests/test_deterministic_splitter.py", "splitter-io", ALR_SPLITTER_TARGETS, False),
    ("alr", "tests/test_pure_ref_prefilter.py", "pure-ref", PURE_REF_TARGETS, False),
    ("alr", "tests/test_pinpoint_kind_guards.py", "guard-negative", GUARD_TARGETS, False),
    ("alr", "tests/test_quote_fragments.py", "raw-string", QUOTE_FRAGMENT_TARGETS, True),
    ("toa", "tests/test_toa_maker.py", "toa-io", TOA_TARGETS, False),
]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("alr_root", nargs="?", default=DEFAULT_ALR,
                        help="ALR-Quote-Verifier repo root")
    parser.add_argument("toa_root", nargs="?", default=DEFAULT_TOA,
                        help="AuthoritiesHelper repo root")
    args = parser.parse_args(argv)
    roots = {"alr": Path(args.alr_root), "toa": Path(args.toa_root)}

    out_path = Path(__file__).resolve().parent / "harvested.jsonl"
    kept: dict[tuple, Vector] = {}
    order: list[tuple] = []
    stats = {"skipped": 0, "deduped": 0}

    for repo, rel, kind, targets, sweep in FILES:
        path = roots[repo] / rel
        if not path.is_file():
            print(f"ERROR: missing source file: {path}", file=sys.stderr)
            return 2
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        label = f"{repo}/{Path(rel).name}"
        harvester = Harvester(kind, targets, label, capture_env=sweep)
        rows = harvester.harvest(tree)
        stats["skipped"] += harvester.skipped
        if sweep:
            seen_here = {(kind, vec.input) for vec in rows}
            rows += sweep_raw_strings(tree, kind, seen_here, label)
        print(f"  {label}: {len(rows)} vectors before dedupe")
        for vec in rows:
            key = (vec.kind, vec.input)
            if key not in kept:
                kept[key] = vec
                order.append(key)
                continue
            stats["deduped"] += 1
            old = kept[key]
            old_splitter = old.expect.get("splitter")
            new_splitter = vec.expect.get("splitter")
            if old_splitter and new_splitter and old_splitter != new_splitter:
                rest_old = {k: v for k, v in old.expect.items() if k != "splitter"}
                rest_new = {k: v for k, v in vec.expect.items() if k != "splitter"}
                if rest_old == rest_new:
                    names = set()
                    for entry in (old_splitter, new_splitter):
                        names.update(entry if isinstance(entry, list) else [entry])
                    old.expect["splitter"] = sorted(names)
                continue  # different splitters, different claims: keep first row
            if not old.expect and vec.expect:
                kept[key] = vec  # adopt the row that actually carries assertions
                continue
            # Same (or unstated) splitter: merge every non-conflicting expectation.
            for field, value in vec.expect.items():
                if field == "asserts":
                    merged = old.expect.setdefault("asserts", [])
                    merged.extend(item for item in value if item not in merged)
                elif field not in old.expect:
                    old.expect[field] = value
                elif old.expect[field] != value:
                    stats["conflicts"] = stats.get("conflicts", 0) + 1

    counts = {}
    with out_path.open("w", encoding="utf-8", newline="\n") as handle:
        for key in order:
            vec = kept[key]
            counts[vec.kind] = counts.get(vec.kind, 0) + 1
            row = {
                "source": f"{vec.label}:{vec.line}",
                "kind": vec.kind,
                "input": vec.input,
                "expect": vec.expect or None,
                "note": vec.note,
            }
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    total = sum(counts.values())
    print(f"wrote {total} vectors -> {out_path}")
    for kind in ("splitter-io", "pure-ref", "guard-negative", "raw-string", "toa-io"):
        print(f"  {kind:15s} {counts.get(kind, 0)}")
    print(f"  deduped {stats['deduped']} duplicate (kind, input) pairs; "
          f"skipped {stats['skipped']} unresolvable call sites")
    missing = [key for key, vec in kept.items()
               if vec.kind == "splitter-io" and not vec.expect]
    if missing:
        print(f"WARNING: {len(missing)} splitter-io rows carry no expectation",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
