"""Judges' own pins, harvested from the whole dump: every citation CourtListener resolved to a cluster in CLUSTERS, with its pin and the
quotation it supports. No parser. python -I pin_stream.py OPINIONS.csv.bz2 CLUSTERS OUT [THREADS]
A row is one quotation closing just before the citation: {cited cluster, citing id, citation text, pin, form, quote}."""
import csv, html, io, json, re, sys, time
import indexed_bzip2
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.csv as pcsv
csv.field_size_limit(2**31 - 1)
dump, clusters, out = sys.argv[1:4]
threads = int(sys.argv[4]) if len(sys.argv) > 4 else 8
# A folder here also keeps what the quoted pins leave out: links.jsonl, every pinned link with or without a quotation;
# pairs.jsonl, the parallel pins a judge writes together, "556 U.S. 662, 678, 129 S. Ct. 1937, 1949"; opinions.tsv, each opinion's case and type.
keep = sys.argv[5] if len(sys.argv) > 5 else None
links_out = open(f"{keep}/links.jsonl", "w", encoding="utf-8", newline="\n") if keep else None
pairs_out = open(f"{keep}/pairs.jsonl", "w", encoding="utf-8", newline="\n") if keep else None
extras_out = open(f"{keep}/extras.jsonl", "w", encoding="utf-8", newline="\n") if keep else None
# What follows a citation that its link does not carry: a slip page, a Part of the opinion.
SLIP = re.compile(r"^[\s,]*(?:\([^()]{0,40}\)\s*)?(?:,\s*)?\(?slip op(?:inion)?\.?,?\s*(?:at\s*)?(\d{1,4})", re.I)
PART = re.compile(r"^[\s,]*(?:at\s+\S+\s+)?\(?(?:Parts?|Section)\s+([IVXLC]{1,6}(?:[-.(]?[A-Za-z0-9]{1,3}\)?){0,3})\b")
opinions_out = open(f"{keep}/opinions.tsv", "w", encoding="utf-8", newline="\n") if keep else None
PAIR_GAP = 70
wanted = None if clusters == "ALL" else {line.strip() for line in open(clusters, encoding="utf-8") if line.strip()}
SPAN = re.compile(r'<span class="citation[^"]*"[^>]*>\s*<a href="/opinion/(\d+)/[^"#]*(?:#([^"]{1,12}))?"[^>]*>(.*?)</a>', re.S)
# "Syl. pt. 3, State v. Smith," standing before a citation: the citation is pinned to a syllabus point, which carries no fragment.
SYLLABUS = re.compile(r"\bSyl(?:labus)?\.?,?\s*(?:(?:[Pp]ts?\.?|[Pp]oints?|¶+)\s*)?(\d{1,3})[^;:]{0,160}$", re.S)
TAG = re.compile(r"<[^>]+>")
CLOSE = re.compile(r'[”"]')
OPEN = re.compile(r'[“"]([^“”"]{40,600})$', re.S)
# Between a quotation and its citation stand a signal and a case's name at most: no sentence ends there, no other citation.
SIGNAL = r"(?:(?i:see|see also|accord|quoting|citing|in|e\.g\.,?|cf\.)\s+)*"
GAP = re.compile(r"^[\s.,;:)\]\u2019']*" + SIGNAL + r"(?:[A-Z][^;:()\d]{0,90}?)?[\s,]*\(?$")
# "83 Wis. 2d at 453", "320 U.S. at page 281", "318 F.2d, at page 154", "26 U.S. (1 Pet.) 386, 439".
VOLUME = re.compile(r"^\s*(\d{1,4})\s+(.+?)\s*(?:\(\d+\s+[^)]*\)\s*)?,?\s*(?:at\s+(?:pp?\.\s*|page\s+)?\*?\d|\d+\s*(?:[,(]|$))")
WIDE = 1600
LEAD = 200


def form(cite):
    if "¶" in cite: return "paragraph"
    if re.search(r"LEXIS|\bWL\b", cite): return "vendor"
    return "page"


def quote_before(text, at):
    before = html.unescape(TAG.sub("", text[max(0, at - WIDE):at]))
    closes = list(CLOSE.finditer(before))
    if not closes: return None
    last = closes[-1]
    if len(before) - last.end() > LEAD or not GAP.match(before[last.end():]): return None
    found = OPEN.search(before[:last.start()])
    return re.sub(r"\s+", " ", found.group(1)).strip() if found else None


def reporter_of(cite):
    found = VOLUME.match(re.sub(r"\s+", " ", cite))
    return f"{found.group(1)} {found.group(2).strip()}" if found else None


def harvest(row_id, text, w, citing_cluster=None):
    global links, written, unnamed, repeats
    named = {}
    told = set()
    if keep:
        before = None
        for m in SPAN.finditer(text):
            if wanted is None or m.group(1) in wanted:
                following = re.sub(r"\s+", " ", html.unescape(TAG.sub("", text[m.end():m.end() + 200])))[:120]
                for form_name, pattern in (("slip", SLIP), ("part", PART)):
                    found = pattern.match(following)
                    if found:
                        extras_out.write(json.dumps({"cluster": m.group(1), "citing": row_id, "citing_cluster": citing_cluster, "form": form_name, "value": found.group(1), "quote": quote_before(text, m.start())}, ensure_ascii=False) + "\n")
            if not m.group(2) or (wanted is not None and m.group(1) not in wanted): continue
            cite = re.sub(r"\s+", " ", html.unescape(TAG.sub("", m.group(3)))).strip()
            links_out.write(json.dumps({"cluster": m.group(1), "citing": row_id, "citing_cluster": citing_cluster, "cite": cite, "pin": m.group(2)}, ensure_ascii=False) + "\n")
            mine = reporter_of(cite)
            if before and before[0] == m.group(1) and m.start() - before[1] <= PAIR_GAP and mine and before[2] and mine != before[2]:
                pairs_out.write(json.dumps({"cluster": m.group(1), "citing": row_id, "citing_cluster": citing_cluster, "a": before[2], "a_pin": before[3], "b": mine, "b_pin": m.group(2)}, ensure_ascii=False) + "\n")
            before = (m.group(1), m.end(), mine, m.group(2))
    for m in SPAN.finditer(text):
        if wanted is not None and m.group(1) not in wanted: continue
        before = html.unescape(TAG.sub("", text[max(0, m.start() - 500):m.start()]))
        syllabus = SYLLABUS.search(before[-220:])
        if not m.group(2) and not syllabus: continue
        links += 1
        cite = re.sub(r"\s+", " ", html.unescape(TAG.sub("", m.group(3)))).strip()
        if syllabus:
            ahead = re.search(r"\bSyl", text[max(0, m.start() - 400):m.start()])
            quote = quote_before(text, max(0, m.start() - 400) + ahead.start()) if ahead else None
            if quote and len(quote.split()) >= 6:
                w.write(json.dumps({"cluster": m.group(1), "citing": row_id, "cite": cite, "reporter": reporter_of(cite), "pin": syllabus.group(1), "form": "syllabus", "quote": quote, "after": ""}, ensure_ascii=False) + "\n")
                written += 1
            continue
        # A short form names its reporter; "Id." and "supra" take the one last named for that case in this opinion.
        reporter = reporter_of(cite)
        if reporter: named[m.group(1)] = reporter
        reporter = reporter or named.get(m.group(1))
        quote = quote_before(text, m.start())
        if not quote or len(quote.split()) < 6: continue
        if not reporter and "¶" not in cite:
            unnamed += 1
            continue
        # One opinion saying one thing twice is one pin.
        if (m.group(1), quote, m.group(2)) in told:
            repeats += 1
            continue
        told.add((m.group(1), quote, m.group(2)))
        # What follows the citation holds a footnote pin ("n.3") or the writer quoted ("(Scalia, J., dissenting)").
        after = re.sub(r"\s+", " ", html.unescape(TAG.sub("", text[m.end():m.end() + 400])))[:120]
        w.write(json.dumps({"cluster": m.group(1), "citing": row_id, "cite": cite, "reporter": reporter, "pin": m.group(2), "form": form(cite if reporter is None else cite + " " + reporter), "quote": quote, "after": after}, ensure_ascii=False) + "\n")
        written += 1


unnamed = 0
repeats = 0
t0 = last = time.time(); seen = 0; links = 0; written = 0
with open(out, "w", encoding="utf-8", newline="\n") as w:
    if dump.endswith(".jsonl"):
        # A pack in place of the dump: a quick set to build the grader on, never one to judge by.
        for path in dump.split(","):
            for line in open(path, encoding="utf-8"):
                row = json.loads(line); text = row["files"].get("html_with_citations.html", "")
                if "/#" in text: harvest(row["id"], text, w)
                seen += 1
    else:
        head = next(csv.reader(io.TextIOWrapper(indexed_bzip2.open(dump, parallelization=1), encoding="utf-8", newline=""), escapechar="\\", doublequote=False))
        reader = pcsv.open_csv(indexed_bzip2.open(dump, parallelization=threads),
                               read_options=pcsv.ReadOptions(block_size=64 << 20, use_threads=True),
                               parse_options=pcsv.ParseOptions(escape_char="\\", double_quote=False, newlines_in_values=True, invalid_row_handler=lambda row: "skip"),
                               convert_options=pcsv.ConvertOptions(column_types={h: pa.string() for h in head}, strings_can_be_null=True, quoted_strings_can_be_null=False, check_utf8=False, include_columns=["id", "html_with_citations", "cluster_id", "type"] if keep else ["id", "html_with_citations"]))
        for batch in reader:
            has = pc.fill_null(pc.match_substring(batch.column("html_with_citations"), "/#"), False)
            if keep:
                for opinion, owner, kind in zip(batch.column("id").to_pylist(), batch.column("cluster_id").to_pylist(), batch.column("type").to_pylist()):
                    opinions_out.write(f"{opinion}\t{owner}\t{kind}\n")
            for row in batch.filter(has).to_pylist():
                harvest(row["id"], row["html_with_citations"], w, row.get("cluster_id"))
            seen += batch.num_rows
            if time.time() - last > 60:
                w.flush(); last = time.time()
                print(f"{time.strftime('%H:%M:%S')} rows {seen} pinned links {links} with quotes {written} ({seen / (time.time() - t0):.0f} rows/s)", flush=True)
print(f"done rows {seen} pinned links {links} with quotes {written} dropped for naming no reporter {unnamed} repeats {repeats}", flush=True)
