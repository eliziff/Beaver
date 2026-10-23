"""Bundle the installed ranker and original inference code into one HTML file."""
import argparse
import ast
import base64
import json
from pathlib import Path
import zlib

HERE = Path(__file__).resolve().parent


def source_module(filename, functions, *, drop_imports=(), helpers_only=False):
    """Keep original source, including decorators; omit corpus and training code."""
    source = (HERE / filename).read_text(encoding="utf-8")
    lines = source.splitlines(keepends=True)
    parts = []
    found = set()
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef):
            if node.name not in functions:
                continue
            found.add(node.name)
        elif helpers_only:
            continue
        elif isinstance(node, ast.ImportFrom) and node.module in drop_imports:
            continue
        start = min([node.lineno, *[d.lineno for d in getattr(node, "decorator_list", [])]])
        parts.append("".join(lines[start - 1:node.end_lineno]))
    if found != set(functions):
        raise ValueError(f"Missing inference functions in {filename}: {set(functions) - found}")
    return "\n".join(parts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=HERE / "model.json")
    parser.add_argument("--party-names", required=True, type=Path,
                        help="Training-only party-name memory belonging to the selected pack")
    args = parser.parse_args()
    from evidence import grammar_pattern
    patterns = {name: (grammar_pattern(name).pattern, int(grammar_pattern(name).flags))
                for name in ("cite.in-text", "ref.infer.parties")}
    modules = {
        "mine": "import unicodedata\n" + source_module("mine.py", {
            "normalize", "words", "balanced_delimiters"}, helpers_only=True),
        "evidence": "import re\nfrom mine import balanced_delimiters, words\n" +
            source_module("evidence.py", {"caption_flag"}, helpers_only=True) +
            f"\n_patterns = {patterns!r}\n\ndef grammar_pattern(name):\n    return re.compile(*_patterns[name])\n",
        "shortform": source_module("shortform.py", {
            "anonymous", "anonymous_letters", "party_type", "core", "name_slice",
            "complete_fragment", "name_structure", "shape_features", "context_features",
            "name_proposals", "candidates", "tree_score", "model_candidates", "ranked", "generate",
            "strip_citation_tail", "clean_caption", "_party_match", "party_names"
        }),
        "edit_decoder": source_module("edit_decoder.py", {
            "anonymous_key", "anonymous_orders", "party_proposals", "propose"
        }, drop_imports={"operations"}),
        "playground_runtime": (HERE / "playground_runtime.py").read_text(encoding="utf-8"),
    }
    payload = dict(modules=modules,
                   model=json.loads(args.model.read_text(encoding="utf-8")),
                   party_names=json.loads(args.party_names.read_text(encoding="utf-8")))
    packed = base64.b64encode(zlib.compress(json.dumps(payload, ensure_ascii=False,
        separators=(",", ":")).encode("utf-8"), 9)).decode("ascii")
    output = HERE / "dist" / "shortforms.html"
    output.parent.mkdir(exist_ok=True)
    output.write_text((HERE / "playground.html").read_text(encoding="utf-8")
                      .replace("__MODEL_BUNDLE__", packed), encoding="utf-8")
    print(f"{output.relative_to(HERE.parent.parent)} ({output.stat().st_size / 1024 / 1024:.2f} MiB)")


if __name__ == "__main__":
    main()
