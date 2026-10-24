"""What a document's numbering is, decided once for the whole document (CONVENTIONS section 6).

The lines pass reads three pages at a time and cannot see whether "9." belongs to the document's
own running paragraphs or to a list, so it only transcribes the printed marker. This module finds
the document's numbered runs over all of its body units and says what each run is:

  paragraph  the document's own numbered paragraphs, clauses, sections or recitals: text, marked
  list       the items of a list inside or after a paragraph: list_item, marked
  plain      not numbering (speaker labels, transcript line numbers, field labels): text, unmarked
  option     a form's checkbox options: list_item, unmarked

A run is the units of one numbering family whose count continues, wherever they fall: paragraph 18
continues paragraph 17's run across the (a) to (c) list between them. A letter, roman or bullet run
that a lead-in ending in a colon opens at its first value is a list by rule; the numbering pass
decides every other run, one answer per run (author.py author_numbering).
"""
import gzip
import json
import re

import hierarchy

BODY = ("text", "list_item")
KINDS = ("paragraph", "list", "plain", "option")
REGION = {"paragraph": "text", "list": "list_item", "plain": "text", "option": "list_item"}
MARKED = {"paragraph", "list"}
ROMAN = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100}
LEAD = re.compile(r"(:|—|:-|:—)$")


def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def flat(text):
    return " ".join(text.replace("\t", " ").split())


def numbered(typed, groups):
    """[(unit, family, marker, first-line text)] for body units that open with a printed marker."""
    found, open_letter = [], None
    for u, members in enumerate(groups):
        first = typed[members[0]]
        if first["region"] not in BODY or not first.get("markers"):
            continue
        text = first["text"]
        marker = text.split("\t", 1)[0].strip() if "\t" in text else flat(text)[:8]
        family = hierarchy.numbering(text, open_letter) or "other"
        if family == "al":
            open_letter = marker.strip("().[]").lower()[-1:] or None
        found.append((u, family, marker, flat(text)))
    return found


def count(marker, family):
    """The marker's place in its count (a tuple for decimal numbering), or None when uncounted."""
    token = marker.strip("()[].:- ")
    if family == "num" and token.isdigit():
        return (int(token),)
    if family.startswith("dec"):
        parts = [p for p in token.split(".") if p]
        return tuple(int(p) for p in parts) if parts and all(p.isdigit() for p in parts) else None
    if family in ("al", "AU") and len(token) == 1:
        return (ord(token.lower()),)
    if family in ("rl", "RU") and token and all(c in ROMAN for c in token.lower()):
        values = [ROMAN[c] for c in token.lower()]
        return (sum(-v if k + 1 < len(values) and v < values[k + 1] else v for k, v in enumerate(values)),)
    return None


def follows(before, after):
    """Whether a count continues: n then n+1, or 2.3 then 2.4, 3 or 3.1."""
    if len(before) == 1 and len(after) == 1:
        return after[0] == before[0] + 1
    if len(after) == len(before) and after[:-1] == before[:-1]:
        return after[-1] == before[-1] + 1
    return after[0] == before[0] + 1 or (after[0] == before[0] and len(after) > len(before))


def runs(found):
    """The document's numbered runs: a counted unit joins the most recent run of its family whose
    count it continues, wherever that run stands (paragraph 18 resumes 1 to 17 after a list of its
    own 1 to 6); an uncounted one (a bullet) only the run just before it."""
    result, of_family, last = [], {}, None
    for item in found:
        family, after = item[1], count(item[2], item[1])
        joined = None
        for k in reversed(of_family.get(family, [])):
            before = count(result[k][-1][2], family)
            if (follows(before, after) if before and after else k == last):
                joined = k
                break
        if joined is None:
            result.append([item]); joined = len(result) - 1
            of_family.setdefault(family, []).append(joined)
        else:
            result[joined].append(item)
        last = joined
    return result


def lead(typed, groups, unit):
    """The end of the unit before `unit`: ("heading" or "body", its last 80 characters)."""
    if unit == 0:
        return None
    before = typed[groups[unit - 1][-1]]
    return ("heading" if before["region"] == "heading" else "body", flat(before["text"])[-80:])


def by_rule(typed, groups, run):
    """A run's kind where the convention fixes it without judgement, else None."""
    unit, family, marker = run[0][:3]
    first = count(marker, family)
    opens = family == "bullet" or (family in ("al", "AU", "rl", "RU") and first in ((1,), (ord("a"),)))
    before = lead(typed, groups, unit)
    return "list" if opens and before and before[0] == "body" and LEAD.search(before[1]) else None


def listing(typed, groups, found_runs, asked):
    """The prompt's view of the runs the pass decides, with the rule-decided ones as context."""
    out = []
    for k, run in enumerate(found_runs, 1):
        unit = run[0][0]
        pages = typed[groups[unit][0]]["page"], typed[groups[run[-1][0]][0]]["page"]
        head = f"R{k} | {len(run)} units | pages {pages[0]}-{pages[1]} | {run[0][2]} .. {run[-1][2]}"
        if k - 1 not in asked:
            out.append(head + " | list (decided)")
            continue
        out.append(head)
        before = lead(typed, groups, unit)
        if before:
            out.append(f"   after {'heading' if before[0] == 'heading' else 'text'}: ...{before[1]}")
        for item in (run[:2] + run[-1:]) if len(run) > 2 else run:
            out.append(f"   {item[3][:110]}")
    return "\n".join(out)


def apply(typed, groups, found_runs, kinds):
    """Each run's kind written onto its units: regions and markers. Returns the changes made."""
    changes = []
    for k, (run, kind) in enumerate(zip(found_runs, kinds), 1):
        region = REGION[kind]
        for unit, family, marker, text in run:
            members = groups[unit]
            old = typed[members[0]]["region"]
            unmark = kind not in MARKED
            if old == region and not unmark:
                continue
            for t in members:
                typed[t]["region"] = region
            if unmark:
                typed[members[0]]["markers"] = []
            changes.append({"unit": unit, "run": k, "kind": kind, "from": old, "to": region, "text": text[:80]})
    return changes
