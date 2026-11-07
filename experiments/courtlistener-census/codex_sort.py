"""Codex Luna sorts readers' new findings into families, then merges the round's proposals into the family list.

    python -I codex_sort.py --known KNOWN_JSON --items DIR --out DIR [--effort medium] [--workers 6] [--cap 30]

DIR (--items) holds items-NN.json chunks: findings with a number n, the opinion, what, quote, renditions and the
reader's nearest family. Each chunk goes to Luna with the known families: every finding is assigned to a known
family (with what to add to its description when it is too thin) or to a new family it proposes. Then one call
merges every chunk's proposals and additions into the full family list, folding duplicates. Writes
OUT/assignments.jsonl, OUT/families.json (the new list, with is_new) and OUT/known-families.json (the list
readers take next). Answers are checked: every finding assigned, every family named exists; otherwise retried.
"""
import argparse
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from codex_read import POLICY, Quota  # noqa: E402
from codex_runner import backend  # noqa: E402
from codex_runner.artifacts import atomic_json  # noqa: E402
from codex_runner.calls import call  # noqa: E402

FAMILY = {"type": "object", "additionalProperties": False,
          "properties": {"id": {"type": "string"}, "name": {"type": "string"}, "description": {"type": "string"}},
          "required": ["id", "name", "description"]}
SORTED = {"type": "object", "additionalProperties": False, "properties": {
    "proposed": {"type": "array", "items": FAMILY},
    "widen": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                          "properties": {"id": {"type": "string"}, "add": {"type": "string"}}, "required": ["id", "add"]}},
    "assign": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                           "properties": {"n": {"type": "integer"}, "family": {"type": "string"}}, "required": ["n", "family"]}}},
    "required": ["proposed", "widen", "assign"]}
MERGED = {"type": "object", "additionalProperties": False, "properties": {
    "families": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                             "properties": {"id": {"type": "string"}, "name": {"type": "string"}, "description": {"type": "string"},
                                                            "is_new": {"type": "boolean"}}, "required": ["id", "name", "description", "is_new"]}},
    "renames": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                            "properties": {"from": {"type": "string"}, "to": {"type": "string"}}, "required": ["from", "to"]}}},
    "required": ["families", "renames"]}

SORT_TASK = """Below are (1) the families of structure catalogued so far in CourtListener court opinions (id, name, description), and (2) findings that readers reported as not covered by those families, each with a number n, the opinion it came from, what it is, an exact quote, the files that show it and the reader's nearest family.

For every finding, decide: (a) it is an instance of a known family as that family is meant (the description may just be too thin): assign it there and, if the description does not already cover it, say in widen what to add; or (b) it is a kind of structure no known family covers: propose a new family (one per kind, not one per finding; specific enough that a parser could read it; a short kebab-case id) and assign it there. Assign every finding by its n. Nothing is dropped: findings about record fields, encoding, escaping or layout get families too."""
MERGE_TASK = """Below are (1) the known families of structure in CourtListener court opinions and (2) this round's proposed new families and description additions, from several sorters working on different chunks (so the same new family may be proposed more than once under different ids).

Produce the full family list after this round: every known family, with its description widened to include the additions for it (concise, no repetition), plus the new families, folding together new families that are the same kind of thing (and folding a new family into a known one if it is really the same). Keep every known family's id. Mark which are new. List every folded proposed id in renames."""


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--known", type=Path, required=True)
    p.add_argument("--items", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--model", default="gpt-6-luna")
    p.add_argument("--effort", default="medium")
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--cap", type=float, default=30.0, help="Percent of the Codex window this task's own calls may use")
    p.add_argument("--own-root", type=Path, help="Folder holding every run of this task (default: the parent of --out)")
    p.add_argument("--attempts", type=int, default=3)
    p.add_argument("--timeout", type=int, default=1200)
    a = p.parse_args()
    if not a.model.startswith("gpt-6-luna"):
        sys.exit("this task runs on Luna only")
    known = json.loads(a.known.read_text(encoding="utf-8"))["families"]
    known_ids = {f["id"] for f in known}
    chunks = sorted(a.items.glob("items-*.json"))
    a.out.mkdir(parents=True, exist_ok=True)
    for name, schema in (("sorted.schema.json", SORTED), ("merged.schema.json", MERGED)):
        atomic_json(a.out / name, schema)
    args = SimpleNamespace(model=a.model, effort=a.effort, attempts=a.attempts, max_calls=None, timeout=a.timeout)
    quota = Quota(a.cap, a.own_root or a.out.parent)
    known_text = "===== known families =====\n" + json.dumps(known, ensure_ascii=False)

    def sort_chunk(path):
        if not quota.open():
            raise RuntimeError("Codex usage cap reached")
        items = json.loads(path.read_text(encoding="utf-8"))
        ns = {it["n"] for it in items}

        def validate(r):
            proposed = {f["id"] for f in r["proposed"]}
            got = {x["n"] for x in r["assign"]}
            unknown = sorted({x["family"] for x in r["assign"]} - known_ids - proposed)
            missing = sorted(ns - got)
            if missing or unknown:
                raise ValueError(f"unassigned findings n={missing[:20]}; families neither known nor proposed: {unknown[:10]}")
            return r
        prompt = "\n\n".join([SORT_TASK, known_text, "===== findings =====\n" + json.dumps(items, ensure_ascii=False), "Now answer as instructed."])
        try:
            return call(prompt, a.out / "sorted.schema.json", [], a.out / "calls" / path.stem, args, validate,
                        dispatch=backend.invoke, policy=POLICY, cache_key=f"cl-sort-{a.items.name}-{path.stem}")
        except Exception as exc:  # one chunk that never validates is reported, not fatal to the round
            print(json.dumps({"chunk_failed": path.stem, "error": str(exc)[-300:]}), flush=True)
            return None

    with ThreadPoolExecutor(a.workers) as ex:
        results = list(ex.map(sort_chunk, chunks))
    chunks = [c for c, r in zip(chunks, results) if r is not None]
    sorted_chunks = [r for r in results if r is not None]
    proposals = [f for r in sorted_chunks for f in r["proposed"]]
    widen = [w for r in sorted_chunks for w in r["widen"]]

    def validate_merge(r):
        ids = {f["id"] for f in r["families"]}
        lost = sorted(known_ids - ids)
        if lost:
            raise ValueError(f"known families missing from the merged list: {lost[:20]}")
        return r
    prompt = "\n\n".join([MERGE_TASK, known_text, "===== proposed new families =====\n" + json.dumps(proposals, ensure_ascii=False),
                          "===== additions to known families =====\n" + json.dumps(widen, ensure_ascii=False), "Now answer as instructed."])
    merged = call(prompt, a.out / "merged.schema.json", [], a.out / "calls" / "merge", args, validate_merge,
                  dispatch=backend.invoke, policy=POLICY, cache_key=f"cl-merge-{a.items.name}")
    renames = {r["from"]: r["to"] for r in merged["renames"]}
    with open(a.out / "assignments.jsonl", "w", encoding="utf-8") as w:
        for path, r in zip(chunks, sorted_chunks):
            for x in r["assign"]:
                w.write(json.dumps({"chunk": path.stem, "n": x["n"], "family": renames.get(x["family"], x["family"])}) + "\n")
    atomic_json(a.out / "families.json", merged)
    atomic_json(a.out / "known-families.json", {"families": [{k: f[k] for k in ("id", "name", "description")} for f in merged["families"]]})
    new = [f for f in merged["families"] if f["is_new"]]
    print(json.dumps({"chunks": len(chunks), "proposed": len(proposals), "families": len(merged["families"]), "new": len(new),
                      "new_ids": [f["id"] for f in new], "own_percent": round(quota.own, 2), "account_used": quota.used}))


if __name__ == "__main__":
    main()
