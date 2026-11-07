"""Detect-Order-Construct (Wang, Hu, Zhong, Sun, Huo: "Detect-Order-Construct: A Tree Construction based Approach for
Hierarchical Document Structure Analysis", Pattern Recognition 2024, arXiv 2401.11874), trained on our gold.

As the paper builds it:
- Detect, page by page: each text line's embedding fuses its text (a frozen pretrained sentence encoder), its 2D position
  (x1/W, y1/H, x2/W, y2/H, w/W, h/H through a two-layer MLP) and its look; a transformer encoder over the page's lines
  (no positional encoding); each line scores every line of its page as its successor in its text region, f_ij =
  q(F_i).k(F_j) + MLP(r_ij), r_ij the 18 spatial compatibility measures of the two boxes and their union, trained as a
  softmax over the page's lines (a region's last line its own successor); a second head the same for predecessors;
  lines grouped into regions by union-find over the links both heads agree on; each line's logical role, a region's
  role its lines' plurality.
- Order, over the document: each region its lines' attention-pooled features and its role's embedding; a 3-layer
  transformer over all the document's regions; each region scores every region as its successor in reading order, the
  same head form; a bilinear classifier types a pair's link.
- Construct: the section headings in reading order through a transformer with rotary position embedding; each heading
  scores every earlier heading as its parent and as its left sibling (a heading without one pointing to itself), the
  tree built by the paper's Algorithm 1 (each heading the right-most child of the node on the tree's right-most path
  whose parent score times its child's sibling score is greatest).

Where this differs from the paper, and why:
- Text: Model2Vec's static distillation of a multilingual sentence encoder (`--text`) in place of BERT-base, so a
  laptop's CPU can read a document (BERT-base can be passed for the GPU tiers: any model2vec name or path).
- No image features: the paper's RoIAlign visual embedding is left out; the parser's own line features (type size and
  weight, indent, markers, reference marks, OCR confidence) stand in for what the image tells, as one more embedding.
- Sizes: our gold is about 4,000 documents, the paper trains on 1,000 to 80,000 pages with 768-wide layers; ours are
  256 wide (`--width`), heads as the paper's.
- Link agreement: the paper "combines" the successor and predecessor heads without saying how; a link is kept where
  both heads choose it, or where the successor head is sure of it (probability over a half).
- Our legal structure, the same kinds of heads over the same states, none changing the paper's:
  - the body's own tree, Construct over the body's regions (paragraphs, provisions, list items, quotations): their
    parents and left siblings, so provision nesting and the paragraph numbering's sequence (each numbered unit's left
    sibling its predecessor in the sequence);
  - two more region links, each a softmax over the document's regions (or none): a region a unit goes on in (a
    paragraph past a page or a quotation), and a note's region the region holding its reference mark;
  - two line flags: a unit opening on its printed marker, a line opening a constituent document.
- The Order stage's attention is local (block-local, as Longformer's and BigBird's): the regions in the parser's order
  cut into blocks of `BLOCK`, each block attending to itself and the blocks either side, so a document's cost grows
  with its regions, not their square (a statute of 13,745 regions read in 455 s with full attention).
- Reading order: the Order stage's successor head learns the gold's order of the regions (each line's rank in the
  gold, carried onto the parser's lines), which may differ from the parser's (two columns, a form's labels and
  values); its transformer reads the regions with rotary positions over the parser's order.
- The region heads' pair term: the paper's f_ij = q.k + MLP(r_ij) at the region level too, r_ij the two regions'
  spatial measures and what places them: their pages' distance, their distance in the parser's order, whether their
  roles agree, and whether a note's number is a mark the other region sets. Each region's softmax runs over the
  regions within a page of it (itself among them), not the document's: the region a unit goes on in and a note's
  mark lie there (1,281 of 1,292 continuations and 1,196 of 1,203 notes on development), and a document of thousands
  of regions holds no region-by-region matrix.
- The trees: each node's gap under its parent (1 to 4 levels: the print may skip one) a head of its own; their layers'
  dropout 0.2; each parent and sibling score biased by whether the two nodes share a template and by the difference of
  the levels the document's outline names them at.
- The document's stylesheet (Gemini's template inference: the parser's templates, each one's measured relations to the
  others, `stylesheet`): each template a node of its row and its lines' pooled states, read across the document by a
  transformer, each line's state given its template's (Detect reads a page, the templates the document); and each
  line's outline anchor (the level the contents list or the bookmarks name it at) an input of its own.

Inputs: a line dump of every document (LEGALPDF_TRANSITION_DUMP with the gold given, LEGALPDF_TRANSITION_DUMP_LINES=0:
`<sha>.json`, `<sha>.lines.f32`): each line's features, text, page and reference marks, and the gold's labels per line.

python docparse.py fit LINE_DUMP GOLD_STORE OUT_DIR [--text MODEL] [--epochs N] [--width D]
    fits on train's documents, reports each head on development's, and exports the three stages as ONNX graphs
    (detect.onnx, order.onnx, construct.onnx) with docparse.json (feature means and spreads, the text model, sizes)."""
import argparse, copy, gc, json, os, sys, time, zlib
# The allocator grows its segments in place (no fragmenting into blocks no step can use).
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CLASSES = 34
ANCHORS = 10  # an outline anchor's level, 0 for none
T0 = 27  # what t0 decided of a line (`lines::T0`): its role, one of 14, twelve flags and its heading's level
BLOCK = 64  # the Order stage's attention block
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
REGIONS = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote", "marginal_note",
           "furniture", "page_label", "line_label", "title", "note_quote", "provision"]
STREAMS = {"note": 1, "note_quote": 1, "marginal_note": 2, "furniture": 3, "page_label": 4, "line_label": 5}
HEADING = 3
BODY = {1, 2, 4, 6, 8, 9, 16}  # all the gold's depth steps chain over (`machine::RANKED_BODY`)
GAPS = 4
PAIR = 25  # a region pair's measures: 18 spatial, 3 for the pages' distance, the order's distance and side, roles, a note's mark
NOTE = {5, 15}
REFERRING = {1, 2, 3, 4, 8, 9, 14, 16}  # regions whose lines set reference marks notes answer (`machine::REFERRING`)
UNMARKED_BODY = 101
UNMARKED = (1, 2, 4)  # text, a list item, a quotation
TEXT_PULL = 0.25  # a free line's lean to text (`role_loss`)


def partition(store, sha):
    """A source's partition from its source.json; none for a gold held for repair (`hold`), which no one trains on."""
    try:
        source = json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return None if source.get("hold") else source.get("partition")


def region_of(g):
    return 1 if g == 101 else int(g)


# ----------------------------------------------------------------------------------------------- the gold, read
def gold_units(gold):
    """Each labelled line's unit (the index of the unit's first line; -1 none), read as the gold's decoder reads its rows:
    a line opens a unit, goes on with the unit open in its stream, or resumes the unit its pointer names."""
    unit = np.full(len(gold), -1, dtype=np.int64)
    open_unit = {}
    for k, g in enumerate(gold):
        region = region_of(g[0])
        if region <= 0:
            continue
        stream = STREAMS.get(REGIONS[region], 0)
        start, pointer = int(g[1]), int(g[6])
        if start == 2 and 0 <= pointer < k and unit[pointer] >= 0:
            unit[k] = unit[pointer]
        elif start == 0 and stream in open_unit and region_of(gold[open_unit[stream]][0]) == region:
            unit[k] = open_unit[stream]
        else:
            unit[k] = k
        open_unit[stream] = unit[k]
    return unit


def absolute(gold, column, regions):
    """Each unit opening's absolute level (column 4) or depth (column 7) of the given regions, its steps chained (10 the
    same), a document start beginning again; 0 elsewhere or unknown."""
    out, current = np.zeros(len(gold), dtype=np.int64), 0
    for k, g in enumerate(gold):
        if g[2] == 1:
            current = 0
        if region_of(g[0]) in regions and g[1] == 1:
            if g[column] < 0:
                current = 0
                continue
            current = int(np.clip(max(current, 1) + g[column] - 10, 1, 9))
            out[k] = current
    return out


def tree(levels, nodes, starts):
    """For the regions `nodes` (their first lines, in reading order) with levels, each one's parent and left sibling
    among the earlier nodes (indexes into `nodes`; its own index for none), the nearest open node of a smaller level
    and that parent's last child before it."""
    parent, sibling, gaps = [], [], []
    stack, last_child = [], {}
    for i, k in enumerate(nodes):
        if any(starts[j] for j in range(nodes[i - 1] + 1 if i else 0, k + 1)):
            stack, last_child = [], {}
        level = levels[k]
        while stack and levels[nodes[stack[-1]]] >= level:
            stack.pop()
        p = stack[-1] if stack else -1
        parent.append(p if p >= 0 else i)
        s = last_child.get(p)
        sibling.append(s if s is not None else i)
        gaps.append(int(np.clip(level - (levels[nodes[p]] if p >= 0 else 0), 1, GAPS)) - 1)
        last_child[p] = i
        stack.append(i)
    return parent, sibling, gaps


class Doc:
    """One document's lines and every head's gold, read from its line dump."""

    def __init__(self, meta, features):
        self.sha, self.features, self.texts = meta["sha256"], features, meta["texts"]
        n = self.n = len(self.texts)
        gold = np.asarray(meta["gold"], dtype=np.int64).reshape(-1, 8) if meta.get("gold") else np.full((n, 8), -1)
        self.pages = np.asarray(meta["pages"], dtype=np.int64)
        names = meta["line_features"]
        at = {name: names.index(name) for name in ("x0", "y0", "x1", "y1", "width", "height")}
        self.boxes = np.stack([features[:, at["x0"]], features[:, at["y0"]], features[:, at["x1"]], features[:, at["y1"]]], axis=1).astype(np.float32)
        self.marker_value = np.round(np.expm1(np.maximum(features[:, names.index("marker_value")], 0.0))).astype(np.int64)
        self.marker_value = np.where(features[:, names.index("marker")] > 0.5, self.marker_value, -1)
        self.marker_prefix = np.round(np.maximum(features[:, names.index("marker_prefix")], 0.0)).astype(np.int64)
        c0, w0 = names.index("count_1"), names.index("wrap_()")
        count_idx = features[:, c0:c0 + 9].argmax(axis=1)
        wrap_idx = features[:, w0:w0 + 5].argmax(axis=1)
        self.marker_family = np.where(self.marker_value >= 0, count_idx * 5 + wrap_idx + 1, 0).astype(np.int64)
        self.x0 = features[:, at["x0"]].astype(np.float32)
        self.size = features[:, names.index("size")].astype(np.float32)
        self.looks = np.asarray(meta.get("looks") or [0] * n, dtype=np.int64)
        regions = np.asarray([region_of(g) if g >= 0 else -1 for g in gold[:, 0]])
        self.role = np.where(regions >= 0, regions * 2 + (gold[:, 1] == 1), -100)
        # A gold that leaves a quotation or a list item set in its body unmarked (`gold_labels.UNMARKED_BODY`) says no more than
        # that a line is one of `UNMARKED`: `role_loss` holds it to that, and the role's accuracy does not read it.
        self.free = gold[:, 0] == UNMARKED_BODY
        self.marked = np.where(regions >= 0, ((gold[:, 1] == 1) & (gold[:, 5] == 1)).astype(np.int64), -100)
        self.start = np.where(regions >= 0, (gold[:, 2] == 1).astype(np.int64), -100)
        units = gold_units(gold)
        # Detect: regions, a unit's lines on one page in reading order; each line's successor on its page.
        region = np.full(n, -1, dtype=np.int64)
        firsts = {}
        for k in range(n):
            if units[k] >= 0:
                key = (int(units[k]), int(self.pages[k]))
                firsts.setdefault(key, k)
                region[k] = firsts[key]
        self.region = region
        self.successor = np.full(n, -100, dtype=np.int64)
        self.predecessor = np.full(n, -100, dtype=np.int64)
        last = {}
        for k in range(n):
            if region[k] < 0:
                continue
            if region[k] in last:
                self.successor[last[region[k]]] = k
                self.predecessor[k] = last[region[k]]
            else:
                self.predecessor[k] = k
            self.successor[k] = k
            last[region[k]] = k
        # Order: the document's regions in reading order (their first lines), each region's successor; a unit's
        # regions after its first going on in it; a note's region pointing at the region holding its paired mark.
        self.regions = sorted({int(r) for r in region if r >= 0})
        index = {r: i for i, r in enumerate(self.regions)}
        self.region_of_line = np.asarray([index.get(int(r), -1) for r in region], dtype=np.int64)
        m = len(self.regions)
        unit_regions = {}
        for i, r in enumerate(self.regions):
            unit_regions.setdefault(int(units[r]), []).append(i)
        self.goes_on = np.full(m, -100, dtype=np.int64)
        for parts in unit_regions.values():
            for a, b in zip(parts, parts[1:]):
                self.goes_on[a] = b
            self.goes_on[parts[-1]] = parts[-1]
        self.note_of = np.full(m, -100, dtype=np.int64)
        references = meta.get("references") or [[] for _ in range(n)]
        translated = features[:, names.index("translation")]
        notes = meta["note_numbers"]  # each line's note number as the engine reads it (`doc::note_number`), -1 for none
        taken = set()
        for i, r in enumerate(self.regions):
            if region_of(gold[r][0]) not in NOTE or gold[r][1] != 1:
                continue
            label = notes[r]
            # The gold's paired mark of its number nearest before it, else after it, wherever it stands, each mark one
            # note's; a parallel report's two notes of a number take the marks of their own languages.
            target = i
            order = list(range(r - 1, -1, -1)) + list(range(r + 1, n))
            same = [k for k in order if translated[k] == translated[r]]
            for k in same + order:
                if gold[k][3] == 1 and (k, label) not in taken and any(ref[0] == label for ref in references[k]) and self.region_of_line[k] >= 0:
                    target = int(self.region_of_line[k])
                    taken.add((k, label))
                    break
            self.note_of[i] = target
        self.region_role = np.asarray([self.role[r] // 2 if self.role[r] >= 0 else 0 for r in self.regions], dtype=np.int64)
        # Construct: the headings' tree, and the body's.
        starts = (gold[:, 2] == 1)
        levels = absolute(gold, 4, {HEADING})
        self.headings = [i for i, r in enumerate(self.regions) if region_of(gold[r][0]) == HEADING and gold[r][1] == 1 and levels[r] > 0]
        self.heading_parent, self.heading_sibling, self.heading_gap = tree(levels, [self.regions[i] for i in self.headings], starts)
        self.heading_sibling_from = list(self.heading_sibling)
        depths = absolute(gold, 7, BODY)
        opening = [i for i, r in enumerate(self.regions) if region_of(gold[r][0]) in BODY and gold[r][1] == 1]
        # A gold that gives its body no depths (A2AJ's alignments) says what its numbered paragraphs are: the court's
        # numbering, at the body's top (98.9% of the model golds' judgments' numbered paragraphs), each one's left sibling
        # among the nodes from the paragraph before it; the tree learns that and nothing of its other nodes.
        self.partial_bodies = bool(opening) and not any(depths[self.regions[i]] > 0 for i in opening)
        if self.partial_bodies:
            self.bodies = opening
            h = len(opening)
            self.body_parent, self.body_sibling, self.body_sibling_from, self.body_gap = ([-100] * h for _ in range(4))
            prev, last = None, -1
            for at, i in enumerate(opening):
                r = self.regions[i]
                if starts[last + 1:r + 1].any():
                    prev = None
                last = r
                if region_of(gold[r][0]) == 1 and gold[r][5] == 1:
                    self.body_parent[at], self.body_gap[at] = at, 0
                    if prev is not None:
                        self.body_sibling[at], self.body_sibling_from[at] = at - 1, prev
                    prev = at
        else:
            self.bodies = [i for i in opening if depths[self.regions[i]] > 0]
            self.body_parent, self.body_sibling, self.body_gap = tree(depths, [self.regions[i] for i in self.bodies], starts)
            self.body_sibling_from = list(self.body_sibling)
        # The regions' places: each one's page and its lines' union box; its rank in the gold's reading (its lines'
        # least) and its successor in that order (none where the gold gives no ranks); a note's number (its first line's) and
        # the marks of it each region sets.
        firsts = np.asarray(self.regions, dtype=np.int64)
        self.region_pages = self.pages[firsts] if m else np.zeros(0, dtype=np.int64)
        box = np.tile(np.asarray([1e9, 1e9, -1e9, -1e9], dtype=np.float32), (m, 1))
        for k in np.flatnonzero(self.region_of_line >= 0):
            i = self.region_of_line[k]
            box[i, :2] = np.minimum(box[i, :2], self.boxes[k, :2])
            box[i, 2:] = np.maximum(box[i, 2:], self.boxes[k, 2:])
        self.region_boxes = box
        ranks = np.asarray(meta.get("ranks") or [-1] * n, dtype=np.int64)
        rank = np.full(m, np.iinfo(np.int64).max)
        for k in np.flatnonzero((self.region_of_line >= 0) & (ranks >= 0)):
            rank[self.region_of_line[k]] = min(rank[self.region_of_line[k]], ranks[k])
        self.region_order = np.full(m, -100, dtype=np.int64)
        known = [i for i in range(m) if rank[i] < np.iinfo(np.int64).max]
        known.sort(key=lambda i: (rank[i], i))
        for a, b in zip(known, known[1:]):
            self.region_order[a] = b
        if known:
            self.region_order[known[-1]] = known[-1]
        number = np.full(m, -1, dtype=np.int64)
        marks = [set() for _ in range(m)]
        for i, r in enumerate(self.regions):
            if region_of(gold[r][0]) in NOTE:
                number[i] = notes[r]
        for k in np.flatnonzero(self.region_of_line >= 0):
            i = int(self.region_of_line[k])
            if int(self.region_role[i]) in REFERRING:
                for ref in references[k]:
                    marks[i].add(int(ref[0]))
        self.region_number, self.region_marks = number, marks
        # The stylesheet: each line's template, each template's measured row, each line's outline anchor.
        self.templates = np.asarray(meta.get("templates") or [0] * n, dtype=np.int64)
        rows = meta.get("template_rows") or []
        count = max(len(rows), int(self.templates.max()) + 1 if n else 1)
        table = np.zeros((count, max(len(rows[0]) if rows else 1, 1)), dtype=np.float32)
        if rows:
            table[:len(rows), :len(rows[0])] = np.clip(np.nan_to_num(np.asarray(rows, dtype=np.float32)), -8, 8)
            # How the walker's first reading read each template (`read_heading`, `read_level`): the engine reads
            # before any walk, so neither is known to it.
            table[:, 9:11] = 0
        self.template_rows = table
        self.anchors = np.clip(np.asarray(meta.get("anchors") or [0] * n, dtype=np.int64), 0, ANCHORS - 1)
        # What t0 decided of each line (`lines::T0`): the model reads the parser's own reading, not beside it.
        self.t0 = np.asarray(meta["t0"], dtype=np.float32).reshape(n, T0)


# ----------------------------------------------------------------------------------------------- the model
def spatial(boxes_i, boxes_j):
    """The paper's spatial compatibility measures of each pair (i, j): Δ(b_i, b_j), Δ(b_i, b_ij), Δ(b_j, b_ij), b_ij the
    union box; Δ(a, b) the centres' offsets each way scaled by the boxes' sizes and the log ratios of width and height."""
    return measures(*torch.broadcast_tensors(boxes_i[..., :, None, :], boxes_j[..., None, :, :]))


def measures(a, b):
    """The spatial measures of the boxes `a` against the boxes `b`, aligned."""
    def delta(a, b):
        wa, ha = (a[..., 2] - a[..., 0]).clamp(min=1e-3), (a[..., 3] - a[..., 1]).clamp(min=1e-3)
        wb, hb = (b[..., 2] - b[..., 0]).clamp(min=1e-3), (b[..., 3] - b[..., 1]).clamp(min=1e-3)
        xa, ya = (a[..., 0] + a[..., 2]) / 2, (a[..., 1] + a[..., 3]) / 2
        xb, yb = (b[..., 0] + b[..., 2]) / 2, (b[..., 1] + b[..., 3]) / 2
        return torch.stack([(xa - xb) / wa, (ya - yb) / ha, torch.log(wa / wb), torch.log(ha / hb), (xb - xa) / wb, (yb - ya) / hb], dim=-1)
    union = torch.stack([torch.minimum(a[..., 0], b[..., 0]), torch.minimum(a[..., 1], b[..., 1]), torch.maximum(a[..., 2], b[..., 2]), torch.maximum(a[..., 3], b[..., 3])], dim=-1)
    return torch.cat([delta(a, b), delta(a, union), delta(b, union)], dim=-1).clamp(-20, 20)


class RelationHead(nn.Module):
    """The paper's relation head: f_ij = q(F_i).k(F_j) (+ MLP(r_ij) where boxes are given)."""

    def __init__(self, d, spatial_term=True):
        super().__init__()
        self.q, self.k = nn.Linear(d, d), nn.Linear(d, d)
        # The spatial MLP 64 wide (the paper leaves its width open): 18 measures in, one score out.
        self.r = nn.Sequential(nn.Linear(18, 64), nn.ReLU(), nn.Linear(64, 1)) if spatial_term else None

    def pairs(self, xi, xj, batch=None, boxes=None):
        """Batched scores (B, Li, Lj) of rows xi (B, Li, d) against columns xj (B, Lj, d), the spatial term added on the
        batch's real pairs (its measures computed here from the boxes: the same values every step, too many to hold)."""
        f = self.q(xi) @ self.k(xj).transpose(-1, -2) / xi.shape[-1] ** 0.5
        if self.r is not None and batch is not None:
            r = batch.rows.clamp(min=0)
            measures = spatial(boxes[r], boxes[r]).reshape(-1, 18)[batch.keep]
            f = f.reshape(-1).index_add(0, batch.keep, self.r(measures).squeeze(-1).to(f.dtype)).view_as(f)
        return f

    def forward(self, x):
        """Every node against every node, on their features (the region links and the trees)."""
        return self.q(x) @ self.k(x).t() / x.shape[-1] ** 0.5


class PairHead(nn.Module):
    """The paper's relation head over regions with a pair term: f_ij = q(F_i).k(F_j) + MLP(r_ij), r_ij (`PAIR`) given
    for the pairs listed (`pairs`, the regions within a page of each other); elsewhere the pair scores on its features
    alone."""

    def __init__(self, d):
        super().__init__()
        self.q, self.k = nn.Linear(d, d), nn.Linear(d, d)
        self.r = nn.Sequential(nn.Linear(PAIR, 64), nn.ReLU(), nn.Linear(64, 1))

    def forward(self, x, pairs):
        """Each listed pair's score (P,): on the device the regions' products all at once (a matrix the device holds
        well), the listed pairs' read off it."""
        i, j, r = pairs
        f = self.q(x) @ self.k(x).t() / x.shape[-1] ** 0.5
        return f[i, j] + self.r(r).squeeze(-1).to(f.dtype)

    def parts(self, x, pairs):
        """The same scores' parts as the engine computes them, a pair at a time with no matrix: the regions' scaled
        queries and keys, and each pair's term."""
        _, _, r = pairs
        return self.q(x) / x.shape[-1] ** 0.5, self.k(x), self.r(r).squeeze(-1)


def row_loss(logits, i, m, target):
    """Cross-entropy of each region's softmax over its pairs (`i` each pair's region, `target` each region's gold pair,
    negative where none is given or the gold lies outside the region's pairs)."""
    logits = logits.float()
    top = torch.full((m,), -1e9, device=logits.device).scatter_reduce(0, i, logits, reduce="amax")
    total = torch.zeros(m, device=logits.device).scatter_add(0, i, torch.exp(logits - top[i]))
    norm = torch.log(total.clamp(min=1e-30)) + top
    rows = target >= 0
    return (norm[rows] - logits[target[rows]]).mean() if rows.any() else logits.sum() * 0


def row_choice(logits, i, j, m):
    """Each region's likeliest pair's other region (itself where it has no pairs)."""
    logits, i, j = logits.float().cpu().numpy(), i.cpu().numpy(), j.cpu().numpy()
    order = np.lexsort((-logits, i))
    first = order[np.r_[True, i[order][1:] != i[order][:-1]]] if len(order) else order
    chosen = np.arange(m)
    chosen[i[first]] = j[first]
    return chosen


def region_pairs(boxes, pages, roles, i, j, match):
    """The pair measures r_ij of the regions `i` against the regions `j` (`PAIR` each): their boxes' spatial measures,
    the pages' distance (-1, 0, 1), the distance in the parser's order (log) and its side, whether the roles agree,
    and whether a note's number is a mark the other sets."""
    gap = (pages[j] - pages[i]).clamp(-1, 1)
    order = (j - i).float()
    return torch.cat([measures(boxes[i], boxes[j]), F.one_hot(gap + 1, 3).float(), torch.log1p(order.abs())[:, None] / 5,
                      order.sign()[:, None], (roles[i] == roles[j]).float()[:, None], match.float()[:, None]], dim=-1)


def padded(starts, ends):
    """Runs of indexes [a, z) as rows of a matrix, -1 past each run's end."""
    width = int((ends - starts).max())
    out = starts[:, None] + np.arange(width)[None, :]
    return np.where(out < ends[:, None], out, -1)


def moved(thing, device):
    """A copy of a prepared object with its tensors (and its batches') on `device`, indexes held in 32 bits widened."""
    new = copy.copy(thing)
    for name, value in vars(thing).items():
        if torch.is_tensor(value):
            value = value.to(device)
            setattr(new, name, value.long() if value.dtype == torch.int32 else value)
        elif isinstance(value, (Batch, Paged)):
            setattr(new, name, moved(value, device))
        elif isinstance(value, list) and value and isinstance(value[0], Batch):
            setattr(new, name, [moved(b, device) for b in value])
    return new


class Batch:
    """Pages of like length read together: each page's nodes a padded row (`rows`), its first index (`starts`), the
    lines compared within the page; as flat integer indexes in 32 bits (no step waits on a mask's count), the real
    places (`valid_at` into the rows, `nodes` the lines there) and the real pairs (`keep` into rows by rows)."""

    def __init__(self, starts, ends):
        rows = padded(starts, ends)
        i32 = lambda a: torch.as_tensor(np.asarray(a, dtype=np.int32))
        self.rows, self.starts = i32(rows), i32(starts)
        self.valid = torch.as_tensor(rows >= 0)
        self.valid_at, self.nodes = i32(np.flatnonzero(rows >= 0)), i32(rows[rows >= 0])
        self.keep = i32(np.flatnonzero((rows[:, :, None] >= 0) & (rows[:, None, :] >= 0)))


class Paged:
    """A document's pages in batches of pages of like length (each padded to its own longest page, at most `budget`
    pairs a batch); `inverse` puts the batches' lines back in reading order."""

    def __init__(self, pages, budget=2_000_000):
        pages = np.asarray(pages)
        cut = np.flatnonzero(np.diff(pages)) + 1
        starts, ends = np.concatenate([[0], cut]).astype(np.int64), np.concatenate([cut, [len(pages)]]).astype(np.int64)
        by = np.argsort(ends - starts, kind="stable")
        self.batches, group = [], []
        for i in by:
            width = ends[i] - starts[i]
            if group and (len(group) + 1) * width * width > budget:
                self.batches.append(Batch(starts[group], ends[group]))
                group = []
            group.append(i)
        self.batches.append(Batch(starts[group], ends[group]))
        self.inverse = torch.argsort(torch.cat([b.nodes for b in self.batches]).long()).to(torch.int32)


def encoder(d, heads, layers, rotary=False):
    return nn.Sequential(*[Layer(d, heads, rotary) for _ in range(layers)])


class Layer(nn.Module):
    """A pre-norm transformer encoder layer over one sequence (n, d), its attention PyTorch's memory-efficient kernel
    (the same attention, never holding the n-by-n matrix); with `rotary`, queries and keys rotated by their
    reading-order place (RoPE)."""

    def __init__(self, d, heads, rotary=False, dropout=0.1):
        super().__init__()
        self.heads, self.size, self.rotary, self.dropout = heads, d // heads, rotary, dropout
        self.drop = nn.Dropout(dropout)
        self.norm1, self.norm2 = nn.LayerNorm(d), nn.LayerNorm(d)
        self.qkv, self.out = nn.Linear(d, 3 * d), nn.Linear(d, d)
        self.feed = nn.Sequential(nn.Linear(d, 4 * d), nn.GELU(), nn.Linear(4 * d, d))

    def rotate(self, t):
        """t (B, h, L, s), rotated by each place along L."""
        n, s = t.shape[-2], t.shape[-1]
        place = torch.arange(n, device=t.device, dtype=torch.float32)[:, None]
        freq = 10000 ** (-torch.arange(0, s, 2, device=t.device, dtype=torch.float32) / s)
        angle = place * freq[None]
        cos, sin = angle.cos(), angle.sin()
        even, odd = t[..., 0::2], t[..., 1::2]
        return torch.stack([even * cos - odd * sin, even * sin + odd * cos], dim=-1).flatten(-2)

    def forward(self, x, valid=None):
        """x (L, d) one sequence, or (B, L, d) a batch with `valid` (B, L) its real places."""
        single = x.dim() == 2
        if single:
            x = x[None]
        b, n, _ = x.shape
        q, k, v = self.qkv(self.norm1(x)).reshape(b, n, 3, self.heads, self.size).permute(2, 0, 3, 1, 4)
        if self.rotary:
            q, k = self.rotate(q), self.rotate(k)
        mask = None if valid is None else valid[:, None, None, :]
        y = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, dropout_p=self.dropout if self.training else 0.0)
        x = x + self.drop(self.out(y.transpose(1, 2).reshape(b, n, -1)))
        x = x + self.drop(self.feed(self.norm2(x)))
        return x[0] if single else x


class Detect(nn.Module):
    def __init__(self, width, text_dim, d):
        super().__init__()
        self.text = nn.Sequential(nn.Linear(text_dim, d), nn.ReLU(), nn.LayerNorm(d))
        self.position = nn.Sequential(nn.Linear(6, d), nn.ReLU(), nn.Linear(d, d), nn.ReLU(), nn.LayerNorm(d))
        self.look = nn.Sequential(nn.Linear(width, d), nn.ReLU(), nn.LayerNorm(d))
        self.anchor = nn.Embedding(ANCHORS, d)
        self.decided = nn.Sequential(nn.Linear(T0, d), nn.ReLU(), nn.LayerNorm(d))
        self.fuse = nn.Linear(5 * d, d)
        self.encoder = nn.ModuleList([Layer(d, 8)])
        self.successor, self.predecessor = RelationHead(d), RelationHead(d)
        self.role = nn.Linear(d, CLASSES)
        self.flags = nn.Linear(d, 2)

    def embed(self, features, text, boxes, anchors, t0):
        size = (boxes[:, 2:] - boxes[:, :2]).clamp(min=0)
        return self.fuse(torch.cat([self.text(text), self.position(torch.cat([boxes, size], dim=-1)), self.look(features), self.anchor(anchors),
                                    self.decided(t0)], dim=-1))

    def forward(self, features, text, boxes, anchors, t0, paged):
        """Every line's state, its page's lines read together (the pages batched, each its own sequence)."""
        u = self.embed(features, text, boxes, anchors, t0)
        out = []
        for batch in paged.batches:
            x = u[batch.rows.clamp(min=0)]
            for layer in self.encoder:
                x = layer(x, batch.valid)
            out.append(x.reshape(-1, x.shape[-1])[batch.valid_at])
        return torch.cat(out)[paged.inverse]

class BlockLayer(Layer):
    """A transformer layer whose attention is block-local: the sequence (its length a multiple of `BLOCK`, `valid` its
    real places) cut into blocks, each block's queries attending to the keys of itself and the blocks either side;
    queries and keys rotated by their places in the whole sequence."""

    def forward(self, x, valid):
        n = x.shape[0]
        q, k, v = self.qkv(self.norm1(x)).reshape(n, 3, self.heads, self.size).permute(1, 2, 0, 3)  # (h, n, s) each
        if self.rotary:
            q, k = self.rotate(q), self.rotate(k)
        blocks = lambda t: t.reshape(self.heads, -1, BLOCK, self.size).transpose(0, 1)  # (b, h, BLOCK, s)
        qb, kb, vb = blocks(q), blocks(k), blocks(v)
        mask = valid.reshape(-1, BLOCK)
        edge_kv = torch.zeros_like(kb[:1])
        edge_mask = torch.zeros_like(mask[:1])
        around = lambda t, edge: torch.cat([torch.cat([edge, t[:-1]]), t, torch.cat([t[1:], edge])], dim=-2 if t.dim() == 4 else -1)
        keys, values = around(kb, edge_kv), around(vb, edge_kv)
        seen = around(mask, edge_mask)  # (b, 3 BLOCK)
        y = F.scaled_dot_product_attention(qb, keys, values, attn_mask=seen[:, None, None, :], dropout_p=self.dropout if self.training else 0.0)
        y = y.transpose(0, 1).reshape(self.heads, n, self.size).permute(1, 0, 2).reshape(n, -1)
        x = x + self.drop(self.out(y))
        return x + self.drop(self.feed(self.norm2(x)))


class Templates(nn.Module):
    """The document's stylesheet read across the document: each template a node of its measured row and its lines'
    pooled states, a transformer over the templates, each line's state given its template's."""

    def __init__(self, d, row_width):
        super().__init__()
        self.row_width = max(row_width, 1)
        self.row = nn.Sequential(nn.Linear(self.row_width, d), nn.ReLU(), nn.LayerNorm(d))
        self.pool = nn.Linear(d, d)
        self.encoder = encoder(d, 8, 2)
        self.back = nn.Sequential(nn.Linear(d, d), nn.LayerNorm(d))

    def forward(self, states, templates, rows):
        if rows.shape[1] < self.row_width:
            rows = F.pad(rows, (0, self.row_width - rows.shape[1]))
        x = states.float()
        # The templates' buffers shaped from the rows (an exported graph reads the count of templates off its input).
        blank = (rows[:, :1].float() * 0).expand(-1, x.shape[1])
        total = blank.scatter_add(0, templates[:, None].expand(-1, x.shape[1]), x)
        count = (blank[:, 0] * 0).scatter_add(0, templates, torch.ones_like(x[:, 0]))
        node = self.pool(total / count[:, None].clamp(min=1)) + self.row(rows.float())
        node = self.encoder(node)
        return states + self.back(node)[templates].to(states.dtype)


class Order(nn.Module):
    def __init__(self, d, regions=17):
        super().__init__()
        self.pool = nn.Sequential(nn.Linear(d, d), nn.Tanh(), nn.Linear(d, 1))
        self.role = nn.Sequential(nn.Embedding(regions, d), nn.ReLU(), nn.LayerNorm(d))
        self.fuse = nn.Linear(2 * d, d)
        self.encoder = nn.ModuleList([BlockLayer(d, 8, rotary=True) for _ in range(3)])
        self.goes_on, self.note_of, self.successor = PairHead(d), PairHead(d), PairHead(d)

    def forward(self, line_states, region_lines, line_region, region_roles, valid=None):
        """line_states (n, d), the lines in regions and each one's region (of m), the regions' roles -> region states
        (m, d): each region's attention-pooled state and role."""
        # `region_lines` None: every line given is in a region (the exported graph's input).
        states, region = (line_states if region_lines is None else line_states[region_lines]).float(), line_region
        alpha = self.pool(states).squeeze(-1).float()
        # The regions' buffers made from a tensor of their shape (an exported graph reads the count of regions
        # from its input, not the one it was traced with).
        roles = self.role(region_roles)
        blank = roles.float() * 0
        top = (blank[:, 0] - 1e4).scatter_reduce(0, region, alpha, reduce="amax")
        w = torch.exp(alpha - top[region])
        total = blank[:, 0].scatter_add(0, region, w)
        pooled = blank.scatter_add(0, region[:, None].expand(-1, states.shape[1]), w[:, None] * states) / total[:, None].clamp(min=1e-9)
        x = self.fuse(torch.cat([pooled, roles], dim=-1))
        # The regions padded to whole blocks (the engine pads them itself, `valid` its real ones).
        m = x.shape[0]
        if valid is None:
            pad = (-m) % BLOCK
            x = F.pad(x, (0, 0, 0, pad))
            valid = torch.arange(m + pad, device=x.device) < m
        for layer in self.encoder:
            x = layer(x, valid)
        return x[:m] if x.shape[0] != m else x


def tree_codes(family, value, prefix, section, x0, size, looks, pages, roles):
    """Factored pairwise grammar and geometry state indices (n, n) of each node `i` against each node `j`, avoiding
    materializing a 3D feature tensor on large statutes."""
    with torch.no_grad():
        n = family.shape[0]
        fi, fj = family[:, None], family[None, :]
        vi, vj = value[:, None], value[None, :]
        same_fam = (fi > 0) & (fi == fj)
        valid_v = (vi >= 0) & (vj >= 0)
        dv = vi - vj
        idx = torch.arange(n, device=family.device)
        earlier_same = same_fam & (idx[:, None] > idx[None, :])
        latest_j = torch.where(earlier_same, idx[None, :], -1).amax(dim=-1, keepdim=True)
        no_intervening = earlier_same & (idx[None, :] == latest_j)
        del earlier_same, latest_j
        same_sec = section[:, None] == section[None, :]
        # Grammar state code in 0..12:
        # 0: both unnumbered; 1: numbered under unnumbered; 2: unnumbered under numbered;
        # 3: diff family, vi == 1, same section; 4: diff family, vi == 1, diff section; 5: diff family, vi != 1;
        # 6: same family, dv <= 0; 7: same family, dv > 1, intervened; 8: same family, dv > 1, no intervening;
        # 9: same family, dv == 1, intervened; 10: same family, dv == 1, no intervening, diff section;
        # 11: same family, dv == 1, no intervening, same section.
        g = torch.zeros_like(fi)
        g = torch.where((fi > 0) & (fj == 0), 1, g)
        g = torch.where((fi == 0) & (fj > 0), 2, g)
        diff_fam = (fi > 0) & (fj > 0) & (fi != fj)
        g = torch.where(diff_fam & (vi != 1), 5, g)
        g = torch.where(diff_fam & (vi == 1) & ~same_sec, 4, g)
        g = torch.where(diff_fam & (vi == 1) & same_sec, 3, g)
        del diff_fam
        g = torch.where(same_fam & valid_v & (dv <= 0), 6, g)
        g = torch.where(same_fam & valid_v & (dv > 1) & ~no_intervening, 7, g)
        g = torch.where(same_fam & valid_v & (dv > 1) & no_intervening, 8, g)
        g = torch.where(same_fam & valid_v & (dv == 1) & ~no_intervening, 9, g)
        g = torch.where(same_fam & valid_v & (dv == 1) & no_intervening & ~same_sec, 10, g)
        g = torch.where(same_fam & valid_v & (dv == 1) & no_intervening & same_sec, 11, g)
        del same_fam, valid_v, dv, no_intervening
        # Geometry/style state code in 0..48:
        # indent_rel (0: aligned |dx|<0.015, 1: indented dx>=0.015, 2: outdented dx<=-0.015) * 16
        # + same_look * 8 + same_role * 4 + same_page * 2 + same_sec
        dx = x0[:, None] - x0[None, :]
        geom = torch.where(dx >= 0.015, 16, torch.where(dx <= -0.015, 32, 0))
        geom = geom + (looks[:, None] == looks[None, :]).long() * 8
        geom = geom + (roles[:, None] == roles[None, :]).long() * 4
        geom = geom + (pages[:, None] == pages[None, :]).long() * 2 + same_sec.long()
        del same_sec
        pref = (prefix[:, None] - prefix[None, :]).clamp(-4, 4) + 4
        order_diff = (idx[:, None] - idx[None, :]).clamp(min=0)
        dist = torch.clamp(torch.log2(order_diff.float() + 1.0).long(), 0, 15)
        del order_diff
        ds = (size[:, None] - size[None, :]).clamp(-2.0, 2.0)
        return g, geom, pref, dist, dx.clamp(-1.0, 1.0), ds


class Construct(nn.Module):
    def __init__(self, d):
        super().__init__()
        self.node_role = nn.Embedding(17, d)
        self.node_fam = nn.Embedding(64, d)
        self.node_geom = nn.Linear(4, d)
        self.enclosing = nn.Linear(d, d, bias=False)
        nn.init.zeros_(self.enclosing.weight)
        self.extra_drop = nn.Dropout(0.2)
        self.layers = nn.ModuleList([Layer(d, 8, rotary=True, dropout=0.2) for _ in range(2)])
        self.parent, self.sibling = RelationHead(d, spatial_term=False), RelationHead(d, spatial_term=False)
        self.gap = nn.Linear(d, GAPS)
        # Biases on every two nodes: shared template, outline anchor difference, and factored grammar/geometry tables.
        self.same = nn.Parameter(torch.zeros(2))
        self.levels = nn.Embedding(2 * ANCHORS - 1, 2)
        self.grammar_rel = nn.Embedding(12, 2)
        self.geom_rel = nn.Embedding(48, 2)
        self.pref_rel = nn.Embedding(9, 2)
        self.dist_rel = nn.Embedding(16, 2)
        self.cont_scale = nn.Parameter(torch.zeros(2, 2))
        for emb in (self.levels, self.grammar_rel, self.geom_rel, self.pref_rel, self.dist_rel):
            nn.init.zeros_(emb.weight)

    def forward(self, states, heading_states, templates, anchors, family, value, prefix, section, x0, size, looks, pages, roles):
        node_feat = torch.stack([
            x0.float(),
            size.float(),
            ((family > 0) & (value == 1)).float(),
            prefix.clamp(0, 4).float() / 4.0,
        ], dim=-1)
        extra = self.node_role(roles.clamp(0, 16)) + self.node_fam(family.clamp(0, 63)) + self.node_geom(node_feat) + self.enclosing(heading_states.float())
        states = states + self.extra_drop(extra.to(states.dtype))
        for layer in self.layers:
            states = layer(states)
        same = (templates[:, None] == templates[None, :]).float()
        steps = self.levels((anchors[None, :] - anchors[:, None]) + ANCHORS - 1)
        g, geom, pref, dist, dx, ds = tree_codes(family, value, prefix, section, x0, size, looks, pages, roles)
        bias = same[..., None] * self.same + steps + self.grammar_rel(g) + self.geom_rel(geom) + self.pref_rel(pref) + self.dist_rel(dist)
        p, s = self.parent(states), self.sibling(states)
        p = p + (bias[..., 0] + dx * self.cont_scale[0, 0] + ds * self.cont_scale[1, 0]).to(p.dtype)
        s = s + (bias[..., 1] + dx * self.cont_scale[0, 1] + ds * self.cont_scale[1, 1]).to(s.dtype)
        return p, s, self.gap(states)


class DocParser(nn.Module):
    def __init__(self, width, text_dim, d, row_width=0):
        super().__init__()
        self.detect = Detect(width, text_dim, d)
        self.templates = Templates(d, row_width)
        self.order = Order(d)
        self.headings, self.bodies = Construct(d), Construct(d)


def earlier(f):
    """A tree head's scores over earlier nodes and itself (none), later ones masked."""
    n = f.shape[0]
    return f.masked_fill(torch.triu(torch.ones(n, n, dtype=torch.bool, device=f.device), diagonal=1), -1e4)


# ----------------------------------------------------------------------------------------------- training
class Ready:
    """A document's inputs, gold and page indexes, built once and held in host memory (`moved` to the device a step at
    a time, so the device holds one document whatever the corpus); the features and texts in the precision the
    autocast reads them in; which losses the document has (`has`), read off its gold here and not on the device."""

    def __init__(self, doc, mean, std, embed):
        on = lambda a, dtype=torch.long: torch.as_tensor(np.asarray(a), dtype=dtype)
        self.f = on(np.clip((doc.features - mean) / std, -8, 8), torch.float32).to(torch.bfloat16)
        self.t = on(embed(doc), torch.float32).to(torch.bfloat16)
        self.z = on(doc.t0, torch.float32).to(torch.bfloat16)
        self.b = on(doc.boxes, torch.float32)
        self.lines = Paged(doc.pages)
        self.free = on(doc.free, torch.bool)
        for name in ("role", "successor", "predecessor", "marked", "start", "goes_on", "note_of"):
            setattr(self, name, on(getattr(doc, name)))
        lines = np.flatnonzero(doc.region_of_line >= 0)
        self.region_lines, self.line_region = on(lines), on(doc.region_of_line[lines])
        self.region_role = on(doc.region_role)
        self.counts = {name: int((np.asarray(getattr(doc, name)) >= 0).sum()) for name in ("successor", "predecessor")}
        self.has = {name for name in ("role", "marked", "start", "goes_on", "note_of") if (np.asarray(getattr(doc, name)) >= 0).any()}
        self.has |= {name for name in ("successor", "predecessor") if self.counts[name]}
        if doc.regions:
            self.has.add("regions")
        self.region_order = on(doc.region_order)
        if (doc.region_order >= 0).any():
            self.has.add("order")
        self.region_boxes, self.region_pages = on(doc.region_boxes, torch.float32), on(doc.region_pages)
        self.templates, self.template_rows, self.anchors = on(doc.templates), on(doc.template_rows, torch.float32), on(doc.anchors)
        self.trees(doc)
        i, j, match = pairs_of(doc)
        self.pair_i, self.pair_j, self.pair_match = on(i, torch.int32), on(j, torch.int32), on(match, torch.bool)
        # Each region's gold pair for each region head: the pair (region, its target), negative where the gold gives
        # none (-100) or its target lies outside the region's pairs (-1).
        m = len(doc.regions)
        at = {int(a) * max(m, 1) + int(b): p for p, (a, b) in enumerate(zip(i.tolist(), j.tolist()))}
        for name, gold in (("goes_on_pair", doc.goes_on), ("note_of_pair", doc.note_of), ("order_pair", doc.region_order)):
            setattr(self, name, on([-100 if t < 0 else at.get(r * max(m, 1) + int(t), -1) for r, t in enumerate(gold.tolist())], torch.int32))


    def trees(self, doc):
        """The trees' nodes, inputs and gold, read from the document's gold each time the prepared tensors are (not kept
        with them: what the gold says of the trees changes without the inputs changing)."""
        on = lambda a, dtype=torch.long: torch.as_tensor(np.asarray(a), dtype=dtype)
        for name in ("headings", "heading_parent", "heading_sibling", "heading_sibling_from", "heading_gap",
                     "bodies", "body_parent", "body_sibling", "body_sibling_from", "body_gap"):
            setattr(self, name, on(getattr(doc, name)))
        self.partial_bodies = doc.partial_bodies
        self.has = (self.has - {"heading", "body"}) | {name for name, nodes in (("heading", doc.headings), ("body", doc.bodies)) if len(nodes) >= 2}
        firsts = np.asarray(doc.regions, dtype=np.int64)
        sections = np.cumsum((doc.region_role == HEADING) | (doc.start[firsts] == 1 if len(firsts) else 0))
        for name, nodes in (("heading", doc.headings), ("body", doc.bodies)):
            idx = np.asarray(nodes, dtype=np.int64)
            lines = firsts[idx] if len(nodes) else np.zeros(0, dtype=np.int64)
            setattr(self, f"{name}_templates", on(doc.templates[lines]))
            setattr(self, f"{name}_anchors", on(doc.anchors[lines]))
            setattr(self, f"{name}_family", on(doc.marker_family[lines]))
            setattr(self, f"{name}_value", on(doc.marker_value[lines]))
            setattr(self, f"{name}_prefix", on(doc.marker_prefix[lines]))
            setattr(self, f"{name}_section", on(sections[idx] if len(nodes) else np.zeros(0, dtype=np.int64)))
            setattr(self, f"{name}_x0", on(doc.x0[lines], torch.float32))
            setattr(self, f"{name}_size", on(doc.size[lines], torch.float32))
            setattr(self, f"{name}_looks", on(doc.looks[lines]))
            setattr(self, f"{name}_pages", on(doc.pages[lines]))
            setattr(self, f"{name}_roles", on(doc.region_role[idx] if len(nodes) else np.zeros(0, dtype=np.int64)))


def pairs_of(doc):
    """The region pairs the pair term is computed for: every two regions within a page of each other; and whether a
    note's number is a mark the other region sets."""
    m = len(doc.regions)
    by_page = {}
    for i, page in enumerate(doc.region_pages.tolist()):
        by_page.setdefault(page, []).append(i)
    rows, cols = [], []
    for page, members in by_page.items():
        near = np.asarray(sum((by_page.get(page + d, []) for d in (-1, 0, 1)), []), dtype=np.int64)
        rows.append(np.repeat(np.asarray(members, dtype=np.int64), len(near)))
        cols.append(np.tile(near, len(members)))
    # A note's candidates are every region setting its number, however far (endnotes).
    pages = doc.region_pages
    setting = {}
    for b, set_ in enumerate(doc.region_marks):
        for value in set_:
            setting.setdefault(value, []).append(b)
    far = [(a, b) for a in range(m) if doc.region_number[a] >= 0 for b in setting.get(int(doc.region_number[a]), []) if abs(int(pages[a]) - int(pages[b])) > 1]
    if far:
        rows.append(np.asarray([a for a, _ in far], dtype=np.int64))
        cols.append(np.asarray([b for _, b in far], dtype=np.int64))
    i = np.concatenate(rows) if rows else np.zeros(0, dtype=np.int64)
    j = np.concatenate(cols) if cols else np.zeros(0, dtype=np.int64)
    order = np.lexsort((j, i))
    i, j = i[order], j[order]
    number = doc.region_number
    match = np.asarray([a != b and number[a] >= 0 and number[a] in doc.region_marks[b] for a, b in zip(i.tolist(), j.tolist())], dtype=bool) if m else np.zeros(0, dtype=bool)
    return i, j, match


def pair_terms(r):
    """A document's prepared region pairs and their measures, on the device."""
    i, j = r.pair_i, r.pair_j
    return i, j, region_pairs(r.region_boxes, r.region_pages, r.region_role, i, j, r.pair_match)


READY = 11  # the prepared tensors' layout; a change to `Ready`, `Paged` or `Batch` bumps it
TREE_GOLD = 2  # what the trees' gold holds (`Doc`, `Ready.trees`); a change bumps it, the tree fit's kept inputs read again


def prepare(docs, mean, std, embed, folder):
    """Every document's prepared tensors, read from `folder` where kept (by this layout and these feature
    statistics), else built and kept there."""
    key = f"{READY}-{zlib.crc32(np.asarray(mean, np.float64).tobytes() + np.asarray(std, np.float64).tobytes()):08x}"
    os.makedirs(folder, exist_ok=True)
    built = 0
    for doc in docs:
        path = os.path.join(folder, f"{doc.sha}.{key}.pt")
        if os.path.exists(path):
            doc.ready = torch.load(path, weights_only=False)
            doc.ready.trees(doc)
        else:
            doc.ready = Ready(doc, mean, std, embed)
            torch.save(doc.ready, path)
            built += 1
        # The raw features and texts are in the prepared tensors now; host memory holds each document once.
        doc.features = doc.texts = None
    return built


def on_device(doc):
    """A document's prepared tensors on the device: those `resident` there already, else a copy for this step."""
    return doc.ready if doc.ready.f.device.type == DEVICE else moved(doc.ready, DEVICE)


RESIDENT = float(os.environ.get("DOCPARSE_RESIDENT_GIB", "1.5"))  # the device memory the prepared tensors may hold


def resident(docs):
    """The documents' prepared tensors moved to the device once (no copies a step; host memory freed) while they take
    no more than `RESIDENT` GiB of it, the step's own peak beside them; the rest copied there a step at a time
    (`on_device`). The device memory they take."""
    before = torch.cuda.memory_allocated() if DEVICE == "cuda" else 0
    for doc in docs:
        if DEVICE != "cuda":
            break
        est = sum(v.numel() * v.element_size() for v in vars(doc.ready).values() if torch.is_tensor(v))
        if torch.cuda.memory_allocated() - before + est > RESIDENT * 2**30:
            continue
        doc.ready = moved(doc.ready, DEVICE)
    return (torch.cuda.memory_allocated() - before) if DEVICE == "cuda" else 0


def page_links(heads, states, boxes, paged, succ_gold, pred_gold):
    """Both line-link heads read page by page in one batched pass (spatial compatibility measures computed once per page
    batch): each batch's successor and predecessor logits and local gold targets."""
    succ_out, pred_out = [], []
    for batch in paged.batches:
        r = batch.rows.clamp(min=0)
        x = states[r]
        measures = spatial(boxes[r], boxes[r]).reshape(-1, 18)[batch.keep]
        for head, g, out in ((heads[0], succ_gold, succ_out), (heads[1], pred_gold, pred_out)):
            if g is None:
                continue
            f = head.q(x) @ head.k(x).transpose(-1, -2) / x.shape[-1] ** 0.5
            f = f.reshape(-1).index_add(0, batch.keep, head.r(measures).squeeze(-1).to(f.dtype)).view_as(f)
            f = f.float().masked_fill(~batch.valid[:, None, :], -1e4)
            local = torch.where(g[r] >= 0, g[r] - batch.starts[:, None], -100)
            out.append((f.reshape(-1, f.shape[-1])[batch.valid_at], local.reshape(-1)[batch.valid_at]))
    return succ_out, pred_out


def link_loss(links, count):
    return sum(F.cross_entropy(f, g, ignore_index=-100, reduction="sum") for f, g in links) / count


def two_way(flag, gold):
    return F.cross_entropy(torch.stack([torch.zeros_like(flag), flag], dim=1), gold, ignore_index=-100)


def role_loss(role, gold, free):
    """Each line's role against its gold; a line `free` against any of `UNMARKED`, opening or not as the gold says, leaning to text:
    with nothing holding it to text a plain paragraph drifts to a list item."""
    log = F.log_softmax(role, dim=1)
    known = gold != -100
    named = known & ~free
    held = log[named, gold[named]]
    opens = gold[free] % 2
    allowed = torch.stack([log[free, region * 2 + opens] for region in UNMARKED], dim=1)
    return -(held.sum() + torch.logsumexp(allowed, dim=1).sum() + TEXT_PULL * allowed[:, 0].sum()) / known.sum().clamp(min=1)


def enclosing(nodes, headings, starts):
    """For each node in `nodes`, the place in `headings` of the latest heading region strictly before it in the same
    constituent document (`starts`), or -1 where none precedes it."""
    if headings.numel() == 0 or nodes.numel() == 0:
        return torch.full_like(nodes, -1)
    pos = torch.searchsorted(headings, nodes, right=False) - 1
    valid = (pos >= 0) & (starts[headings[pos.clamp(min=0)]] == starts[nodes])
    return torch.where(valid, pos, -1)


def enclosing_states(heading_states, at):
    """Each node's enclosing heading's state (`enclosing`'s places into the heading nodes' states), nought where none."""
    if heading_states.shape[0] == 0:
        return torch.zeros(at.shape[0], heading_states.shape[1], dtype=heading_states.dtype, device=heading_states.device)
    return torch.where((at >= 0)[:, None], heading_states[at.clamp(min=0)], torch.zeros_like(heading_states[:1]))


TREE_INPUTS = ("templates", "anchors", "family", "value", "prefix", "section", "x0", "size", "looks", "pages", "roles")


def tree_inputs(r, name):
    """A tree's nodes' inputs beside their states, in Construct's order."""
    return tuple(getattr(r, f"{name}_{field}") for field in TREE_INPUTS)


def region_docs(r, regions):
    """Each region's constituent document: the count of starts up to its first line."""
    doc_starts = torch.cumsum((r.start == 1).long(), dim=0)[r.region_lines]
    reg_doc = torch.zeros(regions.shape[0], device=regions.device, dtype=torch.long)
    if r.line_region.numel() > 0:
        reg_doc.scatter_reduce_(0, r.line_region, doc_starts, reduce="amin", include_self=False)
    return reg_doc


def tree_losses(name, p, s, g, parent, sibling, sibling_from, gap):
    """A tree's losses over the nodes its gold answers (-100 none): each node's parent, its gap, and its left sibling, one
    of the nodes from `sibling_from` to `sibling` (the one where they are the same)."""
    parts = {}
    if (parent != -100).any():
        parts[f"{name}_parent"] = F.cross_entropy(earlier(p.float()), parent)
    if (gap != -100).any():
        parts[f"{name}_gap"] = F.cross_entropy(g.float(), gap, label_smoothing=0.01)
    known = sibling != -100
    if known.any():
        log = F.log_softmax(earlier(s.float()), dim=1)[known]
        cols = torch.arange(log.shape[1], device=log.device)[None, :]
        among = (cols >= sibling_from[known, None]) & (cols <= sibling[known, None])
        parts[f"{name}_sibling"] = -torch.logsumexp(log.masked_fill(~among, float("-inf")), dim=1).mean()
    return parts


def losses(model, doc):
    r = on_device(doc)
    parts = {}
    with torch.autocast("cuda", dtype=torch.bfloat16, enabled=DEVICE == "cuda"):
        states = model.templates(model.detect(r.f, r.t, r.b, r.anchors, r.z, r.lines), r.templates, r.template_rows)
        role, flags = model.detect.role(states).float(), model.detect.flags(states).float()
        if "role" in r.has:
            parts["role"] = role_loss(role, r.role, r.free)
        if "successor" in r.has or "predecessor" in r.has:
            succ_links, pred_links = page_links(
                (model.detect.successor, model.detect.predecessor), states, r.b, r.lines,
                r.successor if "successor" in r.has else None,
                r.predecessor if "predecessor" in r.has else None,
            )
            if "successor" in r.has:
                parts["successor"] = link_loss(succ_links, r.counts["successor"])
            if "predecessor" in r.has:
                parts["predecessor"] = link_loss(pred_links, r.counts["predecessor"])
        if "marked" in r.has:
            parts["marked"] = two_way(flags[:, 0], r.marked)
        if "start" in r.has:
            parts["start"] = two_way(flags[:, 1], r.start)
        if "regions" in r.has:
            regions = model.order(states, r.region_lines, r.line_region, r.region_role)
            pairs = pair_terms(r)
            if "goes_on" in r.has:
                parts["goes_on"] = row_loss(model.order.goes_on(regions, pairs), pairs[0], regions.shape[0], r.goes_on_pair)
            if "note_of" in r.has:
                parts["note_of"] = row_loss(model.order.note_of(regions, pairs), pairs[0], regions.shape[0], r.note_of_pair)
            if "order" in r.has:
                parts["order"] = row_loss(model.order.successor(regions, pairs), pairs[0], regions.shape[0], r.order_pair)
            reg_doc = region_docs(r, regions)
            for name, nodes, parent, sibling, gap, construct in (("heading", r.headings, r.heading_parent, r.heading_sibling, r.heading_gap, model.headings),
                                                                 ("body", r.bodies, r.body_parent, r.body_sibling, r.body_gap, model.bodies)):
                if name in r.has:
                    enc = enclosing_states(regions[r.headings], enclosing(nodes, r.headings, reg_doc))
                    p, s, g = construct(regions[nodes], enc, *tree_inputs(r, name))
                    parts.update(tree_losses(name, p, s, g, parent, sibling, getattr(r, f"{name}_sibling_from"), gap))
    return sum(parts.values()), parts


class Tally:
    """Heads' accuracies summed over documents; with `links`, also on the nodes whose gold points past themselves
    (`<name>_links`)."""

    def __init__(self):
        self.right, self.total = {}, {}

    def count(self, name, guess, gold, links=False):
        gold = np.asarray(gold)
        keep = gold != -100
        self.add(name, int((guess[keep] == gold[keep]).sum()), int(keep.sum()))
        if links:
            real = keep & (gold != np.arange(len(gold)))
            self.add(f"{name}_links", int((guess[real] == gold[real]).sum()), int(real.sum()))

    def add(self, name, right, total):
        self.right[name] = self.right.get(name, 0) + right
        self.total[name] = self.total.get(name, 0) + total

    def report(self):
        return {k: (self.right.get(k, 0) / max(t, 1), t) for k, t in self.total.items()}


def count_tree(tally, name, p, s, g, parent, sibling, sibling_from, gap):
    """A tree's heads' accuracies; a left sibling read right where it is one of the nodes its gold allows."""
    tally.count(f"{name}_parent", earlier(p).argmax(1).cpu().numpy(), np.asarray(parent), links=True)
    tally.count(f"{name}_gap", g.argmax(1).cpu().numpy(), np.asarray(gap))
    guess, hi, lo = earlier(s).argmax(1).cpu().numpy(), np.asarray(sibling), np.asarray(sibling_from)
    keep = hi != -100
    right = keep & (guess >= lo) & (guess <= hi)
    tally.add(f"{name}_sibling", int(right.sum()), int(keep.sum()))
    real = keep & (lo != np.arange(len(hi)))
    tally.add(f"{name}_sibling_links", int((right & real).sum()), int(real.sum()))


def evaluate(model, docs):
    """Each head's accuracy on development's documents, the gold's regions and roles given to the later stages; and
    the heading openings' F1."""
    model.eval()
    tally = Tally()
    count = tally.count
    tp = gold_headings = guessed_headings = 0
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=DEVICE == "cuda"):
        for doc in docs:
            r = on_device(doc)
            states = model.templates(model.detect(r.f, r.t, r.b, r.anchors, r.z, r.lines), r.templates, r.template_rows)
            role, flags = model.detect.role(states).float(), model.detect.flags(states).float()
            guess = role.argmax(1).cpu().numpy()
            count("role", guess, np.where(doc.free, -100, doc.role))
            for batch, (logits, gold) in zip(r.lines.batches, page_links((model.detect.successor, model.detect.predecessor), states, r.b, r.lines, r.successor, None)[0]):
                # a line's own place on its page: its index in the batch's flattened rows, modulo the row's width
                own = (batch.valid_at % batch.rows.shape[1]).cpu().numpy()
                g, linked = gold.cpu().numpy(), logits.argmax(1).cpu().numpy()
                keep = g != -100
                tally.add("successor", int((linked[keep] == g[keep]).sum()), int(keep.sum()))
                real = keep & (g != own)
                tally.add("successor_links", int((linked[real] == g[real]).sum()), int(real.sum()))
            count("marked", (flags[:, 0] > 0).long().cpu().numpy(), doc.marked)
            heading_open, guessed = doc.role == HEADING * 2 + 1, guess == HEADING * 2 + 1
            tp += int((guessed & heading_open).sum())
            gold_headings += int(heading_open.sum())
            guessed_headings += int((guessed & (doc.role != -100)).sum())
            if "regions" not in r.has:
                continue
            regions = model.order(states, r.region_lines, r.line_region, r.region_role)
            pairs = pair_terms(r)
            m = regions.shape[0]
            choose = lambda head: row_choice(head(regions, pairs), pairs[0], pairs[1], m)
            count("goes_on", choose(model.order.goes_on), doc.goes_on, links=True)
            count("note_of", choose(model.order.note_of), doc.note_of, links=True)
            count("order", choose(model.order.successor), doc.region_order, links=True)
            reg_doc = region_docs(r, regions)
            for name, nodes, construct in (("heading", r.headings, model.headings), ("body", r.bodies, model.bodies)):
                if name in r.has:
                    enc = enclosing_states(regions[r.headings], enclosing(nodes, r.headings, reg_doc))
                    count_tree(tally, name, *construct(regions[nodes], enc, *tree_inputs(r, name)),
                               *(getattr(doc, f"{name}_{part}") for part in ("parent", "sibling", "sibling_from", "gap")))
    model.train()
    out = tally.report()
    out["heading_openings_f1"] = (2 * tp / max(gold_headings + guessed_headings, 1), gold_headings)
    return out


def preflight(model, docs, limit=0.85):
    """A full step (forward and backward, no update) on the heaviest documents by lines, regions, page pairs and body
    units, each one's peak device memory and time; the fit stops before its first epoch if any comes within `limit` of
    the device's memory."""
    if DEVICE != "cuda":
        return
    weight = {"lines": lambda d: d.n, "regions": lambda d: len(d.regions), "bodies": lambda d: len(d.bodies),
              "pairs": lambda d: int(sum(int(b.keep.numel()) for b in d.ready.lines.batches))}
    heavy = []
    for measure in weight.values():
        heavy += [d for d in sorted(docs, key=measure, reverse=True)[:3] if d not in heavy]
    capacity = torch.cuda.get_device_properties(0).total_memory
    worst = 0.0
    for doc in heavy:
        torch.cuda.reset_peak_memory_stats()
        started = time.time()
        loss, _ = losses(model, doc)
        loss.backward()
        model.zero_grad(set_to_none=True)
        torch.cuda.synchronize()
        peak = torch.cuda.max_memory_allocated() / capacity
        worst = max(worst, peak)
        print(f"  preflight {doc.sha[:12]}: {doc.n} lines, {len(doc.regions)} regions, peak {peak:.0%} of the device, {time.time() - started:.2f}s", flush=True)
    if worst > limit:
        raise SystemExit(f"preflight: a step takes {worst:.0%} of the device's memory, over {limit:.0%}")


def load(folder, store, splits=None):
    """The dump's documents (only those of `splits` where given), each with its partition."""
    docs = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".json") or name.endswith(".labels.json"):
            continue
        split = partition(store, name[:-len(".json")])
        if splits is not None and split not in splits:
            continue
        meta = json.load(open(os.path.join(folder, name), encoding="utf-8"))
        if "pages" not in meta or not meta.get("lines"):
            continue
        x = np.fromfile(os.path.join(folder, f"{meta['sha256']}.lines.f32"), dtype="<f4").reshape(meta["lines"], meta["line_width"])
        doc = Doc(meta, x)
        doc.split = split
        docs.append(doc)
    return docs


def prepared(dump, store, text, mean=None, std=None, splits=None):
    """Train's and development's documents (only `splits`' where given) with their prepared tensors, and the features'
    statistics (train's, unless given: a fitted checkpoint's)."""
    docs = load(dump, store, splits)
    # Every line's text embedded once: the documents' distinct texts in one call (the tokenizer in parallel), each
    # document's kept beside its dump for the next fit.
    tag = text.replace("/", "_")
    cache, missing = {}, []
    for doc in docs:
        path = os.path.join(dump, f"{doc.sha}.{tag}.npy")
        if os.path.exists(path):
            cache[doc.sha] = np.load(path)
        else:
            missing.append(doc)
    if missing:
        from model2vec import StaticModel
        text_model = StaticModel.from_pretrained(text)
        texts = sorted({t if t.strip() else " " for doc in missing for t in doc.texts})
        at = {t: i for i, t in enumerate(texts)}
        vectors = np.asarray(text_model.encode(texts, use_multiprocessing=True, show_progress_bar=False), dtype=np.float32)
        for doc in missing:
            cache[doc.sha] = vectors[[at[t if t.strip() else " "] for t in doc.texts]]
            np.save(os.path.join(dump, f"{doc.sha}.{tag}.npy"), cache[doc.sha])
        print(f"{len(texts)} distinct line texts embedded for {len(missing)} documents", flush=True)

    def embed(doc):
        return cache[doc.sha]

    train_docs = [d for d in docs if d.split == "train"]
    dev_docs = [d for d in docs if d.split == "development"]
    print(f"{len(train_docs)} train documents, {len(dev_docs)} development; text {text}", flush=True)
    if mean is None:
        # The features' means and spreads over train's lines, summed a document at a time.
        total = sum(d.features.astype(np.float64).sum(0) for d in train_docs)
        squares = sum((d.features.astype(np.float64) ** 2).sum(0) for d in train_docs)
        count = sum(d.n for d in train_docs)
        mean = total / count
        std = np.sqrt(np.maximum(squares / count - mean ** 2, 0)) + 1e-6
    started = time.time()
    built = prepare(train_docs + dev_docs, mean, std, embed, os.path.join(dump, "ready"))
    cache.clear()  # the embeddings are in the prepared tensors
    print(f"prepared tensors: {built} built, {len(train_docs) + len(dev_docs) - built} read, {time.time() - started:.0f}s", flush=True)
    return train_docs, dev_docs, mean, std


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["fit"])
    parser.add_argument("dump")
    parser.add_argument("store")
    parser.add_argument("out")
    parser.add_argument("--text", default="minishlab/potion-multilingual-128M")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--width", type=int, default=256)
    # A fitted checkpoint to start from (its weights where their shapes match, its feature statistics), at a tenth of the
    # learning rate and a short warm-up: a gold or label change refits in a few epochs, not twenty from nothing.
    parser.add_argument("--init")
    parser.add_argument("--lr", type=float, default=None)
    args = parser.parse_args()
    start = torch.load(args.init, map_location="cpu", weights_only=False) if args.init else None
    train_docs, dev_docs, mean, std = prepared(args.dump, args.store, start["text"] if start else args.text,
                                               start["mean"] if start else None, start["std"] if start else None)
    held = resident(train_docs + dev_docs)
    # The prepared documents never go away: the collector leaves them out of its passes over the steps' objects.
    gc.collect()
    gc.freeze()
    print(f"prepared tensors on the device: {held / 2**30:.2f} GiB", flush=True)
    row_width = max(d.template_rows.shape[1] for d in train_docs)
    model = DocParser(train_docs[0].ready.f.shape[1], train_docs[0].ready.t.shape[1], args.width, row_width).to(DEVICE)
    if start:
        own = model.state_dict()
        kept = {k: v for k, v in start["model"].items() if k in own and own[k].shape == v.shape}
        model.load_state_dict(kept, strict=False)
        fresh = [k for k in own if k not in kept]
        groups = sorted({".".join(k.split(".")[:2]) for k in fresh})
        print(f"started from {args.init}: {len(kept)} tensors kept, {len(fresh)} new: {groups[:12]}", flush=True)
    preflight(model, train_docs)
    # Development read once before training, so a fault in the evaluation shows before an epoch is spent.
    started = time.time()
    print(f"  preflight development: {len(evaluate(model, dev_docs))} heads read, {time.time() - started:.0f}s", flush=True)
    # The paper's schedule: AdamW, a linear warm-up over two epochs, then a linear fall to nothing; one document a step.
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr or (2e-5 if start else 2e-4), weight_decay=1e-2, fused=DEVICE == "cuda")
    steps = args.epochs * len(train_docs)
    warm = (len(train_docs) // 5) if start else 2 * len(train_docs)
    schedule = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda s: min((s + 1) / warm, max(0.0, (steps - s) / max(steps - warm, 1))))
    rng = np.random.default_rng(7)
    os.makedirs(args.out, exist_ok=True)
    started, best, since = time.time(), -1.0, 0
    for epoch in range(args.epochs):
        totals = {}
        for i in rng.permutation(len(train_docs)):
            loss, parts = losses(model, train_docs[i])
            if not torch.is_tensor(loss):
                continue
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            schedule.step()
            for name, v in parts.items():
                totals[name] = totals.get(name, 0.0) + v.detach()
        print(f"epoch {epoch + 1} ({time.time() - started:.0f}s): " + " ".join(f"{n} {float(v) / len(train_docs):.3f}" for n, v in sorted(totals.items())), flush=True)
        # Development every fifth epoch and after each of the last five, where the best has always stood; the checkpoint
        # kept is the best by its heads' mean accuracy.
        if not start and (epoch + 1) % 5 and epoch + 1 <= args.epochs - 5:
            continue
        report = evaluate(model, dev_docs)
        # Heads with no development examples (a count of nought) are left out of the mean.
        score = float(np.mean([a for a, c in report.values() if c]))
        print(f"  development {score:.4f}: " + " ".join(f"{n} {a:.4f} ({c})" for n, (a, c) in sorted(report.items())), flush=True)
        if score > best:
            best, since = score, 0
            torch.save({"model": model.state_dict(), "mean": mean, "std": std, "text": start["text"] if start else args.text, "width": args.width, "row_width": row_width, "epoch": epoch + 1}, os.path.join(args.out, "docparser.pt"))
        else:
            since += 1
            if since == 3:
                print(f"  no gain in three epochs; best {best:.4f}", flush=True)
                break
    open(os.path.join(args.out, "fit.done"), "w").write("done\n")


def upstream_model(checkpoint):
    """A checkpoint and the model holding its earlier stages (Detect, the stylesheet, Order); its trees as this code
    builds them, unfitted."""
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    upstream = {k: v for k, v in saved["model"].items() if not k.startswith(("headings.", "bodies."))}
    width, d = upstream["detect.look.0.weight"].shape[1], saved["width"]
    text_dim = upstream["detect.text.0.weight"].shape[1]
    model = DocParser(width, text_dim, d, saved.get("row_width", 0)).to(DEVICE)
    missing, unexpected = model.load_state_dict(upstream, strict=False)
    if unexpected or any(not k.startswith(("headings.", "bodies.")) for k in missing):
        raise SystemExit(f"the checkpoint's earlier stages do not fit this code: missing {missing[:5]}, unexpected {unexpected[:5]}")
    return saved, model


def roles(argv):
    """python docparse.py roles CHECKPOINT DUMP STORE OUT_JSON: Detect's line roles on development's documents against
    the gold's, every document's counts of (gold region, read region) and of openings read right, and the free lines'
    (the gold says only one of `UNMARKED`) read regions; with its source.json's genre, yardstick and label source."""
    checkpoint, dump, store, out = argv
    saved, model = upstream_model(checkpoint)
    _, dev_docs, _, _ = prepared(dump, store, saved["text"], saved["mean"], saved["std"], splits={"development"})
    model.eval()
    rows = []
    with torch.no_grad(), torch.autocast(DEVICE, dtype=torch.bfloat16):
        for doc in dev_docs:
            r = on_device(doc)
            states = model.templates(model.detect(r.f, r.t, r.b, r.anchors, r.z, r.lines), r.templates, r.template_rows)
            guess = model.detect.role(states).float().argmax(1).cpu().numpy()
            gold = np.asarray(doc.role)
            named = (gold != -100) & ~doc.free
            pairs, free = {}, {}
            for g, p in zip(gold[named] // 2, guess[named] // 2):
                key = f"{REGIONS[g]}>{REGIONS[p]}"
                pairs[key] = pairs.get(key, 0) + 1
            for p in guess[doc.free] // 2:
                free[REGIONS[p]] = free.get(REGIONS[p], 0) + 1
            try:
                source = json.load(open(os.path.join(store, doc.sha, "source.json"), encoding="utf-8"))
            except (OSError, ValueError):
                source = {}
            rows.append({"sha": doc.sha, "lines": int(named.sum()), "pairs": pairs, "free": free,
                         "openings_right": int(((gold[named] % 2) == (guess[named] % 2)).sum()),
                         **{k: source.get(k) for k in ("genre_group", "yardstick", "label_source", "language_layout")}})
            doc.ready = None
    json.dump(rows, open(out, "w", encoding="utf-8"))
    print(f"roles of {len(rows)} development documents -> {out}", flush=True)


def trees(argv):
    """python docparse.py trees CHECKPOINT DUMP STORE OUT [--epochs N]: the two trees alone fitted, from nothing, on
    CHECKPOINT's earlier stages held fixed. Those stages read every document once, over the gold's regions as the full
    fit gives them, and what the trees take (their nodes' region states, enclosing headings, inputs and gold) is kept in
    DUMP (trees-<the checkpoint's crc>.pt) for the next tree fit to read in seconds. The best epoch by development's tree
    heads is written to OUT as a whole checkpoint (the earlier stages CHECKPOINT's) for export."""
    parser = argparse.ArgumentParser(prog="docparse.py trees")
    for name in ("checkpoint", "dump", "store", "out"):
        parser.add_argument(name)
    parser.add_argument("--epochs", type=int, default=30)
    args = parser.parse_args(argv)
    saved, model = upstream_model(args.checkpoint)
    crc = zlib.crc32(open(args.checkpoint, "rb").read())
    path = os.path.join(args.dump, f"trees-{READY}-{TREE_GOLD}-{crc:08x}.pt")
    started = time.time()
    if os.path.exists(path):
        kept = torch.load(path, weights_only=False)
    else:
        train_docs, dev_docs, _, _ = prepared(args.dump, args.store, saved["text"], saved["mean"], saved["std"])
        model.eval()
        kept = []
        with torch.no_grad(), torch.autocast(DEVICE, dtype=torch.bfloat16):
            for doc in train_docs + dev_docs:
                r = on_device(doc)
                if "regions" not in r.has:
                    continue
                states = model.templates(model.detect(r.f, r.t, r.b, r.anchors, r.z, r.lines), r.templates, r.template_rows)
                regions = model.order(states, r.region_lines, r.line_region, r.region_role)
                reg_doc = region_docs(r, regions)
                entry = {"split": doc.split, "partial": doc.partial_bodies, "trees": {}}
                for name, nodes in (("heading", r.headings), ("body", r.bodies)):
                    if name not in r.has:
                        continue
                    entry["trees"][name] = {
                        "states": regions[nodes].to(torch.bfloat16).cpu(),
                        "enclosing": enclosing(nodes, r.headings, reg_doc).cpu(),
                        "inputs": tuple(t.cpu() for t in tree_inputs(r, name)),
                        "gold": tuple(getattr(r, f"{name}_{part}").cpu() for part in ("parent", "sibling", "sibling_from", "gap")),
                    }
                if entry["trees"]:
                    entry["heading_states"] = regions[r.headings].to(torch.bfloat16).cpu()
                    kept.append(entry)
                doc.ready = None
        torch.save(kept, path)
    train = [e for e in kept if e["split"] == "train"]
    dev = [e for e in kept if e["split"] == "development"]
    for e in kept:
        e["heading_states"] = e["heading_states"].to(DEVICE)
        for tree in e["trees"].values():
            for key in ("states", "enclosing"):
                tree[key] = tree[key].to(DEVICE)
            tree["inputs"] = tuple(t.to(DEVICE) for t in tree["inputs"])
            tree["gold"] = tuple(t.to(DEVICE) for t in tree["gold"])
    print(f"tree inputs of {len(train)} train and {len(dev)} development documents, {time.time() - started:.0f}s", flush=True)
    constructs = {"heading": model.headings, "body": model.bodies}

    def run(e, name):
        tree = e["trees"][name]
        enc = enclosing_states(e["heading_states"], tree["enclosing"])
        return constructs[name](tree["states"], enc, *tree["inputs"])

    def score():
        """Development's tree heads on the golds that give whole trees; the partial golds' apart (`partial_`), out of the mean."""
        model.eval()
        whole, partial = Tally(), Tally()
        with torch.no_grad(), torch.autocast(DEVICE, dtype=torch.bfloat16):
            for e in dev:
                for name in e["trees"]:
                    p, s, g = run(e, name)
                    count_tree(partial if e["partial"] else whole, name, p.float(), s.float(), g.float(),
                               *(t.cpu().numpy() for t in e["trees"][name]["gold"]))
        model.train()
        return whole.report(), {f"partial_{k}": v for k, v in partial.report().items()}

    parameters = list(model.headings.parameters()) + list(model.bodies.parameters())
    optimizer = torch.optim.AdamW(parameters, lr=2e-4, weight_decay=1e-2, fused=DEVICE == "cuda")
    steps, warm = args.epochs * len(train), len(train)
    schedule = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda s: min((s + 1) / warm, max(0.0, (steps - s) / max(steps - warm, 1))))
    rng = np.random.default_rng(7)
    os.makedirs(args.out, exist_ok=True)
    model.train()
    started, best, since = time.time(), -1.0, 0
    for epoch in range(args.epochs):
        totals = {}
        for i in rng.permutation(len(train)):
            e = train[i]
            parts = {}
            with torch.autocast(DEVICE, dtype=torch.bfloat16):
                for name in e["trees"]:
                    parts.update(tree_losses(name, *run(e, name), *e["trees"][name]["gold"]))
            if not parts:
                continue
            optimizer.zero_grad()
            sum(parts.values()).backward()
            torch.nn.utils.clip_grad_norm_(parameters, 1.0)
            optimizer.step()
            schedule.step()
            for name, v in parts.items():
                totals[name] = totals.get(name, 0.0) + v.detach()
        report, partial = score()
        mean_accuracy = float(np.mean([a for a, c in report.values() if c]))
        print(f"epoch {epoch + 1} ({time.time() - started:.0f}s): " + " ".join(f"{n} {float(v) / len(train):.3f}" for n, v in sorted(totals.items())), flush=True)
        print(f"  development {mean_accuracy:.4f}: " + " ".join(f"{n} {a:.4f} ({c})" for n, (a, c) in sorted({**report, **partial}.items())), flush=True)
        if mean_accuracy > best:
            best, since = mean_accuracy, 0
            state = {**saved["model"], **{k: v.detach().cpu() for k, v in model.state_dict().items() if k.startswith(("headings.", "bodies."))}}
            state = {k: v for k, v in state.items() if k in model.state_dict()}
            torch.save({**{k: v for k, v in saved.items() if k != "model"}, "model": state, "epoch": epoch + 1}, os.path.join(args.out, "docparser.pt"))
        else:
            since += 1
            if since == 3:
                print(f"  no gain in three epochs; best {best:.4f}", flush=True)
                break
    open(os.path.join(args.out, "fit.done"), "w").write("done\n")


class DetectPage(nn.Module):
    """Detect's encoder over one page's lines as the engine runs it (the training batches' padding and flat indexes
    left out; the same function on a page's real lines)."""

    def __init__(self, detect):
        super().__init__()
        self.detect = detect

    def forward(self, features, text, boxes, anchors, t0):
        x = self.detect.embed(features, text, boxes, anchors, t0)
        for layer in self.detect.encoder:
            x = layer(x)
        return x


class StylesheetDocument(nn.Module):
    """The templates over a document's lines: every line's state given its template's."""

    def __init__(self, templates):
        super().__init__()
        self.templates = templates

    def forward(self, states, templates, rows):
        return self.templates(states, templates, rows)


class LinesPage(nn.Module):
    """Detect's heads over one page's lines, their states the stylesheet's: each line's successor and predecessor
    among the page's lines, its role and its two flags."""

    def __init__(self, detect):
        super().__init__()
        self.detect = detect

    def forward(self, states, boxes):
        d = self.detect
        links = []
        for head in (d.successor, d.predecessor):
            f = head.q(states) @ head.k(states).t() / states.shape[-1] ** 0.5
            links.append(f + head.r(spatial(boxes, boxes)).squeeze(-1))
        return links[0], links[1], d.role(states), d.flags(states)


class OrderDocument(nn.Module):
    """Order over a document's regions: the lines in regions and each one's region, the regions' roles -> the
    regions' states and their two links."""

    def __init__(self, order):
        super().__init__()
        self.order = order

    def forward(self, line_states, line_region, region_roles, region_valid, region_boxes, region_pages, pair_i, pair_j, pair_match):
        regions = self.order(line_states, None, line_region, region_roles, region_valid)
        pairs = (pair_i, pair_j, region_pairs(region_boxes, region_pages, region_roles, pair_i, pair_j, pair_match))
        return (regions, *self.order.goes_on.parts(regions, pairs), *self.order.note_of.parts(regions, pairs),
                *self.order.successor.parts(regions, pairs))


def export(argv):
    """python docparse.py export CHECKPOINT OUT_DIR: the fitted stages as ONNX graphs the engine runs (detect.onnx a
    page at a time, order.onnx a document, headings.onnx and bodies.onnx a tree's nodes), docparse.json (the feature
    statistics, the sizes, the regions and the text model's settings), and the text model itself: its tokenizer
    (tokenizer.json) and token vectors (embeddings.f32, little-endian rows), with parity.json, texts and the vectors
    Python gives them, for the engine's reading to be checked against."""
    checkpoint, out = argv
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    state = saved["model"]
    width, d = state["detect.look.0.weight"].shape[1], saved["width"]
    text_dim = state["detect.text.0.weight"].shape[1]
    model = DocParser(width, text_dim, d, saved.get("row_width", 0))
    model.load_state_dict(state)
    model.eval()
    os.makedirs(out, exist_ok=True)
    n, m, k = 12, 5, 9
    with torch.no_grad():
        torch.onnx.export(DetectPage(model.detect), (torch.randn(n, width), torch.randn(n, text_dim), torch.rand(n, 4), torch.randint(0, ANCHORS, (n,)), torch.rand(n, T0)),
                          os.path.join(out, "detect.onnx"), input_names=["features", "text", "boxes", "anchors", "t0"], output_names=["states"],
                          dynamic_axes={"features": {0: "lines"}, "text": {0: "lines"}, "boxes": {0: "lines"}, "anchors": {0: "lines"}, "t0": {0: "lines"},
                                        "states": {0: "lines"}}, opset_version=18, dynamo=False)
        templates = 4
        torch.onnx.export(StylesheetDocument(model.templates), (torch.randn(n, d), torch.randint(0, templates, (n,)), torch.randn(templates, model.templates.row_width)),
                          os.path.join(out, "stylesheet.onnx"), input_names=["states", "templates", "rows"], output_names=["styled"],
                          dynamic_axes={"states": {0: "lines"}, "templates": {0: "lines"}, "rows": {0: "templates"}, "styled": {0: "lines"}},
                          opset_version=18, dynamo=False)
        torch.onnx.export(LinesPage(model.detect), (torch.randn(n, d), torch.rand(n, 4)),
                          os.path.join(out, "lines.onnx"), input_names=["states", "boxes"], output_names=["successor", "predecessor", "role", "flags"],
                          dynamic_axes={"states": {0: "lines"}, "boxes": {0: "lines"}, "successor": {0: "lines", 1: "lines"},
                                        "predecessor": {0: "lines", 1: "lines"}, "role": {0: "lines"}, "flags": {0: "lines"}},
                          opset_version=18, dynamo=False)
        pairs = 7
        m = 2 * BLOCK  # the engine pads the regions to whole blocks
        boxes = torch.rand(m, 4)
        boxes[:, 2:] = boxes[:, :2] + 0.1
        valid = torch.arange(m) < m - 5
        torch.onnx.export(OrderDocument(model.order), (torch.randn(k, d), torch.randint(0, m - 5, (k,)), torch.randint(0, 17, (m,)), valid, boxes,
                                                       torch.randint(0, 3, (m,)), torch.randint(0, m, (pairs,)), torch.randint(0, m, (pairs,)),
                                                       torch.zeros(pairs, dtype=torch.bool)),
                          os.path.join(out, "order.onnx"),
                          input_names=["line_states", "line_region", "region_roles", "region_valid", "region_boxes", "region_pages", "pair_i", "pair_j", "pair_match"],
                          output_names=["regions"] + [f"{head}_{part}" for head in ("goes_on", "note_of", "successor") for part in ("q", "k", "r")],
                          dynamic_axes={"line_states": {0: "lines"}, "line_region": {0: "lines"}, "region_roles": {0: "regions"},
                                        "region_valid": {0: "regions"}, "region_boxes": {0: "regions"}, "region_pages": {0: "regions"}, "pair_i": {0: "pairs"},
                                        "pair_j": {0: "pairs"}, "pair_match": {0: "pairs"}, "regions": {0: "regions"},
                                        **{f"{head}_{part}": {0: "pairs" if part == "r" else "regions"} for head in ("goes_on", "note_of", "successor") for part in ("q", "k", "r")}},
                          opset_version=18, dynamo=False)
        for name, construct in (("headings", model.headings), ("bodies", model.bodies)):
            torch.onnx.export(construct, (torch.randn(m, d), torch.randn(m, d), torch.randint(0, 3, (m,)), torch.randint(0, ANCHORS, (m,)),
                                          torch.randint(0, 10, (m,)), torch.randint(-1, 5, (m,)), torch.randint(0, 3, (m,)),
                                          torch.randint(0, 4, (m,)), torch.rand(m), torch.randn(m),
                                          torch.randint(0, 10, (m,)), torch.randint(0, 5, (m,)), torch.randint(1, 17, (m,))),
                              os.path.join(out, f"{name}.onnx"),
                              input_names=["states", "heading_states", "templates", "anchors", "family", "value", "prefix", "section", "x0", "size", "looks", "pages", "roles"],
                              output_names=["parent", "sibling", "gap"],
                              dynamic_axes={"states": {0: "nodes"}, "heading_states": {0: "nodes"}, "templates": {0: "nodes"}, "anchors": {0: "nodes"},
                                            "family": {0: "nodes"}, "value": {0: "nodes"}, "prefix": {0: "nodes"},
                                            "section": {0: "nodes"}, "x0": {0: "nodes"}, "size": {0: "nodes"},
                                            "looks": {0: "nodes"}, "pages": {0: "nodes"}, "roles": {0: "nodes"},
                                            "parent": {0: "nodes", 1: "nodes"}, "sibling": {0: "nodes", 1: "nodes"}, "gap": {0: "nodes"}},
                              opset_version=18, dynamo=False)
    from model2vec import StaticModel
    text_model = StaticModel.from_pretrained(saved["text"])
    open(os.path.join(out, "tokenizer.json"), "w", encoding="utf-8").write(text_model.tokenizer.to_str())
    np.ascontiguousarray(text_model.embedding, dtype="<f4").tofile(os.path.join(out, "embeddings.f32"))
    samples = ["12. The appellant appeals.", "(a) a person who", "PART II — GENERAL", "Ibid. at para 4.", "Le tribunal a jugé que", " ", "R v Smith, 2019 SCC 12"]
    json.dump({"texts": samples, "vectors": np.asarray(text_model.encode(samples), dtype=np.float32).round(6).tolist()},
              open(os.path.join(out, "parity.json"), "w", encoding="utf-8"))
    json.dump({"width": int(width), "text_dim": int(text_dim), "d": int(d), "row_width": int(model.templates.row_width), "classes": CLASSES, "regions": REGIONS,
               "mean": [float(v) for v in saved["mean"]], "std": [float(v) for v in saved["std"]], "text": saved["text"],
               "vocabulary": int(text_model.embedding.shape[0]), "unknown": text_model.unk_token_id, "normalize": bool(text_model.normalize),
               "epoch": saved.get("epoch")}, open(os.path.join(out, "docparse.json"), "w", encoding="utf-8"))
    print(f"exported epoch {saved.get('epoch')} to {out}", flush=True)


if __name__ == "__main__":
    # Run as the module `docparse`, so what it pickles (the prepared tensors) names its classes there and any tool
    # importing the module reads them back.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import docparse
    if sys.argv[1:2] == ["export"]:
        docparse.export(sys.argv[2:])
    elif sys.argv[1:2] == ["trees"]:
        docparse.trees(sys.argv[2:])
    elif sys.argv[1:2] == ["roles"]:
        docparse.roles(sys.argv[2:])
    else:
        docparse.main()
