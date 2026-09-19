"""Three landed-run tasks, each with its own Jev configuration.

task framing     legal-grounding-framing holdout: exact quote + source evidence +
                 framing claim -> supported / contradicted / insufficient.
                 Baseline: the Opus 5 semantic checker verdicts already on disk.
task treatment   a2aj-case-treatment gold: given the containing decision, the
                 target decision and the treating passage -> treatment signal.
                 Baseline: Luna Max 77.8%, Sol Low 64.1%, Terra Max 51.5%.

Usage: python run_tasks.py framing [--limit N] [--tag TAG]
"""
import argparse
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

BASE = pathlib.Path(__file__).resolve().parent
RECEIPTS = BASE / "receipts"
API_URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
FRAMING = BASE.parent / "legal_grounding_framing" / "receipts"

TREATMENT_SIGNALS = ["explained", "approved", "followed", "applied", "extended",
                     "distinguished", "limited", "criticized", "questioned",
                     "not_followed", "overruled", "other"]


def api_key():
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        raise SystemExit("TYPESAFE_API_KEY is not set")
    return key


def call(state, questions, note, tag):
    body = {"model": MODEL, "state": state, "questions": questions}
    payload = json.dumps(body).encode("utf-8")
    for attempt in range(4):
        request = urllib.request.Request(
            API_URL, data=payload, method="POST",
            headers={"Authorization": "Bearer " + api_key(),
                     "Content-Type": "application/json"})
        start = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                result = json.load(response)
            record = {"ok": True, "note": note, "request": body, "response": result,
                      "elapsed_seconds": round(time.perf_counter() - start, 3)}
            break
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            if error.code in (429, 529) and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            record = {"ok": False, "note": note, "request": body, "http_status": error.code,
                      "error": detail, "elapsed_seconds": round(time.perf_counter() - start, 3)}
            break
    with (RECEIPTS / ("live-%s.jsonl" % tag)).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def framing_questions():
    return {
        "verdict": {
            "type": "choice",
            "instructions": ("A quotation supports a statement only if the source text, taken as a "
                             "whole, actually says what the statement says. The statement may not add "
                             "conditions, widen the rule, or rely on general legal knowledge not in "
                             "the source text. If the statement adds to or widens the source, answer "
                             "unsupported even if the quotation is genuinely in the source."),
            "criteria": {
                "supported": "The source text, taken as a whole, states or directly implies the statement, with nothing added or widened.",
                "contradicted": "The source text says something materially different from the statement.",
                "unsupported": "The statement is not established by the source text: it adds conditions, widens the rule, generalizes beyond it, or is simply not stated.",
            },
        },
        "supported": {
            "type": "noul",
            "instructions": ("Does the source text, taken as a whole, state or directly imply the "
                             "statement, with nothing added or widened?"),
            "criteria": {"true": "The source states or directly implies the statement as written.",
                         "false": "The statement adds to, widens, or is not established by the source."},
        },
    }


def run_framing(limit, tag, claims_file=None, verdicts_file=None):
    claims = [json.loads(line) for line in
              (FRAMING / (claims_file or "natural-qf-holdout-luna-512-v1.jsonl")).read_text(encoding="utf-8").splitlines()]
    verdicts = {}
    for line in (FRAMING / (verdicts_file or "natural-qf-holdout-opus5-512-v1.jsonl")).read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        verdicts[record.get("row_id")] = record.get("verdict")
    rows = []
    for claim in claims[:limit] if limit else claims:
        evidence = claim.get("evidence_texts") or []
        context = "\n---\n".join(text for text in evidence if isinstance(text, str))[:6000]
        state = {
            "cited_decision": claim.get("citation"),
            "exact_quotation": claim.get("exact_quote"),
            "source_text": context,
            "framing_claim": claim.get("claim_text") or claim.get("claim"),
        }
        row_id = claim.get("id") or claim.get("cell_id") or claim.get("claim_id")
        record = call(state, framing_questions(), "framing:%s" % row_id, tag)
        if not record["ok"]:
            rows.append({"row_id": row_id, "error": record.get("error")})
            print(json.dumps(rows[-1])); continue
        answers = record["response"]["answers"]
        proxy = verdicts.get(row_id)
        got = answers["verdict"]["choice"]
        proxy_adverse = {"insufficient", "contradicted"}
        got_adverse = {"unsupported", "contradicted"}
        rows.append({"row_id": row_id, "citation": claim.get("citation"),
                     "arm": claim.get("arm"), "proxy_label": proxy, "got": got,
                     "supported_p": answers["supported"]["noul"],
                     "confidence": answers["verdict"].get("confidence"),
                     "matches_proxy": proxy == got,
                     "proxy_adverse_caught": (proxy in adverse) and (got in adverse),
                     "proxy_false_adverse": (proxy == "supported") and (got in adverse),
                     "usage": record["response"]["usage"],
                     "elapsed_seconds": record["elapsed_seconds"]})
        print(json.dumps({k: rows[-1][k] for k in ("row_id", "proxy_label", "got",
                                                   "matches_proxy", "supported_p", "confidence")}))
    (RECEIPTS / ("framing-%s.json" % tag)).write_text(json.dumps(rows, indent=2), encoding="utf-8")
    scored = [r for r in rows if r.get("proxy_label")]
    print("NOTE: proxy_label is an Opus checker verdict, explicitly not human gold.")
    print("SCORED %d  matches_proxy %d  proxy-adverse caught %d  proxy-false-adverse %d" % (
        len(scored), sum(1 for r in scored if r["matches_proxy"]),
        sum(1 for r in scored if r["proxy_adverse_caught"]),
        sum(1 for r in scored if r["proxy_false_adverse"])))


def treatment_questions():
    return {
        "signal": {
            "type": "choice",
            "instructions": ("In the passage, what is the containing court's treatment of the cited decision? "
                             "Choose the single best signal for how the opinion uses that authority."),
            "criteria": {
                "explained": "Sets out what the cited decision says without adopting or rejecting it.",
                "approved": "Expressly endorses the cited decision or its reasoning.",
                "followed": "Applies the cited decision as binding or persuasive authority.",
                "applied": "Uses the cited decision's rule or test on the facts here.",
                "extended": "Carries the cited decision's principle further than it went.",
                "distinguished": "Finds the cited decision inapplicable on materially different facts or issues.",
                "limited": "Narrows the scope of the cited decision.",
                "criticized": "Disapproves of the cited decision without refusing to follow it.",
                "questioned": "Doubts the cited decision's correctness or continuing force.",
                "not_followed": "Declines to follow the cited decision.",
                "overruled": "Deprives the cited decision of authority.",
                "other": "Some other treatment.",
            },
        },
        "adverse": {
            "type": "noul",
            "instructions": "Is the treatment adverse to the cited decision (questioned, criticized, not followed, overruled, distinguished, or limited)?",
        },
    }


def run_treatment(limit, tag, slate=None):
    records = [json.loads(line) for line in
               (BASE.parent.parent / "backend/experiments/a2aj-case-treatment/gold/gold.jsonl")
               .read_text(encoding="utf-8").splitlines()]
    if slate:
        ids = {json.loads(line)["document_id"] for line in
               (BASE.parent.parent / slate).read_text(encoding="utf-8").splitlines() if line.strip()}
        records = [record for record in records if record["document_id"] in ids]
        print("slate %s -> %d gold records" % (slate, len(records)))
    sys.path.insert(0, str(BASE))
    from inspect_sources import source
    items = []
    for record in records:
        for cited in record["annotation"]["analysis"]["cited_decisions"]:
            for treatment in cited.get("treatments") or []:
                items.append((record, cited, treatment))
    if limit:
        items = items[:limit]
    print("treatments to score: %d" % len(items))
    rows = []
    for record, cited, treatment in items:
        try:
            text = source(record["document_id"])["unofficial_text_en"]
        except Exception as error:
            rows.append({"document_id": record["document_id"], "error": str(error)}); continue
        spans = treatment.get("evidence_spans") or []
        start_quote = (spans[0].get("start_quote") or "") if spans else ""
        at = text.find(start_quote) if start_quote else -1
        if at < 0:
            proposition = (treatment.get("proposition") or "")[:80]
            at = text.find(proposition) if proposition else -1
        if at < 0:
            rows.append({"document_id": record["document_id"],
                         "treatment_id": treatment.get("treatment_id"),
                         "error": "evidence span not located"}); continue
        # Give the model the decision itself: the whole text, split only when it
        # exceeds what one request can carry.
        cap = 120000
        if len(text) <= cap:
            portions = [(0, len(text), 1, 1)]
        else:
            bounds = []
            start = 0
            while start < len(text):
                end = min(len(text), start + cap)
                if end < len(text):
                    newline = text.rfind("\n", start + cap - 2000, end)
                    if newline > start:
                        end = newline + 1
                bounds.append((start, end))
                start = end
            portions = [(a, b, i + 1, len(bounds)) for i, (a, b) in enumerate(bounds)]
        portion = next((p for p in portions if p[0] <= at < p[1]), portions[0])
        a, b, index, total = portion
        state = {
            "containing_decision": record["citation"],
            "cited_decision": (cited.get("identifying_span") or {}).get("start_quote"),
            "decision_text": text[a:b],
            "portion": "%d of %d" % (index, total),
        }
        note = "treatment:%s:%s" % (record["document_id"], treatment.get("treatment_id"))
        response = call(state, treatment_questions(), note, tag)
        if not response["ok"]:
            rows.append({"document_id": record["document_id"], "error": response.get("error")}); continue
        answers = response["response"]["answers"]
        gold = treatment.get("signals") or []
        got = answers["signal"]["choice"]
        rows.append({"document_id": record["document_id"], "citation": record["citation"],
                     "treatment_id": treatment.get("treatment_id"), "gold_signals": gold, "got": got,
                     "in_gold_set": got in gold, "exact_primary": bool(gold) and got == gold[0],
                     "adverse_gold": bool(set(gold) & {"questioned", "criticized", "not_followed",
                                                       "overruled", "distinguished", "limited"}),
                     "adverse_got": answers["adverse"]["noul"],
                     "confidence": answers["signal"].get("confidence"),
                     "usage": response["response"]["usage"],
                     "elapsed_seconds": response["elapsed_seconds"]})
    (RECEIPTS / ("treatment-task-%s.json" % tag)).write_text(json.dumps(rows, indent=2), encoding="utf-8")
    scored = [r for r in rows if "got" in r]
    print("treatments scored %d" % len(scored))
    if scored:
        print("signal in gold set: %d/%d (%.1f%%)" % (
            sum(1 for r in scored if r["in_gold_set"]), len(scored),
            100 * sum(1 for r in scored if r["in_gold_set"]) / len(scored)))
        print("exact primary match: %d/%d (%.1f%%)" % (
            sum(1 for r in scored if r["exact_primary"]), len(scored),
            100 * sum(1 for r in scored if r["exact_primary"]) / len(scored)))
        print("adverse recall: %d/%d" % (
            sum(1 for r in scored if r["adverse_gold"] and r["adverse_got"] >= 0.5),
            sum(1 for r in scored if r["adverse_gold"])))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("task", choices=["framing", "treatment"])
    parser.add_argument("--limit", type=int)
    parser.add_argument("--tag", default="task")
    parser.add_argument("--slate")
    parser.add_argument("--claims", help="claims jsonl under legal_grounding_framing/receipts")
    parser.add_argument("--verdicts", help="opus checker verdicts jsonl under the same directory")
    args = parser.parse_args()
    RECEIPTS.mkdir(parents=True, exist_ok=True)
    if args.task == "framing":
        run_framing(args.limit, args.tag, args.claims, args.verdicts)
    else:
        run_treatment(args.limit, args.tag, args.slate)


if __name__ == "__main__":
    main()
