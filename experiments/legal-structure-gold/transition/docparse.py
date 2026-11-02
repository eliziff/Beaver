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
  dropout 0.2.

Inputs: a line dump of every document (LEGALPDF_TRANSITION_DUMP with the gold given, LEGALPDF_TRANSITION_DUMP_LINES=0:
`<sha>.json`, `<sha>.lines.f32`): each line's features, text, page and reference marks, and the gold's labels per line.

python docparse.py fit LINE_DUMP GOLD_STORE OUT_DIR [--text MODEL] [--epochs N] [--width D]
    fits on train's documents, reports each head on development's, and exports the three stages as ONNX graphs
    (detect.onnx, order.onnx, construct.onnx) with docparse.json (feature means and spreads, the text model, sizes)."""
import argparse, copy, json, os, sys, time, zlib
# The allocator grows its segments in place (no fragmenting into blocks no step can use).
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CLASSES = 34
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
REGIONS = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote", "marginal_note",
           "furniture", "page_label", "line_label", "title", "note_quote", "provision"]
STREAMS = {"note": 1, "note_quote": 1, "marginal_note": 2, "furniture": 3, "page_label": 4, "line_label": 5}
HEADING = 3
BODY = {1, 2, 4, 16}
GAPS = 4
PAIR = 25  # a region pair's measures: 18 spatial, 3 for the pages' distance, the order's distance and side, roles, a note's mark
NOTE = {5, 15}


def partition(store, sha):
    try:
        return json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8"))["partition"]
    except (OSError, KeyError, ValueError):
        return None


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
        regions = np.asarray([region_of(g) if g >= 0 else -1 for g in gold[:, 0]])
        self.role = np.where(regions >= 0, regions * 2 + (gold[:, 1] == 1), -100)
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
        for i, r in enumerate(self.regions):
            if region_of(gold[r][0]) not in NOTE or gold[r][1] != 1:
                continue
            label = "".join(c for c in self.texts[r].strip()[:4] if c.isdigit())
            target = i
            for k in range(r - 1, -1, -1):
                if self.pages[r] - self.pages[k] > 2:
                    break
                if gold[k][3] == 1 and any(str(ref[0]) == label for ref in references[k]) and self.region_of_line[k] >= 0:
                    target = int(self.region_of_line[k])
                    break
            self.note_of[i] = target
        self.region_role = np.asarray([self.role[r] // 2 if self.role[r] >= 0 else 0 for r in self.regions], dtype=np.int64)
        # Construct: the headings' tree, and the body's.
        starts = (gold[:, 2] == 1)
        levels = absolute(gold, 4, {HEADING})
        self.headings = [i for i, r in enumerate(self.regions) if region_of(gold[r][0]) == HEADING and gold[r][1] == 1 and levels[r] > 0]
        self.heading_parent, self.heading_sibling, self.heading_gap = tree(levels, [self.regions[i] for i in self.headings], starts)
        depths = absolute(gold, 7, BODY)
        self.bodies = [i for i, r in enumerate(self.regions) if region_of(gold[r][0]) in BODY and gold[r][1] == 1 and depths[r] > 0]
        self.body_parent, self.body_sibling, self.body_gap = tree(depths, [self.regions[i] for i in self.bodies], starts)
        # The regions' places: each one's page and its lines' union box; its rank in the gold's reading (its lines'
        # least) and its successor in that order (none where the gold gives no ranks); a note's number (the figures its
        # first line opens on) and the marks of it each region sets.
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
                digits = "".join(c for c in self.texts[r].strip()[:4] if c.isdigit())
                number[i] = int(digits) if digits else -1
        for k in np.flatnonzero(self.region_of_line >= 0):
            for ref in references[k]:
                marks[self.region_of_line[k]].add(int(ref[0]))
        self.region_number, self.region_marks = number, marks


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
        """Each listed pair's score (P,)."""
        i, j, r = pairs
        return (self.q(x)[i] * self.k(x)[j]).sum(-1) / x.shape[-1] ** 0.5 + self.r(r).squeeze(-1).to(x.dtype)


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
        self.fuse = nn.Linear(3 * d, d)
        self.encoder = encoder(d, 8, 1)
        self.successor, self.predecessor = RelationHead(d), RelationHead(d)
        self.role = nn.Linear(d, CLASSES)
        self.flags = nn.Linear(d, 2)

    def forward(self, features, text, boxes, paged):
        """Every line's state, its page's lines read together (the pages batched, each its own sequence)."""
        size = (boxes[:, 2:] - boxes[:, :2]).clamp(min=0)
        u = self.fuse(torch.cat([self.text(text), self.position(torch.cat([boxes, size], dim=-1)), self.look(features)], dim=-1))
        out = []
        for batch in paged.batches:
            x = u[batch.rows.clamp(min=0)]
            for layer in self.encoder:
                x = layer(x, batch.valid)
            out.append(x.reshape(-1, x.shape[-1])[batch.valid_at])
        return torch.cat(out)[paged.inverse]

class Order(nn.Module):
    def __init__(self, d, regions=17):
        super().__init__()
        self.pool = nn.Sequential(nn.Linear(d, d), nn.Tanh(), nn.Linear(d, 1))
        self.role = nn.Sequential(nn.Embedding(regions, d), nn.ReLU(), nn.LayerNorm(d))
        self.fuse = nn.Linear(2 * d, d)
        self.encoder = encoder(d, 8, 3, rotary=True)
        self.goes_on, self.note_of, self.successor = PairHead(d), PairHead(d), PairHead(d)

    def forward(self, line_states, region_lines, line_region, region_roles):
        """line_states (n, d), the lines in regions and each one's region (of m), the regions' roles -> region states
        (m, d)."""
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
        return self.encoder(self.fuse(torch.cat([pooled, roles], dim=-1)))


class Construct(nn.Module):
    def __init__(self, d):
        super().__init__()
        self.layers = nn.ModuleList([Layer(d, 8, rotary=True, dropout=0.2) for _ in range(2)])
        self.parent, self.sibling = RelationHead(d, spatial_term=False), RelationHead(d, spatial_term=False)
        self.gap = nn.Linear(d, GAPS)

    def forward(self, states):
        for layer in self.layers:
            states = layer(states)
        return self.parent(states), self.sibling(states), self.gap(states)


class DocParser(nn.Module):
    def __init__(self, width, text_dim, d):
        super().__init__()
        self.detect = Detect(width, text_dim, d)
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
        self.b = on(doc.boxes, torch.float32)
        self.lines = Paged(doc.pages)
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
        for name in ("headings", "heading_parent", "heading_sibling", "heading_gap", "bodies", "body_parent", "body_sibling", "body_gap"):
            setattr(self, name, on(getattr(doc, name)))
        self.has |= {name for name, nodes in (("heading", doc.headings), ("body", doc.bodies)) if len(nodes) >= 2}
        self.region_order = on(doc.region_order)
        if (doc.region_order >= 0).any():
            self.has.add("order")
        self.region_boxes, self.region_pages = on(doc.region_boxes, torch.float32), on(doc.region_pages)
        i, j, match = pairs_of(doc)
        self.pair_i, self.pair_j, self.pair_match = on(i, torch.int32), on(j, torch.int32), on(match, torch.bool)
        # Each region's gold pair for each region head: the pair (region, its target), negative where the gold gives
        # none (-100) or its target lies outside the region's pairs (-1).
        m = len(doc.regions)
        at = {int(a) * max(m, 1) + int(b): p for p, (a, b) in enumerate(zip(i.tolist(), j.tolist()))}
        for name, gold in (("goes_on_pair", doc.goes_on), ("note_of_pair", doc.note_of), ("order_pair", doc.region_order)):
            setattr(self, name, on([-100 if t < 0 else at.get(r * max(m, 1) + int(t), -1) for r, t in enumerate(gold.tolist())], torch.int32))


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
    i = np.concatenate(rows) if rows else np.zeros(0, dtype=np.int64)
    j = np.concatenate(cols) if cols else np.zeros(0, dtype=np.int64)
    order = np.lexsort((j, i))
    i, j = i[order], j[order]
    number = doc.region_number
    match = np.asarray([number[a] >= 0 and number[a] in doc.region_marks[b] for a, b in zip(i.tolist(), j.tolist())], dtype=bool) if m else np.zeros(0, dtype=bool)
    return i, j, match


def pair_terms(r):
    """A document's prepared region pairs and their measures, on the device."""
    i, j = r.pair_i, r.pair_j
    return i, j, region_pairs(r.region_boxes, r.region_pages, r.region_role, i, j, r.pair_match)


READY = 6  # the prepared tensors' layout; a change to `Ready`, `Paged` or `Batch` bumps it


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


def resident(docs):
    """Every document's prepared tensors moved to the device once (no copies a step; host memory freed); the device
    memory they take."""
    before = torch.cuda.memory_allocated() if DEVICE == "cuda" else 0
    for doc in docs:
        doc.ready = moved(doc.ready, DEVICE)
    return (torch.cuda.memory_allocated() - before) if DEVICE == "cuda" else 0


def page_links(head, states, boxes, paged, g):
    """A line-link head read page by page (its softmax over the page's lines), the pages batched: each batch's logits
    (one row a line, its page's lines the columns) and its gold, the gold's indexes made the page's own."""
    out = []
    for batch in paged.batches:
        r = batch.rows.clamp(min=0)
        x = states[r]
        f = head.pairs(x, x, batch, boxes).float().masked_fill(~batch.valid[:, None, :], -1e4)
        local = torch.where(g[r] >= 0, g[r] - batch.starts[:, None], -100)
        out.append((f.reshape(-1, f.shape[-1])[batch.valid_at], local.reshape(-1)[batch.valid_at]))
    return out


def link_loss(links, count):
    return sum(F.cross_entropy(f, g, ignore_index=-100, reduction="sum") for f, g in links) / count


def two_way(flag, gold):
    return F.cross_entropy(torch.stack([torch.zeros_like(flag), flag], dim=1), gold, ignore_index=-100)


def losses(model, doc):
    r = on_device(doc)
    parts = {}
    with torch.autocast("cuda", dtype=torch.bfloat16, enabled=DEVICE == "cuda"):
        states = model.detect(r.f, r.t, r.b, r.lines)
        role, flags = model.detect.role(states).float(), model.detect.flags(states).float()
        if "role" in r.has:
            parts["role"] = F.cross_entropy(role, r.role, ignore_index=-100)
        for name, head in (("successor", model.detect.successor), ("predecessor", model.detect.predecessor)):
            if name in r.has:
                parts[name] = link_loss(page_links(head, states, r.b, r.lines, getattr(r, name)), r.counts[name])
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
            for name, nodes, parent, sibling, gap, construct in (("heading", r.headings, r.heading_parent, r.heading_sibling, r.heading_gap, model.headings),
                                                                 ("body", r.bodies, r.body_parent, r.body_sibling, r.body_gap, model.bodies)):
                if name in r.has:
                    p, s, g = construct(regions[nodes])
                    parts[f"{name}_parent"] = F.cross_entropy(earlier(p.float()), parent)
                    parts[f"{name}_sibling"] = F.cross_entropy(earlier(s.float()), sibling)
                    parts[f"{name}_gap"] = F.cross_entropy(g.float(), gap)
    return sum(parts.values()), parts


def evaluate(model, docs):
    """Each head's accuracy on development's documents, the gold's regions and roles given to the later stages; and
    the heading openings' F1."""
    model.eval()
    right, total = {}, {}
    tp = gold_headings = guessed_headings = 0

    def count(name, guess, gold, links=False):
        """A head's accuracy; with `links`, also on the nodes whose gold points past themselves (`<name>_links`)."""
        gold = np.asarray(gold)
        keep = gold != -100
        right[name] = right.get(name, 0) + int((guess[keep] == gold[keep]).sum())
        total[name] = total.get(name, 0) + int(keep.sum())
        if links:
            real = keep & (gold != np.arange(len(gold)))
            right[f"{name}_links"] = right.get(f"{name}_links", 0) + int((guess[real] == gold[real]).sum())
            total[f"{name}_links"] = total.get(f"{name}_links", 0) + int(real.sum())
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=DEVICE == "cuda"):
        for doc in docs:
            r = on_device(doc)
            states = model.detect(r.f, r.t, r.b, r.lines)
            role, flags = model.detect.role(states).float(), model.detect.flags(states).float()
            guess = role.argmax(1).cpu().numpy()
            count("role", guess, doc.role)
            for batch, (logits, gold) in zip(r.lines.batches, page_links(model.detect.successor, states, r.b, r.lines, r.successor)):
                # a line's own place on its page: its index in the batch's flattened rows, modulo the row's width
                own = (batch.valid_at % batch.rows.shape[1]).cpu().numpy()
                g, linked = gold.cpu().numpy(), logits.argmax(1).cpu().numpy()
                keep = g != -100
                right["successor"] = right.get("successor", 0) + int((linked[keep] == g[keep]).sum())
                total["successor"] = total.get("successor", 0) + int(keep.sum())
                real = keep & (g != own)
                right["successor_links"] = right.get("successor_links", 0) + int((linked[real] == g[real]).sum())
                total["successor_links"] = total.get("successor_links", 0) + int(real.sum())
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
            for name, nodes, parent, sibling, construct in (("heading", r.headings, doc.heading_parent, doc.heading_sibling, model.headings),
                                                            ("body", r.bodies, doc.body_parent, doc.body_sibling, model.bodies)):
                if name in r.has:
                    p, s, g = construct(regions[nodes])
                    count(f"{name}_parent", earlier(p).argmax(1).cpu().numpy(), parent, links=True)
                    count(f"{name}_sibling", earlier(s).argmax(1).cpu().numpy(), sibling, links=True)
                    count(f"{name}_gap", g.argmax(1).cpu().numpy(), np.asarray(doc.heading_gap if name == "heading" else doc.body_gap))
    model.train()
    out = {k: (right.get(k, 0) / max(total[k], 1), total[k]) for k in total}
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


def load(folder, store):
    docs = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".json") or name.endswith(".labels.json"):
            continue
        meta = json.load(open(os.path.join(folder, name), encoding="utf-8"))
        if "pages" not in meta or not meta.get("lines"):
            continue
        x = np.fromfile(os.path.join(folder, f"{meta['sha256']}.lines.f32"), dtype="<f4").reshape(meta["lines"], meta["line_width"])
        doc = Doc(meta, x)
        doc.split = partition(store, doc.sha)
        docs.append(doc)
    return docs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["fit"])
    parser.add_argument("dump")
    parser.add_argument("store")
    parser.add_argument("out")
    parser.add_argument("--text", default="minishlab/potion-multilingual-128M")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--width", type=int, default=256)
    args = parser.parse_args()
    docs = load(args.dump, args.store)
    # Every line's text embedded once: the documents' distinct texts in one call (the tokenizer in parallel), each
    # document's kept beside its dump for the next fit.
    tag = args.text.replace("/", "_")
    cache, missing = {}, []
    for doc in docs:
        path = os.path.join(args.dump, f"{doc.sha}.{tag}.npy")
        if os.path.exists(path):
            cache[doc.sha] = np.load(path)
        else:
            missing.append(doc)
    if missing:
        from model2vec import StaticModel
        text_model = StaticModel.from_pretrained(args.text)
        texts = sorted({t if t.strip() else " " for doc in missing for t in doc.texts})
        at = {t: i for i, t in enumerate(texts)}
        vectors = np.asarray(text_model.encode(texts, use_multiprocessing=True, show_progress_bar=False), dtype=np.float32)
        for doc in missing:
            cache[doc.sha] = vectors[[at[t if t.strip() else " "] for t in doc.texts]]
            np.save(os.path.join(args.dump, f"{doc.sha}.{tag}.npy"), cache[doc.sha])
        print(f"{len(texts)} distinct line texts embedded for {len(missing)} documents", flush=True)

    def embed(doc):
        return cache[doc.sha]

    train_docs = [d for d in docs if d.split == "train"]
    dev_docs = [d for d in docs if d.split == "development"]
    print(f"{len(train_docs)} train documents, {len(dev_docs)} development; text {args.text}", flush=True)
    # The features' means and spreads over train's lines, summed a document at a time.
    total = sum(d.features.astype(np.float64).sum(0) for d in train_docs)
    squares = sum((d.features.astype(np.float64) ** 2).sum(0) for d in train_docs)
    count = sum(d.n for d in train_docs)
    mean = total / count
    std = np.sqrt(np.maximum(squares / count - mean ** 2, 0)) + 1e-6
    started = time.time()
    built = prepare(train_docs + dev_docs, mean, std, embed, os.path.join(args.dump, "ready"))
    cache.clear()  # the embeddings are in the prepared tensors
    print(f"prepared tensors: {built} built, {len(train_docs) + len(dev_docs) - built} read, {time.time() - started:.0f}s", flush=True)
    held = resident(train_docs + dev_docs)
    print(f"prepared tensors on the device: {held / 2**30:.2f} GiB", flush=True)
    model = DocParser(train_docs[0].ready.f.shape[1], train_docs[0].ready.t.shape[1], args.width).to(DEVICE)
    preflight(model, train_docs)
    # Development read once before training, so a fault in the evaluation shows before an epoch is spent.
    started = time.time()
    print(f"  preflight development: {len(evaluate(model, dev_docs))} heads read, {time.time() - started:.0f}s", flush=True)
    # The paper's schedule: AdamW, a linear warm-up over two epochs, then a linear fall to nothing; one document a step.
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-4, weight_decay=1e-2)
    steps = args.epochs * len(train_docs)
    warm = 2 * len(train_docs)
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
        # Development after every epoch; the checkpoint kept is the best by its heads' mean accuracy.
        report = evaluate(model, dev_docs)
        # Heads with no development examples (a count of nought) are left out of the mean.
        score = float(np.mean([a for a, c in report.values() if c]))
        print(f"  development {score:.4f}: " + " ".join(f"{n} {a:.4f} ({c})" for n, (a, c) in sorted(report.items())), flush=True)
        if score > best:
            best, since = score, 0
            torch.save({"model": model.state_dict(), "mean": mean, "std": std, "text": args.text, "width": args.width, "epoch": epoch + 1}, os.path.join(args.out, "docparser.pt"))
        else:
            since += 1
            if since == 3:
                print(f"  no gain in three epochs; best {best:.4f}", flush=True)
                break
    open(os.path.join(args.out, "fit.done"), "w").write("done\n")


class DetectPage(nn.Module):
    """Detect over one page's lines as the engine runs it: every line against every line of the page (the training
    batches' padding and flat indexes left out; the same function on a page's real lines)."""

    def __init__(self, detect):
        super().__init__()
        self.detect = detect

    def forward(self, features, text, boxes):
        d = self.detect
        size = (boxes[:, 2:] - boxes[:, :2]).clamp(min=0)
        x = d.fuse(torch.cat([d.text(text), d.position(torch.cat([boxes, size], dim=-1)), d.look(features)], dim=-1))
        for layer in d.encoder:
            x = layer(x)
        links = []
        for head in (d.successor, d.predecessor):
            f = head.q(x) @ head.k(x).t() / x.shape[-1] ** 0.5
            links.append(f + head.r(spatial(boxes, boxes)).squeeze(-1))
        return x, links[0], links[1], d.role(x), d.flags(x)


class OrderDocument(nn.Module):
    """Order over a document's regions: the lines in regions and each one's region, the regions' roles -> the
    regions' states and their two links."""

    def __init__(self, order):
        super().__init__()
        self.order = order

    def forward(self, line_states, line_region, region_roles, region_boxes, region_pages, pair_i, pair_j, pair_match):
        regions = self.order(line_states, None, line_region, region_roles)
        pairs = (pair_i, pair_j, region_pairs(region_boxes, region_pages, region_roles, pair_i, pair_j, pair_match))
        return regions, self.order.goes_on(regions, pairs), self.order.note_of(regions, pairs), self.order.successor(regions, pairs)


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
    model = DocParser(width, text_dim, d)
    model.load_state_dict(state)
    model.eval()
    os.makedirs(out, exist_ok=True)
    n, m, k = 12, 5, 9
    with torch.no_grad():
        torch.onnx.export(DetectPage(model.detect), (torch.randn(n, width), torch.randn(n, text_dim), torch.rand(n, 4)),
                          os.path.join(out, "detect.onnx"), input_names=["features", "text", "boxes"],
                          output_names=["states", "successor", "predecessor", "role", "flags"],
                          dynamic_axes={"features": {0: "lines"}, "text": {0: "lines"}, "boxes": {0: "lines"}, "states": {0: "lines"},
                                        "successor": {0: "lines", 1: "lines"}, "predecessor": {0: "lines", 1: "lines"},
                                        "role": {0: "lines"}, "flags": {0: "lines"}}, opset_version=18, dynamo=False)
        pairs = 7
        boxes = torch.rand(m, 4)
        boxes[:, 2:] = boxes[:, :2] + 0.1
        torch.onnx.export(OrderDocument(model.order), (torch.randn(k, d), torch.randint(0, m, (k,)), torch.randint(0, 17, (m,)), boxes,
                                                       torch.randint(0, 3, (m,)), torch.randint(0, m, (pairs,)), torch.randint(0, m, (pairs,)),
                                                       torch.zeros(pairs, dtype=torch.bool)),
                          os.path.join(out, "order.onnx"),
                          input_names=["line_states", "line_region", "region_roles", "region_boxes", "region_pages", "pair_i", "pair_j", "pair_match"],
                          output_names=["regions", "goes_on", "note_of", "successor"],
                          dynamic_axes={"line_states": {0: "lines"}, "line_region": {0: "lines"}, "region_roles": {0: "regions"},
                                        "region_boxes": {0: "regions"}, "region_pages": {0: "regions"}, "pair_i": {0: "pairs"},
                                        "pair_j": {0: "pairs"}, "pair_match": {0: "pairs"}, "regions": {0: "regions"},
                                        "goes_on": {0: "pairs"}, "note_of": {0: "pairs"}, "successor": {0: "pairs"}},
                          opset_version=18, dynamo=False)
        for name, construct in (("headings", model.headings), ("bodies", model.bodies)):
            torch.onnx.export(construct, (torch.randn(m, d),), os.path.join(out, f"{name}.onnx"), input_names=["states"],
                              output_names=["parent", "sibling", "gap"],
                              dynamic_axes={"states": {0: "nodes"}, "parent": {0: "nodes", 1: "nodes"}, "sibling": {0: "nodes", 1: "nodes"},
                                            "gap": {0: "nodes"}},
                              opset_version=18, dynamo=False)
    from model2vec import StaticModel
    text_model = StaticModel.from_pretrained(saved["text"])
    open(os.path.join(out, "tokenizer.json"), "w", encoding="utf-8").write(text_model.tokenizer.to_str())
    np.ascontiguousarray(text_model.embedding, dtype="<f4").tofile(os.path.join(out, "embeddings.f32"))
    samples = ["12. The appellant appeals.", "(a) a person who", "PART II — GENERAL", "Ibid. at para 4.", "Le tribunal a jugé que", " ", "R v Smith, 2019 SCC 12"]
    json.dump({"texts": samples, "vectors": np.asarray(text_model.encode(samples), dtype=np.float32).round(6).tolist()},
              open(os.path.join(out, "parity.json"), "w", encoding="utf-8"))
    json.dump({"width": int(width), "text_dim": int(text_dim), "d": int(d), "classes": CLASSES, "regions": REGIONS,
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
    else:
        docparse.main()
