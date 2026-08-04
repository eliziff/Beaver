#!/usr/bin/env python3
"""Generate the Harvey LAB local-corpus launchpad.

Reads only the accessible task corpus under <harvey-labs>/tasks (dev +
validation tiers vendored locally; the sealed tier is off-machine) and emits:

  launchpad.html              - self-contained browser UI (opens from file://)
  launchpad_materials.json    - companion data file with extracted document text,
                                loaded via the file picker in the UI

No third-party dependencies; document text is extracted with the stdlib
(zipfile + email) which is sufficient for a browsing/gisting tool.
"""

import base64  # noqa: F401  (kept for clarity; not used)
import html
import io
import json
import os
import re
import sys
import time
import zipfile
from collections import Counter, OrderedDict
from email import policy
from email.parser import BytesParser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # harvey-labs/
TASKS_DIR = os.path.join(ROOT, "tasks")
RESULTS_DIR = os.path.join(ROOT, "results")
OUT_HTML = os.path.join(ROOT, "launchpad.html")
OUT_MAT = os.path.join(ROOT, "launchpad_materials.json")

DOC_CAP = 25000      # per-document extracted-text cap (chars)
TASK_CAP = 200000    # per-task total extracted-text cap (chars)


# --------------------------------------------------------------------------
# text extraction (stdlib only)
# --------------------------------------------------------------------------

def _dec(data):
    """Decode bytes: prefer UTF-8; fall back to cp1252 for stray non-UTF8 bytes."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1252", "replace")


def _clean(xml):
    """Insert breaks for structural elements, strip tags, unescape entities."""
    x = xml
    x = re.sub(r"</w:p>|</a:p>|</w:tr>|</w:row>|</p>", "\n", x)
    x = re.sub(r"</w:tc>|</a:tc>|</td>", " | ", x)
    x = re.sub(r"</w:r>|</a:r>", "", x)
    x = re.sub(r"<[^>]+>", "", x)
    x = html.unescape(x)
    # collapse 3+ blank lines
    x = re.sub(r"\n{3,}", "\n\n", x)
    # collapse spaces within a line
    x = re.sub(r"[ \t]{2,}", " ", x)
    return x.strip()


def extract_docx(path):
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        return "[unreadable docx: %s]" % e
    try:
        xml = _dec(z.read("word/document.xml"))
    except Exception:
        return "[unreadable docx: no word/document.xml]"
    return _clean(xml)


def extract_xlsx(path):
    try:
        z = zipfile.ZipFile(path)
    except Exception:
        return "[unreadable xlsx]"
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        try:
            sx = _dec(z.read("xl/sharedStrings.xml"))
            shared = [html.unescape(s) for s in re.findall(r"<t(?:\s[^>]*)?>([^<]*)</t>", sx)]
        except Exception:
            shared = []
    out = []
    try:
        names = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
    except Exception:
        names = []
    for name in names:
        sheet = os.path.basename(name).replace(".xml", "")
        try:
            xml = _dec(z.read(name))
        except Exception:
            continue
        for rm in re.finditer(r"<row[^>]*r=\"(\d+)\"[^>]*>(.*?)</row>", xml, re.S):
            rownum, body = rm.group(1), rm.group(2)
            cells = []
            for cm in re.finditer(r"<c[^>]*r=\"([A-Z]+)\d+\"[^>]*?t=\"([^\"]*)\"[^>]*>(.*?)</c>|<c[^>]*r=\"([A-Z]+)\d+\"[^>]*>(.*?)</c>", body, re.S):
                ref, ttype, cell_a, cell_b = cm.group(1), cm.group(2), cm.group(3), cm.group(4)
                inner = cell_a if cell_a is not None else cell_b
                vm = re.search(r"<v>([^<]*)</v>", inner)
                if vm is None:
                    ism = re.search(r"<is><t[^>]*>([^<]*)</t></is>", inner)
                    val = html.unescape(ism.group(1)) if ism else ""
                else:
                    raw = vm.group(1)
                    if ttype == "s":
                        try:
                            val = shared[int(raw)]
                        except Exception:
                            val = raw
                    elif ttype == "b":
                        val = "TRUE" if raw == "1" else "FALSE"
                    else:
                        val = raw
                if val:
                    cells.append("%s: %s" % (ref, val))
            if cells:
                out.append("[%s row %s] %s" % (sheet, rownum, " | ".join(cells)))
    return "\n".join(out) if out else "[xlsx: no parseable cell text]"


def extract_pptx(path):
    try:
        z = zipfile.ZipFile(path)
    except Exception:
        return "[unreadable pptx]"
    out = []
    for name in sorted(z.namelist()):
        if re.match(r"ppt/slides/slide\d+\.xml$", name):
            try:
                xml = _dec(z.read(name))
            except Exception:
                continue
            txt = _clean(xml)
            if txt:
                out.append("[%s]\n%s" % (name, txt))
    return "\n\n".join(out) if out else "[pptx: no parseable slide text]"


def extract_eml(path):
    try:
        with open(path, "rb") as f:
            msg = BytesParser(policy=policy.default).parse(f)
    except Exception as e:
        return "[unreadable eml: %s]" % e
    head = []
    for k in ("From", "To", "Cc", "Date", "Subject"):
        v = msg.get(k)
        if v:
            head.append("%s: %s" % (k, v))
    plain, htmlbody = [], []
    def walk(part):
        ct = part.get_content_type()
        if ct == "text/plain":
            try:
                plain.append(part.get_content())
            except Exception:
                pass
        elif ct == "text/html":
            try:
                htmlbody.append(part.get_content())
            except Exception:
                pass
        for sub in part.iter_parts():
            walk(sub)
    walk(msg)
    if not plain and htmlbody:
        body = "\n\n".join(htmlbody)
        body = re.sub(r"<[^>]+>", "\n", body)
        body = html.unescape(body)
        body = re.sub(r"\n{3,}", "\n\n", body)
    else:
        body = "\n\n".join(plain)
    return "\n".join(head) + "\n\n" + body if (head or body) else "[eml: empty]"


def extract_txt(path):
    try:
        with open(path, "rb") as f:
            raw = f.read()
        if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
            try:
                return raw.decode("utf-16")
            except Exception:
                pass
        return _dec(raw)
    except Exception as e:
        return "[unreadable txt: %s]" % e


EXTRACTORS = {
    ".docx": extract_docx,
    ".xlsx": extract_xlsx,
    ".pptx": extract_pptx,
    ".eml": extract_eml,
    ".txt": extract_txt,
}


def extract_file(path):
    ext = os.path.splitext(path)[1].lower()
    fn = EXTRACTORS.get(ext)
    if fn is None:
        return "[unsupported type %s]" % ext
    try:
        return fn(path)
    except Exception as e:
        return "[extraction error: %s]" % e


# --------------------------------------------------------------------------
# corpus scan
# --------------------------------------------------------------------------

def find_task_jsons():
    found = []
    for root, dirs, files in os.walk(TASKS_DIR):
        if "task.json" in files:
            found.append(os.path.join(root, "task.json"))
    return sorted(found)


def scan(extract=True):
    tasks = []  # embedded index records
    mat = []    # materials records
    total_docs = 0
    total_criteria = 0
    t0 = time.time()
    paths = find_task_jsons()
    print("scanning %d task.json files..." % len(paths))
    for idx, p in enumerate(paths):
        with open(p, encoding="utf-8") as f:
            t = json.load(f)
        rel = os.path.relpath(p, TASKS_DIR).replace(os.sep, "/")
        task_id = rel[:-len("/task.json")]
        parts = task_id.split("/")
        area = parts[0]
        sub = parts[1] if len(parts) > 2 else ""
        ddir = os.path.join(os.path.dirname(p), "documents")
        # recursive listing (some diligence tasks keep a deep data-room tree)
        docs = []
        if os.path.isdir(ddir):
            for r, _dirs, files in os.walk(ddir):
                for fn in files:
                    fp = os.path.join(r, fn)
                    rel = os.path.relpath(fp, ddir).replace(os.sep, "/")
                    try:
                        sz = os.path.getsize(fp)
                    except Exception:
                        sz = -1
                    docs.append({"n": rel, "s": sz})
            docs.sort(key=lambda d: d["n"])
        criteria = t.get("criteria", []) or []
        crit_out = []
        for c in criteria:
            crit_out.append({
                "i": c.get("id", ""),
                "t": c.get("title", ""),
                "d": c.get("deliverables", []),
                "m": c.get("match_criteria", ""),
            })
        total_criteria += len(crit_out)
        total_docs += len(docs)
        rec = {
            "id": task_id,
            "area": area,
            "sub": sub,
            "t": t.get("title", ""),
            "wt": t.get("work_type", ""),
            "tags": t.get("tags", []) or [],
            "instr": t.get("instructions", ""),
            "deliv": t.get("deliverables", {}) or {},
            "nc": len(crit_out),
            "docs": docs,
            "crit": crit_out,
        }
        tasks.append(rec)
        if not extract:
            continue
        # materials: extracted text, capped per doc and per task
        mdocs = []
        budget = TASK_CAP
        for d in docs:
            fp = os.path.join(ddir, d["n"])
            txt = extract_file(fp)
            truncated = False
            omitted = False
            if len(txt) > DOC_CAP:
                txt = txt[:DOC_CAP] + "\n… [extracted text truncated at %d chars]" % DOC_CAP
                truncated = True
            if budget is not None:
                if budget <= 0:
                    txt = ""
                    omitted = True
                else:
                    if len(txt) > budget:
                        txt = txt[:budget] + "\n… [extracted text truncated to stay within per-task materials budget]"
                        truncated = True
                    budget -= len(txt)
            mdocs.append({
                "n": d["n"],
                "p": os.path.abspath(fp),
                "s": d["s"],
                "c": len(txt),
                "tr": truncated,
                "om": omitted,
                "t": txt,
            })
        mat.append({"id": task_id, "docs": mdocs})
        if (idx + 1) % 50 == 0:
            print("  ...%d/%d tasks (%.1fs)" % (idx + 1, len(paths), time.time() - t0))
    return tasks, mat, total_docs, total_criteria


def scan_experiments():
    families = Counter()
    arms = Counter()
    ndirs = 0
    if os.path.isdir(RESULTS_DIR):
        for d in os.listdir(RESULTS_DIR):
            if os.path.isdir(os.path.join(RESULTS_DIR, d)):
                ndirs += 1
                families[d.split("--")[0]] += 1
                parts = d.split("--")
                if len(parts) >= 2:
                    arms[parts[-1]] += 1
    return {
        "result_dirs": ndirs,
        "families": dict(sorted(families.items())),
        "arms": dict(sorted(arms.items())),
    }


# --------------------------------------------------------------------------
# HTML template
# --------------------------------------------------------------------------

TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harvey LAB — Local Corpus Launchpad</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --ink: #1b2430; --muted: #5b6b7c;
    --line: #dfe4ea; --accent: #0e7c7b; --accent-soft: #e6f2f2;
    --chip: #eef1f5; --code: #274b5c; --warn-bg: #fff7e6; --warn-line: #f0d9a8;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--ink); }
  header { background: var(--panel); border-bottom: 1px solid var(--line); padding: 14px 20px 12px; position: sticky; top: 0; z-index: 5; }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: .2px; }
  h1 .sub { font-weight: 400; color: var(--muted); font-size: 13px; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0; }
  .stat { background: var(--accent-soft); color: var(--accent); border: 1px solid #cfe5e4;
          border-radius: 999px; padding: 2px 12px; font-size: 12.5px; font-weight: 600; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
  .controls input[type=search] { flex: 1 1 260px; padding: 7px 10px; border: 1px solid var(--line);
          border-radius: 8px; font-size: 13.5px; background: var(--bg); }
  .controls select { padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px;
          font-size: 13px; background: var(--panel); color: var(--ink); }
  button { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel);
          font-size: 13px; cursor: pointer; color: var(--ink); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button:hover { filter: brightness(.97); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  .muted { color: var(--muted); font-size: 12.5px; }
  details.exp { margin-top: 8px; }
  details.exp > summary { cursor: pointer; color: var(--muted); font-size: 12.5px; user-select: none; }
  main { max-width: 1080px; margin: 18px auto 30px; padding: 0 16px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)); gap: 14px; }
  @media (max-width: 580px) { .cards { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px;
          box-shadow: 0 1px 2px rgba(20,30,50,.04); }
  .card h3 { margin: 0 0 2px; font-size: 15px; line-height: 1.35; }
  .card .id { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11.5px;
          color: var(--code); background: var(--chip); padding: 1px 6px; border-radius: 6px; word-break: break-all; }
  .card .deliv-line { color: var(--muted); font-size: 12px; margin-top: 3px; }
  .card .deliv-line b { color: var(--ink); font-weight: 600; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--chip);
          border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .badge.wt { background: #eef4ff; border-color: #cfe0ff; color: #2854a0; }
  .badge.crit { background: #f5f0ff; border-color: #e4d8f7; color: #6b3fa0; }
  section.blk { border: 1px solid var(--line); border-radius: 10px; margin-top: 10px; overflow: hidden; }
  section.blk details > summary { cursor: pointer; padding: 8px 12px; font-weight: 600; font-size: 13px;
          background: #fbfcfd; user-select: none; }
  section.blk details > summary:hover { background: #f4f6f8; }
  section.blk .body { border-top: 1px solid var(--line); padding: 10px 12px; max-height: 48vh; overflow: auto; }
  pre.prompt { white-space: pre-wrap; word-break: break-word; margin: 0; font: 13px/1.55 ui-monospace,
          "Cascadia Code", Consolas, monospace; }
  .crit { padding: 6px 0; border-bottom: 1px dashed var(--line); }
  .crit:last-child { border-bottom: 0; }
  .crit .cid { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; color: var(--code);
          background: var(--chip); padding: 0 5px; border-radius: 4px; margin-right: 6px; }
  .crit .ctitle { font-weight: 600; }
  .crit .deliv { color: var(--muted); font-size: 12px; margin: 2px 0 0 0; }
  .crit details { margin-top: 3px; }
  .crit details summary { cursor: pointer; color: var(--accent); font-size: 12px; user-select: none; }
  .crit .match { white-space: pre-wrap; margin: 4px 0 0 0; font-size: 12.5px; color: #37474f;
          border-left: 3px solid var(--accent); padding-left: 8px; }
  .docrow { display: flex; gap: 8px; align-items: baseline; padding: 5px 0; border-bottom: 1px dashed var(--line); }
  .docrow:last-child { border-bottom: 0; }
  .docrow .dn { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: var(--code);
          word-break: break-all; }
  .docrow .meta { color: var(--muted); font-size: 11.5px; white-space: nowrap; }
  .docrow details { margin-left: auto; }
  .docrow details summary { cursor: pointer; color: var(--accent); font-size: 12px; user-select: none; }
  .doctext { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.5;
          border: 1px solid var(--line); background: #fafbfc; padding: 8px; border-radius: 8px;
          margin-top: 4px; max-height: 32vh; overflow: auto; }
  .placeholder { color: var(--muted); font-size: 12.5px; border: 1px dashed var(--line); border-radius: 8px;
          padding: 8px 10px; background: #fbfcfd; }
  .warn { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; padding: 8px 12px;
          font-size: 12.5px; color: #6d4c00; }
  #pager { display: flex; align-items: center; gap: 10px; justify-content: center; margin: 20px 0 8px; }
  #pager input[type=number] { width: 64px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; }
  #status { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
  footer { text-align: center; color: var(--muted); font-size: 12px; padding: 10px 0 30px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>Harvey LAB — Local Corpus Launchpad <span class="sub">accessible task set</span></h1>
  <div class="stats" id="stats"></div>
  <div class="controls">
    <input type="search" id="q" placeholder="Search task id / title / prompt / rubric / document text…" autocomplete="off">
    <select id="area"><option value="all">All practice areas</option></select>
    <select id="wt"><option value="all">All work types</option></select>
    <select id="psize">
      <option value="6">6 / page</option>
      <option value="10" selected>10 / page</option>
      <option value="20">20 / page</option>
      <option value="40">40 / page</option>
    </select>
    <button class="primary" id="loadbtn">📂 Load materials file</button>
    <input type="file" id="file" accept="application/json,.json" class="hidden">
  </div>
  <details class="exp" id="exp">
    <summary>Experiments / arms observed in local results/ (read-only index, not task data)</summary>
    <div class="muted" id="expbody" style="margin-top:6px;"></div>
  </details>
  <div id="status"></div>
</header>
<main>
  <div class="cards" id="cards"></div>
  <div id="pager">
    <button id="prev">← Prev</button>
    <span class="muted">Page</span>
    <input type="number" id="jump" min="1" value="1">
    <span class="muted" id="pagelabel">/ 1</span>
    <button id="next">Next →</button>
  </div>
  <footer>Launchpad generated from the locally accessible Harvey LAB corpus (dev + validation tiers). Sealed tier is not present locally and is not indexed.</footer>
</main>
<script type="application/json" id="index">__INDEX_JSON__</script>
<script type="application/json" id="experiments">__EXPERIMENTS_JSON__</script>
<script>
"use strict";
const INDEX = JSON.parse(document.getElementById('index').textContent);
const EXPERIMENTS = JSON.parse(document.getElementById('experiments').textContent);
let materials = null;            // id -> {docs:[{n,p,s,c,tr,t}]}
let materialsName = '__MATERIALS_FILENAME__';
let q = '', area = 'all', wt = 'all', page = 0, psize = 10;

const $ = id => document.getElementById(id);
const cardsEl = $('cards'), statusEl = $('status'), pagerEl = $('pager');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmtBytes(n) {
  if (n < 0) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(1) + ' MB';
}
function fmtN(n) { return n.toLocaleString('en-US'); }

// ---- precompute search haystacks (metadata) ------------------------------
for (const t of INDEX) {
  const crit = (t.crit || []).map(c => (c.t || '') + '\n' + (c.m || '')).join('\n');
  t._hay = ((t.id || '') + '\n' + (t.t || '') + '\n' + (t.instr || '') + '\n' + crit).toLowerCase();
  t._hayDocs = '';  // doc text appended when materials load
}

function filtered() {
  const needle = q.toLowerCase();
  return INDEX.filter(t => {
    if (area !== 'all' && t.area !== area) return false;
    if (wt !== 'all' && (t.wt || '') !== wt) return false;
    if (needle) {
      if (t._hay.includes(needle)) return true;
      if (t._hayDocs && t._hayDocs.includes(needle)) return true;
      return false;
    }
    return true;
  });
}

// ---- rendering ------------------------------------------------------------
function badges(t) {
  const b = [];
  if (t.wt) b.push('<span class="badge wt">' + esc(t.wt) + '</span>');
  b.push('<span class="badge">' + esc(t.area) + '</span>');
  if (t.sub) b.push('<span class="badge">' + esc(t.sub) + '</span>');
  for (const tag of (t.tags || []).slice(0, 5)) b.push('<span class="badge">' + esc(tag) + '</span>');
  if (t.tags && t.tags.length > 5) b.push('<span class="badge">+' + (t.tags.length - 5) + '</span>');
  b.push('<span class="badge crit">' + t.nc + ' criteria</span>');
  b.push('<span class="badge">' + (t.docs ? t.docs.length : 0) + ' docs</span>');
  return b.join('');
}

function renderCriteria(t, container) {
  if (container.dataset.rendered === '1') return;
  container.dataset.rendered = '1';
  if (!t.crit || !t.crit.length) {
    container.innerHTML = '<div class="muted">No rubric criteria in task.json.</div>';
    return;
  }
  let h = '';
  for (const c of t.crit) {
    const d = Array.isArray(c.d) ? c.d : (c.d ? [c.d] : []);
    const deliv = d.length ? '<div class="deliv">deliverable: ' + esc(d.join(', ')) + '</div>' : '';
    const match = (c.m || '').trim() ? '<details><summary>match criteria</summary><p class="match">' + esc(c.m) + '</p></details>' : '';
    h += '<div class="crit"><span class="cid">' + esc(c.i || '') + '</span><span class="ctitle">' + esc(c.t || '') + '</span>' + deliv + match + '</div>';
  }
  container.innerHTML = h;
}

function renderMaterials(t, container) {
  if (container.dataset.rendered === '1') return;
  container.dataset.rendered = '1';
  const docs = t.docs || [];
  if (!docs.length) {
    container.innerHTML = '<div class="muted">No documents folder.</div>';
    return;
  }
  const m = materials ? materials[t.id] : null;
  const mdoc = m ? (m.docs || []) : [];
  const MAX_ROWS = 300;
  let h = '';
  if (!materials) {
    h += '<div class="warn">Document text is not embedded (the corpus is ~900 MB). Click “📂 Load materials file” above and pick <b>' + esc(materialsName) + '</b> to read extracted text.</div>';
  }
  h += '<div class="muted" style="margin:6px 0 4px;">Sources: ' + esc('tasks/' + t.id + '/documents/') + ' (' + fmtN(docs.length) + ' files)</div>';
  const showAll = docs.length > MAX_ROWS;
  const shown = showAll ? docs.slice(0, MAX_ROWS) : docs;
  h += '<div class="docrows">';
  shown.forEach((d, i) => {
    const ex = mdoc[i];
    h += '<div class="docrow"><span class="dn">' + esc(d.n) + '</span><span class="meta">' + fmtBytes(d.s) + '</span>';
    if (ex && ex.t) {
      const trunc = ex.tr ? ' <span class="muted">(truncated: ' + fmtN(ex.c) + ' chars)</span>' : '';
      h += '<details><summary>text' + trunc + '</summary><div class="doctext" title="' + esc(ex.p || '') + '">' + esc(ex.t) + '</div></details>';
    } else if (ex && ex.om) {
      h += '<span class="meta">(text omitted — per-task materials budget)</span>';
    } else {
      h += '<span class="meta">(text unavailable)</span>';
    }
    h += '</div>';
  });
  h += '</div>';
  if (showAll) {
    h += '<div style="margin-top:8px;"><button class="morebtn" type="button">Show remaining ' + fmtN(docs.length - MAX_ROWS) + ' files…</button></div>';
  }
  container.innerHTML = h;
  const moreBtn = container.querySelector('.morebtn');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      let extra = '';
      for (let i = MAX_ROWS; i < docs.length; i++) {
        const d = docs[i], ex = mdoc[i];
        extra += '<div class="docrow"><span class="dn">' + esc(d.n) + '</span><span class="meta">' + fmtBytes(d.s) + '</span>';
        if (ex && ex.t) {
          const trunc = ex.tr ? ' <span class="muted">(truncated: ' + fmtN(ex.c) + ' chars)</span>' : '';
          extra += '<details><summary>text' + trunc + '</summary><div class="doctext" title="' + esc(ex.p || '') + '">' + esc(ex.t) + '</div></details>';
        } else if (ex && ex.om) {
          extra += '<span class="meta">(text omitted — per-task materials budget)</span>';
        } else {
          extra += '<span class="meta">(text unavailable)</span>';
        }
        extra += '</div>';
      }
      const box = container.querySelector('.docrows');
      box.insertAdjacentHTML('beforeend', extra);
      moreBtn.remove();
    });
  }
}

function card(t) {
  const el = document.createElement('article');
  el.className = 'card';
  const delivKeys = Object.keys(t.deliv || {});
  const delivLine = delivKeys.length ? '<div class="deliv-line"><b>Deliverables:</b> ' + esc(delivKeys.join(', ')) + '</div>' : '';
  el.innerHTML =
    '<h3>' + esc(t.t) + '</h3>' +
    '<div class="id">' + esc(t.id) + '</div>' +
    delivLine +
    '<div class="badges">' + badges(t) + '</div>' +
    '<section class="blk"><details open><summary>Prompt</summary><div class="body"><pre class="prompt">' + esc(t.instr || '') + '</pre></div></details></section>' +
    '<section class="blk"><details><summary>Rubric (' + t.nc + ' criteria)</summary><div class="body" data-crit-container></div></details></section>' +
    '<section class="blk"><details><summary>Materials (' + (t.docs ? t.docs.length : 0) + ' documents)</summary><div class="body" data-mat-container></div></details></section>';
  const critBody = el.querySelector('[data-crit-container]');
  const critDet = el.querySelectorAll('section.blk')[1].querySelector('details');
  critDet.addEventListener('toggle', () => { if (critDet.open) renderCriteria(t, critBody); });
  const matDet = el.querySelectorAll('section.blk')[2].querySelector('details');
  const matBody = matDet.querySelector('.body');
  matDet.addEventListener('toggle', () => { if (matDet.open) renderMaterials(t, matBody); });
  return el;
}

function render() {
  const list = filtered();
  const totalPages = Math.max(1, Math.ceil(list.length / psize));
  if (page >= totalPages) page = totalPages - 1;
  if (page < 0) page = 0;
  const start = page * psize;
  const slice = list.slice(start, start + psize);
  cardsEl.innerHTML = '';
  for (const t of slice) cardsEl.appendChild(card(t));
  $('pagelabel').textContent = '/ ' + fmtN(totalPages);
  $('jump').value = String(page + 1);
  $('jump').max = String(totalPages);
  $('prev').disabled = page <= 0;
  $('next').disabled = page >= totalPages - 1;
  const lo = list.length ? start + 1 : 0;
  const hi = Math.min(start + psize, list.length);
  statusEl.textContent = 'Showing ' + fmtN(lo) + '–' + fmtN(hi) + ' of ' + fmtN(list.length) +
    ' tasks' + (list.length !== INDEX.length ? ' (filtered from ' + fmtN(INDEX.length) + ')' : '') +
    (materials ? ' · materials loaded' : '');
}

// ---- header stats / experiments ------------------------------------------
function init() {
  const areas = new Set(INDEX.map(t => t.area));
  const wts = new Set(INDEX.map(t => t.wt).filter(Boolean));
  const totalDocs = INDEX.reduce((a, t) => a + (t.docs ? t.docs.length : 0), 0);
  const totalCrit = INDEX.reduce((a, t) => a + t.nc, 0);
  $('stats').innerHTML =
    '<span class="stat">' + fmtN(INDEX.length) + ' tasks</span>' +
    '<span class="stat">' + areas.size + ' practice areas</span>' +
    '<span class="stat">' + fmtN(totalDocs) + ' source documents</span>' +
    '<span class="stat">' + fmtN(totalCrit) + ' rubric criteria</span>' +
    (materials ? '<span class="stat">materials loaded</span>' : '');
  const areaSel = $('area');
  if (areaSel.options.length === 0) {
    const all = document.createElement('option');
    all.value = 'all'; all.textContent = 'All practice areas'; areaSel.appendChild(all);
    for (const a of Array.from(areas).sort()) {
      const o = document.createElement('option');
      o.value = a; o.textContent = a; areaSel.appendChild(o);
    }
  }
  const wtSel = $('wt');
  if (wtSel.options.length === 0) {
    const all = document.createElement('option');
    all.value = 'all'; all.textContent = 'All work types'; wtSel.appendChild(all);
    for (const w of Array.from(wts).sort()) {
      const o = document.createElement('option');
      o.value = w; o.textContent = w; wtSel.appendChild(o);
    }
  }
  // experiments summary
  const ex = EXPERIMENTS;
  let eh = 'Local results/ contains ' + fmtN(ex.result_dirs) + ' run directories. ' +
    'Experiment families: ' + Object.entries(ex.families).map(([k, v]) => k + ' (' + v + ')').join(', ') + '. ';
  const armEntries = Object.entries(ex.arms).sort((a, b) => b[1] - a[1]);
  if (armEntries.length) {
    eh += 'Distinct arm slugs: ' + armEntries.map(([k, v]) => k + ' ×' + v).join(', ') + '.';
  }
  $('expbody').textContent = eh;
}

// ---- events ---------------------------------------------------------------
$('q').addEventListener('input', e => { q = e.target.value; page = 0; render(); });
$('area').addEventListener('change', e => { area = e.target.value; page = 0; render(); });
$('wt').addEventListener('change', e => { wt = e.target.value; page = 0; render(); });
$('psize').addEventListener('change', e => { psize = parseInt(e.target.value, 10) || 10; page = 0; render(); });
$('prev').addEventListener('click', () => { if (page > 0) { page--; render(); } });
$('next').addEventListener('click', () => { page++; render(); });
$('jump').addEventListener('change', e => {
  const v = parseInt(e.target.value, 10);
  if (!isNaN(v) && v >= 1) { page = v - 1; render(); } else { $('jump').value = String(page + 1); }
});
$('loadbtn').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const map = {};
      for (const rec of data.tasks) {
        map[rec.id] = rec;
        const tk = INDEX.find(t => t.id === rec.id);
        if (tk) {
          tk._hayDocs = (rec.docs || []).map(d => d.t || '').join('\n').toLowerCase();
        }
      }
      materials = map;
      $('loadbtn').textContent = '📂 Reload materials file';
      init(); render();
      statusEl.textContent += ' · materials loaded from ' + f.name;
    } catch (err) {
      statusEl.textContent = 'Error loading materials file: ' + err.message;
    }
  };
  reader.readAsText(f);
  e.target.value = '';
});

// jump to a specific task by id (query string support: ?task=<id>)
function goToTask(id) {
  const i = INDEX.findIndex(t => t.id === id);
  if (i >= 0) { page = Math.floor(i / psize); q = ''; $('q').value = ''; render(); }
}

init();
render();
</script>
</body>
</html>
"""


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    html_only = "--html-only" in argv
    if html_only:
        # reuse existing materials file, only regenerate the HTML (index + experiments)
        tasks, _mat, total_docs, total_criteria = scan(extract=False)
        mat = None
        if os.path.exists(OUT_MAT):
            with open(OUT_MAT, encoding="utf-8") as f:
                mat = json.load(f).get("tasks")
        else:
            print("WARNING: %s not found; run without --html-only first" % OUT_MAT)
    else:
        tasks, mat, total_docs, total_criteria = scan(extract=True)
    experiments = scan_experiments()

    index_json = json.dumps(tasks, ensure_ascii=False, separators=(",", ":"))
    # escape so </script> can never appear inside the embedded JSON
    index_json = index_json.replace("<", "\\u003c").replace(">", "\\u003e")
    exp_json = json.dumps(experiments, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")

    html_out = (
        TEMPLATE
        .replace("__INDEX_JSON__", index_json)
        .replace("__EXPERIMENTS_JSON__", exp_json)
        .replace("__MATERIALS_FILENAME__", os.path.basename(OUT_MAT))
    )

    with open(OUT_HTML, "w", encoding="utf-8") as f:
        f.write(html_out)

    if not html_only:
        mat_out = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "task_count": len(mat), "tasks": mat}
        with open(OUT_MAT, "w", encoding="utf-8") as f:
            json.dump(mat_out, f, ensure_ascii=False, separators=(",", ":"))

    mb = 1024 * 1024
    print("tasks indexed: %d" % len(tasks))
    print("total documents: %d" % total_docs)
    print("total criteria: %d" % total_criteria)
    print("launchpad.html: %.1f MB" % (os.path.getsize(OUT_HTML) / mb))
    mat_size = os.path.getsize(OUT_MAT) if os.path.exists(OUT_MAT) else -1
    print("launchpad_materials.json: %.1f MB" % (mat_size / mb))
    print("experiments: %d result dirs, %d families, %d arm slugs" % (
        experiments["result_dirs"], len(experiments["families"]), len(experiments["arms"])))


if __name__ == "__main__":
    main()
