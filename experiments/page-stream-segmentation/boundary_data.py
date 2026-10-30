"""Source-page labels and measurements; no PDF parsing or boundary inference."""
from collections import Counter
import os
from pathlib import Path
import re
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
DEFAULT_OUT = ROOT / "benchmarks/local-data/page-stream-segmentation"
sys.path[:0] = [str(ROOT / "tools"), str(ROOT / "experiments/legal-structure-gold"), str(ROOT / "experiments/legal_pdf_corpus")]
from codex_runner.artifacts import atomic_json, digest, fingerprint, read_json
from corpus_store import HOME
from hierarchy import UNLEVELLED as UNRANKED


def corpus_home():
    return HOME.resolve()


def read_catalogue(home):
    """The corpus catalogue, read-only."""
    path = home / "corpus" / "corpus.sqlite"
    # Immutable avoids SQLite shared-memory writes; refuse an uncheckpointed WAL.
    wal = path.with_name(path.name + "-wal")
    if wal.exists() and wal.stat().st_size:
        raise ValueError("Catalogue has an active WAL; use a checkpointed read-only snapshot")
    db = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    db.row_factory = sqlite3.Row
    return db


def source_path(source, home):
    roots = {"openlegaldata": home.resolve(), "repository": ROOT}
    root = roots[source["storage"]]
    # The corpus deliberately uses collection junctions to other backing drives.
    path = Path(os.path.abspath(root / source["path"]))
    if not path.is_relative_to(root):
        raise ValueError("Source path escapes its owning store")
    return path


def validate_pages(pages, page_count):
    if (not isinstance(pages, list) or not pages
            or any(type(p) is not int or not 1 <= p <= page_count for p in pages)
            or pages != sorted(set(pages))):
        raise ValueError("pages must be sorted, unique, original 1-based physical page numbers")
    return pages


def validate_sha(sha):
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise ValueError("Expected an original PDF SHA256")
    return sha


def annotation_decisions(part, page_count):
    """Validate source parts without converting internal line starts to page edges.

    A decision on page p covers its top edge and its lines, so a line start, like a
    page start, needs page p - 1 in the scope; only physical page 1 has no top edge.
    """
    pages = validate_pages(part["pages"], page_count)
    selected = set(pages)
    gaps = {p for p in selected if p - 1 in selected}
    if "document_starts" not in part:
        return {}
    starts = part["document_starts"]
    if not isinstance(starts, list):
        raise ValueError("document_starts must be a list")
    edges = [s for s in starts if type(s) is int]
    if edges != sorted(set(edges)) or not set(edges) <= gaps:
        raise ValueError("Page starts must be sorted internal pages with their preceding page in scope")
    decisions, seen = {p: [] for p in sorted(gaps)}, set()
    for start in starts:
        if type(start) is int:
            page, key = start, (start, None)
        elif (isinstance(start, dict) and set(start) == {"page", "line_id", "text"}
              and type(start["page"]) is int and (start["page"] in gaps or start["page"] == 1 and 1 in selected)
              and isinstance(start["line_id"], str) and start["line_id"]
              and isinstance(start["text"], str)):
            page, key = start["page"], (start["page"], start["line_id"])
        else:
            raise ValueError("A line start must name page 1 or a page whose preceding page is selected, a packet line_id and its text")
        if key in seen:
            raise ValueError("Repeated document start")
        seen.add(key)
        decisions.setdefault(page, []).append(start)
    return decisions


def annotation_labels(part, page_count):
    """Project only physical page edges; line starts stay in the source annotation."""
    selected = set(part["pages"])
    return {p: int(p in starts) for p, starts in annotation_decisions(part, page_count).items()
            if p - 1 in selected}


def structure_labels(gold, unread_pages=()):
    """Project existing v4 flags, retaining unrepresentable boundaries as unknown.

    Page starts must be at the first ranked typed line, in the gold's reading
    order. Never round a within-page start to a page edge. Ends without a next
    start can resume an enclosing document; leave that edge for review.
    """
    if gold["schema_version"] != "legal-structure-gold.v4":
        raise ValueError("Expected structure gold v4")
    count, typed = gold["page_count"], gold["typed"]
    first, last = {}, {}
    for i, line in enumerate(typed):
        if line["region"] not in UNRANKED and line.get("spans"):
            first.setdefault(line["page"], i)
            last[line["page"]] = i
    starts, uncertain, within = set(), set(), set()
    for unit in gold["units"]:
        members = unit["lines"]
        if not members:
            continue
        opening, closing = typed[members[0]]["page"], typed[members[-1]]["page"]
        if unit["starts_document"]:
            if members[0] == first.get(opening):
                if opening > 1:
                    starts.add(opening)
            else:
                within.add(opening)
                uncertain.update((opening, opening + 1))
        if unit["ends_document"] and closing < count:
            uncertain.add(closing + 1)
            if members[-1] != last.get(closing):
                within.add(closing)
                uncertain.add(closing)
    # Explicit starts settle an end/start pair, but never a mixed-document page.
    uncertain -= starts
    for p in within:
        uncertain.update((p, p + 1))
    for p in set(range(1, count + 1)) - first.keys() | set(unread_pages):
        uncertain.update((p, p + 1))
    return ({p: int(p in starts) for p in range(2, count + 1) if p not in uncertain}, sorted(within))


def combine_labels(votes):
    """Conflicting accepted annotations stay unknown, with a reviewable inventory."""
    values = {}
    for labels in votes:
        for page, label in labels.items():
            values.setdefault(int(page), {})[fingerprint(label)] = label
    return ({p: next(iter(v.values())) for p, v in values.items() if len(v) == 1},
            sorted(p for p, v in values.items() if len(v) != 1))


def compact_scopes(sha, labels):
    """Represent partial review with just complete scopes and internal starts."""
    scopes = []
    for page, label in sorted(labels.items()):
        if not scopes or scopes[-1]["pages"][-1] != page - 1:
            scopes.append({"sha256": sha, "pages": [max(1, page - 1)], "document_starts": []})
        if scopes[-1]["pages"][-1] != page:
            scopes[-1]["pages"].append(page)
        if isinstance(label, list):
            scopes[-1]["document_starts"].extend(s for s in label if s != 1)
        elif label and page > 1:
            scopes[-1]["document_starts"].append(page)
    return scopes


def check_partitions(sources):
    families, seen = {}, set()
    for source in sources:
        sha, family, split = source["sha256"], source["family_id"], source["split"]
        validate_sha(sha)
        if sha in seen or not family or split not in {"train", "development", "test", "unassigned"}:
            raise ValueError("Invalid or repeated source partition")
        seen.add(sha)
        if families.setdefault(family, split) != split:
            raise ValueError("One source family crosses partitions")


def segments(page_count, starts):
    edges = [1, *sorted(starts), page_count + 1]
    return set(zip(edges[:-1], (p - 1 for p in edges[1:])))


def measure(sources, predictions):
    """Predictions: {sha: {right_page: 0|1}}. Missing predictions are abstentions."""
    counts, lengths = Counter(), {}
    for source in sources:
        labels = {int(p): v for p, v in source["labels"].items()}
        predicted = predictions.get(source["sha256"], {})
        count = source["page_count"]
        if any(type(p) is not int or not 2 <= p <= count or type(v) is not int or v not in (0, 1)
               for p, v in predicted.items()):
            raise ValueError("Predictions must identify physical gaps with binary labels")
        counts["known_gaps"] += len(labels)
        counts["unknown_gaps"] += count - 1 - len(labels)
        for p, wanted in labels.items():
            if p not in predicted:
                counts["abstained_gaps"] += 1
                continue
            counts["scored_gaps"] += 1
            counts[{(1, 1): "true_splits", (0, 1): "false_splits", (1, 0): "missed_splits", (0, 0): "true_continuations"}[wanted, predicted[p]]] += 1
        # Partial review must never inflate exact-packet or exact-document scores.
        if count < 2 or len(labels) != count - 1 or source.get("within_page"):
            counts["incomplete_gold_packets"] += 1
            continue
        counts["complete_gold_packets"] += 1
        bucket = "2-9" if count < 10 else "10-49" if count < 50 else "50+"
        row = lengths.setdefault(bucket, {"packets": 0, "fully_predicted": 0, "exact": 0})
        row["packets"] += 1
        if not labels.keys() <= predicted.keys():
            continue
        counts["fully_predicted_packets"] += 1
        row["fully_predicted"] += 1
        exact = all(predicted[p] == v for p, v in labels.items())
        counts["exact_packets"] += exact
        row["exact"] += exact
        wanted = segments(count, [p for p, v in labels.items() if v])
        got = segments(count, [p for p, v in predicted.items() if v])
        counts["gold_documents"] += len(wanted)
        counts["predicted_documents"] += len(got)
        counts["exact_documents"] += len(wanted & got)
    ratio = lambda a, b: a / b if b else None
    tp, fp, fn = counts["true_splits"], counts["false_splits"], counts["missed_splits"]
    return {"counts": dict(counts), "precision": ratio(tp, tp + fp), "recall": ratio(tp, tp + fn),
            "f1": ratio(2 * tp, 2 * tp + fp + fn),
            "coverage": ratio(counts["scored_gaps"], counts["known_gaps"]),
            "exact_packet_rate": ratio(counts["exact_packets"], counts["complete_gold_packets"]),
            "document_f1_on_fully_predicted_packets": ratio(2 * counts["exact_documents"], counts["gold_documents"] + counts["predicted_documents"]),
            "packet_lengths": lengths}
