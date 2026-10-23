"""Resolve raw witnesses and materialize usable aliases and preferred case shortforms."""
from collections import Counter, defaultdict
from contextlib import ExitStack, closing
import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time

from evidence import annotation_flag, base_name_flag, caption_flag, clean_alias, grammar_pattern, usable_alias
from mine import Engine, data_root, normalize, readonly, words
from shortform import caption_profile, generate_case, load_model, party_names
from party_alias import learn_party_names, matches_party


HISTORY = grammar_pattern("ref.history")
CORES = grammar_pattern("cite.in-text")
BRIDGE = grammar_pattern("pinpoint.bridge")


def history_relation(gap):
    # Normalize equivalent wording before applying the shared history grammar.
    gap = re.sub(r"\bautorisation\s+de\s+pourvoi\b", "autorisation d'appel", gap, flags=re.I)
    gap = re.sub(r"\bdevant\s+la\b", "à la", gap, flags=re.I)
    return HISTORY.match(gap.replace("appeal at ", "appeal to "))


def declaration_origin(text, start):
    origin = max(0, start-700)
    matches = list(CORES.finditer(text, origin, start))
    if not matches:
        return origin
    index = len(matches)-1
    while index:
        gap = text[matches[index-1].end():matches[index].start()]
        unwrapped = re.sub(r"\([^()]{0,80}\)", "", gap)
        if not (BRIDGE.fullmatch(unwrapped) or any(c.isdigit() for c in gap) or
                history_relation(unwrapped)):
            break
        index -= 1
    return matches[index].start()


def court_forms(engine):
    return {row["id"]: {normalize(value) for value in (*row.get("neutral", []), *row.get("aliases", []))}
            for row in engine.call("registry", {})["courts"]}


def court_marker_forms(engine):
    return {normalize(part) for row in engine.call("registry", {})["courts"]
            for value in (*row.get("neutral", []), *row.get("aliases", []))
            for part in (value, value.rsplit(" ", 1)[-1]) if part == value or part.isupper()}


def usable_case_alias(name, profile, court_markers):
    return usable_alias(name) and not base_name_flag(name, profile[1:]) and (normalize(name) not in court_markers or
        any(party and matches_party(name, party) for party in profile[1:]))


def rejected_evidence(connection):
    row = connection.execute("SELECT value FROM meta WHERE key='rejected_evidence'").fetchone()
    rejected = {}
    for item in json.loads(row[0]) if row else []:
        source = connection.execute("SELECT sha256 FROM source WHERE id=?", (item["key"][2],)).fetchone()
        if not source or source[0] != item["source_sha256"]:
            raise ValueError("reviewed rejection no longer matches its source witness")
        rejected[tuple(item["key"])] = item["reason"]
    return rejected


def normalized_declarations(connection):
    row = connection.execute("SELECT value FROM meta WHERE key='normalized_declaration_evidence'").fetchone()
    corrected = {}
    for item in json.loads(row[0]) if row else []:
        key = tuple(item["before"][:4])
        source = connection.execute("SELECT sha256 FROM source WHERE id=?", (key[2],)).fetchone()
        if not source or source[0] != item["source_sha256"]:
            raise ValueError("reviewed declaration no longer matches its source witness")
        corrected[key] = item["after"][6]
    return corrected


def pinpoint_parallel(gap):
    if "," not in gap:
        return False
    value = gap.strip(" ,\r\n\t")
    value = re.sub(r"^(?:at|au|aux)\s+", "", value, flags=re.I)
    value = re.sub(r"\bparagraphe(s?)\b", r"paragraph\1", value, flags=re.I)
    return bool(grammar_pattern("pinpoint.para.toa").fullmatch(value))


def owner(citations, start, end, spelling, keys, body, courts):
    """Resolve an authored declaration's complete parallel/history chain."""
    full = [c for c in citations if c["form"] == "full" and c["authority"] == "case"]
    for previous, current in zip(full, full[1:]):
        gap = body[previous["core"]["end"]:current["core"]["start"]]
        previous["_pinpoint_parallel"] = pinpoint_parallel(gap)
        previous["_gap_is_parallel"] = ("," in gap and not gap.strip(" ,\r\n\t")) or previous["_pinpoint_parallel"]
        unwrapped = re.sub(r"\([^()]{0,80}\)", "", gap)
        if history_relation(unwrapped) and not previous.get("history"):
            previous["history"] = [{"target": current["index"]}]
    attached = [c for c in full if c.get("explicitSpan") and
                c["explicitSpan"]["start"] < end and c["explicitSpan"]["end"] > start and
                normalize(clean_alias(c.get("explicit") or "")) == normalize(spelling)]
    if not attached:
        return None, "unverified_declaration"
    selected = attached[-1]
    parents = {h["target"]: c for c in full for h in c.get("history", []) if h.get("target") is not None}
    tokens = words(spelling)
    label_parts = {"".join(tokens[index:index+length]) for index in range(len(tokens))
                   for length in range(1, min(5, len(tokens)-index)+1)}
    while selected["index"] in parents:
        parent = parents[selected["index"]]
        court = selected.get("court") or {}
        forms = courts.get(court.get("id"), set()) | {normalize(court.get("id", "").split("-")[-1]),
                                                     normalize(court.get("text", ""))}
        if (forms - {""}) & label_parts:
            break
        selected = parent
    # An unkeyed parallel can still carry history; retain the known main citation.
    while not selected.get("key"):
        index = full.index(selected)
        if not index or not full[index-1].get("_gap_is_parallel"):
            return None, "unindexed_owner"
        selected = full[index-1]
    group = selected.get("parallelGroup")
    members = [c for c in full if group is not None and c.get("parallelGroup") == group] or [selected]
    index = full.index(selected)
    if group is None and index and full[index-1].get("_pinpoint_parallel"):
        previous = full[index-1]
        previous_group = previous.get("parallelGroup")
        members += [c for c in full if previous_group is not None and c.get("parallelGroup") == previous_group] or [previous]
    provider_ids = {keys[c["key"]][1] for c in members if c.get("key") in keys and keys[c["key"]][1] is not None}
    if len(provider_ids) > 1:
        return None, "conflicting_provider_citations"
    # A parser may refuse a written parallel after its canonical alias exposes inconsistent years.
    before = [c for c in full if c["core"]["end"] <= selected["core"]["start"]]
    if before and selected["index"] not in parents:
        previous = before[-1]
        if previous.get("_gap_is_parallel") and previous.get("key") in keys and selected["key"] in keys:
            first, second = keys[previous["key"]][1], keys[selected["key"]][1]
            if first is not None and second is not None and first != second:
                return None, "conflicting_provider_citations"
    target = keys.get(selected["key"])
    if provider_ids and (target is None or target[1] is None):
        target = next(keys[c["key"]] for c in members if c.get("key") in keys and keys[c["key"]][1] is not None)
    return (target[0], "accepted") if target else (None, "unindexed_owner")


SCHEMA = """
DROP TABLE IF EXISTS case_profile;
DROP TABLE IF EXISTS clean_observation;
DROP TABLE IF EXISTS case_alias;
DROP TABLE IF EXISTS case_shortform;
DROP TABLE IF EXISTS party_shortform;
CREATE TABLE case_profile(case_id INTEGER NOT NULL,language TEXT NOT NULL,style TEXT,
 plaintiff TEXT,defendant TEXT,PRIMARY KEY(case_id,language)) WITHOUT ROWID;
CREATE TABLE clean_observation(original_case_id INTEGER NOT NULL,original_alias_id INTEGER NOT NULL,
 source_id INTEGER NOT NULL,kind TEXT NOT NULL,case_id INTEGER,normalized TEXT,spelling TEXT,
 occurrences INTEGER NOT NULL,status TEXT NOT NULL,
 PRIMARY KEY(original_case_id,original_alias_id,source_id,kind)) WITHOUT ROWID;
CREATE TABLE case_alias(case_id INTEGER NOT NULL,language TEXT NOT NULL,normalized TEXT NOT NULL,
 spelling TEXT NOT NULL,definition_documents INTEGER NOT NULL,reference_documents INTEGER NOT NULL,
 document_count INTEGER NOT NULL,occurrences INTEGER NOT NULL,PRIMARY KEY(case_id,language,normalized)) WITHOUT ROWID;
CREATE TABLE case_shortform(case_id INTEGER NOT NULL,language TEXT NOT NULL,shortform TEXT NOT NULL,
 method TEXT NOT NULL,generated TEXT NOT NULL,definition_documents INTEGER NOT NULL,
 PRIMARY KEY(case_id,language)) WITHOUT ROWID;
CREATE TABLE party_shortform(party_key TEXT PRIMARY KEY,shortform TEXT NOT NULL,
 definition_documents INTEGER NOT NULL,case_count INTEGER NOT NULL,vote_share REAL NOT NULL) WITHOUT ROWID;
"""


def qualify_profiles(connection, cases, table="case_profile"):
    """Repair physical wrapping only when the corpus attests the spelling."""
    profiles = {(case_id, language): (style, left, right) for case_id, language, style, left, right
                in connection.execute(f"SELECT case_id,language,style,plaintiff,defendant FROM {table}")}
    for case_id, language in connection.execute("SELECT DISTINCT o.case_id,s.language FROM observation o JOIN source s ON s.id=o.source_id"):
        profiles.setdefault((case_id, language), ("", None, None))
    spellings = set()
    party_spellings = {normalize(party) for profile in profiles.values() for party in profile[1:]
                       if party and not party.startswith("Dans ") and not caption_flag(party)}
    token = re.compile(r"[^\W\d_]+(?:[-’'][^\W\d_]+)*", re.UNICODE)
    for profile in profiles.values():
        for value in profile:
            if value and not caption_flag(value) and not re.search(r"-\s+", value):
                spellings.update(match.group().casefold() for match in token.finditer(value))

    def unwrap(value):
        if not value:
            return value
        def replace(match):
            if match[2].casefold() in {"v", "c"}:
                return match.group()
            hyphenated = match[1] + "-" + match[2]
            joined = match[1] + match[2]
            return joined if joined.casefold() in spellings and hyphenated.casefold() not in spellings else hyphenated
        return re.sub(r"([^\W\d_]+)-\s+([^\W\d_]+)", replace, value)

    evidence = connection.execute("SELECT value FROM meta WHERE key='caption_evidence'").fetchone()
    party_projections = {}
    for item in json.loads(evidence[0]) if evidence else []:
        source = connection.execute("SELECT language,sha256 FROM source WHERE id=?", (item["source_id"],)).fetchone()
        if not source or source != (item.get("source_language", item["language"]), item["source_sha256"]):
            raise ValueError("caption correction no longer matches its source witness")
        profiles[item["case_id"], item["language"]] = (item["caption"], item.get("plaintiff"), item.get("defendant"))
        if item.get("explicit_party_projection"):
            party_projections[item["case_id"], item["language"]] = (item.get("plaintiff"), item.get("defendant"))
    for key, profile in list(profiles.items()):
        style, left, right = map(unwrap, profile)
        # Retain procedural titles; remove an introduction only with party-name evidence.
        if style and style.startswith("Dans "):
            inferred, _ = party_names(style[5:])
            other = profiles.get((key[0], "fr" if key[1] == "en" else "en"))
            if inferred and not re.match(r"l['’]affaire\b", inferred, re.I) and (
                    normalize(inferred) in party_spellings or normalize(inferred) in {"r", "rex", "regina"} or
                    other and any(party and normalize(party) == normalize(inferred) for party in other[1:])):
                style, left, right = style[5:], None, None
        profiles[key] = caption_profile(style, left, right, cases[key[0]][1])
        if key in party_projections:
            profiles[key] = (profiles[key][0], *party_projections[key])
    return profiles


def recommendations(cases, profiles, ranked, model, party_aliases):
    cached = {}
    last_progress = time.monotonic()
    for ordinal, (case_id, case) in enumerate(cases.items(), 1):
        if time.monotonic() - last_progress >= 10:
            last_progress = time.monotonic()
            print(f"preferred names: {ordinal}/{len(cases)} identities", flush=True)
        languages = {language for language in ("en", "fr") if (case_id, language) in profiles or (case_id, language) in ranked}
        for language in sorted(languages or {"en"}):
            style, left, right = profiles.get((case_id, language), (None, None, None))
            profile = (language, style, left, right)
            generated = cached.get(profile)
            if generated is None:
                generated = generate_case(style, left, right, model, case[1] or case[0], party_aliases,
                                          qualified=True, language=language)
                if generated["method"] != "citation_fallback":
                    cached[profile] = generated
            found = sorted(ranked.get((case_id, language), []),
                           key=lambda alias: (-alias[3], -alias[1], len(alias[0]), normalize(alias[0])))
            preferred = next((alias for alias in found if alias[1]), None) if not case[3] else None
            if preferred:
                short, method, votes = preferred[0], "observed" if preferred[1] >= 2 else "observed_single", preferred[1]
            else:
                short, method, votes = generated["shortform"], generated["method"], 0
            yield case_id, language, short, method, generated["shortform"], votes


def store_recommendations(target, cases, profiles, ranked, model):
    from analyze import gold
    policy = model.get("party_name_policy")
    party_aliases = learn_party_names(gold(target), **policy) if policy else {}
    target.executemany("INSERT INTO party_shortform VALUES (?,?,?,?,?)", (
        (key, row["shortform"], row["definition_documents"], row["case_count"], row["vote_share"])
        for key, row in party_aliases.items()))
    target.executemany("INSERT INTO case_shortform VALUES (?,?,?,?,?,?)",
                       recommendations(cases, profiles, ranked, model, party_aliases))
    return {**dict(target.execute("SELECT method,count(*) FROM case_shortform GROUP BY method")),
            "learned_party_names": len(party_aliases),
            "preferred_shortform_rows": target.execute("SELECT count(*) FROM case_shortform").fetchone()[0]}


def rank_aliases(revised, source_rows, cases):
    aliases = defaultdict(lambda: {"definition": set(), "reference": set(), "spellings": defaultdict(set), "occurrences": 0})
    for original, _, source_id, kind, case_id, norm, spelling, occurrences, status in revised:
        if status != "accepted" or cases[case_id][3]:
            continue
        provider, local_id, language, _ = source_rows[source_id]
        document = (provider, local_id)
        value = aliases[case_id, language, norm]
        value["definition" if kind == "definition" else "reference"].add(document)
        value["spellings"][spelling].add(document)
        value["occurrences"] += occurrences
    rows, ranked = [], defaultdict(list)
    for (case_id, language, norm), value in aliases.items():
        spelling = min(value["spellings"].items(), key=lambda item: (-len(item[1]), len(item[0]), item[0]))[0]
        definitions, references = len(value["definition"]), len(value["reference"])
        documents = len(value["definition"] | value["reference"])
        rows.append((case_id, language, norm, spelling, definitions, references, documents, value["occurrences"]))
        ranked[case_id, language].append((spelling, definitions, references, documents))
    return rows, ranked


def refresh_shortforms(database, output):
    """Requalify cached labels and captions, then regenerate preferred names."""
    started = time.monotonic()
    with closing(sqlite3.connect(database)) as target:
        receipt = json.loads(target.execute("SELECT value FROM meta WHERE key='prepared'").fetchone()[0])
        cases = {row[0]: row[1:] for row in target.execute("SELECT id,identity,citation,provider_id,ambiguous FROM case_record")}
        previous_profiles = {(row[0], row[1]): row[2:] for row in target.execute("SELECT * FROM case_profile")}
        profiles = qualify_profiles(target, cases)
        corrections = [(*profiles[case_id, language], case_id, language)
                       for case_id, language in profiles
                       if profiles[case_id, language] != previous_profiles.get((case_id, language))]
        sources = {row[0]: row[1:] for row in target.execute("SELECT id,provider,local_id,language,sha256 FROM source")}
        court_markers = set(receipt["court_marker_forms"])
        revised = []
        newly_unsuitable = Counter()
        cleaned_spellings = Counter()
        reviewed_rejections = rejected_evidence(target)
        reviewed_names = normalized_declarations(target)
        for original, alias_id, source_id, kind, case_id, norm, spelling, occurrences, status in target.execute(
                "SELECT * FROM clean_observation"):
            name = clean_alias(reviewed_names.get((original, alias_id, source_id, kind), spelling))
            if status == "accepted":
                if (original, alias_id, source_id, kind) in reviewed_rejections:
                    newly_unsuitable[reviewed_rejections[original, alias_id, source_id, kind]] += 1
                    revised.append((original, alias_id, source_id, kind, None, None, name, occurrences, "reviewed_source_error"))
                    continue
                if name != spelling:
                    cleaned_spellings[kind] += 1
                profile = profiles.get((case_id, sources[source_id][2]), (None, None, None))
                if usable_case_alias(name, profile, court_markers):
                    norm = normalize(name)
                else:
                    newly_unsuitable[base_name_flag(name, profile[1:]) or "unsuitable_label"] += 1
                    case_id, norm, status = None, None, "unsuitable_label"
            revised.append((original, alias_id, source_id, kind, case_id, norm, name, occurrences, status))
        rows, ranked = rank_aliases(revised, sources, cases)
        target.execute("BEGIN")
        target.execute("DELETE FROM clean_observation")
        target.executemany("INSERT INTO clean_observation VALUES (?,?,?,?,?,?,?,?,?)", revised)
        target.execute("DELETE FROM case_alias")
        target.executemany("INSERT INTO case_alias VALUES (?,?,?,?,?,?,?,?)", rows)
        target.executemany("INSERT OR REPLACE INTO case_profile VALUES (?,?,?,?,?)",
                           ((case_id, language, style, left, right) for style, left, right, case_id, language in corrections))
        target.execute("DELETE FROM case_shortform")
        target.execute("DROP TABLE IF EXISTS party_shortform")
        target.execute("CREATE TABLE party_shortform(party_key TEXT PRIMARY KEY,shortform TEXT NOT NULL,"
                       "definition_documents INTEGER NOT NULL,case_count INTEGER NOT NULL,vote_share REAL NOT NULL) WITHOUT ROWID")
        counts = store_recommendations(target, cases, profiles, ranked, load_model())
        for key in ("generated", "generated_attested_party", "observed", "observed_single", "title_generated", "citation_fallback"):
            receipt["stats"].pop(key, None)
        counts["case_alias_rows"] = len(rows)
        receipt["stats"].update(counts)
        receipt["qualification"] = {"method": "reuse_verified_identity",
            "caption_profiles_repaired": len(corrections),
            "newly_unsuitable_labels": dict(newly_unsuitable),
            "alias_spellings_cleaned": dict(cleaned_spellings),
            "accepted_definition_rows": sum(row[3] == "definition" and row[-1] == "accepted" for row in revised),
            "unsuitable_definition_rows": sum(row[3] == "definition" and row[-1] == "unsuitable_label" for row in revised)}
        receipt["stats"].update(accepted=receipt["qualification"]["accepted_definition_rows"], case_profiles=len(profiles))
        receipt["recommendation_code_sha256"] = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in ("prepare.py", "shortform.py", "edit_decoder.py", "operations.py", "party_alias.py", "evidence.py", "mine.py", "analyze.py", "training_data.py", "model.json")}
        receipt["refresh_elapsed_seconds"] = round(time.monotonic()-started, 2)
        target.execute("UPDATE meta SET value=? WHERE key='prepared'", (json.dumps(receipt),))
        target.commit()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({**counts, "elapsed_seconds": receipt["refresh_elapsed_seconds"]}, indent=2), flush=True)
    return receipt


def prepare(database, output, limit=0, evidence_only=False):
    started = time.monotonic()
    counts = Counter()
    engine = Engine()
    try:
        courts = court_forms(engine)
        court_markers = court_marker_forms(engine)
        with ExitStack() as stack:
            raw = stack.enter_context(closing(readonly(database)))
            meta = {key: json.loads(value) for key, value in raw.execute("SELECT * FROM meta")}
            if engine.metadata != meta["engine"]:
                raise ValueError("the index and current native engine differ")
            sources = {provider: stack.enter_context(closing(readonly(Path(filename))))
                       for provider, filename in meta["sources"].items()}
            cases = {row[0]: row[1:] for row in raw.execute("SELECT id,identity,citation,provider_id,ambiguous FROM case_record")}
            keys = {key: (case_id, cases[case_id][2]) for key, case_id in raw.execute("SELECT key,case_id FROM case_key")}
            table = "case_profile" if evidence_only else "case_name"
            profiles = qualify_profiles(raw, cases, table)
            work = defaultdict(lambda: {"definitions": [], "captions": []})
            accepted = []
            reviewed_rejections = rejected_evidence(raw)
            reviewed_names = normalized_declarations(raw)
            for row in raw.execute("SELECT case_id,alias_id,source_id,kind,spelling,occurrences,start,end FROM observation"):
                case_id, alias_id, source_id, kind, spelling, occurrences, start, end = row
                name = clean_alias(reviewed_names.get(row[:4], spelling))
                if row[:4] in reviewed_rejections:
                    accepted.append((case_id, alias_id, source_id, kind, None, None, name, occurrences, "reviewed_source_error"))
                elif not usable_alias(name):
                    accepted.append((case_id, alias_id, source_id, kind, None, None, name, occurrences, "unsuitable_label"))
                elif kind == "definition":
                    work[source_id]["definitions"].append((*row[:4], name, occurrences, start, end))
                else:
                    accepted.append((case_id, alias_id, source_id, kind, case_id, normalize(name), name, occurrences, "accepted"))
            for case_id, source_id, start, end in ([] if evidence_only else raw.execute("SELECT w.case_id,w.source_id,w.start,w.end FROM case_seen w"
                    " JOIN case_record c ON c.id=w.case_id WHERE c.provider_id IS NULL")):
                if not any(profiles.get((case_id, language), (None,))[0] for language in ("en", "fr")):
                    work[source_id]["captions"].append((case_id, start, end))
            pending, locations = [], []

            def flush():
                if not pending:
                    return
                responses = engine.call("batch", [{"method": "extract", "request": {"text": body,
                    "offsetUnit": "char", "options": {"resolve": False, "parallel": True}}}
                    for body in pending])
                for body, location, response in zip(pending, locations, responses):
                    mode, original, origin, language = location
                    if "error" in response:
                        counts["native_errors"] += 1
                        if mode == "definition":
                            case_id, alias_id, source_id, kind, name, occurrences, start, end = original
                            accepted.append((case_id, alias_id, source_id, kind, None, None, name, occurrences, "native_error"))
                        continue
                    citations = response["citations"]
                    full = [c for c in citations if c["form"] == "full" and c["authority"] == "case" and c.get("key")]
                    for citation in full:
                        target = keys.get(citation["key"])
                        style = (citation.get("style") or {}).get("text")
                        if target and style and not profiles.get((target[0], language), (None,))[0]:
                            parties = citation.get("parties") or {}
                            left, right = parties.get("plaintiff"), parties.get("defendant")
                            profiles[target[0], language] = caption_profile(style, left, right, cases[target[0]][1])
                    if mode == "definition":
                        case_id, alias_id, source_id, kind, name, occurrences, start, end = original
                        resolved, status = owner(citations, start-origin, end-origin, name, keys, body, courts)
                        accepted.append((case_id, alias_id, source_id, kind, resolved,
                                         normalize(name) if resolved else None, name, occurrences, status))
                        counts[status] += 1
                        counts["retargeted_definitions"] += int(resolved is not None and resolved != case_id)
                    else:
                        counts["caption_excerpts"] += 1
                pending.clear()
                locations.clear()

            source_rows = {row[0]: row[1:] for row in raw.execute("SELECT id,provider,local_id,language,sha256 FROM source")}
            last_progress = time.monotonic()
            for ordinal, source_id in enumerate(sorted(work)):
                if limit and ordinal >= limit:
                    break
                provider, local_id, language, expected = source_rows[source_id]
                query = "SELECT text FROM articles WHERE article_id=?" if provider == "journal" else (
                    "SELECT unofficial_text_" + language + " FROM document WHERE id=?")
                text = sources[provider].execute(query, (local_id,)).fetchone()[0]
                if hashlib.sha256(text.encode("utf-8")).hexdigest() != expected:
                    raise ValueError("a source changed since the corpus census")
                counts["source_texts_verified"] += 1
                for row in work[source_id]["definitions"]:
                    start, end = row[-2:]
                    origin = declaration_origin(text, start)
                    pending.append(text[origin:end])
                    locations.append(("definition", row, origin, language))
                    if len(pending) >= 256:
                        flush()
                for row in work[source_id]["captions"]:
                    case_id, start, end = row
                    if profiles.get((case_id, language), (None,))[0]:
                        continue
                    origin = max(0, start - 350)
                    pending.append(text[origin:end])
                    locations.append(("caption", row, origin, language))
                    if len(pending) >= 256:
                        flush()
                if time.monotonic() - last_progress >= 10:
                    last_progress = time.monotonic()
                    print(f"prepared {counts['source_texts_verified']}/{len(work)} source texts, "
                          f"{len(profiles)} captions; {time.monotonic()-started:.0f}s", flush=True)
            flush()
            if limit:
                print(json.dumps({"pilot": True, **counts, "elapsed_seconds": round(time.monotonic()-started, 2)}, indent=2))
                return
            # A named supra inherits the outcome of its own document's explicit declaration.
            declarations = defaultdict(set)
            declared = set()
            for row in accepted:
                original, _, source_id, kind, resolved, norm, name, _, status = row
                if kind == "definition":
                    declared.add((source_id, normalize(name)))
                if kind == "definition" and status == "accepted":
                    declarations[source_id, normalize(name)].add(resolved)
            revised = []
            for row in accepted:
                original, alias_id, source_id, kind, resolved, norm, name, occurrences, status = row
                if kind != "definition" and status == "accepted":
                    targets = declarations.get((source_id, normalize(name)), set())
                    if len(targets) == 1:
                        resolved = next(iter(targets))
                    elif len(targets) > 1:
                        resolved, status = None, "ambiguous_reference"
                    elif (source_id, normalize(name)) in declared:
                        resolved, status = None, "rejected_antecedent"
                if status == "accepted":
                    profile = profiles.get((resolved, source_rows[source_id][2]), (None, None, None))
                    if not usable_case_alias(name, profile, court_markers):
                        resolved, norm, status = None, None, "unsuitable_label"
                        counts["court_markers_rejected"] += 1
                revised.append((original, alias_id, source_id, kind, resolved, norm, name, occurrences, status))
            counts["accepted"] = sum(row[3] == "definition" and row[-1] == "accepted" for row in revised)
            rows, ranked = rank_aliases(revised, source_rows, cases)
            with closing(sqlite3.connect(database)) as target:
                raw.commit()
                target.execute("PRAGMA journal_mode=WAL")
                target.executescript("BEGIN;" + SCHEMA)
                target.executemany("INSERT INTO case_profile VALUES (?,?,?,?,?)", ((case_id, language, *value) for (case_id, language), value in profiles.items()))
                target.executemany("INSERT INTO clean_observation VALUES (?,?,?,?,?,?,?,?,?)", revised)
                target.executemany("INSERT INTO case_alias VALUES (?,?,?,?,?,?,?,?)", rows)
                counts.update(store_recommendations(target, cases, profiles, ranked, load_model()))
                counts["case_profiles"] = len(profiles)
                counts["case_alias_rows"] = len(rows)
                counts["elapsed_seconds"] = round(time.monotonic()-started, 2)
                receipt = {"text_stream_sha256": meta["text_stream_sha256"], "engine": engine.metadata,
                    "court_marker_forms": sorted(court_markers),
                    "code_sha256": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                    for name in ("prepare.py", "evidence.py", "shortform.py", "edit_decoder.py", "operations.py", "party_alias.py", "parser.mjs", "model.json")}, "stats": dict(counts)}
                target.execute("INSERT OR REPLACE INTO meta VALUES ('prepared',?)", (json.dumps(receipt),))
                target.commit()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(receipt["stats"], indent=2), flush=True)
            return receipt
    finally:
        engine.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=data_root() / "cache/case-shortforms/shortforms.sqlite")
    parser.add_argument("--output", type=Path, default=Path("benchmarks/local-data/case-shortforms/preparation.json"))
    parser.add_argument("--limit", type=int, default=0, help="source-text pilot only; does not write prepared tables")
    parser.add_argument("--refresh", action="store_true", help="requalify cached labels/captions and refresh preferred names")
    parser.add_argument("--evidence", action="store_true", help="revalidate declarations after ownership changes; reuse recovered captions")
    args = parser.parse_args()
    if args.refresh:
        refresh_shortforms(args.database, args.output)
    else:
        prepare(args.database, args.output, args.limit, args.evidence)
