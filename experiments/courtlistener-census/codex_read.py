"""Codex Luna reads CourtListener opinions in full and reports every structure the known families do not cover.

    python -I codex_read.py --queue QUEUE --known KNOWN_JSON --out DIR [--effort low] [--workers 8] [--cap 30]

QUEUE is a JSON list of opinion folders (each as sample_head.py / cell_stream.py writes them: fields.json and
one file per rendition) or a folder of such folders. Each opinion's fields and renditions go into the prompt as
text (the direct backend has no tools, so nothing is opened turn by turn), with the known families, through the
shared runner (tools/codex_runner: direct Codex backend, content-addressed calls, receipts). An answer is
accepted when its quotes are found in the opinion's files (whitespace-insensitive, by the parts around an
ellipsis); otherwise it is retried once with the misses named. Accepted answers go to DIR/results.jsonl, one line
per opinion, and a rerun reads only opinions not already there. Before every new call the account's Codex usage is
read (at most once a minute); at --cap percent used no new call starts, and calls in flight finish.
"""
import argparse
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from codex_runner import backend, limits  # noqa: E402
from codex_runner.artifacts import atomic_json  # noqa: E402
from codex_runner.calls import CallPolicy, call  # noqa: E402

INSTRUCTIONS = "You read court opinions and report their structure exactly as instructed. Answer only with the JSON the schema asks for."
SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "known_seen": {"type": "array", "items": {"type": "string"}},
        "new_items": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "properties": {"what": {"type": "string"}, "quote": {"type": "string"},
                           "renditions": {"type": "array", "items": {"type": "string"}}, "nearest_family": {"type": "string"}},
            "required": ["what", "quote", "renditions", "nearest_family"]}},
    },
    "required": ["known_seen", "new_items"],
}
TASK = """Below are (1) the families of structure already catalogued in CourtListener's court opinions, each with an id, a name and a description, and (2) one court opinion exactly as CourtListener stores it: fields.json (the record's other fields) and every stored version ("rendition") of its text, each under its file name (plain_text.txt, html.html, html_lawbox.html, html_columbia.html, html_anon_2020.html, xml_harvard.xml, html_with_citations.html). Read every rendition all the way through.

Structure means everything that organizes, divides, numbers, labels, links, refers or identifies: pages and page numbers, lines, paragraphs, headings, notes, quotations, lists, tables, the opinion and its parts, captions, parties, court, judges, counsel, dates, docket and case numbers, citations, signatures, stamps, anything else, in any rendition or field, whether marked up or only in the text, and whatever produced it.

Report in known_seen the ids of the known families this opinion shows. Report in new_items every structure the opinion carries that no known family covers, including anything unexpected or that you cannot name, and including a known kind of thing done in a way the family's description does not cover. One item per distinct thing. Each quote must be copied exactly from the opinion's files (markup included where it is markup), short, and from the files you name. nearest_family is the closest known family id, or "none". If nothing is new, new_items is empty."""
EXHAUSTIVE = """

Be exhaustive: go through the opinion rendition by rendition and part by part (fields, head matter, body, notes, end matter), and do not stop until every structure in it is either among known_seen or listed in new_items, however small or ordinary it seems."""


def retry_error(exc, response):
    if response is None and not isinstance(exc, ValueError):
        return None  # a provider failure: the runner's transport has already retried it
    return str(exc)[:600] or type(exc).__name__


POLICY = CallPolicy(INSTRUCTIONS, {}, lambda prompt, error, previous: prompt + ("\n\nThe previous answer was rejected: " + error if error else ""),
                    retry_error, "No valid answer after bounded retries: ")


def squash(s):
    return re.sub(r"\s+", " ", s).strip()


def opinion_files(folder):
    return {p.name: p.read_text(encoding="utf-8", errors="replace") for p in sorted(folder.iterdir()) if p.is_file()}


def prompt_for(folder, families, exhaustive=False):
    parts = [TASK + (EXHAUSTIVE if exhaustive else ""), "===== known families =====\n" + json.dumps(families, ensure_ascii=False)]
    parts += [f"===== {name} =====\n{text}" for name, text in opinion_files(folder).items()]
    parts.append("===== end of the opinion =====\nNow answer as instructed.")
    return "\n\n".join(parts)


def checker(folder):
    corpus = squash("\n".join(opinion_files(folder).values()))

    def found(quote):
        pieces = [squash(p) for p in re.split(r"\.\.\.|…", quote) if len(squash(p)) >= 4]
        return bool(pieces) and all(p in corpus for p in pieces)

    def validate(answer):
        missing = [it["quote"] for it in answer["new_items"] if not found(it["quote"])]
        if len(missing) > max(1, len(answer["new_items"]) // 5):
            raise ValueError("these quotes are not in the opinion's files, copy quotes exactly: " + json.dumps(missing[:8])[:500])
        for it in answer["new_items"]:
            it["quote_found"] = found(it["quote"])
        return answer
    return validate


# Measured 2026-11-01 on Luna rounds 1 and 2: about 45M tokens per 1% of the weekly Codex window.
TOKENS_PER_PERCENT = 45_000_000


def own_tokens(root):
    """Total tokens of every call this task has made: the receipts of every run under root."""
    total = 0
    for receipt in root.glob("**/calls/*/*/receipt.json"):
        try:
            for att in json.loads(receipt.read_text(encoding="utf-8"))["attempts"]:
                total += att.get("usage", {}).get("total_tokens", 0)
        except (OSError, ValueError, KeyError):
            continue
    return total


class Quota:
    """Our share of the Codex window: closed once this task's own calls (all runs under root) reach cap percent,
    counted in tokens at TOKENS_PER_PERCENT, or once Codex no longer allows ordinary usage. Checked at most once a
    minute; the account-wide used percent is read too and reported."""
    def __init__(self, cap, root):
        self.cap, self.root = cap, root
        self.checked, self.used, self.own, self.allowed, self.lock = 0.0, 0.0, 0.0, True, threading.Lock()

    def open(self):
        with self.lock:
            if time.time() - self.checked > 60:
                self.own = own_tokens(self.root) / TOKENS_PER_PERCENT
                try:
                    l = limits.rate_limits()
                    self.used, self.allowed = limits.used_percent(l), bool(l.get("ordinaryUsageAllowed", True))
                except Exception as exc:  # an unreadable limit is reported; our own count still governs
                    print(json.dumps({"quota_read_error": str(exc)[:300]}), flush=True)
                self.checked = time.time()
            return self.allowed and self.own < self.cap


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--queue", type=Path, required=True)
    p.add_argument("--known", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--model", default="gpt-6-luna")
    p.add_argument("--effort", default="low")
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--cap", type=float, default=30.0, help="Percent of the Codex window this task's own calls may use (all runs under --own-root)")
    p.add_argument("--own-root", type=Path, help="Folder holding every run of this task (default: the parent of --out)")
    p.add_argument("--attempts", type=int, default=2)
    p.add_argument("--timeout", type=int, default=900)
    p.add_argument("--exhaustive", action="store_true", help="Add the instruction to go part by part until everything is covered")
    a = p.parse_args()
    if not a.model.startswith("gpt-6-luna"):
        sys.exit("this task runs on Luna only")
    folders = [Path(x) for x in json.loads(a.queue.read_text(encoding="utf-8"))] if a.queue.is_file() else \
        [d for d in sorted(a.queue.iterdir()) if (d / "fields.json").is_file()]
    families = json.loads(a.known.read_text(encoding="utf-8"))["families"]
    a.out.mkdir(parents=True, exist_ok=True)
    schema_path = a.out / "schema.json"
    atomic_json(schema_path, SCHEMA)
    results = a.out / "results.jsonl"
    done = {json.loads(l)["id"] for l in results.read_text(encoding="utf-8").splitlines() if l.strip()} if results.exists() else set()
    todo = [f for f in folders if f.name not in done]
    args = SimpleNamespace(model=a.model, effort=a.effort, attempts=a.attempts, max_calls=None, timeout=a.timeout)
    quota, write_lock, stopped = Quota(a.cap, a.own_root or a.out.parent), threading.Lock(), threading.Event()
    print(json.dumps({"queue": len(folders), "already_read": len(folders) - len(todo), "to_read": len(todo), "model": a.model, "effort": a.effort, "cap": a.cap}), flush=True)

    def read(folder):
        if stopped.is_set() or not quota.open():
            stopped.set(); return None
        fields = json.loads((folder / "fields.json").read_text(encoding="utf-8"))
        answer = call(prompt_for(folder, families, a.exhaustive), schema_path, [], a.out / "calls" / folder.name, args, checker(folder),
                      dispatch=backend.invoke, policy=POLICY, cache_key=f"cl-read-{folder.name}")
        row = {"id": folder.name, "cell": fields.get("_cell"), "cluster_id": fields.get("cluster_id"), "model": a.model, "effort": a.effort,
               "known_seen": answer["known_seen"], "new_items": answer["new_items"]}
        with write_lock:
            with open(results, "a", encoding="utf-8") as w:
                w.write(json.dumps(row, ensure_ascii=False) + "\n")
        return row

    t0, n, errors = time.time(), 0, 0
    with ThreadPoolExecutor(a.workers) as ex:
        for fut in as_completed([ex.submit(read, f) for f in todo]):
            try:
                row = fut.result()
                if row is not None:
                    n += 1
                    if n % 25 == 0:
                        print(json.dumps({"read": n, "seconds": round(time.time() - t0), "own_percent": round(quota.own, 2), "account_used": quota.used}), flush=True)
            except Exception as exc:
                errors += 1
                print(json.dumps({"error": str(exc)[-300:]}), flush=True)
    usage = {}
    for receipt in (a.out / "calls").glob("*/*/receipt.json"):
        for att in json.loads(receipt.read_text(encoding="utf-8"))["attempts"]:
            for k, v in att.get("usage", {}).items():
                usage[k] = usage.get(k, 0) + v
    print(json.dumps({"read": n, "errors": errors, "stopped_at_cap": stopped.is_set(), "own_percent": round(quota.own, 2), "account_used": quota.used,
                      "seconds": round(time.time() - t0), "usage": usage}), flush=True)


if __name__ == "__main__":
    main()
