"""Mine authored case aliases from complete installed journal and A2AJ texts."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import unicodedata

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend" / "scripts"))
from open_legal_data_bridge import data_root  # noqa: E402
sys.path.insert(0, str(ROOT / "legal-pdf-parser" / "src"))
from legalpdf.anchored_scan import AnchoredPattern  # noqa: E402
from legalpdf.grammar_tables import compile_entry  # noqa: E402


class Scanner:
    """The shared grammar screens complete text; native verification sees only excerpts."""
    def __init__(self, engine, forms=()):
        self.engine = engine
        corpus = json.loads((ROOT / "common-law-cite/crates/legal-grammar/data/grammar-corpus.json").read_text(encoding="utf-8"))
        entries = {e["id"]: (e, t.get("defs")) for t in corpus["tables"].values() for e in t["entries"]}
        def pattern(key, screen=False):
            entry, defs = entries[key]
            if screen:
                # Dropping boundaries only over-finds. Factoring the leading digit enables re's C-speed skip loop.
                source = entry["pattern"].replace(r"\b", "").replace(r"(?:19|20)\d{2}", r"\d\d{3}")
                source = source.replace(r"\d+", r"\d\d*")
                entry = {**entry, "pattern": source}
            return AnchoredPattern(compile_entry(entry, defs))
        self.cores = pattern("cite.in-text", True)
        self.exact_core = pattern("cite.in-text").rx
        self.brackets = pattern("ref.infer.explicit")
        entry, defs = entries["attach.defined-term"]
        self.defined = AnchoredPattern(compile_entry({**entry, "pattern": r"\(" + entry["pattern"][1:-1] + r"\)"}, defs))
        self.references = pattern("ref.back", True)
        self.references = AnchoredPattern(self.references.rx,
            ["ibid", "id.", "supra", "above", "(n", "précit", "precit", "op"])
        self.antecedent = pattern("ref.antecedent-name")
        self.bridge = pattern("pinpoint.bridge").rx
        self.pins = [pattern(key).rx for key in ("pinpoint.para.toa", "pinpoint.section.toa", "pinpoint.page.toa")]
        self.keys = {normalize(form): key for form, key in forms}
        self.definitions = {}
        self.hints = {}
        registry = engine.call("registry", {})
        self.registered = {normalize(value) for rows in registry["reporters"].values() for row in rows
                           for value in [*row["editions"], *row.get("variations", {})]}
        self.registered.update(normalize(value) for row in registry["courts"]
                               for value in [*row.get("neutral", []), *row.get("aliases", [])])
        self.caption_keys = set(self.keys.values())

    def scan(self, text):
        hits, errors = [], []
        verified = 0
        def batch(bodies, purpose):
            nonlocal verified
            if not bodies:
                return []
            verified += sum(map(len, bodies))
            results = self.engine.call("batch", [{"method": "extract", "request": {"text": body,
                "offsetUnit": "char", "options": {"resolve": False, "parallel": False}}} for body in bodies])
            rows = []
            for body, result in zip(bodies, results):
                if "error" in result:
                    errors.append({"purpose": purpose, "message": result["error"], "text": body})
                    rows.append([])
                else:
                    rows.append(result["citations"])
            return rows
        cores = [m for m in self.cores.finditer(text) if self.exact_core.match(text, m.start())]
        novel = {}
        for match in cores:
            core, norm = match.group(), normalize(match.group())
            if norm in self.keys:
                continue
            reporter = normalize(re.sub(r"\d+|\([^)]*\)", "", core))
            if reporter in self.registered or reporter == "canlii":
                novel[norm] = core
            else:
                self.keys[norm] = None
        for norm, rows in zip(novel, batch(list(novel.values()), "core")):
            parsed = next((c for c in rows if c["form"] == "full" and c["authority"] == "case" and c.get("key")), None)
            self.keys[norm] = parsed["key"] if parsed else None
        owners = []
        for match in cores:
            key = self.keys[normalize(match.group())]
            if key:
                row = {"form": "full", "authority": "case", "key": key,
                       "core": {"start": match.start(), "end": match.end(), "text": match.group()}}
                owners.append(row)
                hits.append(row)
        declarations = sorted([*self.brackets.finditer(text), *self.defined.finditer(text)], key=lambda m: m.start())
        index = -1
        located, pending = [], {}
        for match in declarations:
            if not any(char.isalpha() for char in match.group()):
                continue
            while index + 1 < len(owners) and owners[index + 1]["core"]["end"] <= match.start():
                index += 1
            previous = owners[index] if index >= 0 else None
            anchor = previous["core"] if previous and match.start() - previous["core"]["end"] < 600 else None
            if not anchor:
                screened = list(self.cores.rx.finditer(text, max(0, match.start()-500), match.start()))
                if not screened:
                    continue
                anchor = {"start": screened[-1].start(), "end": screened[-1].end()}
            if match.group().startswith("["):
                gap = text[anchor["end"]:match.start()]
                # Numeric continuations can contain an unscreened parallel citation or subsequent history.
                possible = any(char.isdigit() for char in gap) or self.bridge.fullmatch(gap) or any(
                    self.bridge.fullmatch(gap[:pin.start()]) and not gap[pin.end():].strip(" ,\n\r\t")
                    for pattern in self.pins for pin in pattern.finditer(gap))
                if not possible:
                    continue
            if previous and match.start() - previous["core"]["end"] < 600:
                origin = previous["core"]["start"]
                if previous["key"] not in self.caption_keys:
                    origin = max(0, origin - 350)
            else:
                origin = max(0, match.start() - 500)
                if not self.cores.rx.search(text, origin, match.start()):
                    continue
            body = text[origin:match.end()]
            located.append((body, origin))
            if body not in self.definitions:
                pending[body] = None
        for body, rows in zip(pending, batch(list(pending), "definition")):
            self.definitions[body] = [c for c in rows if c.get("explicit") and c.get("key")]
        for body, origin in located:
            for cached in self.definitions[body]:
                row = {**cached}
                for field in ("core", "style", "explicitSpan"):
                    if row.get(field):
                        row[field] = {**row[field], "start": origin + row[field]["start"], "end": origin + row[field]["end"]}
                hits.append(row)
        references, pending_names = [], {}
        if hits:
            for match in self.references.finditer(text):
                if match.groupdict().get("ibid"):
                    continue
                start = max(0, match.start() - 220)
                named = list(self.antecedent.finditer(text[start:match.start()]))
                if not named:
                    continue
                captured = named[-1].group("name")
                references.append((match, captured, start))
                if captured not in self.hints:
                    pending_names[captured] = None
        if pending_names:
            names = self.engine.call("batch", [{"method": "supraHint", "request": {
                "text": captured + ", supra note 1", "aggressive": True}} for captured in pending_names])
            self.hints.update(zip(pending_names, names))
        for match, captured, start in references:
            name = self.hints[captured]
            at = text.rfind(name, start, match.start()) if isinstance(name, str) and name else -1
            if at >= 0:
                hits.append({"form": "supra", "authority": "unknown", "name": name,
                             "core": {"start": match.start(), "end": match.end(), "text": match.group()},
                             "style": {"start": at, "end": at + len(name), "text": name}})
        unique, first = {}, set()
        for row in sorted(hits, key=lambda c: c["core"]["start"]):
            if row["form"] == "full" and not row.get("explicit") and not row.get("style"):
                if row["key"] in first:
                    continue
                first.add(row["key"])
            token = (row["form"], row["core"]["start"], row["core"]["end"])
            unique[token] = {**unique.get(token, {}), **row}
        return {"citations": list(unique.values()), "screenedCores": len(cores), "verifiedChars": verified,
                "errors": errors, "fullCaseCitations": len(owners)}


def normalize(value: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", value).casefold() if c.isalnum())


def balanced_delimiters(value):
    stack = []
    for char in value or "":
        if char in "([":
            stack.append(char)
        elif char in ")]":
            if not stack or stack.pop() != ("(" if char == ")" else "["):
                return False
    return not stack


def label(value: str | None) -> str:
    value = " ".join((value or "").split()).strip('\"“”')
    if value.startswith("[") and value.endswith("]") and balanced_delimiters(value[1:-1]):
        value = value[1:-1].strip()
    return value if 0 < len(value) <= 100 and any(c.isalpha() for c in value) else ""


def reusable(value: str) -> bool:
    # These labels name a document-local role, rather than an identifiable case.
    return normalize(value) not in {
        "case", "thecase", "decision", "thedecision", "maindecision", "appeal",
        "trialdecision", "firstdecision", "seconddecision", "majority", "dissent",
        "reasons", "rfj", "judgesreasons", "reasonsoftheassociatejudge", "trialreasons",
        "reasonsforjudgment", "judgment", "order", "trialjudgment", "appealdecision",
    } and not (set(words(value)) <= {"the", "first", "second", "third", "trial", "appeal", "judge",
                                   "judges", "s", "associate", "reasons", "for", "judgment", "decision", "order", "of"})


def readonly(filename: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(filename.resolve().as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA mmap_size=268435456")
    connection.execute("BEGIN")
    return connection


def journal_path() -> Path:
    configured = os.environ.get("MIKE_PUBLIC_ENDPOINT_DB", "").strip()
    if configured:
        return Path(configured)
    shared = data_root() / "providers/journals/public_endpoint.db"
    if shared.is_file():
        return shared
    search = Path(os.environ.get("MIKE_PUBLIC_ENDPOINT_FTS_DB", "").strip() or
                  data_root() / "providers/journals/public_endpoint-search.sqlite")
    if search.is_file():
        with closing(readonly(search)) as connection:
            source = dict(connection.execute("SELECT key,value FROM meta")).get("source_path")
            if source and Path(source).is_file():
                return Path(source)
    return shared


class Engine:
    def __init__(self):
        self.process = subprocess.Popen(
            ["node", str(Path(__file__).with_name("parser.mjs"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, encoding="utf-8", bufsize=1,
        )
        self.metadata = self._read()

    def _read(self):
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("citation engine exited without a reply")
        result = json.loads(line)
        if isinstance(result, dict) and "error" in result:
            raise RuntimeError(result["error"])
        return result

    def call(self, method, request):
        self.process.stdin.write(json.dumps({"method": method, "request": request}, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        return self._read()

    def extract(self, text):
        return self.call("extract", {"text": text, "offsetUnit": "char", "options": {
            "resolve": False, "parallel": False,
        }})["citations"]

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()


def chunks(text: str, size=24000, context=1500):
    """Read every character, with context on each side and one owner per core span."""
    for start in range(0, len(text), size):
        stop = min(start + size, len(text))
        origin = max(0, start - context)
        yield origin, start, stop, text[origin:min(len(text), stop + context)]


def extract_document(engine, text):
    citations = []
    for origin, start, stop, body in chunks(text):
        for citation in engine.extract(body):
            span = citation["core"]
            midpoint = origin + (span["start"] + span["end"]) // 2
            if not start <= midpoint < stop:
                continue
            for field in ("core", "style", "explicitSpan"):
                if citation.get(field):
                    citation[field]["start"] += origin
                    citation[field]["end"] += origin
            citations.append(citation)
    return sorted(citations, key=lambda c: (c["core"]["start"], c["core"]["end"]))


def observations(citations, identity):
    """Independent declarations are gold. Name-based links remain a separate tier."""
    found = []
    known = defaultdict(list)
    declarations = defaultdict(set)
    for citation in citations:
        if citation["form"] != "full" or citation["authority"] != "case" or not citation.get("key"):
            continue
        case_id = identity(citation)
        core = citation["core"]
        known[case_id].append(citation)
        explicit = label(citation.get("explicit"))
        if explicit:
            span = citation.get("explicitSpan") or core
            found.append((case_id, explicit, "definition", span["start"], span["end"]))
            declarations[normalize(explicit)].add(case_id)
        elif not citation.get("parties") and citation.get("style"):
            name = label(citation["style"]["text"])
            if name and reusable(name):
                span = citation["style"]
                found.append((case_id, name, "named_citation", span["start"], span["end"]))
    name_index = defaultdict(set)
    first_seen = {}
    for case_id, fulls in known.items():
        first_seen[case_id] = min(full["core"]["start"] for full in fulls)
        for full in fulls:
            for name in [*(full.get("parties") or {}).values(), *(full.get("comparison_names") or [])]:
                tokens = words(name or "")
                for length in range(1, min(10, len(tokens)) + 1):
                    for start in range(len(tokens) - length + 1):
                        name_index[tuple(tokens[start:start+length])].add(case_id)
    for citation in citations:
        if citation["form"] not in {"reference", "supra", "short"}:
            continue
        name = label(citation.get("name"))
        if not name or not reusable(name):
            continue
        norm = normalize(name)
        candidates = {case_id for case_id in declarations.get(norm, set())
                      if first_seen[case_id] < citation["core"]["start"]}
        if not candidates:
            # Only a whole authored party-name token sequence can support this weaker link.
            wanted = words(name)
            candidates = {case_id for case_id in name_index.get(tuple(wanted), set())
                          if first_seen[case_id] < citation["core"]["start"]}
        if len(candidates) == 1:
            case_id = next(iter(candidates))
            span = citation.get("style") or citation["core"]
            found.append((case_id, name, "named_reference", span["start"], span["end"]))
    return found


def words(value: str):
    import re
    return re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", value).casefold())


def contains(haystack, needle):
    return bool(needle) and any(haystack[i:i + len(needle)] == needle
                              for i in range(len(haystack) - len(needle) + 1))


SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE case_record(id INTEGER PRIMARY KEY, identity TEXT NOT NULL UNIQUE,
 citation TEXT, style TEXT, plaintiff TEXT, defendant TEXT, provider_id INTEGER,
 ambiguous INTEGER NOT NULL DEFAULT 0);
CREATE TABLE case_key(key TEXT PRIMARY KEY, case_id INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE case_name(case_id INTEGER NOT NULL, language TEXT NOT NULL, style TEXT,
 plaintiff TEXT, defendant TEXT, PRIMARY KEY(case_id,language)) WITHOUT ROWID;
CREATE TABLE case_seen(case_id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL,
 start INTEGER NOT NULL, end INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE ambiguous_key(key TEXT PRIMARY KEY, provider_ids TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE source(id INTEGER PRIMARY KEY, provider TEXT NOT NULL, local_id INTEGER NOT NULL,
 language TEXT NOT NULL, sha256 TEXT NOT NULL, chars INTEGER NOT NULL, duplicate_of INTEGER,
 UNIQUE(provider,local_id,language));
CREATE TABLE alias(id INTEGER PRIMARY KEY, normalized TEXT NOT NULL UNIQUE, reusable INTEGER NOT NULL);
CREATE TABLE observation(case_id INTEGER NOT NULL, alias_id INTEGER NOT NULL, source_id INTEGER NOT NULL,
 kind TEXT NOT NULL, spelling TEXT NOT NULL, occurrences INTEGER NOT NULL, start INTEGER NOT NULL,
 end INTEGER NOT NULL, PRIMARY KEY(case_id,alias_id,source_id,kind)) WITHOUT ROWID;
CREATE INDEX observation_case ON observation(case_id,alias_id,kind);
"""


def mine(journals: Path, a2aj: Path, output: Path, every: int = 1, limit: int = 0):
    if every < 1 or limit < 0:
        raise ValueError("every must be positive; limit must be nonnegative")
    for filename in (journals, a2aj):
        if not filename.is_file():
            raise FileNotFoundError(filename)
        if filename.resolve() == output.resolve():
            raise ValueError("output must not replace a source database")
    output.parent.mkdir(parents=True, exist_ok=True)
    building = output.with_name(output.name + ".building")
    if building.exists():
        raise FileExistsError(f"unfinished build already exists: {building}")
    engine = None
    stats = Counter()
    started = time.monotonic()
    failure_file = ROOT / "benchmarks/local-data/case-shortforms/verification-errors.jsonl"
    failure_file.parent.mkdir(parents=True, exist_ok=True)
    failure_file.write_text("", encoding="utf-8")
    code_sha256 = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                   for name in ("mine.py", "parser.mjs")}
    try:
        engine = Engine()
        with closing(readonly(a2aj)) as cases, closing(readonly(journals)) as articles, \
                closing(sqlite3.connect(building)) as target:
            target.executescript(SCHEMA)
            target.execute("PRAGMA journal_mode=OFF")
            target.execute("PRAGMA synchronous=OFF")
            key_version = dict(cases.execute("SELECT * FROM meta")).get("citation_key_version")
            if (key_version or "").split(":")[0] != engine.metadata["version"]["keyVersion"]:
                raise ValueError("A2AJ lookup keys and the citation engine have different versions")
            by_key = defaultdict(set)
            for key, case_id in cases.execute("SELECT citation_key,document_id FROM citation_lookup"):
                by_key[key].add(case_id)
            unique = {key: next(iter(ids)) for key, ids in by_key.items() if len(ids) == 1}
            inverse = defaultdict(list)
            for key, case_id in unique.items():
                inverse[case_id].append(key)
            target.executemany("INSERT INTO ambiguous_key VALUES (?,?)", (
                (key, json.dumps(sorted(ids))) for key, ids in by_key.items() if len(ids) > 1))
            canonical = lambda keys: min(keys, key=lambda key: (":neutral:" not in key, key))
            names = {}
            forms = defaultdict(set)
            for case_id, en, fr, en2, fr2, en_name, fr_name in cases.execute("SELECT id,citation_en,citation_fr,citation2_en,"
                    "citation2_fr,name_en,name_fr FROM document NOT INDEXED WHERE doc_type='cases'"):
                name = en_name or fr_name
                citation = en or fr
                identity_key = canonical(inverse[case_id]) if inverse[case_id] else f"a2aj:{case_id}"
                target.execute("INSERT INTO case_record(id,identity,citation,style,provider_id) VALUES (?,?,?,?,?)",
                               (case_id, identity_key, citation, name, case_id))
                names[case_id] = name
                target.executemany("INSERT INTO case_name(case_id,language,style) VALUES (?,?,?)",
                                   ((case_id, language, value) for language, value in (("en", en_name), ("fr", fr_name)) if value))
                if inverse[case_id]:
                    for form in (en, fr, en2, fr2):
                        if form:
                            forms[form].add(identity_key)
            scanner = Scanner(engine, ((form, next(iter(keys))) for form, keys in forms.items() if len(keys) == 1))
            print(f"provider identities loaded in {time.monotonic()-started:.1f}s", flush=True)
            target.executemany("INSERT INTO case_key VALUES (?,?)", ((key, case_id) for key, case_id in unique.items()
                              if target.execute("SELECT 1 FROM case_record WHERE id=?", (case_id,)).fetchone()))
            next_id = cases.execute("SELECT max(id) FROM document").fetchone()[0] + 1
            ids = {key: case_id for key, case_id in target.execute("SELECT key,case_id FROM case_key")}
            witnessed = set()
            aliases = {}
            seen_text = {}
            digests = {provider: hashlib.sha256() for provider in ("journal", "a2aj")}

            def identity(citation):
                nonlocal next_id
                key = citation["key"]
                case_id = ids.get(key)
                parties = citation.get("parties") or {}
                style = (citation.get("style") or {}).get("text")
                if case_id is None:
                    case_id = next_id
                    next_id += 1
                    ids[key] = case_id
                    target.execute("INSERT INTO case_record(id,identity,citation,style,plaintiff,defendant,ambiguous)"
                                   " VALUES (?,?,?,?,?,?,?)", (case_id, key, citation["core"]["text"], style,
                                   parties.get("plaintiff"), parties.get("defendant"),
                                   int(key in by_key or ":reporter:unknown:" in key)))
                    target.execute("INSERT INTO case_key VALUES (?,?)", (key, case_id))
                elif style or parties:
                    target.execute("UPDATE case_record SET plaintiff=coalesce(plaintiff,?),"
                                   "defendant=coalesce(defendant,?),style=coalesce(style,?) WHERE id=?",
                                   (parties.get("plaintiff"), parties.get("defendant"), style, case_id))
                if names.get(case_id):
                    citation["comparison_names"] = [names[case_id]]
                if case_id not in witnessed:
                    target.execute("INSERT INTO case_seen VALUES (?,?,?,?)", (case_id, source_id,
                                   citation["core"]["start"], citation["core"]["end"]))
                    witnessed.add(case_id)
                if style and case_id not in names:
                    target.execute("INSERT OR IGNORE INTO case_name VALUES (?,?,?,?,?)", (case_id, language,
                                   style, parties.get("plaintiff"), parties.get("defendant")))
                return case_id

            streams = [
                ("journal", articles.execute("SELECT article_id,'en',text FROM articles WHERE length(text)>0"
                    " AND article_id % ? = 0 ORDER BY article_id", (every,))),
                ("a2aj", ((local_id, language, text) for local_id, en, fr in cases.execute(
                    "SELECT id,unofficial_text_en,unofficial_text_fr FROM document NOT INDEXED WHERE doc_type='cases'"
                    " AND id % ?=0 ORDER BY id", (every,))
                    for language, text in (("en", en), ("fr", fr)) if text)),
            ]
            for provider, rows in streams:
                provider_start = time.monotonic()
                last_progress = provider_start
                for ordinal, (local_id, language, text) in enumerate(rows):
                    if limit and ordinal >= limit:
                        break
                    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
                    digests[provider].update(f"{local_id}:{language}:{sha}\n".encode())
                    duplicate = seen_text.get(sha)
                    cursor = target.execute("INSERT INTO source(provider,local_id,language,sha256,chars,duplicate_of)"
                                            " VALUES (?,?,?,?,?,?)", (provider, local_id, language, sha, len(text), duplicate))
                    source_id = cursor.lastrowid
                    stats[f"{provider}_texts"] += 1
                    stats[f"{provider}_chars"] += len(text)
                    if duplicate:
                        stats["duplicate_texts"] += 1
                        continue
                    seen_text[sha] = source_id
                    scanned = scanner.scan(text)
                    citations = scanned["citations"]
                    stats["screened_cores"] += scanned["screenedCores"]
                    stats["verified_chars"] += scanned["verifiedChars"]
                    stats["verification_errors"] += len(scanned["errors"])
                    stats["full_case_citations"] += scanned["fullCaseCitations"]
                    for error in scanned["errors"]:
                        # Error text is private source material, retained with its exact source identity.
                        with failure_file.open("a", encoding="utf-8") as failures:
                            failures.write(json.dumps({"provider": provider, "local_id": local_id,
                                "language": language, "sha256": sha, **error}, ensure_ascii=False) + "\n")
                    found = observations(citations, identity)
                    grouped = {}
                    for case_id, spelling, kind, start, end in found:
                        norm = normalize(spelling)
                        alias_id = aliases.get(norm)
                        if alias_id is None:
                            alias_id = target.execute("INSERT INTO alias(normalized,reusable) VALUES (?,?)",
                                                      (norm, int(reusable(spelling)))).lastrowid
                            aliases[norm] = alias_id
                        group = (case_id, alias_id, kind)
                        if group not in grouped:
                            grouped[group] = [spelling, 0, start, end]
                        grouped[group][1] += 1
                        stats[kind] += 1
                        full = next((c for c in citations if c.get("key") and ids.get(c["key"]) == case_id
                                     and c.get("style")), None)
                        if full and case_id not in names:
                            target.execute("INSERT OR IGNORE INTO case_name VALUES (?,?,?,?,?)",
                                (case_id, language, (full.get("style") or {}).get("text"),
                                 (full.get("parties") or {}).get("plaintiff"),
                                 (full.get("parties") or {}).get("defendant")))
                    target.executemany("INSERT INTO observation VALUES (?,?,?,?,?,?,?,?)", (
                        (case_id, alias_id, source_id, kind, *values)
                        for (case_id, alias_id, kind), values in grouped.items()))
                    if time.monotonic() - last_progress >= 10:
                        last_progress = time.monotonic()
                        target.commit()
                        print(f"{provider}: {stats[f'{provider}_texts']} texts, "
                              f"{stats[f'{provider}_chars']/1e6:.1f}M chars, {stats['definition']} definitions; "
                              f"{time.monotonic()-provider_start:.0f}s", flush=True)
                target.commit()
                stats[f"{provider}_elapsed_seconds"] = round(time.monotonic() - provider_start, 2)
            # Authoritative provider styles, rather than a citing author's possible misnaming, own gold party names.
            gold_ids = target.execute("SELECT DISTINCT c.id,s.language FROM case_record c JOIN observation o"
                        " ON o.case_id=c.id JOIN source s ON s.id=o.source_id WHERE o.kind='definition'"
                        " AND c.provider_id IS NOT NULL").fetchall()
            for case_id, language in gold_ids:
                row = target.execute("SELECT n.style,c.citation FROM case_record c JOIN case_name n"
                                     " ON n.case_id=c.id WHERE c.id=? AND n.language=?", (case_id, language)).fetchone()
                if not row:
                    stats["missing_language_gold_name"] += 1
                    continue
                name, citation = row
                try:
                    parsed = next((c for c in engine.extract(f"{name}, {citation}") if c.get("parties")), None)
                except RuntimeError as error:
                    stats["metadata_verification_errors"] += 1
                    with failure_file.open("a", encoding="utf-8") as failures:
                        failures.write(json.dumps({"case_id": case_id, "language": language,
                            "purpose": "provider_caption", "text": f"{name}, {citation}", "message": str(error)},
                            ensure_ascii=False) + "\n")
                    parsed = None
                if parsed and normalize((parsed.get("style") or {}).get("text", "")) == normalize(name):
                    target.execute("UPDATE case_name SET plaintiff=?,defendant=? WHERE case_id=? AND language=?",
                                   (parsed["parties"].get("plaintiff"), parsed["parties"].get("defendant"), case_id, language))
                else:
                    stats["unparsed_provider_gold"] += 1
            stats["elapsed_seconds"] = round(time.monotonic() - started, 2)
            meta = {"schema": "case-shortforms.v1", "engine": engine.metadata,
                    "code_sha256": code_sha256, "bulk_options": {"resolve": False, "parallel": False},
                    "sampling": {"every": every, "limit_per_provider": limit}, "stats": dict(stats),
                    "sources": {"journal": str(journals.resolve()), "a2aj": str(a2aj.resolve())},
                    "text_stream_sha256": {k: v.hexdigest() for k, v in digests.items()},
                    "corpus_metadata": {"journal": dict(articles.execute("SELECT * FROM export_metadata")),
                                        "a2aj": dict(cases.execute("SELECT * FROM meta"))}}
            target.executemany("INSERT INTO meta VALUES (?,?)", ((key, json.dumps(value)) for key, value in meta.items()))
            target.commit()
        os.replace(building, output)
        print(json.dumps(meta["stats"], indent=2), flush=True)
        return meta
    finally:
        if engine:
            engine.close()
        building.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--journals", type=Path, default=journal_path())
    parser.add_argument("--a2aj", type=Path, default=Path(os.environ.get("MIKE_A2AJ_BULK_DB", "").strip() or
                        data_root() / "providers/a2aj/a2aj.sqlite"))
    parser.add_argument("--output", type=Path, default=data_root() / "cache/case-shortforms/shortforms.sqlite")
    parser.add_argument("--every", type=int, default=1, help="systematic pilot sampling; 1 scans every installed text")
    parser.add_argument("--limit", type=int, default=0, help="maximum texts per provider; 0 is unlimited")
    args = parser.parse_args()
    mine(args.journals, args.a2aj, args.output, args.every, args.limit)


if __name__ == "__main__":
    main()
