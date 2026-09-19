"""Live Jev runner for the attribution/boundary adaptation experiment.

Standalone: reads the frozen benchmark selections and local A2AJ source text,
sends adapted TypeSafe System One requests, and appends every raw call to
receipts/live.jsonl. No Codex adapter, no existing judge, no benchmark mutation.

Stages:
  boundaries  one Choice per boundary point over line ids (documented line-id
              pattern), plus a count Choice and a Noul multi-opinion check.
  attribution atomic questions per frozen passage: who authored the excerpt
              words, who advanced the proposition, whether the present court
              adopts it, and whether the passage is a quotation.
  treatment   the retired fine-grained vocabulary (target identity, legal actor,
              reduced treatment label) applied to one frozen target occurrence.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

BASE = pathlib.Path(__file__).resolve().parent
RECEIPTS = BASE / "receipts"
LIVE = RECEIPTS / "live.jsonl"
API_URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"

MAX_OPINIONS = 5
BEGIN_CHUNK = 150
SELECTION = "noul"
LEGAL_ACTORS = ["current_court", "party_or_counsel", "decision_under_review",
                "other_source", "metadata", "unclear"]
TREATMENT_LABELS = ["referred_to", "explained", "followed", "applied",
                    "distinguished", "limited", "not_followed", "questioned",
                    "overruled", "unclassified"]
WORD_OWNERS = ["present_court", "cited_authority", "decision_under_review",
               "party_or_counsel", "other_source", "unclear"]


def api_key():
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        raise SystemExit("TYPESAFE_API_KEY is not set")
    return key


def call(state, questions, note):
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
            record = {"ok": False, "note": note, "request": body,
                      "http_status": error.code, "error": detail,
                      "elapsed_seconds": round(time.perf_counter() - start, 3)}
            break
    with LIVE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def numbered_text(packet):
    return "\n".join("L%03d| %s" % (line["line"], line["text"]) for line in packet["lines"])


def boundary_questions(packet):
    options = {"L%03d" % line["line"]: None for line in packet["lines"]}
    questions = {
        "opinion_count": {
            "type": "choice",
            "instructions": (
                "How many separately authored substantive opinions does this decision contain? "
                "Count each set of reasons with its own author or author heading (lead, concurring, "
                "or dissenting) as one opinion. A joint opinion authored by several judges is one opinion."),
            "criteria": {str(n): None for n in range(1, MAX_OPINIONS + 1)},
        },
        "has_multiple_opinions": {
            "type": "noul",
            "instructions": "Does this decision contain more than one separately authored substantive opinion?",
        },
    }
    for index in range(1, MAX_OPINIONS + 1):
        questions["start_%d" % index] = {
            "type": "choice",
            "instructions": (
                "Opinion %d of this decision: which line is its FIRST line? The first line is: "
                "(a) the body heading that introduces those reasons when one immediately precedes them, "
                "for example 'JUDGMENT AND REASONS', 'ORDER', 'COSTS ENDORSEMENT', "
                "'APPEAL BOOK ENDORSEMENT', or 'SUMMARY OF APPEAL/RESPONSE'; or "
                "(b) a delivery line such as 'By the Court:' or 'The judgment of the Court was delivered by'; or "
                "(c) the first numbered paragraph of those reasons, including an author name written inside "
                "that same paragraph, such as '1 Fish J. - ...' or '[1] FISHER J.A.: ...'. "
                "Do NOT start at front matter: the style of cause, court name, dates, docket, counsel, "
                "'Before:' or 'Coram:' lists, 'Written Reasons by:' or 'Concurred in by:' lists, or a "
                "headnote or Summary block. Do NOT start at a standalone author-name line that sits on its "
                "own line before the paragraphs, such as 'DESJARDINS J.A. (Dissenting Reasons)' or "
                "'Reasons for Judgment of the Honourable Madam Justice Fenlon:'. "
                "If there is no opinion %d, choose the line 'L001'." % (index, index)),
            "criteria": options,
        }
        questions["end_%d" % index] = {
            "type": "choice",
            "instructions": (
                "Opinion %d of this decision: which line is its LAST line? The last line is the final line "
                "of that opinion's substance, including its final numbered paragraphs and any trailing "
                "disposition, formal judgment or order block, date line, bullet list, or post-judgment "
                "exchange that belongs to it. Exclude only a judge's quoted name standing alone as a "
                "signature and any 'I AGREE:' line. Do not stop at the last numbered paragraph when "
                "substantive order or disposition lines follow it. "
                "If there is no opinion %d, choose the line 'L001'." % (index, index)),
            "criteria": options,
        }
    return questions


def boundary_state(packet):
    return {
        "document": packet["citation"],
        "court_dataset": packet["cohort"],
        "line_format": "Each line is prefixed with its id, as in 'L039| [1] text...'.",
        "numbered_text": numbered_text(packet),
    }


def gold_bounds(packet):
    gold = packet["gold"]
    if isinstance(gold, dict):
        return [{"start_line": o["boundary"]["start_line"], "end_line": o["boundary"]["end_line"]}
                for o in gold["opinions"]]
    return [{"start_line": o["start_line"], "end_line": o["end_line"]} for o in gold]


def load_packets(name="boundaries.json"):
    return json.loads((RECEIPTS / name).read_text(encoding="utf-8"))


def resolve_line(choice):
    if not isinstance(choice, str) or not choice.startswith("L"):
        return None
    digits = choice[1:]
    return int(digits) if digits.isdigit() else None


def run_boundaries(only, tag):
    scores = []
    for packet in load_packets():
        if only and packet["document_id"] not in only:
            continue
        note = "boundaries:%s:%d" % (tag, packet["document_id"])
        record = call(boundary_state(packet), boundary_questions(packet), note)
        if not record["ok"]:
            scores.append({"document_id": packet["document_id"], "error": record.get("error"),
                           "http_status": record.get("http_status")})
            print(json.dumps(scores[-1]))
            continue
        answers = record["response"]["answers"]
        # Speculative fan-out: keep only as many opinions as the count question reports.
        try:
            declared = max(1, min(MAX_OPINIONS, int(answers["opinion_count"]["choice"])))
        except (KeyError, TypeError, ValueError):
            declared = MAX_OPINIONS
        predicted = []
        for index in range(1, declared + 1):
            start = resolve_line(answers.get("start_%d" % index, {}).get("choice"))
            end = resolve_line(answers.get("end_%d" % index, {}).get("choice"))
            if start is None or end is None or (index > 1 and start <= 1):
                continue
            predicted.append({"index": index, "start": start, "end": end,
                              "start_confidence": answers["start_%d" % index].get("confidence"),
                              "end_confidence": answers["end_%d" % index].get("confidence")})
        scores.append({"document_id": packet["document_id"], "citation": packet["citation"],
                       "cohort": packet["cohort"],
                       "opinion_count_answer": answers["opinion_count"]["choice"],
                       "has_multiple_answer": answers["has_multiple_opinions"]["noul"],
                       "predicted": predicted,
                       "gold": [{"start": o["boundary"]["start_line"], "end": o["boundary"]["end_line"]}
                                for o in packet["gold"]["opinions"]],
                       "usage": record["response"]["usage"],
                       "elapsed_seconds": record["elapsed_seconds"]})
        print(json.dumps(scores[-1]))
    (RECEIPTS / ("boundary-predictions-%s.json" % tag)).write_text(
        json.dumps(scores, indent=2), encoding="utf-8")


WORD_OWNER_CRITERIA = {
    "present_court": "A judge of the deciding court wrote these words as that court's own statement.",
    "cited_authority": "These words are taken from another decision that the deciding court quotes or refers to.",
    "decision_under_review": "These words are taken from the lower court or tribunal decision being appealed or reviewed.",
    "party_or_counsel": "These words come from a party or counsel, such as a factum, submission, or argument.",
    "other_source": "These words come from something else, such as a statute, textbook, or journal article.",
    "unclear": "The context does not show who these words belong to.",
}


def attribution_state(item, text):
    index = text.find(item["anchor"])
    if index < 0:
        raise SystemExit("anchor not found for %s" % item["id"])
    start = max(0, index - 1500)
    end = min(len(text), index + len(item["anchor"]) + 1500)
    return {
        "deciding_court": item["source"],
        "excerpt": text[index:index + len(item["anchor"])],
        "surrounding_text": text[start:end],
    }


def quote_questions():
    return {
        "words_belong_to": {
            "type": "choice",
            "instructions": "The excerpt in the state: who wrote or spoke these exact words? Identify the original source of the words, not whoever is repeating them.",
            "criteria": WORD_OWNER_CRITERIA,
        },
        "proposition_speaker": {
            "type": "choice",
            "instructions": "The excerpt in the state: whose proposition or assertion is being stated? Identify the person or body whose claim it is, whoever is quoting or reporting it.",
            "criteria": WORD_OWNER_CRITERIA,
        },
        "is_verbatim_quotation": {
            "type": "noul",
            "instructions": "Is the excerpt a verbatim quotation taken from another document, rather than the deciding court's own prose?",
        },
        "advanced_by_party": {
            "type": "noul",
            "instructions": "Is the excerpt presented as something a party or counsel advanced or relied on, rather than something the deciding court itself asserts?",
        },
        "court_endorses": {
            "type": "noul",
            "instructions": "Does the deciding court endorse, adopt, or rely on the proposition stated in the excerpt as correct?",
        },
    }


def relationship_questions():
    return {
        "separate_opinion": {
            "type": "noul",
            "instructions": "Does this passage belong to a separate opinion written by one judge, rather than to the lead reasons of the court?",
        },
        "judge_of_deciding_court": {
            "type": "noul",
            "instructions": "Was the author of this passage a judge of the deciding court in this very case?",
        },
        "agrees_with_disposition": {
            "type": "noul",
            "instructions": "Does the author of this passage agree with the outcome or disposition reached by the lead reasons?",
        },
        "agrees_with_reasoning": {
            "type": "noul",
            "instructions": "Does the author of this passage agree with the reasoning of the lead reasons, not merely the outcome?",
        },
    }


def read_answers(answers):
    out = {}
    for key, answer in answers.items():
        if answer.get("type") == "choice":
            out[key] = answer.get("choice")
        elif answer.get("type") == "noul":
            out[key] = answer.get("noul")
    return out


def run_attribution():
    spec = json.loads((BASE / "attribution-spec.json").read_text(encoding="utf-8"))
    sys.path.insert(0, str(BASE))
    from inspect_sources import source
    rows = []
    for item in spec["items"]:
        text = source(item["document_id"])["unofficial_text_en"]
        questions = relationship_questions() if item.get("kind") == "opinion_relationship" else quote_questions()
        record = call(attribution_state(item, text), questions, "attribution:%s" % item["id"])
        if not record["ok"]:
            rows.append({"id": item["id"], "error": record.get("error")})
            print(json.dumps(rows[-1]))
            continue
        answers = read_answers(record["response"]["answers"])
        judged = {}
        for key, expected in item["expected"].items():
            got = answers.get(key)
            if isinstance(expected, bool):
                judged[key] = {"expected": expected, "got": got,
                               "correct": got is not None and (got >= 0.5) == expected}
            else:
                judged[key] = {"expected": expected, "got": got, "correct": got == expected}
        rows.append({"id": item["id"], "document_id": item["document_id"], "source": item["source"],
                     "kind": item.get("kind", "quote_attribution"), "answers": answers,
                     "judged": judged, "correct": sum(1 for v in judged.values() if v["correct"]),
                     "total": len(judged), "rationale": item["rationale"],
                     "usage": record["response"]["usage"], "elapsed_seconds": record["elapsed_seconds"]})
        print(json.dumps(rows[-1]))
    (RECEIPTS / "attribution-results.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    correct = sum(r.get("correct", 0) for r in rows)
    total = sum(r.get("total", 0) for r in rows)
    print("TOTAL %d/%d" % (correct, total))


def run_treatment():
    spec = json.loads((BASE / "treatment-spec.json").read_text(encoding="utf-8"))
    sys.path.insert(0, str(BASE))
    from inspect_sources import source
    rows = []
    for item in spec["items"]:
        text = source(item["document_id"])["unofficial_text_en"]
        index = text.find(item["anchor"])
        if index < 0:
            raise SystemExit("anchor not found for %s" % item["id"])
        state = {"deciding_court": item["source"], "target_decision": item["target"],
                 "surrounding_text": text[max(0, index - 1500):index + len(item["anchor"]) + 1500]}
        questions = {
            "target_identity": {
                "type": "choice",
                "instructions": "Is the cited target decision in the target_decision field actually being referred to at this point in the text?",
                "criteria": {"target": "Yes, this passage refers to that target decision.",
                             "not_target": "No, this passage refers to a different authority.",
                             "unclear": "The reference cannot be resolved."},
            },
            "legal_actor": {
                "type": "choice",
                "instructions": "Who is acting on or invoking the target decision at this point?",
                "criteria": {
                    "current_court": "A judge of the deciding court, in that court's own voice.",
                    "party_or_counsel": "A party or counsel, in a submission or factum.",
                    "decision_under_review": "The lower court or tribunal decision being reviewed.",
                    "other_source": "A quoted or other non-court source.",
                    "metadata": "Document metadata rather than argument.",
                    "unclear": "The text does not show who is acting.",
                },
            },
            "treatment_operation": {
                "type": "choice",
                "instructions": "What is that actor doing with the target decision at this point?",
                "criteria": {label: None for label in TREATMENT_LABELS},
            },
        }
        record = call(state, questions, "treatment:%s" % item["id"])
        if not record["ok"]:
            rows.append({"id": item["id"], "error": record.get("error")})
            print(json.dumps(rows[-1]))
            continue
        answers = record["response"]["answers"]
        judged = {}
        for key, expected in item["expected"].items():
            answer = answers.get(key, {})
            got = answer.get("choice") if answer.get("type") == "choice" else None
            judged[key] = {"expected": expected, "got": got, "correct": got == expected,
                           "confidence": answer.get("confidence"),
                           "probabilities": answer.get("probabilities")}
        rows.append({"id": item["id"], "document_id": item["document_id"], "source": item["source"],
                     "target": item["target"], "judged": judged,
                     "correct": sum(1 for v in judged.values() if v["correct"]),
                     "total": len(judged), "rationale": item["rationale"],
                     "usage": record["response"]["usage"], "elapsed_seconds": record["elapsed_seconds"]})
        print(json.dumps(rows[-1]))
    (RECEIPTS / "treatment-results.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    print("TOTAL %d/%d" % (sum(r.get("correct", 0) for r in rows), sum(r.get("total", 0) for r in rows)))


CONVENTION = (
    "An opinion is one set of reasons with its own author. For each line decide two things. "
    "BEGINS: this line is the first line of an opinion's reasons body. That is the case when the line "
    "is the reasons heading that introduces that body (for example 'JUDGMENT AND REASONS', 'ORDER', "
    "'COSTS ENDORSEMENT', 'SUMMARY OF APPEAL/RESPONSE'), or a delivery line such as 'By the Court:' or "
    "'The judgment of the Court was delivered by', or the first numbered paragraph of those reasons "
    "(including an author name inside that same paragraph, such as '1 Fish J. - ...' or "
    "'[1] FISHER J.A.: ...'). Front matter never begins an opinion: style of cause, court name, dates, "
    "docket, counsel, 'Before:' or 'Coram:' lists, 'Written Reasons by:' or 'Concurred in by:' lists, "
    "headnotes, and Summary blocks. A standalone author-name line on its own (for example "
    "'DESJARDINS J.A. (Dissenting Reasons)') does not begin an opinion; the following paragraph does. "
    "ENDS: this line is the last line of an opinion's reasons body. Include the final numbered "
    "paragraphs and any trailing disposition, formal judgment or order block, date line, or bullet list "
    "that belongs to that opinion. A judge's quoted name standing alone as a signature, and any "
    "'I AGREE:' line, are not part of any opinion body."
)


def line_questions(packet):
    questions = {}
    for line in packet["lines"]:
        tag = "L%03d" % line["line"]
        questions["b%03d" % line["line"]] = {
            "type": "noul",
            "instructions": "Line %s: does a separately authored opinion's reasons body BEGIN at this line?" % tag,
        }
        questions["e%03d" % line["line"]] = {
            "type": "noul",
            "instructions": "Line %s: is this line the LAST line of a separately authored opinion's reasons body?" % tag,
        }
    return questions


def line_state(packet, convention=CONVENTION):
    return {
        "document": packet["citation"],
        "how_to_decide": convention,
        "line_format": "Each line is prefixed with its id, as in 'L039| [1] text...'.",
        "numbered_text": numbered_text(packet),
    }


def run_lines(only, tag):
    scores = []
    for packet in load_packets():
        if only and packet["document_id"] not in only:
            continue
        note = "lines:%s:%d" % (tag, packet["document_id"])
        record = call(line_state(packet), line_questions(packet), note)
        if not record["ok"]:
            scores.append({"document_id": packet["document_id"], "error": record.get("error"),
                           "http_status": record.get("http_status")})
            print(json.dumps(scores[-1]))
            continue
        answers = record["response"]["answers"]
        begins = [{"line": line["line"], "p": answers["b%03d" % line["line"]]["noul"]}
                  for line in packet["lines"] if answers["b%03d" % line["line"]]["noul"] >= 0.5]
        ends = [{"line": line["line"], "p": answers["e%03d" % line["line"]]["noul"]}
                for line in packet["lines"] if answers["e%03d" % line["line"]]["noul"] >= 0.5]
        predicted = []
        for index, begin in enumerate(begins):
            after = [e for e in ends if e["line"] >= begin["line"]]
            if not after:
                continue
            predicted.append({"index": index + 1, "start": begin["line"], "end": after[0]["line"],
                              "start_p": begin["p"], "end_p": after[0]["p"]})
        scores.append({"document_id": packet["document_id"], "citation": packet["citation"],
                       "cohort": packet["cohort"], "predicted": predicted,
                       "begins": begins, "ends": ends,
                       "gold": [{"start": o["boundary"]["start_line"], "end": o["boundary"]["end_line"]}
                                for o in packet["gold"]["opinions"]],
                       "line_count": len(packet["lines"]),
                       "usage": record["response"]["usage"], "elapsed_seconds": record["elapsed_seconds"]})
        print(json.dumps({k: scores[-1][k] for k in ("document_id", "citation", "cohort", "predicted",
                                                     "gold", "line_count", "usage", "elapsed_seconds")}))
    (RECEIPTS / ("boundary-predictions-%s.json" % tag)).write_text(
        json.dumps(scores, indent=2), encoding="utf-8")


def begin_questions(packet):
    questions = {
        "opinion_count": {
            "type": "choice",
            "instructions": ("How many separately authored substantive opinions does this decision contain? "
                             "Count each set of reasons with its own author as one opinion; a joint opinion is one."),
            "criteria": {str(n): None for n in range(1, MAX_OPINIONS + 1)},
        },
    }
    questions.update({
        "b%03d" % line["line"]: {
            "type": "noul",
            "instructions": "Line L%03d: does a separately authored opinion's reasons body BEGIN at this line?" % line["line"],
        } for line in packet["lines"]
    })
    return questions


def run_hybrid(only, tag, packets_name="boundaries.json"):
    scores = []
    for packet in load_packets(packets_name):
        if only and packet["document_id"] not in only:
            continue
        lines = packet["lines"]
        text_of = {line["line"]: line["text"] for line in lines}
        # Count is asked once on a compact state: front matter plus heading-like
        # lines. Per-line begins are asked in bounded chunks so a long decision
        # does not exceed the request token limit.
        headings = [line for line in lines[60:]
                    if len(line["text"].strip()) < 80
                    and re.search(r"(?i)(J\.A\.|JJ\.|C\.J\.|reasons|by the court|\bper\b)", line["text"])]
        compact = sorted({line["line"]: line for line in lines[:60] + headings[:150]}.values(),
                         key=lambda line: line["line"])
        count_call = call(
            line_state(dict(packet, lines=compact)),
            {"opinion_count": {"type": "choice",
                               "instructions": ("How many separately authored substantive opinions does this "
                                                "decision contain? Count each set of reasons with its own author "
                                                "as one opinion; a joint opinion is one."),
                               "criteria": {str(n): None for n in range(1, MAX_OPINIONS + 1)}}},
            "hybrid:count:%s:%d" % (tag, packet["document_id"]))
        if not count_call["ok"]:
            scores.append({"document_id": packet["document_id"], "error": count_call.get("error")})
            print(json.dumps(scores[-1])); continue
        try:
            count = max(1, min(MAX_OPINIONS, int(count_call["response"]["answers"]["opinion_count"]["choice"])))
        except (KeyError, TypeError, ValueError):
            count = 1
        probabilities = {}
        usage_a = {"input_tokens": count_call["response"]["usage"]["input_tokens"],
                   "output_tokens": count_call["response"]["usage"]["output_tokens"]}
        elapsed_a = count_call["elapsed_seconds"]
        for offset in range(0, len(lines), BEGIN_CHUNK):
            block = lines[offset:offset + BEGIN_CHUNK]
            chunk = call(
                line_state(dict(packet, lines=block)),
                {"b%03d" % line["line"]: {
                    "type": "noul",
                    "instructions": "Line L%03d: does a separately authored opinion's reasons body BEGIN at this line?" % line["line"],
                } for line in block},
                "hybrid:begins:%s:%d:%d" % (tag, packet["document_id"], offset))
            if not chunk["ok"]:
                scores.append({"document_id": packet["document_id"], "error": chunk.get("error")})
                print(json.dumps(scores[-1])); break
            usage_a["input_tokens"] += chunk["response"]["usage"]["input_tokens"]
            usage_a["output_tokens"] += chunk["response"]["usage"]["output_tokens"]
            elapsed_a += chunk["elapsed_seconds"]
            for line in block:
                probabilities[line["line"]] = chunk["response"]["answers"]["b%03d" % line["line"]]["noul"]
        else:
            ranked = sorted(probabilities, key=lambda number: probabilities[number], reverse=True)
            begins = sorted(ranked[:count])
            if not begins:
                scores.append({"document_id": packet["document_id"], "citation": packet["citation"],
                               "cohort": packet.get("cohort"), "predicted": [], "begins": [],
                               "count": count, "gold": gold_bounds(packet),
                               "usage_a": usage_a, "elapsed_seconds": elapsed_a})
                print(json.dumps(scores[-1])); continue
        if not probabilities:
            continue
        # Windowed end Choice, one bounded call per opinion: a Choice accepts at
        # most 255 options, and sending the whole decision as state overflows the
        # request limit on long documents. Candidates are the paragraph-final
        # lines in the window, the granularity a boundary actually lands on.
        text_of = {line["line"]: line["text"] for line in lines}
        def starts_paragraph(value):
            probe = value.strip()
            return bool(re.match(r"^\[?\d+[\]\.]?\s", probe)) or (len(probe) < 60 and probe.endswith(":"))
        last_line = lines[-1]["line"]
        usage_b = {"input_tokens": 0, "output_tokens": 0}
        elapsed_b = 0.0
        predicted = []
        for index, begin in enumerate(begins):
            following = begins[index + 1] if index + 1 < len(begins) else last_line + 1
            window = [line for line in lines if begin <= line["line"] < following]
            # Ends sit at the tail of a window, so a very long window is supplied
            # as its last 250 lines to stay inside the request token limit.
            visible = window[-250:] if len(window) > 250 else window
            visible_ids = {line["line"] for line in visible}
            candidates = [line["line"] for line in visible
                          if line["line"] == following - 1 or starts_paragraph(text_of.get(line["line"] + 1, ""))]
            if len(candidates) > 255:
                candidates = candidates[-255:]
            response = call(
                line_state(dict(packet, lines=visible)),
                {"end": {
                    "type": "choice",
                    "instructions": (
                        "This opinion begins at line L%03d. Which line is the LAST line of its reasons body? "
                        "Include its final numbered paragraphs and any trailing disposition, formal judgment or "
                        "order block, or bullet list. Do not include a judge's quoted name standing alone as a "
                        "signature, or an 'I AGREE:' line." % begin),
                    "criteria": {"L%03d" % n: None for n in candidates},
                }},
                "hybrid:ends:%s:%d:%d" % (tag, packet["document_id"], index + 1))
            if not response["ok"]:
                predicted.append({"index": index + 1, "start": begin, "end": None,
                                  "start_p": probabilities[begin], "error": response.get("error")})
                continue
            usage_b["input_tokens"] += response["response"]["usage"]["input_tokens"]
            usage_b["output_tokens"] += response["response"]["usage"]["output_tokens"]
            elapsed_b += response["elapsed_seconds"]
            answer = response["response"]["answers"]["end"]
            predicted.append({"index": index + 1, "start": begin, "end": resolve_line(answer.get("choice")),
                              "start_p": probabilities[begin], "end_confidence": answer.get("confidence")})
        scores.append({"document_id": packet["document_id"], "citation": packet["citation"],
                       "cohort": packet.get("cohort"), "predicted": predicted, "begins": begins,
                       "count": count, "gold": gold_bounds(packet),
                       "line_count": len(lines),
                       "usage_a": usage_a, "usage_b": usage_b,
                       "elapsed_seconds": round(elapsed_a + elapsed_b, 3)})
        print(json.dumps({k: scores[-1][k] for k in ("document_id", "citation", "cohort", "begins", "predicted", "gold", "usage_a", "usage_b", "elapsed_seconds")}))
    (RECEIPTS / ("boundary-predictions-%s.json" % tag)).write_text(json.dumps(scores, indent=2), encoding="utf-8")


SLATE_CONVENTION = (
    "This is a reported decision. Before the reasons there may be a headnote or catchwords block that "
    "summarizes the result using lines such as 'Per Wilson J.:' or 'Per Arbour J. (dissenting):'. Those "
    "headnote lines are editorial summary, not reasons, and they never begin an opinion. "
    "An opinion's reasons begin at its author label, and that label IS part of the opinion body. The label "
    "may be inline with the first paragraph, as in 'THE CHIEF JUSTICE--The principal issue ...', "
    "'BEETZ J.--I have had the advantage ...', 'LA FOREST J. -- This appeal concerns ...', "
    "'WILSON J.--At the heart of this appeal ...'; it may be a standalone line such as "
    "'STRATAS J.A. (Dissenting reasons)'; or the reasons may open with a heading such as "
    "'REASONS FOR JUDGMENT' or a delivery formula such as 'The judgment of X was delivered by'. "
    "Subject-matter headings inside the reasons, such as 'ISSUES', 'FACTS', 'ANALYSIS', 'Introduction' "
    "or 'Conclusion', do not begin an opinion."
)

LINE_ROLES = {
    "opinion_author_label": ("This line begins a set of reasons and names or introduces its author: an inline "
                             "author label, a standalone judge label, a 'REASONS FOR JUDGMENT' heading, or a "
                             "delivery formula such as 'The judgment of X was delivered by'."),
    "headnote_summary": ("This line is part of a headnote or catchwords summary that precedes the reasons, "
                         "for example a 'Per X J.:' summary line."),
    "section_heading": ("This line is a subject-matter heading inside the reasons, such as ISSUES, FACTS, "
                        "ANALYSIS, Introduction or Conclusion."),
    "neither": "None of the above.",
}


def run_v2(only, tag, packets_name="hard-slate.json"):
    scores = []
    for packet in load_packets(packets_name):
        if only and packet["document_id"] not in only:
            continue
        lines = packet["lines"]
        role_state = dict(packet, how_to_decide=SLATE_CONVENTION)
        roles = {}
        for offset in range(0, len(lines), BEGIN_CHUNK):
            block = lines[offset:offset + BEGIN_CHUNK]
            chunk = call(
                line_state(dict(packet, lines=block), SLATE_CONVENTION),
                {"c%03d" % line["line"]: {
                    "type": "choice",
                    "instructions": "Line L%03d: what is this line?" % line["line"],
                    "criteria": LINE_ROLES,
                } for line in block},
                "v2:roles:%s:%d:%d" % (tag, packet["document_id"], offset))
            if not chunk["ok"]:
                roles = None
                break
            for line in block:
                answer = chunk["response"]["answers"]["c%03d" % line["line"]]
                roles[line["line"]] = {"role": answer.get("choice"),
                                       "confidence": answer.get("confidence"),
                                       "probabilities": answer.get("probabilities")}
        if not roles:
            scores.append({"document_id": packet["document_id"], "error": "role classification failed"})
            print(json.dumps(scores[-1])); continue
        begins = sorted(number for number, value in roles.items()
                        if value["role"] == "opinion_author_label" and (value["confidence"] or 0) >= 0.5)
        # Cap by the reported opinion count, but never below the number of
        # high-confidence labels: the count question undercounts long documents
        # and would otherwise truncate opinions the classifier did find.
        count_call = call(
            line_state(dict(packet, lines=lines[:60]), SLATE_CONVENTION),
            {"opinion_count": {"type": "choice",
                               "instructions": ("How many separately authored substantive opinions does this "
                                                "decision contain?"),
                               "criteria": {str(n): None for n in range(1, MAX_OPINIONS + 1)}}},
            "v2:count:%s:%d" % (tag, packet["document_id"]))
        cap = MAX_OPINIONS
        if count_call["ok"]:
            try:
                cap = max(1, min(MAX_OPINIONS, int(count_call["response"]["answers"]["opinion_count"]["choice"])))
            except (KeyError, TypeError, ValueError):
                pass
        confident = [number for number in begins if (roles[number]["confidence"] or 0) >= 0.7]
        if len(begins) > cap:
            ranked = sorted(begins, key=lambda number: roles[number]["confidence"] or 0, reverse=True)
            begins = sorted(ranked[:cap])
        if not begins:
            ranked = sorted(roles, key=lambda number: roles[number]["confidence"] or 0, reverse=True)
            begins = sorted(ranked[:1])
        begins = refine_begins(lines, roles, begins, cap)
        # Ends: one bounded windowed Choice per opinion.
        text_of = {line["line"]: line["text"] for line in lines}
        def starts_paragraph(value):
            probe = value.strip()
            return bool(re.match(r"^\[?\d+[\]\.]?\s", probe)) or (len(probe) < 60 and probe.endswith(":"))
        last_line = lines[-1]["line"]
        predicted = []
        usage_b = {"input_tokens": 0, "output_tokens": 0}
        elapsed_b = 0.0
        for index, begin in enumerate(begins):
            following = begins[index + 1] if index + 1 < len(begins) else last_line + 1
            window = [line for line in lines if begin <= line["line"] < following]
            visible = window[-250:] if len(window) > 250 else window
            candidates = [line["line"] for line in visible
                          if line["line"] == following - 1 or starts_paragraph(text_of.get(line["line"] + 1, ""))]
            if len(candidates) > 255:
                candidates = candidates[-255:]
            response = call(
                line_state(dict(packet, lines=visible), SLATE_CONVENTION),
                {"end": {"type": "choice",
                         "instructions": ("This opinion begins at line L%03d. Which line is the LAST line of its "
                                          "reasons body, including its final numbered paragraphs and any trailing "
                                          "disposition, order or bullet list?" % begin),
                         "criteria": {"L%03d" % n: None for n in candidates}}},
                "v2:ends:%s:%d:%d" % (tag, packet["document_id"], index + 1))
            if not response["ok"]:
                predicted.append({"index": index + 1, "start": begin, "end": None, "error": response.get("error")})
                continue
            usage_b["input_tokens"] += response["response"]["usage"]["input_tokens"]
            usage_b["output_tokens"] += response["response"]["usage"]["output_tokens"]
            elapsed_b += response["elapsed_seconds"]
            answer = response["response"]["answers"]["end"]
            predicted.append({"index": index + 1, "start": begin, "end": resolve_line(answer.get("choice")),
                              "end_confidence": answer.get("confidence")})
        scores.append({"document_id": packet["document_id"], "citation": packet["citation"],
                       "cohort": packet.get("cohort"), "predicted": predicted, "begins": begins,
                       "gold": gold_bounds(packet), "line_count": len(lines),
                       "usage_b": usage_b, "elapsed_seconds": round(elapsed_b, 3)})
        print(json.dumps({k: scores[-1][k] for k in ("document_id", "citation", "begins", "predicted", "gold")}))
    (RECEIPTS / ("boundary-predictions-%s.json" % tag)).write_text(json.dumps(scores, indent=2), encoding="utf-8")


JOINT_LABEL = re.compile(r"\b[A-Z][\w'\u2019.\-]*\s+AND\s+[A-Z][\w'\u2019.\-]*\s+J{1,2}\.")
BARE_JUDGE = re.compile(r"^[\"\u201c]?[A-Z][\w'\u2019.\- ]{0,28}\s+J{1,2}\.?\s*[\"\u201d]?$")
BARE_LABEL = re.compile(r"^(?:REASONS FOR JUDGMENT\s*|Reasons for judgment:\s*|Decision:\s*|"
                        r"Concurring reasons for judgment of .+)$", re.I)
NAMED_LABEL = re.compile(r"^REASONS FOR JUDGMENT\s*:", re.I)
DELIVERED = re.compile(r"^The judgment of .+ was delivered by", re.I)
HEADNOTE_PER = re.compile(r"^Per\b.{0,90}:\s", re.I)


def refine_begins(lines, roles, raw_begins, count):
    """Deterministic post-processing over the model's per-line classification."""
    text_of = {line["line"]: line["text"].strip() for line in lines}
    numbers = [line["line"] for line in lines]
    last = numbers[-1]

    def txt(number):
        return text_of.get(number, "")

    # Rescue well-formed reasons labels the classifier may have missed.
    rescued = {n for n in numbers if BARE_LABEL.match(txt(n))}
    # A bare body heading beats a front-matter 'REASONS FOR JUDGMENT: NAME'.
    if any(re.match(r"^REASONS FOR JUDGMENT\s*$", txt(n), re.I) for n in numbers):
        rescued = {n for n in rescued if not NAMED_LABEL.match(txt(n))}
    # A delivery formula is satisfied by the paragraph that follows it.
    shifted = set()
    for n in rescued:
        if DELIVERED.match(txt(n)):
            nxt = next((m for m in numbers if m > n and re.match(r"^(?:\[?\d+\]?|\d+\.)\s|--|\u2014", txt(m))), n)
            shifted.add(nxt)
        else:
            shifted.add(n)
    rescued = shifted

    raw = set(raw_begins)
    # Headnote 'Per X J.:' summaries are not reasons when inline author labels exist.
    if any("--" in txt(n) or "\u2014" in txt(n) for n in raw | rescued):
        rescued = {n for n in rescued if not HEADNOTE_PER.match(txt(n))}
        raw = {n for n in raw if not HEADNOTE_PER.match(txt(n))}
    # A trailing signature is not an opinion start.
    raw = {n for n in raw if not (n >= last - 6 and BARE_JUDGE.match(txt(n)))}
    rescued = {n for n in rescued if not (n >= last - 6 and BARE_JUDGE.match(txt(n)))}
    # A bare 'X J.' sub-heading inside a joint opinion is not a new opinion.
    joint = [n for n in numbers if JOINT_LABEL.search(txt(n))]
    if joint:
        first_joint = min(joint)
        drop = {n for n in raw | rescued if n > first_joint and BARE_JUDGE.match(txt(n))}
        raw -= drop
        rescued -= drop

    cap = max(count, min(MAX_OPINIONS, len(rescued)))
    others = sorted(raw - rescued, key=lambda n: roles[n]["confidence"] or 0, reverse=True)
    return sorted(rescued | set(others[:max(0, cap - len(rescued))]))


NAME_LABEL = re.compile(r"^[\"\u201c]?[A-Z][\w'\u2019.\- ]{0,45}?\s*(?:J\.J\.A\.|J\.A\.|J\.C\.A\.|J\.C\.|C\.J\.C\.|C\.J\.|JJ?\.)\s*[\(\-\u2014:]")
CHIEF_LABEL = re.compile(r"^THE (?:CHIEF|PUISNE) JUSTICE\s*[\-\u2014]")


def slate_candidates(lines, roles):
    """Recall-first candidate generation, with the headnote region excluded."""
    text_of = {line["line"]: line["text"].strip() for line in lines}
    numbers = [line["line"] for line in lines]
    raw = {n for n, value in roles.items()
           if value["role"] == "opinion_author_label" and (value["confidence"] or 0) >= 0.5}
    shaped = {n for n in numbers if NAME_LABEL.match(text_of[n]) or CHIEF_LABEL.match(text_of[n])}
    rescued = {n for n in numbers if BARE_LABEL.match(text_of[n])}
    if any(re.match(r"^REASONS FOR JUDGMENT\s*$", text_of[n], re.I) for n in numbers):
        rescued = {n for n in rescued if not NAMED_LABEL.match(text_of[n])}
    delivered = {n for n in numbers if DELIVERED.match(text_of[n])}
    shifted = set()
    for n in delivered:
        # Only move a delivery formula when the next author label follows it, so a
        # decision whose gold starts at the delivery line is left alone.
        nxt = next((m for m in numbers if m > n and (NAME_LABEL.match(text_of[m]) or CHIEF_LABEL.match(text_of[m]))), None)
        shifted.add(nxt if nxt is not None else n)
    candidates = raw | shaped | rescued | shifted
    # A headnote 'Per X J.:' line is never a reasons label when the document
    # contains inline author labels.
    if any("--" in text_of[n] or "\u2014" in text_of[n] for n in candidates):
        candidates = {n for n in candidates if not HEADNOTE_PER.match(text_of[n])}
    if not candidates:
        # Fallback openings for decisions with no judge-labelled reasons.
        candidates = {n for n in numbers
                      if re.match(r"^(?:By the Court:|THE COURT|DECISION|Reasons for judgment:)", text_of[n], re.I)
                      or re.match(r"^\[1\]", text_of[n])}
    return sorted(candidates)


def arbitration_questions(lines, candidates):
    text_of = {line["line"]: line["text"].strip() for line in lines}
    questions = {
        "opinion_count": {
            "type": "choice",
            "instructions": "How many distinct sets of reasons, each with its own author, are listed below?",
            "criteria": {str(n): None for n in range(1, 7)},
        },
    }
    for n in candidates:
        questions["d_%03d" % n] = {
            "type": "noul",
            "instructions": (
                "Candidate L%03d is listed in the state. Does it begin a DISTINCT set of reasons? "
                "Answer no if it is a sub-heading inside another candidate's reasons, a repeat of an "
                "earlier candidate, or one judge named inside a joint opinion that an earlier candidate "
                "already introduces." % n),
            "criteria": {"true": "This candidate starts its own set of reasons.",
                         "false": "This candidate is a sub-heading, a repeat, or part of an earlier joint opinion."},
        }
    return questions


def run_v7(only, tag, packets_name="hard-slate.json"):
    scores = []
    for packet in load_packets(packets_name):
        if only and packet["document_id"] not in only:
            continue
        lines = packet["lines"]
        roles = {}
        for offset in range(0, len(lines), BEGIN_CHUNK):
            block = lines[offset:offset + BEGIN_CHUNK]
            chunk = call(
                line_state(dict(packet, lines=block), SLATE_CONVENTION),
                {"c%03d" % line["line"]: {"type": "choice",
                                          "instructions": "Line L%03d: what is this line?" % line["line"],
                                          "criteria": LINE_ROLES} for line in block},
                "v7:roles:%s:%d:%d" % (tag, packet["document_id"], offset))
            if not chunk["ok"]:
                roles = None
                break
            for line in block:
                answer = chunk["response"]["answers"]["c%03d" % line["line"]]
                roles[line["line"]] = {"role": answer.get("choice"), "confidence": answer.get("confidence")}
        if not roles:
            scores.append({"document_id": packet["document_id"], "error": "role classification failed"})
            print(json.dumps(scores[-1])); continue
        candidates = sorted(n for n, value in roles.items()
                            if value["role"] == "opinion_author_label" and (value["confidence"] or 0) >= 0.5) \
            if SELECTION == "model" else slate_candidates(lines, roles)
        if not candidates:
            scores.append({"document_id": packet["document_id"], "error": "no candidates"})
            print(json.dumps(scores[-1])); continue
        text_of = {line["line"]: line["text"] for line in lines}
        toc = [{"line": n, "text": text_of[n][:160]} for n in candidates]
        if SELECTION == "shape":
            # Count-free by construction: the number of opinions is derived from
            # the boundaries in code, never asked of the model and never allowed
            # to veto a boundary.
            answers = {}
        else:
            arbitration = call(
                {"document": packet["citation"], "how_to_decide": SLATE_CONVENTION,
                 "candidates": toc},
                arbitration_questions(lines, candidates),
                "v7:arbitrate:%s:%d" % (tag, packet["document_id"]))
            if not arbitration["ok"]:
                scores.append({"document_id": packet["document_id"], "error": arbitration.get("error")})
                print(json.dumps(scores[-1])); continue
            answers = arbitration["response"]["answers"]
        if SELECTION == "noul":
            begins = [n for n in candidates if answers["d_%03d" % n]["noul"] >= 0.5]
        elif SELECTION == "shape":
            # Boundaries from label taxonomy plus high-confidence model labels.
            stripped = {line["line"]: line["text"].strip() for line in lines}
            numbers = [line["line"] for line in lines]
            shaped = {n for n in numbers if label_shape(stripped.get(n, ""))}
            model_high = {n for n, value in roles.items()
                          if value["role"] == "opinion_author_label"
                          and (value["confidence"] or 0) >= 0.9
                          and not HEADNOTE_PER.match(stripped.get(n, ""))}
            keep = shaped | model_high
            last_line_number = numbers[-1]
            keep = {n for n in keep
                    if not (n >= last_line_number - 6 and BARE_JUDGE.match(stripped.get(n, "")))}
            joint = [n for n in numbers if JOINT_LABEL.search(stripped.get(n, ""))]
            if joint:
                first_joint = min(joint)
                keep = {n for n in keep
                        if not (n > first_joint and BARE_JUDGE.match(stripped.get(n, "")))}
            begins = sorted(keep)[:8]
        else:
            stripped = {line["line"]: line["text"].strip() for line in lines}
            last_line_number = lines[-1]["line"]
            keep = {n for n in candidates
                    if not (n >= last_line_number - 6 and BARE_JUDGE.match(stripped.get(n, "")))}
            joint = [line["line"] for line in lines if JOINT_LABEL.search(stripped.get(line["line"], ""))]
            if joint:
                first_joint = min(joint)
                keep = {n for n in keep
                        if not (n > first_joint and BARE_JUDGE.match(stripped.get(n, "")))}
            try:
                cap = max(1, min(6, int(answers["opinion_count"]["choice"])))
            except (KeyError, TypeError, ValueError):
                cap = 6
            ranked = sorted(
                keep,
                key=lambda n: (1 if NAME_LABEL.match(stripped.get(n, "")) or CHIEF_LABEL.match(stripped.get(n, "")) else 0,
                               (roles.get(n) or {}).get("confidence") or 0),
                reverse=True)
            begins = sorted(ranked[:cap])
        if not begins:
            begins = candidates[:1]
        # Windowed ends, one bounded call per opinion.
        def starts_paragraph(value):
            probe = value.strip()
            return bool(re.match(r"^\[?\d+[\]\.]?\s", probe)) or (len(probe) < 60 and probe.endswith(":"))
        last_line = lines[-1]["line"]
        predicted = []
        usage_b = {"input_tokens": 0, "output_tokens": 0}
        elapsed_b = 0.0
        for index, begin in enumerate(begins):
            following = begins[index + 1] if index + 1 < len(begins) else last_line + 1
            window = [line for line in lines if begin <= line["line"] < following]
            visible = window[-250:] if len(window) > 250 else window
            cands = [line["line"] for line in visible
                     if line["line"] == following - 1 or starts_paragraph(text_of.get(line["line"] + 1, ""))]
            if len(cands) > 255:
                cands = cands[-255:]
            response = call(
                line_state(dict(packet, lines=visible), SLATE_CONVENTION),
                {"end": {"type": "choice",
                         "instructions": ("This opinion begins at line L%03d. Which line is the LAST line of its "
                                          "reasons body, including its final numbered paragraphs and any trailing "
                                          "disposition, order or bullet list?" % begin),
                         "criteria": {"L%03d" % n: None for n in cands}}},
                "v7:ends:%s:%d:%d" % (tag, packet["document_id"], index + 1))
            if not response["ok"]:
                predicted.append({"index": index + 1, "start": begin, "end": None, "error": response.get("error")})
                continue
            usage_b["input_tokens"] += response["response"]["usage"]["input_tokens"]
            usage_b["output_tokens"] += response["response"]["usage"]["output_tokens"]
            elapsed_b += response["elapsed_seconds"]
            answer = response["response"]["answers"]["end"]
            predicted.append({"index": index + 1, "start": begin, "end": resolve_line(answer.get("choice")),
                              "end_confidence": answer.get("confidence")})
        scores.append({"document_id": packet["document_id"], "citation": packet["citation"],
                       "cohort": packet.get("cohort"), "candidates": candidates,
                       "count_answer": (answers.get("opinion_count") or {}).get("choice"),
                       "predicted": predicted, "begins": begins, "gold": gold_bounds(packet),
                       "line_count": len(lines), "usage_b": usage_b,
                       "elapsed_seconds": round(elapsed_b, 3)})
        print(json.dumps({k: scores[-1][k] for k in ("document_id", "citation", "begins", "gold")}))
    (RECEIPTS / ("boundary-predictions-%s.json" % tag)).write_text(json.dumps(scores, indent=2), encoding="utf-8")


LABEL_SHAPES = [
    re.compile(r"^(?:Dissenting )?Reasons for Judgment of the Honourable .+?:?\s*$"),
    re.compile(r"^\d{1,3}\s+[A-Z][\w'\u2019.\-]+(?:\s+[A-Z][\w'\u2019.\-]+)?\s+(?:J\.|C\.J\.|J\.J\.|JJ\.)\s*[\u2014\u2013\-]"),
    re.compile(r"^//\s*[A-Z][^/]{2,60}//\s*$"),
    re.compile(r"^The following are the reasons delivered by\s*$"),
    re.compile(r"^(?:THE (?:CHIEF|PUISNE) JUSTICE|[A-Z][A-Z'\u2019.\- ]{1,40}?"
                r"(?:J\.J?\.|J\.A\.|C\.J\.|C\.J\.C\.|J\.C\.A\.|J\.C\.))(?:\s*\([^)]*\))?\s*(?:--|\u2014)"),
    re.compile(r"^(?:REASONS FOR JUDGMENT|JUDGMENT AND REASONS)\s*$"),
    re.compile(r"^(?:Reasons for judgment|Decision|By the Court|THE COURT|PER CURIAM):?\s*$", re.I),
    re.compile(r"^Concurring reasons for judgment of .+:\s*$", re.I),
]


def label_shape(value):
    return any(rx.match(value) for rx in LABEL_SHAPES)


PL_CONVENTION = (
    "A decision may open with a headnote or catchwords summary, a style of cause, a panel list, "
    "counsel, and a date. The reasons themselves then begin once per opinion. A line BEGINS an "
    "opinion only when it introduces a set of reasons and identifies who wrote them, for example "
    "'X J. -- ...', 'X J.A. (Dissenting reasons)', 'Reasons for Judgment of the Honourable X:', "
    "'By the Court:', 'The judgment of X was delivered by', 'REASONS FOR JUDGMENT', "
    "'1 Name J. - ...', or '//Name J.//'. A line does NOT begin an opinion when it is a headnote "
    "summary line such as 'Per X J.: ...', a subject heading inside reasons such as ISSUES, FACTS or "
    "ANALYSIS, a judge's name on its own as a signature, a citation, or ordinary text."
)


def run_pl(only, tag, packets_name="hard-slate.json"):
    scores = []
    step, context = 120, 10
    for packet in load_packets(packets_name):
        if only and packet["document_id"] not in only:
            continue
        lines = packet["lines"]
        head = lines[:40]
        probability = {}
        for offset in range(0, len(lines), step):
            block = lines[offset:offset + step]
            shown = head + lines[max(0, offset - context):offset] + block
            chunk = call(
                line_state(dict(packet, lines=shown), PL_CONVENTION),
                {"s%03d" % line["line"]: {
                    "type": "noul",
                    "instructions": ("Line L%03d: does a set of reasons BEGIN at this line, and does the line "
                                     "identify who wrote them?" % line["line"]),
                    "criteria": {"true": "This line introduces one or more judges' reasons.",
                                 "false": "This line is a headnote summary, a subject heading, a signature, a "
                                          "citation, or ordinary text."},
                } for line in block},
                "pl:%s:%d:%d" % (tag, packet["document_id"], offset))
            if not chunk["ok"]:
                break
            for line in block:
                probability[line["line"]] = chunk["response"]["answers"]["s%03d" % line["line"]]["noul"]
        accepted = sorted(n for n, value in probability.items() if value >= 0.5)
        # The reported headnote is editorial summary and cannot contain an opinion.
        # It ends at the first genuine author label, found by shape.
        labelled = [line["line"] for line in lines if label_shape(line["text"].strip())]
        if labelled:
            first_label = min(labelled)
            accepted = [n for n in accepted if n >= first_label]
        # Adjacent accepted lines are one opinion: keep the stronger.
        begins = []
        for n in accepted:
            if begins and n - begins[-1] <= 2:
                if probability[n] > probability[begins[-1]]:
                    begins[-1] = n
                continue
            begins.append(n)
        predicted = []
        text_of = {line["line"]: line["text"] for line in lines}
        def starts_paragraph(value):
            probe = value.strip()
            return bool(re.match(r"^\[?\d+[\]\.]?\s", probe)) or (len(probe) < 60 and probe.endswith(":"))
        last_line = lines[-1]["line"]
        for index, begin in enumerate(begins):
            following = begins[index + 1] if index + 1 < len(begins) else last_line + 1
            window = [line for line in lines if begin <= line["line"] < following]
            visible = window[-250:] if len(window) > 250 else window
            cands = [line["line"] for line in visible
                     if line["line"] == following - 1 or starts_paragraph(text_of.get(line["line"] + 1, ""))]
            if len(cands) > 255:
                cands = cands[-255:]
            response = call(
                line_state(dict(packet, lines=visible), PL_CONVENTION),
                {"end": {"type": "choice",
                         "instructions": ("This opinion begins at line L%03d. Which line is the LAST line of its "
                                          "reasons body?" % begin),
                         "criteria": {"L%03d" % n: None for n in cands}}},
                "pl:end:%s:%d:%d" % (tag, packet["document_id"], index + 1))
            end = None
            if response["ok"]:
                end = resolve_line(response["response"]["answers"]["end"].get("choice"))
            predicted.append({"index": index + 1, "start": begin, "end": end,
                              "start_p": probability[begin]})
        scores.append({"document_id": packet["document_id"], "citation": packet["citation"],
                       "cohort": packet.get("cohort"), "predicted": predicted, "begins": begins,
                       "gold": gold_bounds(packet), "line_count": len(lines)})
        print(json.dumps({k: scores[-1][k] for k in ("document_id", "citation", "begins", "gold")}))
    (RECEIPTS / ("boundary-predictions-%s.json" % tag)).write_text(json.dumps(scores, indent=2), encoding="utf-8")


PARAGRAPH_START = re.compile(r"^\s*\[?\d{1,4}\.?\]?\s")
LETTERED_HEADING = re.compile(r"^[A-Z]\.\s+\S")
HEADING_SHAPE = re.compile(r"^[A-Z][A-Z\s,\.'\u2019\-]{3,60}$")


def candidate_positions(lines):
    """Lines where an opinion could plausibly begin: paragraph openings and
    heading/label shapes. Choosing where to ask is not choosing the answer."""
    out = []
    for line in lines:
        text = line["text"].strip()
        if PARAGRAPH_START.match(text) or LETTERED_HEADING.match(text) or HEADING_SHAPE.match(text) or label_shape(text):
            out.append(line["line"])
    return out


def run_full(only, tag, packets_name="hard-slate.json"):
    scores = []
    for packet in load_packets(packets_name):
        if only and packet["document_id"] not in only:
            continue
        lines = packet["lines"]
        all_candidates = candidate_positions(lines)
        # Long decisions cannot carry the whole text in one request. Split the
        # candidate questions into groups, and give each group the front matter
        # (which is where the headnote lives) plus its local body context.
        groups = []
        current = []
        for number in all_candidates:
            trial = current + [number]
            low, high = trial[0] - 25, trial[-1] + 25
            span = sum(len(line["text"]) for line in lines if low <= line["line"] <= high) + 2500
            if current and span > 45000:
                groups.append(current)
                current = [number]
            else:
                current = trial
        if current:
            groups.append(current)
        numbers = [line["line"] for line in lines]
        head = lines[:80]
        accepted = set()
        failed = None
        for group in groups:
            local = [line for line in lines
                     if group[0] - 25 <= line["line"] <= group[-1] + 25 and line["line"] > 120]
            shown = local
            chunk = call(
                line_state(dict(packet, lines=shown), PL_CONVENTION),
                {"o%04d" % n: {
                    "type": "noul",
                    "instructions": ("Does a distinct set of reasons BEGIN at line L%04d? Answer yes only when the "
                                     "line introduces one or more judges' reasons. Answer no for a headnote or "
                                     "catchwords summary line such as 'Per X J.:', a subject heading inside reasons, "
                                     "a signature, or ordinary text." % n),
                } for n in group},
                "full:%s:%d:%d" % (tag, packet["document_id"], group[0]))
            if not chunk["ok"]:
                failed = chunk.get("error")
                break
            answers = chunk["response"]["answers"]
            for n in group:
                if answers["o%04d" % n]["noul"] >= 0.5:
                    accepted.add(n)
        if failed:
            scores.append({"document_id": packet["document_id"], "error": failed,
                           "candidates": len(all_candidates), "lines": len(lines)})
            print(json.dumps(scores[-1])); continue
        begins = sorted(accepted)
        text_of = {line["line"]: line["text"] for line in lines}
        def starts_paragraph(value):
            probe = value.strip()
            return bool(PARAGRAPH_START.match(probe)) or (len(probe) < 60 and probe.endswith(":"))
        last_line = lines[-1]["line"]
        predicted = []
        for index, begin in enumerate(begins):
            following = begins[index + 1] if index + 1 < len(begins) else last_line + 1
            window = [line for line in lines if begin <= line["line"] < following]
            visible = window[-250:] if len(window) > 250 else window
            cands = [line["line"] for line in visible
                     if line["line"] == following - 1 or starts_paragraph(text_of.get(line["line"] + 1, ""))]
            if len(cands) > 255:
                cands = cands[-255:]
            response = call(
                line_state(dict(packet, lines=visible), PL_CONVENTION),
                {"end": {"type": "choice",
                         "instructions": ("This opinion begins at line L%03d. Which line is the LAST line of its "
                                          "reasons body?" % begin),
                         "criteria": {"L%03d" % n: None for n in cands}}},
                "full:end:%s:%d:%d" % (tag, packet["document_id"], index + 1))
            end = resolve_line(response["response"]["answers"]["end"].get("choice")) if response["ok"] else None
            predicted.append({"index": index + 1, "start": begin, "end": end})
        scores.append({"document_id": packet["document_id"], "citation": packet["citation"],
                       "cohort": packet.get("cohort"), "predicted": predicted, "begins": begins,
                       "gold": gold_bounds(packet), "candidates": len(all_candidates), "lines": len(lines),
                       "usage": chunk["response"]["usage"]})
        print(json.dumps({k: scores[-1][k] for k in ("document_id", "citation", "begins", "gold",
                                                     "candidates", "lines", "usage")}))
    (RECEIPTS / ("boundary-predictions-%s.json" % tag)).write_text(json.dumps(scores, indent=2), encoding="utf-8")


def run_pick(only, tag, packets_name="hard-slate.json"):
    """Whole decision in state; name the line that begins each judge's reasons."""
    scores = []
    for packet in load_packets(packets_name):
        if only and packet["document_id"] not in only:
            continue
        lines = packet["lines"]
        candidates = candidate_positions(lines)
        options = {"L%03d" % n: None for n in candidates}
        options["NONE"] = "There is no such opinion in this decision."
        questions = {}
        for index in range(1, 7):
            questions["p%d" % index] = {
                "type": "choice",
                "instructions": ("Reading the whole decision, which line is the FIRST line of the reasons of "
                                 "opinion %d? Opinion 1 is the lead reasons. Each separately authored set of "
                                 "reasons, including a concurrence or dissent, is its own opinion. If the "
                                 "decision has no opinion %d, choose NONE." % (index, index)),
                "criteria": options,
            }
        response = call(line_state(packet, PL_CONVENTION), questions,
                        "pick:%s:%d" % (tag, packet["document_id"]))
        if not response["ok"]:
            scores.append({"document_id": packet["document_id"], "error": response.get("error")})
            print(json.dumps(scores[-1])); continue
        answers = response["response"]["answers"]
        chosen = []
        for index in range(1, 7):
            value = answers["p%d" % index].get("choice")
            number = resolve_line(value)
            if number is not None and number not in chosen:
                chosen.append(number)
        begins = sorted(chosen)
        text_of = {line["line"]: line["text"] for line in lines}
        last_line = lines[-1]["line"]
        predicted = []
        for index, begin in enumerate(begins):
            following = begins[index + 1] if index + 1 < len(begins) else last_line + 1
            window = [line for line in lines if begin <= line["line"] < following]
            visible = window[-250:] if len(window) > 250 else window
            cands = [line["line"] for line in visible
                     if line["line"] == following - 1
                     or PARAGRAPH_START.match(line["text"].strip())
                     or label_shape(line["text"].strip())]
            if len(cands) > 255:
                cands = cands[-255:]
            end_response = call(
                line_state(dict(packet, lines=visible), PL_CONVENTION),
                {"end": {"type": "choice",
                         "instructions": ("This opinion begins at line L%03d. Which line is the LAST line of its "
                                          "reasons body?" % begin),
                         "criteria": {"L%03d" % n: None for n in cands}}},
                "pick:end:%s:%d:%d" % (tag, packet["document_id"], index + 1))
            end = resolve_line(end_response["response"]["answers"]["end"].get("choice")) if end_response["ok"] else None
            predicted.append({"index": index + 1, "start": begin, "end": end})
        scores.append({"document_id": packet["document_id"], "citation": packet["citation"],
                       "cohort": packet.get("cohort"), "predicted": predicted, "begins": begins,
                       "gold": gold_bounds(packet), "candidates": len(candidates), "lines": len(lines),
                       "usage": response["response"]["usage"]})
        print(json.dumps({k: scores[-1][k] for k in ("document_id", "citation", "begins", "gold",
                                                     "candidates", "lines", "usage")}))
    (RECEIPTS / ("boundary-predictions-%s.json" % tag)).write_text(json.dumps(scores, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["boundaries", "lines", "hybrid", "v2", "v7", "v8", "v9", "v10", "v14", "pl", "full", "pick", "attribution", "treatment"])
    parser.add_argument("--doc", type=int, action="append")
    parser.add_argument("--tag", default="run1")
    parser.add_argument("--packets", default="boundaries.json")
    args = parser.parse_args()
    RECEIPTS.mkdir(parents=True, exist_ok=True)
    if args.stage == "boundaries":
        run_boundaries(set(args.doc) if args.doc else None, args.tag)
    elif args.stage == "lines":
        run_lines(set(args.doc) if args.doc else None, args.tag)
    elif args.stage == "hybrid":
        run_hybrid(set(args.doc) if args.doc else None, args.tag, args.packets)
    elif args.stage == "v2":
        run_v2(set(args.doc) if args.doc else None, args.tag, args.packets)
    elif args.stage == "v7":
        run_v7(set(args.doc) if args.doc else None, args.tag, args.packets)
    elif args.stage == "v8":
        globals()["SELECTION"] = "count"
        run_v7(set(args.doc) if args.doc else None, args.tag, args.packets)
    elif args.stage == "v9":
        globals()["SELECTION"] = "prune"
        run_v7(set(args.doc) if args.doc else None, args.tag, args.packets)
    elif args.stage == "v10":
        globals()["SELECTION"] = "shape"
        run_v7(set(args.doc) if args.doc else None, args.tag, args.packets)
    elif args.stage == "v14":
        globals()["SELECTION"] = "model"
        run_v7(set(args.doc) if args.doc else None, args.tag, args.packets)
    elif args.stage == "pl":
        run_pl(set(args.doc) if args.doc else None, args.tag, args.packets)
    elif args.stage == "full":
        run_full(set(args.doc) if args.doc else None, args.tag, args.packets)
    elif args.stage == "pick":
        run_pick(set(args.doc) if args.doc else None, args.tag, args.packets)
    elif args.stage == "attribution":
        run_attribution()
    else:
        run_treatment()


if __name__ == "__main__":
    main()
