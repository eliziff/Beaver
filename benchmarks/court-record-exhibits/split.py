"""Split a sworn affidavit (with its exhibits) into benchmark inputs.

Usage:
  python split.py <source.pdf> <record_id> [--pages 12-140] [--meta meta.json] [--out DIR] [--ocr-affidavit] [--covers A=9,B=15]
  python split.py <record_id> --multi <affidavit.pdf> --exhibit A=a.pdf B=b1.pdf+b2.pdf [--covers A,B] [--meta meta.json]
  python split.py <record_id> --manifest manifest.json [--meta meta.json]

Multi-file mode is for sources that post each exhibit as its own PDF. Each
file's first page is checked for a cover (sworn identification, or a bare
"Pièce P-3" / "Exhibit R-1" page) and stripped or stamp-redacted; --covers
names labels whose first page is a cover read by eye. meta.json's "urls"
maps each file's basename to its URL; source.json then lists every file
under "sources" and each exhibit in split.json lists its "source_files".

--pages selects the affidavit-plus-exhibits run inside a larger motion or
application record (1-based, inclusive). The output directory receives:

  affidavit.pdf / affidavit.txt   the affidavit body alone (page-marked text)
  files/doc-<id>.pdf / .txt        one stripped file per exhibit, shuffled ids
  split.json                       label -> file, source pages, what was stripped
  source.json                      provenance (url, court, sha256, page range)

Stripping removes the identifying label the model must NOT see: exhibit
cover pages, exhibit stamps printed on an exhibit's first page, tab divider
pages, annotations, bookmarks, page labels and metadata. leak_audit in
split.json lists any remaining text that still names an exhibit.
"""
import argparse, difflib, hashlib, json, os, random, re, sys
import fitz

# Scanned stamps often double a quote mark (‘'D'' ), so allow up to two.
Q = r"[\"'“”‘’«»�]{0,2}"
LABEL = r"([A-Z]{1,3}(?:-\d{1,3})?|\d{1,3})"
# OCR often reads a stamped opening quote as "GG" or "G'" (Exhibit GGC" -> C).
QO = r"(?:[\"'“”‘’«»�]{1,2}|G[G'\"](?=[A-Z]{1,3}[\"'”’]))?"
COVER = re.compile(
    # OCR garbles a stamped "Exhibit" ("Exhila", "Exhlbit"); accept that only after "This is".
    rf"(?:this\s+is\s+(?:the\s+)?(?:exhibit|exh[il1][bl]\w{{0,3}})|exhibit)\b\s*(?:no\.?\s*)?{QO}\s*{LABEL}\s*{Q}\s*(?:,\s*)?(?:to\s+the|ref[\w,.']{{2,6}}(?:\s+to)?\b|mentioned|attached|annexed|of\s+the\s+affidavit|in\s+the\s+affidavit|to\s+the\s+affidavit)"
    rf"|ceci\s+est\s+la\s+pi[eè]ce\s*{Q}\s*{LABEL}\s*{Q}",
    re.I)
JURAT = re.compile(r"before\s+me|commissioner|notary|devant\s+moi|commissaire|sworn|affirmed|assermenté", re.I)
TAB_PAGE =re.compile(rf"^\s*(?:tab|exhibit|onglet|pi[eè]ce)?\s*{Q}\s*[A-Z0-9]{{1,4}}\s*{Q}\s*$", re.I)
EXHIBIT_TAB = re.compile(rf"^\s*(?:exhibit|pi[eè]ce)\s*(?:no\.?\s*)?{Q}\s*{LABEL}\s*{Q}\s*$", re.I)
PAGINATOR = re.compile(r"^(?:page\s+)?\d+\s+(?:of|de)\s+\d+$", re.I)
NEEDS_OCR_CHARS = 20


def norm(t):
    return re.sub(r"\s+", " ", t or "").strip()


def undot(t):
    # Fill-in covers print dot leaders: This is Exhibit ...... "A" ...... referred to
    return norm(re.sub(r"\.{3,}", " ", t or ""))


def cover_label(page):
    """Return (label, is_whole_page_cover, stamp_rects) for an exhibit identification."""
    # An identification is a short block naming the exhibit on a page that also
    # carries the commissioner's jurat; body text citing "Exhibit A to the
    # affidavit of X" sits in long numbered paragraphs without one.
    if not JURAT.search(norm(page.get_text())):
        return None, False, []
    # The identification opens its block; a report quoting "Exhibit QQ to the
    # affidavit of X" mid-paragraph is not one.
    m = next((mm for b in page.get_text("blocks")
              if len(norm(b[4])) < 700 and (mm := COVER.search(undot(b[4]))) and mm.start() < 60), None)
    if not m:
        joined = undot(page.get_text())
        m = COVER.search(joined) if len(joined) < 900 else None
    if not m:
        return None, False, []
    label = (m.group(1) or m.group(2)).upper()
    stamp_blocks, other = [], 0
    for x0, y0, x1, y1, btxt, *_ in page.get_text("blocks"):
        b = norm(btxt)
        if not b:
            continue
        if COVER.search(b) or re.search(r"(?i)commissioner|takings+affidavits|notary|sworn|affirmed|declared|before me|LSO|barrister|solicitor|videoconference|province of|city of|O\.\s?Reg|administering oath|located in|avocat|commissaire", b):
            stamp_blocks.append(fitz.Rect(x0, y0, x1, y1))
        else:
            other += len(b)
    return label, other < 250, stamp_blocks


AFFIANT = re.compile(r"affidavit\s+of\s+(.{3,60}?)\s*(?:,|\bsworn|\baffirmed|\bmade|\bdeclared|\bdated|\bbefore|$)", re.I)


def nested(covers, src):
    """Covers naming a different affiant belong to an affidavit exhibited inside
    another exhibit (its own "Exhibit G" stays part of that exhibit)."""
    names = []
    for _, p, _ in covers:
        m = AFFIANT.search(norm(src[p].get_text()))
        names.append(re.sub(r"[^a-z]", "", m.group(1).lower()) if m else "")
    main = max(set(n for n in names if n) or {""}, key=names.count)
    return {i for i, n in enumerate(names) if n and main and difflib.SequenceMatcher(None, n, main).ratio() < 0.5}


def page_range(spec, n):
    if not spec:
        return 0, n - 1
    a, b = spec.split("-")
    return int(a) - 1, min(int(b), n) - 1


def clean_copy(src, pages, redact=None):
    out = fitz.open()
    for p in pages:
        out.insert_pdf(src, from_page=p, to_page=p, annots=False, links=False)
    for i, p in enumerate(pages):
        page = out[i]
        # A record paginator ("35 of 420") gives away a file's place in the record, hence its label.
        rects = list((redact or {}).get(p, [])) + page.search_for(f"{p + 1} of {len(src)}")
        for rect in rects:
            page.add_redact_annot(rect + (-2, -2, 2, 2), fill=(1, 1, 1))
        if rects:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
    out.set_metadata({})
    out.set_toc([])
    try:
        out.set_page_labels([])
    except Exception:
        pass
    return out


def record_folios(src, first, last):
    """Rects of a record's running page numbers (bare integers alone on a line in the
    top or bottom margin that track the PDF page at a fixed offset); like "35 of 420"
    they give away file order. Unnumbered blank pages shift the offset, so every
    offset series seen on three pages, or on two facing pages, counts."""
    hits = {}
    for p in range(first, last + 1):
        lines, h, rot = {}, src[p].rect.height, src[p].rotation_matrix
        for w in src[p].get_text("words"):
            lines.setdefault((w[5], w[6]), []).append(w)
        for ws in lines.values():
            y = (fitz.Rect(ws[0][:4]) * rot).y0  # as displayed, so rotated pages count too
            if len(ws) == 1 and ws[0][4].isdigit() and len(ws[0][4]) <= 6 and not 0.12 * h < y < 0.88 * h:
                hits.setdefault(int(ws[0][4]) - p, {}).setdefault(p, []).append(fitz.Rect(ws[0][:4]))
    folios = {}
    for series in hits.values():
        if len(series) >= 3 or any(p + 1 in series for p in series):
            for p, rects in series.items():
                folios.setdefault(p, []).extend(rects)
    return folios


def text_of(doc, ocr=False):
    """Page-marked text; with ocr, image-only pages are read with Tesseract (TESSDATA_PREFIX)."""
    def page_text(p):
        # A scanned affidavit page can carry a short typed overlay (commissioner's stamp, page number).
        if ocr and len(norm(p.get_text())) < 100 and p.get_images():
            return p.get_textpage_ocr(dpi=300, full=True).extractText()
        return p.get_text()
    return "\n".join(f"[page {i + 1}]\n{page_text(p)}" for i, p in enumerate(doc))


# A one-exhibit file's own cover: "PIÈCE P-3" / "Exhibit R-12" / "Tab 4" alone on its first page.
FILE_COVER = re.compile(rf"^\s*(?:tab|exhibit|onglet|pi[eè]ce)?\s*(?:no\.?\s*)?{Q}\s*{LABEL}\s*{Q}\s*$", re.I)


def file_cover(page, label, by_eye):
    """(whole_page, stamp_rects, detected_label) for the first page of a file holding one exhibit."""
    if by_eye:
        return True, [], label
    found, whole, rects = cover_label(page)
    if found:
        return whole, ([] if whole else rects), found
    lines = [norm(l) for l in page.get_text().splitlines() if norm(l) and not PAGINATOR.match(norm(l))]
    m = [FILE_COVER.match(l) for l in lines]
    if lines and all(m) and any(x.group(1) for x in m):
        return True, [], next(x.group(1).upper() for x in m if x.group(1))
    return False, [], None


def split_multi(a, out_dir):
    """Affidavit and exhibits posted as separate PDFs (--multi AFF --exhibit A=f.pdf B=g.pdf+h.pdf, or --manifest)."""
    if a.manifest:
        man = json.load(open(a.manifest, encoding="utf-8"))
        aff_path = man["affidavit"]
        specs = [(l, [f] if isinstance(f, str) else f) for l, f in man["exhibits"].items()]
    else:
        aff_path = a.multi
        specs = [(l.strip().upper(), f.split("+")) for l, f in (e.split("=", 1) for e in a.exhibit)]
    by_eye = {l.strip().upper() for l in (a.covers or "").split(",") if l.strip()}
    docs = {}
    def src_of(path):
        if path not in docs:
            docs[path] = fitz.open(path)
        return docs[path]
    aff_src = src_of(aff_path)
    first, last = page_range(a.pages, len(aff_src))
    body = list(range(first, last + 1))
    rng = random.Random(hashlib.sha256(a.record_id.encode()).digest())
    ids = set()
    aff = clean_copy(aff_src, body)
    aff.save(os.path.join(out_dir, "affidavit.pdf"), garbage=4, deflate=True)
    open(os.path.join(out_dir, "affidavit.txt"), "w", encoding="utf-8").write(text_of(aff, a.ocr_affidavit))
    split, audit, scanned = [], [], []
    for label, paths in specs:
        parts, pdf, bare = [], fitz.open(), []
        for k, path in enumerate(paths):
            src = src_of(path)
            folios = record_folios(src, 0, len(src) - 1)
            pages, cover, stamp, rects = list(range(len(src))), None, None, []
            if k == 0:
                whole, rects, found = file_cover(src[0], label, label in by_eye)
                if found and found != label:
                    audit.append({"label": label, "problem": f"first page of {os.path.basename(path)} names {found}"})
                if whole:
                    cover, pages = 1, pages[1:]
                elif rects:
                    stamp = 1
                elif len(norm(src[0].get_text())) < NEEDS_OCR_CHARS:
                    audit.append({"label": label, "problem": f"first page of {os.path.basename(path)} has no text: check it for a cover by eye (--covers {label})"})
            scanned += [f"{os.path.basename(path)}:{q + 1}" for q in pages if len(norm(src[q].get_text())) < NEEDS_OCR_CHARS and src[q].get_images()]
            redact = {q: list(folios.get(q, [])) for q in pages}
            if stamp:
                redact[0] += rects
            # Pièces are often stamped bare ("P-3" in a corner) with no cover; blank the token
            # (listed under redact_text, which rebuild.py replays on every page).
            if k == 0 and "-" in label and pages and re.search(rf"(?<![A-Za-z0-9-]){re.escape(label)}(?![0-9])", src[pages[0]].get_text()):
                bare.append(label)
            for q in pages:
                for t in bare:
                    redact[q] = redact.get(q, []) + src[q].search_for(t)
            pdf.insert_pdf(clean_copy(src, pages, redact))
            parts.append({"file": os.path.basename(path), "pages": [q + 1 for q in pages], "cover_page": cover, "stamp_page": stamp})
        if not len(pdf):
            audit.append({"label": label, "problem": "exhibit has no pages after its cover"})
            continue
        fid = None
        while not fid or fid in ids:
            fid = "doc-" + "".join(rng.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(6))
        ids.add(fid)
        pdf.set_metadata({}); pdf.set_toc([])
        try:
            pdf.set_page_labels([])
        except Exception:
            pass
        pdf.save(os.path.join(out_dir, "files", fid + ".pdf"), garbage=4, deflate=True)
        text = text_of(fitz.open(os.path.join(out_dir, "files", fid + ".pdf")))
        open(os.path.join(out_dir, "files", fid + ".txt"), "w", encoding="utf-8").write(text)
        own = re.compile(rf"(?:exhibit|pi[eè]ce)\s*{Q}\s*{re.escape(label)}\s*{Q}(?![A-Za-z0-9])|referred\s+to\s+in\s+the\s+affidavit|ceci\s+est\s+la\s+pi[eè]ce", re.I)
        for hit in own.finditer(norm(text)):
            audit.append({"label": label, "file": fid, "text": norm(text)[max(0, hit.start() - 60):hit.end() + 60]})
        split.append({"label": label, "file": fid + ".pdf", "source_files": parts,
                      "source_pages": parts[0]["pages"], "cover_page": parts[0]["cover_page"], "stamp_page": parts[0]["stamp_page"],
                      "text_chars": len(norm(text)), **({"redact_text": bare} if bare else {})})
        if bare:
            audit.append({"label": label, "file": fid, "problem": f"bare label {label} on the first page blanked (redact_text); check the rest"})
    labels = [l for l, _ in specs]
    if len(set(labels)) != len(labels):
        audit.append({"problem": f"duplicate exhibit labels {labels}"})
    json.dump({"record_id": a.record_id, "multi_file": True, "affidavit_pages": [p + 1 for p in body],
               "divider_pages": [], "scanned_pages": scanned, "exhibits": split, "leak_audit": audit},
              open(os.path.join(out_dir, "split.json"), "w", encoding="utf-8"), indent=1)
    meta = json.load(open(a.meta, encoding="utf-8")) if a.meta else {}
    urls = meta.pop("urls", {})
    meta.update({"record_id": a.record_id, "source_file": os.path.basename(aff_path), "page_range": [first + 1, last + 1],
                 "source_sha256": hashlib.sha256(open(aff_path, "rb").read()).hexdigest(), "source_pages": len(aff_src)})
    meta["sources"] = [{"file": os.path.basename(p), "url": urls.get(os.path.basename(p), meta.get("url", "") if p == aff_path else ""),
                        "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest(), "pages": len(d)} for p, d in docs.items()]
    for s in meta["sources"]:
        if not s["url"]:
            audit.append({"problem": f"no url for {s['file']} (meta urls)"})
    if a.ocr_affidavit:
        meta["affidavit_ocr"] = True
    if a.covers:
        meta["covers"] = a.covers
    json.dump(meta, open(os.path.join(out_dir, "source.json"), "w", encoding="utf-8"), indent=1)
    print(json.dumps({"record": a.record_id, "affidavit_pages": len(body), "exhibits": [(e["label"], e["file"], sum(len(p["pages"]) for p in e["source_files"])) for e in split],
                      "scanned_pages": len(scanned), "leaks": len(audit)}, indent=None))
    if audit:
        print(json.dumps(audit, indent=1, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", nargs="?"); ap.add_argument("record_id", nargs="?")
    ap.add_argument("--multi", help="affidavit PDF whose exhibits are separate files (with --exhibit or --manifest)")
    ap.add_argument("--exhibit", nargs="+", help="A=a.pdf B=b1.pdf+b2.pdf: one exhibit per file (or files, in order)")
    ap.add_argument("--manifest", help='JSON {"affidavit": path, "exhibits": {"A": path or [paths]}} instead of --multi/--exhibit')
    ap.add_argument("--pages"); ap.add_argument("--meta"); ap.add_argument("--out")
    ap.add_argument("--ocr-affidavit", action="store_true", help="OCR image-only affidavit pages into affidavit.txt")
    ap.add_argument("--covers", help="A=9,B=15: whole-page exhibit covers read by eye (handwritten or scanned labels)")
    ap.add_argument("--relabel", help="IT=U: fix a misread stamp label without turning its page into a whole-page cover")
    ap.add_argument("--drop", help="1143,1178: source pages left out of every file (a cover the source repeats inside its exhibit)")
    a = ap.parse_args()
    if (a.multi or a.manifest) and a.record_id is None:
        a.pdf, a.record_id = None, a.pdf  # split.py <id> --multi aff.pdf --exhibit ...
    if not a.record_id:
        ap.error("record_id is required")
    root = a.out or os.path.join(os.environ["LOCALAPPDATA"], "OpenLegalData", "benchmarks", "court-record-exhibits", "records")
    out_dir = os.path.join(root, a.record_id)
    os.makedirs(os.path.join(out_dir, "files"), exist_ok=True)
    if a.multi or a.manifest:
        return split_multi(a, out_dir)
    src = fitz.open(a.pdf)
    first, last = page_range(a.pages, len(src))

    # Lines printed on most pages (e-filing stamps, running footers) are not
    # content; ignore them when deciding whether a page is a bare tab divider.
    line_sets = [{norm(l) for l in src[p].get_text().splitlines() if norm(l)} for p in range(first, last + 1)]
    boiler = {l for l in set().union(*line_sets) if sum(l in ls for ls in line_sets) >= 0.6 * len(line_sets) > 2}
    # A record folio alone on a scanned page does not make it a tab divider.
    folios = record_folios(src, first, last)
    folio_text = {p: {norm(src[p].get_textbox(r)) for r in rs} for p, rs in folios.items()}
    covers, stamps, dividers, scanned, tabs = [], {}, set(), [], []
    for p in range(first, last + 1):
        page = src[p]
        text = norm(page.get_text())
        if len(text) < NEEDS_OCR_CHARS and page.get_images():
            scanned.append(p + 1)
        label, whole, rects = cover_label(page)
        if label and (whole or not covers or covers[-1][0] != label):
            covers.append((label, p, whole))
            if not whole:
                stamps[p] = rects
        elif (rest := {l for l in line_sets[p - first] - boiler if not PAGINATOR.match(l) and l not in folio_text.get(p, ())}) and all(TAB_PAGE.match(l) for l in rest):
            dividers.add(p)
            tab = next((m for l in rest if (m := EXHIBIT_TAB.match(l))), None)
            if tab:
                tabs.append((tab.group(1).upper(), p, True))
    # With no sworn identifications, bare "Exhibit 12" / "Pièce P-3" dividers are the covers.
    if a.covers:
        covers = [(l.strip().upper(), int(n) - 1, True) for l, n in (c.split("=") for c in a.covers.split(","))]
        dividers -= {p for _, p, _ in covers}
    if a.drop:
        dividers |= {int(n) - 1 for n in a.drop.split(",")}
    if not covers and tabs:
        covers = tabs
        dividers -= {p for _, p, _ in tabs}
    if not covers:
        sys.exit("No exhibit identifications found; OCR the record or check --pages.")
    inner = set() if a.covers else nested(covers, src)
    # A garbled OCR affiant name must not drop a cover that exactly fills the gap
    # between its outer neighbours (F, [G], H).
    outer = [i for i in range(len(covers)) if i not in inner]
    for i in sorted(inner):
        prev = max((j for j in outer if j < i), default=None)
        nxt = min((j for j in outer if j > i), default=None)
        if prev is not None and nxt is not None and all(len(covers[j][0]) == 1 for j in (prev, i, nxt)) \
                and ord(covers[prev][0]) + 1 == ord(covers[i][0]) == ord(covers[nxt][0]) - 1:
            inner.discard(i)
    covers = [c for i, c in enumerate(covers) if i not in inner]
    # OCR reads a stamped letter as a digit ("0" for C, "3" for J); a digit between
    # two letters one apart is the letter they bracket.
    for i in range(1, len(covers) - 1):
        (a0, _, _), (l, p, w), (b0, _, _) = covers[i - 1:i + 2]
        if l.isdigit() and len(a0) == len(b0) == 1 and a0.isalpha() and ord(b0) - ord(a0) == 2:
            covers[i] = (chr(ord(a0) + 1), p, w)
    if a.relabel:
        fix = dict(c.split("=") for c in a.relabel.split(","))
        covers = [(fix.get(l, l), p, w) for l, p, w in covers]

    body =[p for p in range(first, covers[0][1]) if p not in dividers]
    exhibits = []
    for i, (label, p, whole) in enumerate(covers):
        end = covers[i + 1][1] - 1 if i + 1 < len(covers) else last
        pages = [q for q in range(p + (1 if whole else 0), end + 1) if q not in dividers]
        exhibits.append({"label": label, "cover_page": p + 1 if whole else None,
                         "stamp_page": None if whole else p + 1, "pages": pages})

    rng = random.Random(hashlib.sha256(a.record_id.encode()).digest())
    ids = set()
    aff = clean_copy(src, body)
    aff.save(os.path.join(out_dir, "affidavit.pdf"), garbage=4, deflate=True)
    open(os.path.join(out_dir, "affidavit.txt"), "w", encoding="utf-8").write(text_of(aff, a.ocr_affidavit))

    split, audit = [], []
    for ex in exhibits:
        if not ex["pages"]:
            audit.append({"label": ex["label"], "problem": "exhibit has no pages after its cover"})
            continue
        fid = None
        while not fid or fid in ids:
            fid = "doc-" + "".join(rng.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(6))
        ids.add(fid)
        redact = {q: list(folios.get(q, [])) for q in ex["pages"]}
        if ex["stamp_page"]:
            redact[ex["stamp_page"] - 1] += stamps[ex["stamp_page"] - 1]
        doc = clean_copy(src, ex["pages"], redact)
        doc.save(os.path.join(out_dir, "files", fid + ".pdf"), garbage=4, deflate=True)
        text = text_of(doc)
        open(os.path.join(out_dir, "files", fid + ".txt"), "w", encoding="utf-8").write(text)
        own = re.compile(rf"exhibit\s*{Q}\s*{re.escape(ex['label'])}\s*{Q}(?![A-Za-z0-9])|referred\s+to\s+in\s+the\s+affidavit|ceci\s+est\s+la\s+pi[eè]ce", re.I)
        for hit in own.finditer(norm(text)):
            audit.append({"label": ex["label"], "file": fid, "text": norm(text)[max(0, hit.start() - 60):hit.end() + 60]})
        split.append({"label": ex["label"], "file": fid + ".pdf", "source_pages": [q + 1 for q in ex["pages"]],
                      "cover_page": ex["cover_page"], "stamp_page": ex["stamp_page"],
                      "text_chars": len(norm(text))})

    labels = [e["label"] for e in exhibits]
    if len(set(labels)) != len(labels):
        audit.append({"problem": f"duplicate exhibit labels {labels}; check the page range"})
    json.dump({"record_id": a.record_id, "affidavit_pages": [p + 1 for p in body],
               "divider_pages": sorted(p + 1 for p in dividers), "scanned_pages": scanned,
               "exhibits": split, "leak_audit": audit},
              open(os.path.join(out_dir, "split.json"), "w", encoding="utf-8"), indent=1)
    meta = json.load(open(a.meta, encoding="utf-8")) if a.meta else {}
    meta.update({"record_id": a.record_id, "source_file": os.path.basename(a.pdf), "page_range": [first + 1, last + 1],
                 "source_sha256": hashlib.sha256(open(a.pdf, "rb").read()).hexdigest(), "source_pages": len(src)})
    if a.ocr_affidavit:
        meta["affidavit_ocr"] = True
    if a.covers:
        meta["covers"] = a.covers
    if a.drop:
        meta["drop"] = a.drop
    if a.relabel:
        meta["relabel"] = a.relabel
    json.dump(meta, open(os.path.join(out_dir, "source.json"), "w", encoding="utf-8"), indent=1)
    print(json.dumps({"record": a.record_id, "affidavit_pages": len(body), "exhibits": [(e["label"], e["file"], len(e["source_pages"])) for e in split],
                      "scanned_pages": len(scanned), "leaks": len(audit)}, indent=None))


if __name__ == "__main__":
    main()
