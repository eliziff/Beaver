"""Read prepared shortforms and ranked authored aliases, or generate from a new caption."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3

from mine import Engine, data_root, normalize, readonly
from shortform import clean_caption, generate_case, load_model, party_names


def linked_cases(connection, cases):
    row = connection.execute("SELECT value FROM meta WHERE key='parallel_case_links'").fetchone()
    links = {link["parallel_case_id"]: link["case_id"] for link in json.loads(row[0])} if row else {}
    result = {}
    for case in cases:
        if case["id"] in links:
            case = connection.execute("SELECT * FROM case_record WHERE id=?", (links[case["id"]],)).fetchone()
        result[case["id"]] = case
    return list(result.values())


def case_result(connection, case, language, top):
    chosen = connection.execute("SELECT * FROM case_shortform WHERE case_id=?"
        " ORDER BY method='citation_fallback',language=? DESC,language LIMIT 1", (case["id"], language)).fetchone()
    profile = connection.execute("SELECT * FROM case_profile WHERE case_id=? AND language=?",
                                 (case["id"], chosen["language"])).fetchone()
    aliases = [dict(row) for row in connection.execute(
        "SELECT spelling AS shortform,definition_documents,reference_documents,document_count,occurrences"
        " FROM case_alias WHERE case_id=? AND language=?"
        " ORDER BY document_count DESC,definition_documents DESC,length(spelling),normalized LIMIT ?",
        (case["id"], chosen["language"], top))]
    return {"identity": case["identity"], "citation": case["citation"], "style": profile["style"] if profile else None,
            "language": chosen["language"], "requested_language": language,
            "status": "caption_missing" if chosen["method"] == "citation_fallback" else "ok",
            "review_required": bool(case["ambiguous"]) or chosen["method"] == "citation_fallback",
            "shortform": chosen["shortform"], "method": chosen["method"],
            "definition_documents": chosen["definition_documents"],
            "generated_alternative": chosen["generated"], "aliases": aliases}


def lookup(connection, key, language="en", top=10):
    """No corpus reads or native calls: only indexed, prepared SQLite tables."""
    connection.row_factory = sqlite3.Row
    ambiguity = connection.execute("SELECT provider_ids FROM ambiguous_key WHERE key=?", (key,)).fetchone()
    if ambiguity:
        ids = json.loads(ambiguity[0])
        cases = connection.execute("SELECT * FROM case_record WHERE provider_id IN (" + ",".join("?" for _ in ids) + ")", ids)
    else:
        case = connection.execute("SELECT c.* FROM case_key k JOIN case_record c ON c.id=k.case_id WHERE k.key=?", (key,)).fetchone()
        if not case:
            case = connection.execute("SELECT * FROM case_record WHERE identity=?", (key,)).fetchone()
        cases = [case] if case else []
    cases = linked_cases(connection, cases)
    if len(cases) > 1:
        return {"key": key, "status": "ambiguous", "review_required": True,
                "candidates": [case_result(connection, case, language, top) for case in cases]}
    return case_result(connection, cases[0], language, top) if cases else {"key": key, "status": "not_indexed"}


def lookup_style(connection, style, model=None, language="en", top=10):
    connection.row_factory = sqlite3.Row
    style = clean_caption(style)
    if not style:
        return generate_style(connection, style, model, language)
    cases = linked_cases(connection, connection.execute(
        "SELECT DISTINCT c.* FROM case_profile p JOIN case_record c ON c.id=p.case_id"
        " WHERE p.style=? COLLATE NOCASE", (style,)))
    if len(cases) == 1:
        return case_result(connection, cases[0], language, top)
    if cases:
        return {"style": style, "status": "ambiguous", "review_required": True,
                "candidates": [case_result(connection, case, language, top) for case in cases]}
    return generate_style(connection, style, model, language)


def generate_style(connection, style, model=None, language="en", citation=""):
    connection.row_factory = sqlite3.Row
    left, right = party_names(style)
    learned = {}
    for party in (left, right):
        if party:
            row = connection.execute("SELECT * FROM party_shortform WHERE party_key=?", (normalize(party),)).fetchone()
            if row:
                learned[row["party_key"]] = dict(row)
    generated = generate_case(style, left, right, model or load_model(), citation,
                              party_aliases=learned, language=language)
    fallback = generated["method"] == "citation_fallback"
    return {"style": style, "status": "caption_missing" if fallback else "generated_from_caption",
            "language": language, "review_required": fallback, **generated, "aliases": []}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("citation_or_style")
    parser.add_argument("--database", type=Path, default=data_root() / "cache/case-shortforms/shortforms.sqlite")
    parser.add_argument("--language", choices=("en", "fr"), default="en")
    parser.add_argument("--top", type=int, default=10)
    args = parser.parse_args()
    with closing(readonly(args.database)) as connection:
        if args.citation_or_style.startswith(("3:", "a2aj:")):
            result = lookup(connection, args.citation_or_style, args.language, args.top)
        else:
            engine = Engine()
            try:
                info = engine.call("keyForText", {"text": args.citation_or_style})
                result = (lookup(connection, info["key"], args.language, args.top) if info.get("key") else
                          lookup_style(connection, args.citation_or_style, language=args.language, top=args.top))
                if result["status"] == "not_indexed":
                    citation = next((c for c in engine.extract(args.citation_or_style)
                                     if c.get("key") == info["key"] and c.get("style")), None)
                    if citation:
                        result = generate_style(connection, citation["style"]["text"], language=args.language,
                                                citation=citation["core"]["text"])
            finally:
                engine.close()
        print(json.dumps(result, indent=2, ensure_ascii=True))
