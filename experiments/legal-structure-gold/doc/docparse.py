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
- Text: Model2Vec's static distillation of a multilingual sentence encoder (the packs' text model, `structure-gold training --text`) in place of BERT-base, so a
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

Inputs: the packs `structure-gold training` writes from the gold store (the parser's arrays and the gold's targets, laid
end to end a step at a time, the statistics and the epochs' plan in their manifest): Python reads them as written.

python docparse.py fit PACKS OUT_DIR [--width D] [--init CHECKPOINT [--reset]] [--schedule wsd|linear]
    [--ema DECAY] [--no-compile] [--log-steps] [--profile STEPS] [--sync-debug]
    fits on the packs `structure-gold training STORE DUMP PACKS` wrote (their manifest names the stages fitted, the
    heads, the statistics and the epochs' plan), reports each head on development's; where fewer stages than all are
    fitted, --init's others are held fixed, their outputs read once and kept.
python docparse.py export CHECKPOINT TEXT OUT_DIR: the stages as ONNX graphs with docparse.json (`export`)."""
import argparse, copy, gc, json, math, os, sys, threading, time
# The allocator grows its segments in place (no fragmenting into blocks no step can use).
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
# Compiled kernels and graphs kept between fits (Inductor's graph and autograd caches): a fit compiles only what changed.
os.environ.setdefault("TORCHINDUCTOR_CACHE_DIR", os.path.join(os.path.expanduser("~"), ".cache", "docparse-inductor"))
os.environ.setdefault("TORCHINDUCTOR_FX_GRAPH_CACHE", "1")
os.environ.setdefault("TORCHINDUCTOR_AUTOGRAD_CACHE", "1")
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.utils.checkpoint

CLASSES = 34
ANCHORS = 10  # an outline anchor's level, 0 for none
T0 = 27  # what t0 decided of a line (`lines::T0`): its role, one of 14, twelve flags and its heading's level
BLOCK = 64  # the Order stage's attention block
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
# What runs in float32 (the losses, the pair measures, the trees' biases) on the tensor cores too (TF32).
torch.backends.cuda.matmul.allow_tf32 = torch.backends.cudnn.allow_tf32 = True
torch.set_float32_matmul_precision("high")
REGIONS = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote", "marginal_note",
           "furniture", "page_label", "line_label", "title", "note_quote", "provision"]
HEADING = 3
GAPS = 4
PAIR = 25  # a region pair's measures: 18 spatial, 3 for the pages' distance, the order's distance and side, roles, a note's mark
UNMARKED_BODY = 101
UNMARKED = (1, 2, 4)  # text, a list item, a quotation
TEXT_PULL = 0.25  # a free line's lean to text (`role_loss`)
OFFSETS = tuple(int(v) for v in np.cumsum([0, 2 * ANCHORS - 1, 12, 48, 9, 16]))  # each pair table's first row (`Construct.table`)
STAGES = ("detect", "templates", "order", "headings", "bodies")
LINES = {"role", "marked", "start", "successor", "predecessor"}  # the line heads
PAIRS = {"goes_on": "goes_on", "note_of": "note_of", "order": "successor"}  # each region head's pair head in Order
HEADS = {**{h: {"detect", "templates"} for h in LINES}, **{h: {"detect", "templates", "order"} for h in PAIRS},
         "heading": {"detect", "templates", "order", "headings"}, "body": {"detect", "templates", "order", "bodies"}}  # the stages each head reads

# ----------------------------------------------------------------------------------------------- the gold, read
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
        # The spatial MLP 64 wide (the paper leaves its width open): 18 measures in, one score out; a line pair beyond the
        # window (`LINE_WINDOW`) takes `far` in its place.
        self.r = nn.Sequential(nn.Linear(18, 64), nn.ReLU(), nn.Linear(64, 1)) if spatial_term else None
        self.far = nn.Parameter(torch.zeros(())) if spatial_term else None

    def forward(self, x):
        """Every node against every node, on their features (a tree's, or each of a batch of trees')."""
        return self.q(x) @ self.k(x).transpose(-1, -2) / x.shape[-1] ** 0.5


def pair_dot(q, k, i, j):
    """Each listed pair's q[i] · k[j]. Compiled (`compiled`), the rows' gather, product and sum are one kernel and the
    backward one scattered sum: the pairs' rows are never held, and the step's graph does not break on it (as the
    chunked autograd function did)."""
    return (q[i].float() * k[j].float()).sum(-1)


class PairHead(nn.Module):
    """The paper's relation head over regions with a pair term: f_ij = q(F_i).k(F_j) + MLP(r_ij), r_ij (`PAIR`) given
    for the pairs listed (`pairs`, the regions within a page of each other); elsewhere the pair scores on its features
    alone. The pair term is read for a pair within `ORDER_WINDOW` regions of each other in reading order, or whose note's
    number is a mark the other sets; a pair beyond takes `far` in its place, so its cost grows with the regions, not with
    how densely they stand."""

    def __init__(self, d):
        super().__init__()
        self.q, self.k = nn.Linear(d, d), nn.Linear(d, d)
        self.r = nn.Sequential(nn.Linear(PAIR, 64), nn.ReLU(), nn.Linear(64, 1))
        self.far = nn.Parameter(torch.zeros(()))

    def forward(self, x, pairs):
        """Each listed pair's score (P,), its two regions' query and key read off at the pair (no region-by-region
        matrix), as the engine reads them."""
        i, j, _ = pairs
        q, k, r = self.parts(x, pairs)
        return pair_dot(q, k, i, j) + r.float()

    def parts(self, x, pairs):
        """The same scores' parts as the engine computes them, a pair at a time with no matrix: the regions' scaled
        queries and keys, and each pair's term (`far` beyond the window, the engine passing only the pairs within)."""
        i, j, r = pairs
        near = ((j.long() - i.long()).abs() <= ORDER_WINDOW[0]) | (r[:, -1] > 0.5)
        term = self.r(r).squeeze(-1)
        return self.q(x) / x.shape[-1] ** 0.5, self.k(x), torch.where(near, term, self.far.to(term.dtype))


def row_loss(logits, i, target, w):
    """Cross-entropy of each region's softmax over its pairs (`i` each pair's region, `target` each region's gold pair,
    negative where none is given or the gold lies outside the region's pairs), each region weighed by `w`."""
    logits, m, i = logits.float(), target.shape[0], i.long()  # the pairs' rows held in 32 bits, scattered in 64
    top = torch.full((m,), -1e9, device=logits.device).scatter_reduce(0, i, logits, reduce="amax")
    total = torch.zeros(m, device=logits.device).scatter_add(0, i, torch.exp(logits - top[i]))
    norm = torch.log(total.clamp(min=1e-30)) + top
    return ((norm - logits[target.clamp(min=0)]) * w).sum()


def row_choice(logits, i, j, m):
    """Each region's likeliest pair's other region, the first in the pairs' order on a tie (itself where it has no pairs)."""
    logits, far, i = logits.float(), torch.iinfo(torch.int64).max, i.long()
    top = torch.full((m,), -float("inf"), device=logits.device).scatter_reduce(0, i, logits, reduce="amax")
    chosen = torch.full((m,), far, device=logits.device).scatter_reduce(0, i, torch.where(logits == top[i], j.long(), far), reduce="amin")
    return torch.where(chosen == far, torch.arange(m, device=logits.device), chosen)


def pair_measures(p):
    """A pack's region pairs' measures (`region_pairs`), made in the step (fused there) rather than held in the pack."""
    return region_pairs(p.region_boxes, p.region_pages, p.region_role, p.pair_i, p.pair_j, p.pair_match)


def region_pairs(boxes, pages, roles, i, j, match):
    """The pair measures r_ij of the regions `i` against the regions `j` (`PAIR` each): their boxes' spatial measures,
    the pages' distance (-1, 0, 1), the distance in the parser's order (log) and its side, whether the roles agree,
    and whether a note's number is a mark the other sets."""
    gap = (pages[j] - pages[i]).clamp(-1, 1)
    order = (j - i).float()
    return torch.cat([measures(boxes[i], boxes[j]), F.one_hot(gap + 1, 3).float(), torch.log1p(order.abs())[:, None] / 5,
                      order.sign()[:, None], (roles[i] == roles[j]).float()[:, None], match.float()[:, None]], dim=-1)


def take(x, at):
    """x's rows at `at` (any shape of indexes), as x[at]: through index_select, whose backward is one scattered sum
    (index_add) where fancy indexing's is an accumulating index_put, which sorts the indexes first (a seventh of a step's
    device time on the page batches', trees' and stylesheet's gathers)."""
    return x.index_select(0, at.reshape(-1)).view(*at.shape, *x.shape[1:])

class Tensors:
    """An object whose tensors (and its parts') `moved` carries together."""


DTYPES = {"F32": torch.float32, "BF16": torch.bfloat16, "I64": torch.int64, "I32": torch.int32, "I8": torch.int8, "U8": torch.uint8, "BOOL": torch.bool}


def mapped(path):
    """A pack's file as the Rust packs write it (`structure-gold training`; safetensors, each array at a multiple of its
    width) mapped, each array a view of the mapping at its place: a dotted name a part (`lines.batches.0.rows`), a part
    numbered from 0 a list."""
    with open(path, "rb") as f:
        size = int.from_bytes(f.read(8), "little")
        header = json.loads(f.read(size))
    buffer = torch.from_file(path, shared=False, size=os.path.getsize(path), dtype=torch.uint8)
    root = {}
    for name, entry in header.items():
        if name == "__metadata__":
            continue
        a, z = entry["data_offsets"]
        *parts, last = name.split(".")
        node = root
        for part in parts:
            node = node.setdefault(part, {})
        node[last] = buffer[8 + size + a:8 + size + z].view(DTYPES[entry["dtype"]]).view(entry["shape"])

    def nested(node):
        if not isinstance(node, dict):
            return node
        if all(key.isdigit() for key in node):
            return [nested(node.get(str(i))) for i in range(max(map(int, node)) + 1)]
        value = object.__new__(Tensors)
        value.__dict__.update({key: nested(v) for key, v in node.items()})
        return value
    return nested(root)


def load_packs(folder, entries):
    """The manifest's packs (`entries`) mapped from `folder`, each with what the manifest says of it. A tree's pair codes
    are made in its step (`tree_codes`, the Construct graph's own): an n-node tree's n² codes are cheaper made than
    stored and read."""
    packs = []
    for entry in entries:
        p = mapped(os.path.join(folder, entry["file"]))
        p.k, p.shas, p.has, p.size, p.kind, p.doc_lines = entry["k"], entry["shas"], set(entry["has"]), entry["size"], entry["kind"], entry["doc_lines"]
        p.resident, p.states, p.regions, p.page_block_mask, p.order_block_mask, p.template_block_mask = False, None, None, None, None, None
        for name in ("heading", "body"):
            setattr(p, name, getattr(p, name, None))
        # Each line's document and each token's line, from the documents' starts and the tokens' counts.
        p.line_doc = torch.repeat_interleave(torch.arange(p.docs.shape[0] - 1), (p.docs[1:] - p.docs[:-1]).long()).int()
        p.token_lines = torch.repeat_interleave(torch.arange(p.token_counts.shape[0]), p.token_counts.long()).int()
        for name in ("heading", "body"):
            for t in getattr(p, name) or ():
                t.codes = None
        packs.append(p)
    return packs


class Muon(torch.optim.Optimizer):
    """Muon (Jordan et al. 2024): each matrix's momentum (Nesterov) orthogonalized by five quintic Newton-Schulz steps and
    applied at AdamW's scale (0.2 √max(rows, cols), Liu et al. 2025's matching), weight decay decoupled. The matrices of
    one shape are stacked and orthogonalized together (batched products): a step's few dozen launches, not hundreds."""

    def __init__(self, params, lr, weight_decay=1e-2, momentum=0.95):
        super().__init__(list(params), {"lr": lr, "weight_decay": weight_decay, "momentum": momentum})
        shapes = {}
        for p in self.param_groups[0]["params"]:
            shapes.setdefault(tuple(p.shape), []).append(p)
        self.groups = list(shapes.values())
        # Each matrix's momentum its own (a frozen stage's matrices, no gradient, left as they are).
        self.momenta = {id(p): torch.zeros(p.shape, device=p.device, dtype=torch.float32) for p in self.param_groups[0]["params"]}

    @staticmethod
    def orthogonal(g, steps=5):
        a, b, c = 3.4445, -4.7750, 2.0315
        x = g.bfloat16()
        tall = x.shape[-2] > x.shape[-1]
        if tall:
            x = x.mT
        x = x / (x.norm(dim=(-2, -1), keepdim=True) + 1e-7)
        for _ in range(steps):
            m = x @ x.mT
            x = a * x + (b * m + c * m @ m) @ x
        return x.mT if tall else x

    @torch.no_grad()
    def step(self):
        group = self.param_groups[0]
        lr, decay, beta = group["lr"], group["weight_decay"], group["momentum"]
        for group_params in self.groups:
            ps = [p for p in group_params if p.grad is not None]
            if not ps:
                continue
            grads = torch.stack([p.grad for p in ps]).float()
            bufs = [self.momenta[id(p)] for p in ps]
            torch._foreach_lerp_(bufs, list(grads.unbind(0)), 1 - beta)
            update = self.orthogonal(grads.lerp_(torch.stack(bufs), beta))
            scale = 0.2 * max(ps[0].shape[-2], ps[0].shape[-1]) ** 0.5
            torch._foreach_mul_(ps, 1 - lr * decay)
            torch._foreach_add_(ps, list(update.to(ps[0].dtype).unbind(0)), alpha=-lr * scale)


def held_by(value, stream):
    """`value`'s tensors (and its parts') marked as used on `stream`, so the allocator keeps them until that stream is
    done with them (a pack copied on a side stream, read on the step's)."""
    if torch.is_tensor(value):
        value.record_stream(stream)
    elif isinstance(value, (list, tuple)):
        for v in value:
            held_by(v, stream)
    elif isinstance(value, dict):
        for v in value.values():
            held_by(v, stream)
    elif isinstance(value, Tensors):
        for v in vars(value).values():
            held_by(v, stream)


def tensors_of(value):
    """`value`'s tensors, in a fixed order (a pack's fields, its batches' and trees')."""
    if torch.is_tensor(value):
        return [value]
    if isinstance(value, (list, tuple)):
        return [t for v in value for t in tensors_of(v)]
    if isinstance(value, dict):
        return [t for v in value.values() for t in tensors_of(v)]
    if isinstance(value, Tensors):
        return [t for v in vars(value).values() for t in tensors_of(v)]
    return []


def rebuilt(value, parts):
    """`value` with its tensors (`tensors_of`'s order) replaced by `parts`, taken from the front."""
    if torch.is_tensor(value):
        return parts.pop(0)
    if isinstance(value, (list, tuple)):
        return type(value)(rebuilt(v, parts) for v in value)
    if isinstance(value, dict):
        return {k: rebuilt(v, parts) for k, v in value.items()}
    if isinstance(value, Tensors):
        new = object.__new__(type(value))
        new.__dict__.update({k: rebuilt(v, parts) for k, v in vars(value).items()})
        return new
    return value


class Prefetch:
    """Packs not held on the device copied there on a side stream ahead of their step, while the step before runs; a
    pack held there given as it is. A pack on the host is its cache file mapped (`build`), not a copy in memory: its
    bytes go through one of two pinned staging buffers (`room` bytes each, the largest pack's), packed end to end, then
    to the device in one copy and cut there into its tensors. The pinned memory is the two buffers, not every pack
    (Windows pins only so much of a 16 GB host, and what it pins the rest of the machine pages around)."""

    def __init__(self, room=0):
        self.stream = torch.cuda.Stream() if DEVICE == "cuda" else None
        self.room = room
        self.buffers = [None, None]
        self.device_buffers = [None, None]
        self.events = [None, None]
        self.turn = 0

    def start(self, p):
        """`p` on its way to the device: its staging and copy run on a thread of their own (the copy into pinned memory
        lets go of the interpreter's lock), so the step's launches go on meanwhile; `take` waits for it."""
        if p.resident or self.stream is None:
            return p, None
        if not hasattr(self, "pool"):
            from concurrent.futures import ThreadPoolExecutor
            self.pool = ThreadPoolExecutor(max_workers=1)
        return self.pool.submit(self.staged, p), "thread"

    def staged(self, p):
        parts = tensors_of(p)
        sizes = [t.numel() * t.element_size() for t in parts]
        total = sum(-(-s // 16) * 16 for s in sizes)
        slot, self.turn = self.turn, 1 - self.turn
        if self.events[slot] is not None:
            self.events[slot].synchronize()  # the copy out of this buffer two packs ago done
        if self.buffers[slot] is None or self.buffers[slot].numel() < total:
            self.buffers[slot] = torch.empty(max(total, self.room), dtype=torch.uint8).pin_memory()
        staging, at, places = self.buffers[slot], 0, []
        for t, s in zip(parts, sizes):
            if s:
                staging[at:at + s].copy_(t.contiguous().view(-1).view(torch.uint8))
            places.append(at)
            at += -(-s // 16) * 16
        # Into one of two device buffers made once, the largest pack's size: a fresh device block of each copied pack's
        # own size every step fragmented the allocator until a step found no room (an epoch in). The copy waits for the
        # steps queued before it, the one that read this buffer two packs ago among them.
        if self.device_buffers[slot] is None or self.device_buffers[slot].numel() < total:
            self.device_buffers[slot] = torch.empty(max(total, self.room), dtype=torch.uint8, device=DEVICE)
        with torch.cuda.stream(self.stream):
            self.stream.wait_stream(torch.cuda.default_stream())
            device = self.device_buffers[slot][:total]
            device.copy_(staging[:total], non_blocking=True)
            done = torch.cuda.Event()
            done.record(self.stream)
            self.events[slot] = done
            q = rebuilt(p, [device[o:o + s].view(t.dtype).view(t.shape) for t, o, s in zip(parts, places, sizes)])
        return q, done

    def take(self, started):
        q, done = started
        if done == "thread":
            q, done = q.result()
        if done is not None:
            torch.cuda.current_stream().wait_event(done)
            held_by(q, torch.cuda.current_stream())
        return q


def moved(value, device, pin=False):
    """`value` with its tensors on `device`, or with `pin` in pinned host memory (from where a copy to the device does
    not wait)."""
    if torch.is_tensor(value):
        if not pin:
            return value.to(device, non_blocking=True)
        # Pinned where the host can still pin (Windows pins only so much); else pageable, copied without overlap.
        try:
            return value.cpu().pin_memory()
        except RuntimeError:
            return value.cpu()
    if isinstance(value, (list, tuple)):
        return type(value)(moved(v, device, pin) for v in value)
    if isinstance(value, dict):
        return {k: moved(v, device, pin) for k, v in value.items()}
    if isinstance(value, Tensors):
        new = object.__new__(type(value))
        new.__dict__.update({k: moved(v, device, pin) for k, v in vars(value).items()})
        return new
    return value

def encoder(d, heads, layers, rotary=False):
    return nn.Sequential(*[Layer(d, heads, rotary) for _ in range(layers)])


ROPE = {}


def rotary(n, size, device, places=None):
    """RoPE's cos and sin (n, size / 2) at the places 0 to n - 1, or at `places` (each below n): read off a table kept
    for the device and size, grown to the longest sequence yet; the exported graph computes them from its input."""
    def angles(at):
        freq = 10000 ** (-torch.arange(0, size, 2, device=device, dtype=torch.float32) / size)
        angle = at.float()[:, None] * freq[None]
        return angle.cos(), angle.sin()
    if torch.onnx.is_in_onnx_export():
        return angles(torch.arange(n, device=device) if places is None else places)
    table = ROPE.get((str(device), size))
    if table is None or table[0].shape[0] < n:
        table = ROPE[(str(device), size)] = angles(torch.arange(max(n, 4096, 2 * table[0].shape[0] if table else 0), device=device))
    return (table[0][:n], table[1][:n]) if places is None else (table[0][places], table[1][places])


SPARSE = {}  # the 2:4 sparse linear (`docparse_sparse`), where the fit turns it on (`--sparse24`) and it checks


def lin(module, x):
    """A layer's linear map: 2:4 sparse on the sparse tensor cores where on (the fit's; the export reads the weights as
    pruned, `sparse_names`) and its shape suits the library (`docparse_sparse.suits`), else dense."""
    return SPARSE["linear"](module, x) if SPARSE and SPARSE["suits"](module.weight) else module(x)


def sparse_names(model):
    """The weights `lin` reads 2:4 sparse: the transformer layers' attention and feed-forward matrices of suiting shape."""
    names = set()
    for prefix, module in model.named_modules():
        if isinstance(module, Layer):
            for part in (module.qkv, module.out, module.feed[0], module.feed[2]):
                if SPARSE["suits"](part.weight):
                    names |= {f"{prefix}.{n}" for n, w in module.named_parameters() if w is part.weight}
    return names


def feed(layer, x):
    """A layer's feed-forward (its two linear maps, ReLU² between) through `lin`."""
    return lin(layer.feed[2], layer.feed[1](lin(layer.feed[0], x)))


class ReLU2(nn.Module):
    """ReLU squared (So et al. 2021, Primer; the NanoGPT speedrun's feed-forward activation)."""

    def forward(self, x):
        return F.relu(x).square()


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
        # QK-Norm (each head's queries and keys normalized before their product), ReLU² in the feed-forward, and the
        # residual branches' output projections starting at zero, as the NanoGPT speedrun trains (modded-nanogpt).
        self.q_norm, self.k_norm = nn.LayerNorm(self.size), nn.LayerNorm(self.size)
        self.feed = nn.Sequential(nn.Linear(d, 4 * d), ReLU2(), nn.Linear(4 * d, d))
        nn.init.zeros_(self.out.weight)
        nn.init.zeros_(self.feed[2].weight)

    def rotate(self, t, rope):
        """t (..., L, s), rotated by each place along L (`rope` its cos and sin, `rotary`)."""
        cos, sin = rope
        even, odd = t[..., 0::2], t[..., 1::2]
        return torch.stack([even * cos - odd * sin, even * sin + odd * cos], dim=-1).flatten(-2)

    def forward(self, x, valid=None, rope=None, block_mask=None):
        """x (L, d) one sequence, or (B, L, d) a batch with `valid` (B, L) its real places; `rope` its places' angles
        (its module's, read once for all its layers); or with `block_mask` one sequence whose places see only those the
        mask lets them (FlexAttention: a pack's pages each its own sequence, in one call; no attention dropout there)."""
        single = x.dim() == 2
        if single:
            x = x[None]
        b, n, _ = x.shape
        q, k, v = lin(self.qkv, self.norm1(x)).reshape(b, n, 3, self.heads, self.size).permute(2, 0, 3, 1, 4)
        q, k = self.q_norm(q), self.k_norm(k)
        if self.rotary:
            rope = rope or rotary(n, self.size, x.device)
            q, k = self.rotate(q, rope), self.rotate(k, rope)
        if block_mask is not None:
            y = FLEX["attention"](q, k, v, block_mask=block_mask)
        else:
            mask = None if valid is None else valid[:, None, None, :]
            y = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, dropout_p=self.dropout if self.training else 0.0)
        x = x + self.drop(lin(self.out, y.transpose(1, 2).reshape(b, n, -1)))
        x = x + self.drop(feed(self, self.norm2(x)))
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
        size = (boxes[..., 2:] - boxes[..., :2]).clamp(min=0)
        return self.fuse(torch.cat([self.text(text), self.position(torch.cat([boxes, size], dim=-1)), self.look(features), self.anchor(anchors),
                                    self.decided(t0)], dim=-1))

    def forward(self, features, text, boxes, anchors, t0, paged, block_mask=None):
        """Every line's state, its page's lines read together (the pages batched, each its own sequence; or, with
        `block_mask`, every page in one call, each seeing only its own lines)."""
        u = self.embed(features, text, boxes, anchors, t0)
        if block_mask is not None:
            x = u[None]
            for layer in self.encoder:
                x = layer(x, block_mask=block_mask)
            return x[0]
        out = []
        for batch in paged.batches:
            x = take(u, batch.rows.clamp(min=0))
            for layer in self.encoder:
                x = layer(x, batch.valid)
            out.append(x.reshape(-1, x.shape[-1])[batch.valid_at])
        return torch.cat(out)[paged.inverse]

class BlockLayer(Layer):
    """A transformer layer whose attention is block-local: the sequence (its length a multiple of `BLOCK`, `valid` its
    real places) cut into blocks, each block's queries attending to the keys of itself and the blocks either side
    (`seen`, where given: those of them a pack's block may see, its own document's); queries and keys rotated by their
    places (`rope`)."""

    def forward(self, x, valid, seen=None, rope=None, block_mask=None):
        """With `block_mask` (`order_mask`: the same document, the blocks either side), one FlexAttention call over the
        whole sequence instead of the blocks and their neighbours gathered and masked."""
        n = x.shape[0]
        if block_mask is not None:
            q, k, v = lin(self.qkv, self.norm1(x)).reshape(n, 3, self.heads, self.size).permute(1, 2, 0, 3)
            q, k = self.q_norm(q), self.k_norm(k)
            if self.rotary:
                rope = rope or rotary(n, self.size, x.device)
                q, k = self.rotate(q, rope), self.rotate(k, rope)
            y = FLEX["attention"](q[None], k[None], v[None], block_mask=block_mask)[0]
            x = x + self.drop(lin(self.out, y.permute(1, 0, 2).reshape(n, -1)))
            return x + self.drop(feed(self, self.norm2(x)))
        q, k, v = lin(self.qkv, self.norm1(x)).reshape(n, 3, self.heads, self.size).permute(1, 2, 0, 3)  # (h, n, s) each
        q, k = self.q_norm(q), self.k_norm(k)
        if self.rotary:
            rope = rope or rotary(n, self.size, x.device)
            q, k = self.rotate(q, rope), self.rotate(k, rope)
        blocks = lambda t: t.reshape(self.heads, -1, BLOCK, self.size).transpose(0, 1)  # (b, h, BLOCK, s)
        qb, kb, vb = blocks(q), blocks(k), blocks(v)
        mask = valid.reshape(-1, BLOCK)
        edge_kv = torch.zeros_like(kb[:1])
        edge_mask = torch.zeros_like(mask[:1])
        around = lambda t, edge: torch.cat([torch.cat([edge, t[:-1]]), t, torch.cat([t[1:], edge])], dim=-2 if t.dim() == 4 else -1)
        keys, values = around(kb, edge_kv), around(vb, edge_kv)
        seen = around(mask, edge_mask) if seen is None else seen  # (b, 3 BLOCK)
        y = F.scaled_dot_product_attention(qb, keys, values, attn_mask=seen[:, None, None, :], dropout_p=self.dropout if self.training else 0.0)
        y = y.transpose(0, 1).reshape(self.heads, n, self.size).permute(1, 0, 2).reshape(n, -1)
        x = x + self.drop(lin(self.out, y))
        return x + self.drop(feed(self, self.norm2(x)))


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

    def forward(self, states, templates, rows, layout=None):
        """One document's lines; or a pack's, with `layout` (each document's templates a row of their places, padded,
        its real places and their places in the flat rows) read document by document."""
        if rows.shape[1] < self.row_width:
            rows = F.pad(rows, (0, self.row_width - rows.shape[1]))
        x = states.float()
        # The templates' buffers shaped from the rows (an exported graph reads the count of templates off its input).
        blank = (rows[:, :1].float() * 0).expand(-1, x.shape[1])
        total = blank.scatter_add(0, templates[:, None].expand(-1, x.shape[1]), x)
        count = (blank[:, 0] * 0).scatter_add(0, templates, torch.ones_like(x[:, 0]))
        node = self.pool(total / count[:, None].clamp(min=1)) + self.row(rows.float())
        if layout is None:
            node = self.encoder(node)
        else:
            at, valid, flat = layout
            node = take(node, at)
            for layer in self.encoder:
                node = layer(node, valid)
            node = node.reshape(-1, node.shape[-1])[flat]
        return states + self.back(node)[templates].to(states.dtype)


class Order(nn.Module):
    def __init__(self, d, regions=17):
        super().__init__()
        self.pool = nn.Sequential(nn.Linear(d, d), nn.Tanh(), nn.Linear(d, 1))
        self.role = nn.Sequential(nn.Embedding(regions, d), nn.ReLU(), nn.LayerNorm(d))
        self.fuse = nn.Linear(2 * d, d)
        self.encoder = nn.ModuleList([BlockLayer(d, 8, rotary=True) for _ in range(3)])
        self.goes_on, self.note_of, self.successor = PairHead(d), PairHead(d), PairHead(d)

    def forward(self, line_states, region_lines, line_region, region_roles, valid=None, seen=None, places=None, block_mask=None):
        """line_states (n, d), the lines in regions and each one's region (of m), the regions' roles -> region states
        (m, d): each region's attention-pooled state and role. A pack's regions come padded (`valid`), with the blocks
        each block sees (`seen`) and each region's place in its document (`places`)."""
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
        rope = rotary(x.shape[0], self.encoder[0].size, x.device, places)
        for layer in self.encoder:
            x = layer(x, valid, seen, rope, block_mask)
        return x[:m] if x.shape[0] != m else x


def tree_codes(templates, anchors, family, value, prefix, section, x0, size, looks, pages, roles):
    """Each node `i` against each node `j`, of one tree (n,) or of each of a batch of trees (k, n): their rows (..., n,
    n, 6) of Construct's pair tables (`Construct.table`, from `OFFSETS`), their outline anchors' step, factored grammar
    and geometry states, marker prefixes, distance in reading order and shared template (no 3D feature tensor held on
    large statutes)."""
    with torch.no_grad():
        col, row = (lambda t: t[..., :, None]), (lambda t: t[..., None, :])
        n = family.shape[-1]
        fi, fj = col(family), row(family)
        vi, vj = col(value), row(value)
        same_fam = (fi > 0) & (fi == fj)
        valid_v = (vi >= 0) & (vj >= 0)
        dv = vi - vj
        idx = torch.arange(n, device=family.device)
        earlier_same = same_fam & (idx[:, None] > idx)
        latest_j = torch.where(earlier_same, idx, -1).amax(dim=-1, keepdim=True)
        no_intervening = earlier_same & (idx == latest_j)
        del earlier_same, latest_j
        same_sec = col(section) == row(section)
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
        dx = col(x0) - row(x0)
        geom = torch.where(dx >= 0.015, 16, torch.where(dx <= -0.015, 32, 0))
        del dx
        geom = geom + (col(looks) == row(looks)).long() * 8
        geom = geom + (col(roles) == row(roles)).long() * 4
        geom = geom + (col(pages) == row(pages)).long() * 2 + same_sec.long()
        del same_sec
        pref = (col(prefix) - row(prefix)).clamp(-4, 4) + 4
        order_diff = (idx[:, None] - idx).clamp(min=0)
        dist = torch.clamp(torch.log2(order_diff.float() + 1.0).long(), 0, 15)
        del order_diff
        steps = row(anchors) - col(anchors) + ANCHORS - 1
        same = (col(templates) == row(templates)).long()
        return torch.stack([steps, g, geom, pref, dist.expand_as(g), same], dim=-1) + torch.tensor(OFFSETS, device=family.device)


def pair_bias(codes, table, x0, size, scale):
    """Every two nodes' biases on the parent and sibling scores: their codes' rows of the pair tables summed, and the
    left-edge and size differences scaled. Compiled (`compiled`), the codes' rows are gathered and summed in one kernel:
    eager, the gathered (n, n, codes, 2) floats were held at once (a 5,000-node tree's, gigabytes)."""
    bias = F.embedding(codes.int(), table).sum(-2)
    dx = (x0[..., :, None] - x0[..., None, :]).clamp(-1.0, 1.0)
    ds = (size[..., :, None] - size[..., None, :]).clamp(-2.0, 2.0)
    return bias[..., 0] + dx * scale[0, 0] + ds * scale[1, 0], bias[..., 1] + dx * scale[0, 1] + ds * scale[1, 1]


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

    def table(self):
        """The pair tables end to end (the rows `tree_codes` names): outline steps, grammar, geometry, prefixes, distance,
        and a shared template's (none, then `same`)."""
        return torch.cat([self.levels.weight, self.grammar_rel.weight, self.geom_rel.weight, self.pref_rel.weight, self.dist_rel.weight,
                          torch.zeros_like(self.same)[None], self.same[None]])

    def nodes(self, states, heading_states, family, value, prefix, x0, size, roles, valid=None):
        """Each node's state through the tree's layers: its region's, its role's, marker's and geometry's, and its
        enclosing heading's; one tree (n, ...) or a batch of trees (k, n, ...), `valid` their real nodes."""
        node_feat = torch.stack([
            x0.float(),
            size.float(),
            ((family > 0) & (value == 1)).float(),
            prefix.clamp(0, 4).float() / 4.0,
        ], dim=-1)
        extra = self.node_role(roles.clamp(0, 16)) + self.node_fam(family.clamp(0, 63)) + self.node_geom(node_feat) + self.enclosing(heading_states.float())
        states = states + self.extra_drop(extra.to(states.dtype))
        rope = rotary(states.shape[-2], self.layers[0].size, states.device)
        for layer in self.layers:
            states = layer(states, valid, rope)
        return states

    def forward(self, states, heading_states, templates, anchors, family, value, prefix, section, x0, size, looks, pages, roles,
                valid=None, codes=None):
        """Every node's parent and left sibling scores among the nodes and its gap: one tree (n, ...), or a batch of
        trees (k, n, ...), `valid` their real nodes and `codes` their pair codes where kept (`tree_codes`)."""
        states = self.nodes(states, heading_states, family, value, prefix, x0, size, roles, valid)
        if codes is None:
            codes = tree_codes(templates, anchors, family, value, prefix, section, x0, size, looks, pages, roles)
        p, s = self.parent(states), self.sibling(states)
        p_bias, s_bias = pair_bias(codes, self.table(), x0, size, self.cont_scale)
        return p + p_bias.to(p.dtype), s + s_bias.to(s.dtype), self.gap(states)


BYTE = 8 / 127  # a feature byte's step: the parser's features are bytes on their scales (`doc::scale`), each within ±8
AROUND, MARKER = range(0, 20), range(72, 92)  # the features read again off the lines around a line: its place and type, its marker's
CONTEXT = 4 * (len(AROUND) + len(MARKER)) + 2 + 4  # the two lines before and after, whether the next and previous are on its page, the document's shape


class Context(nn.Module):
    """What Detect reads of each line from the parser's bytes: its own features, those of the two lines before and after it
    in reading order within its document (`AROUND` and `MARKER` of each; -8 past the document's edges), whether the lines
    before and after are on its page, and its document's shape. Made here from each line's own, not copied onto every
    line by the parser: the fit's step and the engine (`context.onnx`, a document at a time) read it the same."""

    def forward(self, own, docs, pages, shape):
        x = own.float() * BYTE
        n = x.shape[0]
        at = torch.arange(n, device=x.device)
        cols = torch.tensor(list(AROUND) + list(MARKER), device=x.device)
        parts = [x]
        for offset in (-1, 1, -2, 2):
            other = (at + offset).clamp(0, n - 1)
            inside = (at + offset >= 0) & (at + offset < n) & (docs[other] == docs)
            parts.append(torch.where(inside[:, None], x[other][:, cols], torch.full_like(x[:, cols], -8.0)))
        for offset in (-1, 1):
            other = (at + offset).clamp(0, n - 1)
            parts.append(((at + offset >= 0) & (at + offset < n) & (docs[other] == docs) & (pages[other] == pages)).float()[:, None])
        parts.append(shape.float()[docs] * BYTE)
        return torch.cat(parts, dim=-1)


class Text(nn.Module):
    """Each line's text vector as Model2Vec reads one, from its tokens (the parser's `TextModel::tokens`, `lines` each
    token's line): their vectors averaged, scaled to unit length where the model normalizes; a line of no tokens nought.
    The vectors are the text model's (`embeddings.f32`), held fixed: the fit's step and the engine (`TextModel::vectors`, over the same folder) read the same."""

    def __init__(self, folder):
        super().__init__()
        settings = json.load(open(os.path.join(folder, "docparse.json"), encoding="utf-8"))
        table = np.fromfile(os.path.join(folder, "embeddings.f32"), dtype="<f4").reshape(settings["vocabulary"], -1)
        self.register_buffer("table", torch.from_numpy(table.copy()), persistent=False)
        self.normalize = bool(settings["normalize"])
        self.dim = table.shape[1]

    def forward(self, tokens, lines, counts):
        n = counts.shape[0]
        summed = torch.zeros(n, self.dim, device=self.table.device, dtype=self.table.dtype)
        summed = summed.scatter_add(0, lines.long()[:, None].expand(-1, self.dim), self.table[tokens.long()])
        mean = summed / counts.float().clamp(min=1)[:, None]
        return mean / (mean.norm(dim=-1, keepdim=True) + 1e-32) if self.normalize else mean


class DocParser(nn.Module):
    def __init__(self, own, text, d, row_width=0):
        super().__init__()
        self.context, self.text = Context(), Text(text)
        self.detect = Detect(own + CONTEXT, self.text.dim, d)
        self.templates = Templates(d, row_width)
        self.order = Order(d)
        self.headings, self.bodies = Construct(d), Construct(d)


def model_of(saved, text):
    """A fitted checkpoint's model, on the host, over the text model folder its training data was tokenized with (`text`): the parser's own width is what its weights read (Detect's input, the
    context's columns aside)."""
    state = saved["model"]
    model = DocParser(state["detect.look.0.weight"].shape[1] - CONTEXT, text, saved["width"], saved.get("row_width", 0))
    # (A checkpoint fitted before Order's pair heads had their far bias reads as one whose window holds every pair.)
    missing, unexpected = model.load_state_dict(state, strict=False)
    if unexpected or any(not key.endswith(".far") for key in missing):
        raise SystemExit(f"the checkpoint does not fit the model: missing {missing}, unexpected {unexpected}")
    return model


# ----------------------------------------------------------------------------------------------- training
def autocast():
    return torch.autocast(DEVICE, dtype=torch.bfloat16)


FLEX = {}  # FlexAttention compiled ("attention", "mask"), where the fit turns it on (`--flex`, with Triton)


def page_mask(p):
    """The pack's FlexAttention block mask (each line seeing its own page's lines), made once and kept on the pack;
    none where FlexAttention is off."""
    if "attention" not in FLEX:
        return None
    if getattr(p, "page_block_mask", None) is None:
        page = p.line_page
        n = page.shape[0]
        # Built block by block (`_compile`): never the line-by-line matrix, which a pack's 48,000 lines would not fit.
        p.page_block_mask = FLEX["mask"](lambda b, h, q, kv: page[q] == page[kv], None, None, n, n, device=page.device, _compile=True)
    return p.page_block_mask


# The lines near enough a line for the line heads' spatial term: within this many places of it on its page, in reading
# order (on the packs' gold, 2026-11-14, 99.74% of successor and predecessor links). Every line of the page stays a
# candidate, scored by its query and key alone beyond the window (with the head's `far` bias): no link is out of reach,
# and the spatial network's cost is fixed a line, not its page's length.
LINE_WINDOW = [32]
ORDER_WINDOW = [16]  # the regions either side, in reading order, an Order pair reads its pair term within (`PairHead`)


def flat_pairs(p):
    """Every two lines of each page of a pack, flat (each line's candidates its page's lines, in order), and each line's
    gold link as a place among them, made on the pack's device once and kept on it: what the flat line links
    (`--link-pairs flat`) read."""
    if getattr(p, "flat", None) is None:
        page = p.line_page.long()
        n = page.shape[0]
        first = torch.ones(n, dtype=torch.bool, device=page.device)
        first[1:] = page[1:] != page[:-1]
        run = torch.cumsum(first.long(), 0) - 1
        start = torch.cummax(torch.where(first, torch.arange(n, device=page.device), 0), 0).values
        length = torch.bincount(run)[run]
        base = torch.cumsum(length, 0) - length
        i = torch.repeat_interleave(torch.arange(n, device=page.device), length)
        j = start[i] + torch.arange(i.shape[0], device=page.device) - base[i]
        pair = lambda gold: torch.where(gold >= 0, base + gold - start, -100)
        p.flat = (i.int(), j.int(), pair(p.successor), pair(p.predecessor))
    return p.flat


UPPER = {}  # each tree size's later-node mask on its device (`upper`)


def upper(n, device):
    """The nodes after each node of an n-node tree: the parent and sibling scores leave them out."""
    key = (n, str(device))
    if key not in UPPER:
        UPPER[key] = torch.ones(n, n, dtype=torch.bool, device=device).triu(1)
    return UPPER[key]


def order_mask(p):
    """Order's block mask over a pack's regions: a region sees the regions of its own document in its block and the
    blocks either side (`BlockLayer`'s window), real ones only; none where FlexAttention is off."""
    if "attention" not in FLEX:
        return None
    if getattr(p, "order_block_mask", None) is None:
        doc, valid, n = p.region_doc, p.region_valid, p.region_valid.shape[0]
        p.order_block_mask = FLEX["mask"](lambda b, h, q, kv: (doc[q] == doc[kv]) & ((q // BLOCK - kv // BLOCK).abs() <= 1) & valid[kv],
                                          None, None, n, n, device=valid.device, _compile=True)
    return p.order_block_mask


def line_states(model, p):
    """The pack's lines' states: Detect's over each page, given the stylesheet's (kept where those stages are fixed)."""
    if p.states is not None:
        return p.states
    features = model.context(p.own, p.line_doc, p.line_page, p.shape).to(torch.bfloat16)
    texts = model.text(p.tokens, p.token_lines, p.token_counts).to(torch.bfloat16)
    return model.templates(model.detect(features, texts, p.b, p.anchors, p.z, p.lines, page_mask(p)), p.templates, p.template_rows, p.template_layout)


def region_states(model, p, states):
    """The pack's regions' states, Order's (kept where Order is fixed too)."""
    if p.regions is not None:
        return p.regions
    return model.order(states, p.region_lines, p.line_region, p.region_role, p.region_valid, p.seen, p.order_places, order_mask(p))


def keep_states(model, p, regions):
    """The fixed stages' outputs kept in the pack in place of their inputs, read once in evaluation mode: the lines'
    states (Detect's and the stylesheet's), or with `regions` the regions' (Order's)."""
    model.eval()
    with torch.no_grad(), autocast():
        states = line_states(model, p)
        if regions:
            p.regions = region_states(model, p, states).to(torch.bfloat16)
            p.region_lines = p.line_region = p.region_role = p.seen = p.order_places = None
        else:
            p.states = states.to(torch.bfloat16)
        p.own = p.tokens = p.token_lines = p.token_counts = p.shape = p.z = p.b = p.lines = p.templates = p.template_rows = p.template_layout = None


KERNELS = {}  # the Triton kernels in use (`docparse_kernels`), each checked against its reference first (`check_kernels`)


def spatial_term(head, boxes, i, j):
    """A relation head's spatial term over the pairs (i, j): its small network over the pairs' measures, in one kernel
    where checked (`docparse_kernels.spatial`, nothing a pair kept), else recomputed in the backward pass rather than kept
    (each pair's 64 hidden values, millions of pairs a pack, never held)."""
    if "spatial" in KERNELS:
        return KERNELS["spatial"](head, boxes, i, j)
    return torch.utils.checkpoint.checkpoint(lambda a, b: head.r(measures(a, b)).squeeze(-1), boxes[i], boxes[j], use_reentrant=False)


def check_kernels(model, p):
    """The Triton kernels tried on a pack's own pairs against their references (scores, losses and every gradient within
    a tolerance, and their time): each that agrees and is faster is used, each other left out and said so."""
    try:
        import docparse_kernels as kernels
    except Exception as error:  # no Triton, or the kernels do not build
        print(f"kernels off: {error}", flush=True)
        return
    head, (i, j, successor_pair, _) = model.detect.successor, flat_pairs(p)
    # Whole rows only: the first rows' pairs up to some 200,000, a row cut part-way taken out (its gold could lie past the
    # cut, and the check then compared a row the reference and the kernel each see half of).
    cut = min(int(i.shape[0]), 200000)
    last = int(i[cut - 1])
    cut = int(torch.searchsorted(i[:cut].contiguous(), torch.tensor([last], device=i.device, dtype=i.dtype)).item()) if cut < i.shape[0] else cut
    take = slice(0, max(cut, 1))
    i, j = i[take], j[take]
    near = lambda a, b: float((a - b).abs().max()) <= 1e-3 * max(1.0, float(b.abs().max()))

    def faster(kernel, reference, reps=3):
        """Whether `kernel` (a forward and backward) runs faster than `reference` on the device, each timed after a run."""
        times = []
        for f in (kernel, reference):
            f()
            torch.cuda.synchronize()
            started = time.perf_counter()
            for _ in range(reps):
                f()
            torch.cuda.synchronize()
            times.append(time.perf_counter() - started)
        print(f"  kernel {times[0] / reps * 1000:.1f} ms, reference {times[1] / reps * 1000:.1f} ms", flush=True)
        return times[0] < times[1]
    # The spatial term and its network's gradients.
    try:
        ref = head.r(measures(p.b[i], p.b[j])).squeeze(-1)
        grads_ref = torch.autograd.grad(ref.sum(), list(head.r.parameters()))
        got = kernels.spatial(head, p.b, i, j)
        grads_got = torch.autograd.grad(got.sum(), list(head.r.parameters()))
        parameters = list(head.r.parameters())
        if not (near(got, ref.float()) and all(near(a, b) for a, b in zip(grads_got, grads_ref))):
            print("kernel off: the spatial term disagrees with its reference", flush=True)
        elif faster(lambda: torch.autograd.grad(kernels.spatial(head, p.b, i, j).sum(), parameters),
                    lambda: torch.autograd.grad(spatial_term(head, p.b, i, j).sum(), parameters)):
            KERNELS["spatial"] = kernels.spatial
        else:
            print("kernel off: the spatial term is slower than its reference", flush=True)
    except Exception as error:  # the kernel does not compile or run here: its reference stays
        print(f"kernel off: the spatial term fails: {str(error).splitlines()[0][:200]}", flush=True)
    # The rows' cross-entropy and its gradient, on scores of the pack's own pairs.
    try:
        rows = int(i.max()) + 1
        target = torch.where((successor_pair[:rows] >= 0) & (successor_pair[:rows] < take.stop), successor_pair[:rows], -1)
        w = torch.rand(rows, device=i.device) * (target >= 0)  # as the fit weighs them: a row with no gold none (`share`)
        x = torch.randn(i.shape[0], device=i.device, requires_grad=True)
        ref = row_loss(x, i, target, w)
        (g_ref,) = torch.autograd.grad(ref, x)
        got = kernels.row_loss(x, i, target, w)
        (g_got,) = torch.autograd.grad(got, x)
        if not (near(got, ref) and near(g_got, g_ref)):
            print("kernel off: the rows' cross-entropy disagrees with its reference", flush=True)
        elif faster(lambda: torch.autograd.grad(kernels.row_loss(x, i, target, w), x), lambda: torch.autograd.grad(row_loss(x, i, target, w), x)):
            KERNELS["row_loss"] = kernels.row_loss
        else:
            print("kernel off: the rows' cross-entropy is slower than its reference", flush=True)
    except Exception as error:
        print(f"kernel off: the rows' cross-entropy fails: {str(error).splitlines()[0][:200]}", flush=True)
    print(f"kernels on: {sorted(KERNELS)}", flush=True)

def page_term(r, boxes):
    """A page batch's spatial term over every two of its places: the 18 measures of each two boxes and the head's small
    network over them (`r`). Compiled (`compiled`), measures, hidden units and score fuse into a few kernels."""
    return r(spatial(boxes, boxes)).squeeze(-1)


LINK_PAIRS = ["pages"]  # the line links read page block by page block (`page_links`), or "flat" (`pair_dot` over every pair, `--link-pairs`)


def page_links(heads, states, boxes, paged):
    """The line-link heads (`heads`, by name) read page by page in batched passes: each batch's pages a padded block of
    their lines, its q·k scores one batched product on the tensor cores and its spatial term over every two places of
    the block (`spatial`, recomputed in the backward, not kept), the padding masked. No pair is gathered and nothing
    waits on the device: the pages' pairs are every two of their lines, a dense block each (the flat pairs' gathers and
    scattered sums were most of a step's device time). Each batch and its heads' logits (its real lines against its
    row's places)."""
    out = []
    for batch in paged.batches:
        r = batch.rows.clamp(min=0)
        x, b, width = take(states, r), take(boxes, r).float(), r.shape[1]
        logits = {}
        places = torch.arange(width, device=x.device)
        near = (places[:, None] - places[None, :]).abs() <= LINE_WINDOW[0]
        for name, head in heads.items():
            f = head.q(x) @ head.k(x).transpose(-1, -2) / x.shape[-1] ** 0.5
            term = torch.utils.checkpoint.checkpoint(page_term, head.r, b, use_reentrant=False)
            f = f.float() + torch.where(near, term.float(), head.far.float())
            logits[name] = f.masked_fill(~batch.valid[:, None, :], -1e4).reshape(-1, width)[batch.valid_at]
        out.append((batch, logits))
    return out

def run(model, p, heads):
    """The pack's outputs for `heads` (those its gold has, `heads`): the line heads' (role and flag logits, each page
    batch's link logits), the region heads' pair scores and the trees' (parent, sibling, gap), each stage read once."""
    heads = heads & p.has
    out = {"heads": heads}
    states = None if p.regions is not None else line_states(model, p)
    if heads & LINES:
        # The role and flag heads in one product (their weights stacked; the checkpoint and the export keep them apart).
        both = F.linear(states, torch.cat([model.detect.role.weight, model.detect.flags.weight]), torch.cat([model.detect.role.bias, model.detect.flags.bias])).float()
        out["role"], out["flags"] = both[:, :CLASSES], both[:, CLASSES:]
        links = {name: getattr(model.detect, name) for name in ("successor", "predecessor") if name in heads}
        if links and LINK_PAIRS[0] == "flat" and "attention" in FLEX:
            # Compiled, the pairs flat: each pair's product and spatial term read straight off the lines (Inductor
            # gathers inside its kernels), one call for every page, no loop over the pages' batches.
            x, scale = states, states.shape[-1] ** 0.5
            for name, head in links.items():
                q, k = head.q(x), head.k(x)
                lp_i, lp_j = flat_pairs(p)[:2]
                near = (lp_i.long() - lp_j.long()).abs() <= LINE_WINDOW[0]
                out[f"flat_{name}"] = pair_dot(q, k, lp_i, lp_j) / scale + torch.where(near, spatial_term(head, p.b, lp_i, lp_j), head.far)
        elif links:
            out["links"] = page_links(links, states, p.b, p.lines)
    if heads - LINES:
        regions = region_states(model, p, states)
        measured = pair_measures(p) if PAIRS.keys() & heads else None
        for name in PAIRS.keys() & heads:
            out[name] = getattr(model.order, PAIRS[name])(regions, (p.pair_i, p.pair_j, measured))
        for name, construct in (("heading", model.headings), ("body", model.bodies)):
            if name in heads:
                out[name] = [construct(take(regions, t.nodes), torch.where((t.enclosing >= 0)[..., None], take(regions, t.enclosing.clamp(min=0)), 0),
                                       *t.inputs, valid=t.valid, codes=t.codes) for t in getattr(p, name)]
    return out


def link_loss(f, gold, w):
    return (F.cross_entropy(f, gold, ignore_index=-100, reduction="none") * w).sum()


# A line starting a constituent document weighed this many times a line that does not (`--start-weight`). Starts are
# rare (277 in 120 hand-gold development documents) and read unweighed the head fired on 72 (2026-11-13, 32 right);
# with gold starts the document layer went from 0.15 to 0.95.
START_WEIGHT = [1.0]


def two_way(flag, gold, w, positive=1.0):
    weight = None if positive == 1.0 else torch.tensor([1.0, positive], device=flag.device, dtype=flag.dtype)
    return (F.cross_entropy(torch.stack([torch.zeros_like(flag), flag], dim=1), gold, weight=weight, ignore_index=-100, reduction="none") * w).sum()


def role_loss(role, gold, free, w):
    """Each line's role against its gold; a line `free` against any of `UNMARKED`, opening or not as the gold says, leaning to text:
    with nothing holding it to text a plain paragraph drifts to a list item."""
    log = F.log_softmax(role, dim=1)
    g = gold.clamp(min=0)
    allowed = log.gather(1, torch.stack([region * 2 + g % 2 for region in UNMARKED], dim=1))
    held = torch.where(free, torch.logsumexp(allowed, dim=1) + TEXT_PULL * allowed[:, 0], log.gather(1, g[:, None])[:, 0])
    return -(held * w).sum()


def tree_loss(name, p, s, g, parent, sibling, sibling_from, gap, upper):
    """A batch of trees' losses, each the sum over its trees of their means over the nodes their gold answers (-100
    none): each node's parent, its gap, and its left sibling, one of the nodes from `sibling_from` to `sibling` (the
    one where they are the same)."""
    mean = lambda loss, known: (loss / known.sum(-1, keepdim=True).clamp(min=1)).sum()
    ce = lambda f, gold, **kw: F.cross_entropy(f.flatten(0, 1), gold.flatten(), ignore_index=-100, reduction="none", **kw).view_as(gold)
    known = sibling != -100
    log = F.log_softmax(s.float().masked_fill(upper, -1e4), dim=-1)
    cols = torch.arange(log.shape[-1], device=log.device)
    among = ((cols >= sibling_from[..., None]) & (cols <= sibling[..., None])) | ~known[..., None]
    left = torch.where(known, -torch.logsumexp(log.masked_fill(~among, float("-inf")), dim=-1), 0.0)
    return {f"{name}_parent": mean(ce(p.float().masked_fill(upper, -1e4), parent), parent != -100),
            f"{name}_gap": mean(ce(g.float(), gap, label_smoothing=0.01), gap != -100), f"{name}_sibling": mean(left, known)}


def losses(out, p):
    """Each head's loss over the pack: the sum over its documents of each one's mean."""
    heads, parts = out["heads"], {}
    if "role" in heads:
        parts["role"] = role_loss(out["role"], p.role, p.free, p.w.role)
    for column, name in enumerate(("marked", "start")):
        if name in heads:
            parts[name] = two_way(out["flags"][:, column], getattr(p, name), getattr(p.w, name), START_WEIGHT[0] if name == "start" else 1.0)
    for name in ("successor", "predecessor"):
        if name in heads:
            if f"flat_{name}" in out:
                lp_i, _, successor_pair, predecessor_pair = flat_pairs(p)
                parts[name] = row_loss(out[f"flat_{name}"], lp_i, successor_pair if name == "successor" else predecessor_pair, getattr(p.w, name))
            else:
                parts[name] = sum(link_loss(f[name], getattr(batch, name), getattr(batch, f"w_{name}")) for batch, f in out["links"])
    for name in PAIRS.keys() & heads:
        parts[name] = row_loss(out[name], p.pair_i, getattr(p, f"{name}_pair"), getattr(p.w, name))
    for name in ("heading", "body"):
        if name in heads:
            for t, scores in zip(getattr(p, name), out[name]):
                for key, value in tree_loss(name, *scores, t.parent, t.sibling, t.sibling_from, t.gap, upper(t.valid.shape[1], t.valid.device)).items():
                    parts[key] = parts[key] + value if key in parts else value
    return parts


class Tally:
    """Heads' counts (right, total), summed on the device and read once (`read`)."""

    def __init__(self):
        self.counts = {}

    def add(self, name, right, total):
        c = self.counts.setdefault(name, [0, 0])
        c[0], c[1] = c[0] + right, c[1] + total

    def count(self, name, guess, gold, own=None):
        """A head's guesses against its gold (-100 none); with `own` (each place's own index), also on the places whose
        gold points past themselves (`<name>_links`)."""
        keep = gold != -100
        self.add(name, ((guess == gold) & keep).sum(), keep.sum())
        if own is not None:
            real = keep & (gold != own)
            self.add(f"{name}_links", ((guess == gold) & real).sum(), real.sum())

    def read(self):
        if not self.counts:
            return {}
        values = torch.stack([torch.as_tensor(v, device=DEVICE).double() for c in self.counts.values() for v in c]).cpu().tolist()
        return {name: (values[2 * i], values[2 * i + 1]) for i, name in enumerate(self.counts)}


def count_tree(tally, name, p, s, g, t):
    """A batch of trees' heads' accuracies, and apart those of the golds that give their bodies partly (`partial_`, out
    of the mean); a left sibling read right where it is one of the nodes its gold allows."""
    cols = torch.arange(t.valid.shape[1], device=p.device)
    later = upper(t.valid.shape[1], t.valid.device)
    parent, sibling = p.masked_fill(later, -1e4).argmax(-1), s.masked_fill(later, -1e4).argmax(-1)
    for prefix, held in (("", None), ("partial_", t.partial[:, None])):
        only = (lambda gold: gold) if held is None else (lambda gold: torch.where(held, gold, -100))
        tally.count(f"{prefix}{name}_parent", parent, only(t.parent), own=cols)
        tally.count(f"{prefix}{name}_gap", g.argmax(-1), only(t.gap))
        hi, lo = only(t.sibling), t.sibling_from
        keep = hi != -100
        right, real = keep & (sibling >= lo) & (sibling <= hi), keep & (lo != cols)
        tally.add(f"{prefix}{name}_sibling", right.sum(), keep.sum())
        tally.add(f"{prefix}{name}_sibling_links", (right & real).sum(), real.sum())


def evaluate(model, packs, heads):
    """Each of `heads` read on development's packs, the gold's regions and roles given to the later stages, its
    accuracy counted on the device and read once; and the heading openings' F1."""
    model.eval()
    tally = Tally()
    # no_grad, not inference_mode: what evaluation makes first and caches (rotary angles, the sparse layers' pruned weights)
    # is read by the training steps after it, and an inference tensor may never be saved for a backward.
    with torch.no_grad(), autocast():
        for p in packs:
            p = p if p.resident else moved(p, DEVICE)
            out = run(model, p, heads - {"predecessor"})
            if "role" in out:
                guess = out["role"].argmax(1)
                tally.count("role", guess, p.role_named)
                tally.count("marked", (out["flags"][:, 0] > 0).long(), p.marked)
                opening, guessed = p.role == HEADING * 2 + 1, guess == HEADING * 2 + 1
                tally.add("openings", (guessed & opening).sum(), opening.sum())
                tally.add("openings_guessed", (guessed & (p.role != -100)).sum(), 0)
            if "flat_successor" in out:
                n = p.successor.shape[0]
                tally.count("successor", row_choice(out["flat_successor"], *flat_pairs(p)[:2], n), p.successor, own=torch.arange(n, device=p.successor.device))
            for batch, f in out.get("links", ()):
                tally.count("successor", f["successor"].argmax(1), batch.successor, own=batch.own)
            m = p.region_valid.shape[0]
            for name in PAIRS.keys() & out.keys():
                tally.count(name, row_choice(out[name], p.pair_i, p.pair_j, m), getattr(p, name), own=torch.arange(m, device=p.region_valid.device))
            for name in ("heading", "body"):
                if name in out:
                    for t, scores in zip(getattr(p, name), out[name]):
                        count_tree(tally, name, *scores, t)
    counts = tally.read()
    report = {name: (right / max(total, 1), int(total)) for name, (right, total) in counts.items() if not name.startswith("openings")}
    if "openings" in counts:
        (tp, gold), guessed = counts["openings"], counts["openings_guessed"][0]
        report["heading_openings_f1"] = (2 * tp / max(gold + guessed, 1), int(gold))
    return report


def train_mode(model, trained):
    """The model in training mode, the stages not `trained` in evaluation mode (no dropout where nothing is fitted)."""
    model.train()
    for stage in set(STAGES) - trained:
        getattr(model, stage).eval()


def local_memory(release=False):
    """The device's per-thread stack (CUDA's local memory, which the driver reserves for every thread the card can hold
    and keeps at the largest a kernel has asked for): its size a thread, in bytes; with `release`, set back to CUDA's
    default first, the memory a spilling kernel grew it to handed back."""
    import ctypes
    import glob
    if "runtime" not in CUDART:
        found = glob.glob(os.path.join(os.path.dirname(torch.__file__), "lib", "cudart64_*.dll")) or ["libcudart.so"]
        CUDART["runtime"] = ctypes.CDLL(found[0])
    cudart = CUDART["runtime"]
    if release:
        torch.cuda.synchronize()
        cudart.cudaDeviceSetLimit(0, ctypes.c_size_t(1024))
    size = ctypes.c_size_t(0)
    cudart.cudaDeviceGetLimit(ctypes.byref(size), 0)
    return size.value


CUDART = {}  # the CUDA runtime's library, opened by `local_memory`


def preflight(model, p, heads, capacity, limit=0.85):
    """A full step (forward and backward, no update) on a pack, its peak device memory and time; the fit stops if it
    comes within `limit` of the device's memory. The memory the step takes beyond what it found held."""
    torch.cuda.reset_peak_memory_stats()
    held, started = torch.cuda.memory_allocated(), time.time()
    with autocast():
        parts = losses(run(model, p, heads), p)
    (sum(parts.values()) / p.k).backward()
    model.zero_grad(set_to_none=True)
    torch.cuda.synchronize()
    peak = torch.cuda.max_memory_allocated()
    stack = local_memory()
    free = torch.cuda.mem_get_info()[0]
    local_memory(release=True)
    print(f"  preflight {p.k} documents ({', '.join(f'{v} {k}' for k, v in p.size.items())}): peak {peak / capacity:.0%} of the device, {time.time() - started:.2f}s; "
          f"stack {stack} bytes a thread, {free / 2**30:.2f} GiB free, {torch.cuda.mem_get_info()[0] / 2**30:.2f} after its release", flush=True)
    if peak > limit * capacity:
        raise SystemExit(f"preflight: a step takes {peak / capacity:.0%} of the device's memory, over {limit:.0%}")
    return peak - held

BEGAN = time.time()  # the process's start, for the start-up's own time (`main`)
BUDGET = [0]  # the device memory this fit may use, in bytes (set in `main`, read by `build`)


def build(model, packs, heads, trained, extra=None):
    """The packs placed: the heaviest first (by lines, regions, body nodes and line pairs), each one's step tried
    (`preflight`) unless `extra` (the heaviest step's own memory) is given; the fixed stages' outputs kept in each
    (`keep_states`); each held on the device while it holds it beside the heaviest step, else its file mapped (copied in
    through `Prefetch`'s staging each step). The packs, and the heaviest step's memory."""
    heavy = []
    for key in ("lines", "regions", "body nodes", "line pairs") if extra is None else ():
        heavy += [i for i in sorted(range(len(packs)), key=lambda i: packs[i].size[key], reverse=True)[:2] if i not in heavy]
    capacity = BUDGET[0] if DEVICE == "cuda" else 0
    fixed = None if trained & {"detect", "templates"} else "lines" if "order" in trained else "regions"
    placed, extra, largest = [None] * len(packs), extra or 0, 0
    for i in heavy + [i for i in range(len(packs)) if i not in heavy]:
        before = torch.cuda.memory_allocated() if capacity else 0
        p = moved(packs[i], DEVICE)
        p.resident = True
        if fixed:
            keep_states(model, p, fixed == "regions")
            train_mode(model, trained)
        if capacity:
            largest = max(largest, torch.cuda.memory_allocated() - before)
        if i in heavy and capacity:
            # Always tried: the heaviest packs' steps first compile each graph with its sizes dynamic, so the epoch after
            # them meets no recompiles.
            extra = max(extra, preflight(model, p, heads, capacity))
            torch.cuda.empty_cache()
        # To 85% of the budget: a step past its preflight's measure leaves the allocator room.
        if capacity and torch.cuda.memory_allocated() + extra + 2 * largest > 0.85 * capacity:
            p = moved(p, "cpu") if fixed else packs[i]
            p.resident = False
        placed[i] = p
    return placed, extra


COMPILE_UNIT = ["layers"]  # what torch.compile takes as one graph: each transformer "layers", or the model's "stages" (`--compile-unit`; run 14: 3 s an epoch faster once compiled, 400 s more to compile, memory at its cap)


EAGER = {}  # each function `compiled` swapped for its compiled form, as written: the export traces these, not dynamo's


def compiled(model, flex=True, cudagraphs=False):
    """torch.compile, with dynamic shapes, over the transformer layers, the pair measures, the trees' codes and the
    losses; with `flex`, Detect's attention over a pack's pages in one FlexAttention call; with `cudagraphs`, the
    layers' kernels replayed as CUDA graphs (reduce-overhead: each pack's shapes recorded once, replayed each epoch).
    Left off (and said so) where the platform has no compiler for it (no Triton for the GPU), and any graph that fails
    to compile run as it is (dynamo's own fallback, logged)."""
    try:
        import torch._dynamo
        from torch.utils._triton import has_triton
        if DEVICE == "cuda" and not has_triton():
            print("torch.compile off: no Triton for the GPU", flush=True)
            return
        torch._dynamo.config.suppress_errors = True
        for name in ("cache_size_limit", "recompile_limit"):
            if hasattr(torch._dynamo.config, name):
                setattr(torch._dynamo.config, name, 64)
        if COMPILE_UNIT[0] == "stages":
            # Each stage one graph (Detect, the stylesheet, Order, the two trees): a handful of guard checks and graph
            # boundaries a step, not one a layer, and the norms and residuals fused across the layers' joins.
            for stage in (model.detect, model.templates, model.order, model.headings, model.bodies):
                stage.compile(dynamic=True)
        else:
            for module in model.modules():
                if isinstance(module, Layer):
                    module.compile(dynamic=True, mode="reduce-overhead" if cudagraphs else None)
        for name in ("measures", "page_term", "pair_dot", "tree_codes", "pair_bias", "role_loss", "two_way", "link_loss", "row_loss", "tree_loss", "region_pairs"):
            EAGER.setdefault(name, globals()[name])
            globals()[name] = torch.compile(EAGER[name], dynamic=True)
        if flex and DEVICE == "cuda":
            from torch.nn.attention.flex_attention import create_block_mask, flex_attention
            FLEX["attention"], FLEX["mask"] = torch.compile(flex_attention, dynamic=True), create_block_mask
        print(f"torch.compile on{', FlexAttention' if FLEX else ''}{', CUDA graphs' if cudagraphs else ''}", flush=True)
    except Exception as error:  # the fit goes on, eager
        print(f"torch.compile off: {error}", flush=True)

def main():
    parser = argparse.ArgumentParser(prog="docparse.py fit")
    parser.add_argument("command", choices=["fit"])
    # The packs and their manifest (`structure-gold training`): the stages fitted, the heads, the statistics, the epochs.
    parser.add_argument("packs")
    parser.add_argument("out")
    parser.add_argument("--width", type=int, default=None)  # --init's own where not given, else 256
    # A fitted checkpoint to start from (its weights where their shapes match, its feature statistics), at a tenth of the
    # learning rate and a short warm-up: a gold or label change refits in a few epochs, not ten from nothing.
    parser.add_argument("--init")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--lr", type=float, default=None)  # one document a step's; a pack's times the root of its documents
    # Muon (Jordan et al. 2024; torch.optim.Muon) for the transformer layers' matrices, AdamW for the rest; or AdamW alone.
    parser.add_argument("--optimizer", choices=["muon", "adamw"], default="muon")
    # Detect's attention over every page of a pack in one call (FlexAttention, a block mask by page) where it compiles.
    parser.add_argument("--flex", action=argparse.BooleanOptionalAction, default=True)
    # CUDA graphs over the compiled layers (torch.compile's reduce-overhead): a pack's shapes recur every epoch.
    # Off by default, as measured on 2026-11-13: whole-step compile over static buckets compiles every shape combination
    # (an epoch past 35 min), CUDA graphs save at most the launches of a step the device is 94% busy for, and autotuning
    # costs minutes a shape. The default is per-layer compile with dynamic shapes (an epoch 18-21 s).
    parser.add_argument("--cudagraphs", action=argparse.BooleanOptionalAction, default=False)
    # The whole step (forward and losses) one compiled graph, not the layers alone: fewer, larger kernels, where the packs'
    # Python values (documents, heads) give few variants.
    parser.add_argument("--compile-step", action=argparse.BooleanOptionalAction, default=False)
    # The Triton kernels (`docparse_kernels`: the pairs' spatial term, the rows' cross-entropy), each checked first.
    # The Triton kernels off by default: at their last check one lost (the spatial term, 6x slower) and one tied (the rows'
    # cross-entropy), and trying them costs every fit's start-up their compiles and timings.
    parser.add_argument("--kernels", action=argparse.BooleanOptionalAction, default=False)
    # 2:4 sparse layers off by default: a ten-epoch fit with them read development 0.850 in 200 s, without them 0.884 in
    # 174 s (2026-11-13): the products' speed-up never reached a step bound by its host, and half of each matrix held at
    # nought cost the model.
    parser.add_argument("--sparse24", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--link-pairs", choices=("pages", "flat"), default="pages")
    parser.add_argument("--compile-unit", choices=("stages", "layers"), default="layers")
    # Detect and the stylesheet frozen mid-fit once their heads stop gaining, their line states kept (FreezeOut).
    parser.add_argument("--freeze", action=argparse.BooleanOptionalAction, default=True)
    # Inductor's autotuned kernels for the buckets' shapes (kept in its cache between fits).
    parser.add_argument("--autotune", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--schedule", choices=["wsd", "linear"], default="wsd")
    parser.add_argument("--warmup", type=float, default=None)  # epochs; a fifth from --init, else one
    parser.add_argument("--decay", type=float, default=0.3)  # the share of the steps the rate falls over, to nothing (wsd)
    parser.add_argument("--ema", type=float, default=0.998)  # the weights' moving average, evaluated and kept (0 none)
    # From the second epoch, the share of the packs under the median loss trained each epoch (1: all of them).
    # Every pack every epoch by default: training only the packs still above their median loss (0.5) starved the line
    # heads, whose packs read well early (2026-11-13, ten epochs graded: list items 0.599 against 0.646 with every pack,
    # body units 0.730 against 0.746), for 16% less time.
    parser.add_argument("--select", type=float, default=1.0)
    # The share of the device's memory this fit may take, so screening fits can share the one device side by side.
    parser.add_argument("--memory-share", type=float, default=1.0)
    parser.add_argument("--compile", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--log-steps", action="store_true")  # each step's documents, sizes and time, the device waited for
    parser.add_argument("--profile", type=int, default=0)  # torch.profiler over this many steps after the first five, OUT/profile.json
    parser.add_argument("--sync-debug", action="store_true")  # each wait on the device warned of, over the first three steps
    parser.add_argument("--start-weight", type=float, default=1.0)
    args = parser.parse_args()
    START_WEIGHT[0] = args.start_weight
    manifest = json.load(open(os.path.join(args.packs, "manifest.json"), encoding="utf-8"))
    plan, buckets = manifest["plan"], manifest["buckets"]
    epochs = len(plan)
    LINK_PAIRS[0] = args.link_pairs
    COMPILE_UNIT[0] = args.compile_unit
    trained, heads = set(manifest["train"]), set(manifest["heads"])
    if trained - set(STAGES) or (trained != set(STAGES) and not args.init):
        raise SystemExit(f"the packs' stages are of {STAGES}, fewer than all only from --init")
    # One memory budget for the whole fit, set before anything is placed: what the device has free now (the desktop's own
    # use of it under Windows left out) less a gibibyte the driver keeps for itself (the kernels' modules as they load,
    # cuBLAS's and cuSPARSELt's workspaces), within `--memory-share`. The allocator is held to it, so a step past it fails
    # as the allocator's own error (caught and skipped in the loop) and not the driver's; and the packs' placement and
    # the preflights (`build`) measure against the same figure (`BUDGET`).
    if DEVICE == "cuda":
        total = torch.cuda.get_device_properties(0).total_memory
        BUDGET[0] = int(min(total * args.memory_share, torch.cuda.mem_get_info()[0] - 2**30))
        torch.cuda.set_per_process_memory_fraction(BUDGET[0] / total)
        print(f"device budget {BUDGET[0] / 2**30:.2f} GiB of {total / 2**30:.2f}", flush=True)
    # The fit's own process at high priority: the thread launching the device's work is not descheduled behind others.
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x80)
    start = torch.load(args.init, map_location="cpu", weights_only=False) if args.init else None
    os.makedirs(args.out, exist_ok=True)
    train, dev = (load_packs(args.packs, manifest[key]) for key in ("train_packs", "dev_packs"))
    print("train kinds: " + ", ".join(f"{k} {sum(p.k for p in train if p.kind == k)}" for k in ("gold", "silver", "giant", "window")), flush=True)
    row_width = manifest["row_width"]
    # A fit from a checkpoint is of the checkpoint's width (its tensors would not fit another's).
    args.width = args.width or (start["width"] if start else 256)
    model = DocParser(manifest["width"], manifest["text"], args.width, row_width).to(DEVICE)
    if start:
        own = model.state_dict()
        kept = {k: v for k, v in start["model"].items() if k in own and own[k].shape == v.shape and not (args.reset and k.split(".")[0] in trained)}
        model.load_state_dict(kept, strict=False)
        fresh = [k for k in own if k not in kept]
        print(f"started from {args.init}: {len(kept)} tensors kept, {len(fresh)} new: {sorted({'.'.join(k.split('.')[:2]) for k in fresh})[:12]}", flush=True)
    for stage in set(STAGES) - trained:
        getattr(model, stage).requires_grad_(False)
    ema = copy.deepcopy(model).requires_grad_(False) if args.ema else None
    if args.compile:
        # The layers' own CUDA graphs only where the whole step is not one (`--compile-step`, below).
        compiled(model, args.flex, args.cudagraphs and not args.compile_step)
    train_mode(model, trained)
    train, extra = build(model, train, heads, trained)
    dev, _ = build(model, dev, heads, trained, extra)
    # The packs never go away: the collector leaves them out of its passes over the steps' objects.
    gc.collect()
    gc.freeze()
    documents = sum(p.k for p in train)
    per_step = documents / max(len(train), 1)
    print(f"{documents} train documents in {len(train)} packs ({per_step:.1f} a step), {sum(p.k for p in dev)} development in {len(dev)}; "
          f"{sum(p.resident for p in train + dev)} of {len(train) + len(dev)} packs held on the device"
          + (f", {torch.cuda.memory_allocated() / 2**30:.2f} GiB" if DEVICE == "cuda" else ""), flush=True)
    # Development's heaviest pack read once before training, so a fault in the evaluation shows before an epoch is spent.
    started = time.time()
    heaviest = max(dev, key=lambda p: p.size["lines"])
    if DEVICE == "cuda":
        torch.cuda.empty_cache()
        print(f"  development's heaviest pack: {heaviest.k} documents, {heaviest.size["lines"]} lines; "
              f"{torch.cuda.mem_get_info()[0] / 2**30:.2f} GiB free on the device, {torch.cuda.memory_allocated() / 2**30:.2f} "
              f"allocated, {torch.cuda.memory_reserved() / 2**30:.2f} reserved", flush=True)
        torch.cuda.reset_peak_memory_stats()
        try:
            evaluate(model, [heaviest], heads)
        except Exception:
            print(f"  failed with stack {local_memory()} bytes a thread, {torch.cuda.mem_get_info()[0] / 2**30:.2f} GiB free, peak {torch.cuda.max_memory_allocated() / 2**30:.2f} "
                  f"allocated, {torch.cuda.max_memory_reserved() / 2**30:.2f} reserved", flush=True)
            print(torch.cuda.memory_summary(abbreviated=True), flush=True)
            raise
    print(f"  preflight development: {len(evaluate(model, [heaviest], heads))} heads read, {time.time() - started:.0f}s, "
          f"peak {torch.cuda.max_memory_allocated() / torch.cuda.get_device_properties(0).total_memory:.0%} of the device" if DEVICE == "cuda" else "", flush=True)
    train_mode(model, trained)
    # The Triton kernels, where they agree with their references on a pack of this fit's own (`check_kernels`).
    # 2:4 sparsity on the layers' matrices (`docparse_sparse`), where its extension builds and agrees with the dense product.
    if args.sparse24 and DEVICE == "cuda":
        try:
            import docparse_sparse
            difference = docparse_sparse.check()
            if difference < 0.02:
                SPARSE.update(linear=docparse_sparse.linear, suits=docparse_sparse.suits, prune=docparse_sparse.prune, refresh=docparse_sparse.refresh)
                SPARSE["names"] = sparse_names(model)
                SPARSE["weights"] = [w for n, w in model.named_parameters() if n in SPARSE["names"]]
                docparse_sparse.refresh(SPARSE["weights"])
            print(f"2:4 sparse layers {'on' if SPARSE else 'off'}: {len(SPARSE.get('names', ()))} matrices, difference {difference:.4f}", flush=True)
        except Exception as error:  # the extension not built here: dense
            print(f"2:4 sparse layers off: {error}", flush=True)
    if args.kernels and "attention" in FLEX:
        check_kernels(model, next(p for p in train if p.resident))
        if "row_loss" in KERNELS:
            globals()["row_loss"] = KERNELS["row_loss"]
    # AdamW, the rate scaled by the root of the documents a step (Malladi et al. 2022); a linear warm-up, then held and
    # a linear fall to nothing over the last steps (warm-up-stable-decay; `linear`, the paper's, falls from the warm-up).
    parameters = [p for p in model.parameters() if p.requires_grad]
    lr = (args.lr or (2e-5 if start and not args.reset else 2e-4)) * per_step ** 0.5
    # Muon's matrices: the transformer layers' (attention and feed-forward); the embeddings, norms, biases and heads AdamW's,
    # as Muon's authors use it. Its step scaled to AdamW's (`match_rms_adamw`), so one rate serves both.
    matrices = []
    if args.optimizer == "muon":
        for module in model.modules():
            if isinstance(module, Layer):
                matrices += [w for w in (module.qkv.weight, module.out.weight, module.feed[0].weight, module.feed[2].weight) if w.requires_grad]
    held = {id(w) for w in matrices}
    optimizers = [torch.optim.AdamW([p for p in parameters if id(p) not in held], lr=lr, weight_decay=1e-2, fused=DEVICE == "cuda")]
    if matrices:
        optimizers.append(Muon(matrices, lr=lr))
        print(f"Muon over {len(matrices)} matrices in {len(optimizers[-1].groups)} shapes, AdamW over the rest", flush=True)
    # From the second epoch, the packs the model already reads well (loss under the median of their last) trained only in
    # part (`--select` of them, others each epoch), the rest whole (Jiang et al. 2019, selective backprop; Mindermann et
    # al. 2022): the steps counted so for the rate's schedule.
    steps = sum(len(e) if k == 0 or args.select >= 1 else round(len(e) * (0.5 + 0.5 * args.select)) for k, e in enumerate(plan))
    print(f"steps an epoch: {', '.join(str(len(e)) for e in plan)} of {len(train)} packs", flush=True)
    warm = max(1, round((args.warmup if args.warmup is not None else 0.2 if start and not args.reset else 1.0) * steps / max(epochs, 1)))
    fall = steps - round(args.decay * steps) if args.schedule == "wsd" else warm
    rate = lambda s: min((s + 1) / warm, 1.0, max(0.0, (steps - s) / max(steps - fall, 1)))
    schedules = [torch.optim.lr_scheduler.LambdaLR(o, rate) for o in optimizers]
    print(f"learning rate {lr:.2e} ({args.schedule}): {warm} steps' warm-up, falling from step {fall} of {steps}", flush=True)
    averaged = [(e, q) for e, q in zip(ema.parameters(), model.parameters()) if q.requires_grad] if ema is not None else []
    kept_model = ema if ema is not None else model
    profiler = None
    if args.profile:
        # The operators' totals only, device and host, over a few steps: no trace file, no stacks or shapes (a 16 GB host
        # writing 25 steps' trace with stacks ran out of memory and stopped answering).
        def traced(prof):
            for side in ("device", "cpu"):
                print(prof.key_averages().table(sort_by=f"self_{side if DEVICE == 'cuda' or side == 'cpu' else 'cpu'}_time_total", row_limit=25), flush=True)
        activities = [torch.profiler.ProfilerActivity.CPU] + ([torch.profiler.ProfilerActivity.CUDA] if DEVICE == "cuda" else [])
        profiler = torch.profiler.profile(activities=activities, schedule=torch.profiler.schedule(wait=40, warmup=3, active=args.profile, repeat=1),
                                          on_trace_ready=traced)
        profiler.start()
    rng = np.random.default_rng(7)
    os.makedirs(args.out, exist_ok=True)
    last = max(1, math.ceil(args.decay * epochs))
    step, started, best, since = 0, time.time(), -1.0, 0
    print(f"start-up {started - BEGAN:.0f}s (reading, packs, preflights, compiles and checks before the first step)", flush=True)
    fetch = Prefetch(max((sum(-(-t.numel() * t.element_size() // 16) * 16 for t in tensors_of(p)) for p in train if not p.resident), default=0))
    saving = []  # the checkpoints being written in the background
    skipped = []  # the packs whose steps found no room on the device (`step skipped`)

    previous_line = None  # the line heads' loss the epoch before (`--freeze`)
    # Each pack's loss at its last step, read once an epoch; a pack not yet stepped counts as hard.
    last_loss = torch.full((len(train),), float("inf"), device=DEVICE)
    stepped = lambda m, q, h: losses(run(m, q, h), q)
    if args.compile_step and args.compile and DEVICE == "cuda":
        # With CUDA graphs, the whole step's forward and backward each one graph a pack's shapes, replayed every epoch:
        # a step's thousands of launches one (the layers' own graphs give way to it, `compiled`).
        # With the packs in buckets their shapes are fixed: static kernels, autotuned (max-autotune: Triton's matrix
        # products tried against cuBLAS for each bucket's shapes, CUDA graphs with them), the results kept in the cache.
        mode = "max-autotune" if args.autotune and args.cudagraphs else "max-autotune-no-cudagraphs" if args.autotune else "reduce-overhead" if args.cudagraphs else None
        stepped = torch.compile(stepped, dynamic=not buckets, mode=mode)
        print(f"the step compiled whole ({mode or 'default'}, {'static bucket shapes' if buckets else 'dynamic shapes'})", flush=True)
    for epoch in range(epochs):
        totals = {}
        picked = plan[epoch]
        if epoch and args.select < 1:
            seen = last_loss.cpu().numpy()
            middle = np.median(seen[picked])
            picked = [i for i in picked if seen[i] >= middle or rng.random() < args.select]
        order = rng.permutation(picked)
        pending = fetch.start(train[order[0]]) if len(order) else None
        for place, at in enumerate(order):
            p = train[at]
            if not heads & p.has:
                continue
            if args.sync_debug and DEVICE == "cuda" and step <= 3:
                torch.cuda.set_sync_debug_mode("warn" if step < 3 else 0)
            if args.log_steps:
                if DEVICE == "cuda":
                    torch.cuda.synchronize()
                began = time.perf_counter()
            q = fetch.take(pending)
            pending = None
            # The pack's block masks made before the step, outside its graph (kept on the pack): made inside, a CUDA
            # graph's capture would hold them as allocations that are not its outputs.
            if "attention" in FLEX:
                page_mask(q)
                if q.region_valid.shape[0] and heads & q.has - LINES:
                    order_mask(q)
            if args.cudagraphs:
                torch.compiler.cudagraph_mark_step_begin()
            try:
                with autocast():
                    parts = stepped(model, q, heads)
                # The next pack copied in while this one's backward runs.
                pending = fetch.start(train[order[place + 1]]) if place + 1 < len(order) else None
                for o in optimizers:
                    o.zero_grad()
                loss = sum(parts.values()) / q.k
                last_loss[at] = loss.detach().float()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(parameters, 1.0)
                for o, s in zip(optimizers, schedules):
                    if matrices and o is optimizers[-1]:
                        # Muon's momentum warmed up from 0.85 to 0.95 over the first 300 steps (the speedrun's schedule).
                        for group in o.param_groups:
                            group["momentum"] = 0.85 + 0.10 * min(1.0, step / 300)
                    o.step()
                    s.step()
                if SPARSE:
                    SPARSE["refresh"](SPARSE["weights"])
            except (torch.OutOfMemoryError, RuntimeError) as error:
                # A step the device has no room for is given up, not the fit: its graph and gradients let go, the
                # allocator's cache handed back, the pack and the memory said and counted (the epoch's line reports
                # them), and the next pack fetched as it would have been.
                if not isinstance(error, torch.OutOfMemoryError) and "out of memory" not in str(error):
                    raise
                parts = loss = None
                for o in optimizers:
                    o.zero_grad(set_to_none=True)
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
                skipped.append(p.shas)
                print(f"  step skipped, out of memory: {p.k} documents, " + ", ".join(f"{v} {k}" for k, v in p.size.items())
                      + f"; {torch.cuda.memory_allocated() / 2**30:.2f} GiB allocated, {torch.cuda.mem_get_info()[0] / 2**30:.2f} GiB free", flush=True)
                if pending is None and place + 1 < len(order):
                    pending = fetch.start(train[order[place + 1]])
                continue
            # The average moved every fourth step by the four steps' decay (a pass over the weights a step saved).
            if averaged and step % 4 == 3:
                torch._foreach_lerp_([e for e, _ in averaged], [q for _, q in averaged], 1 - min(args.ema, (1 + step) / (10 + step)) ** 4)
            for name, v in parts.items():
                totals[name] = totals.get(name, 0.0) + v.detach()
            step += 1
            if args.log_steps:
                if DEVICE == "cuda":
                    torch.cuda.synchronize()
                print(f"  step {step} {1000 * (time.perf_counter() - began):.1f} ms: {p.k} documents, " + ", ".join(f"{v} {k}" for k, v in p.size.items())
                      + ("" if p.resident else ", copied") + f" [{' '.join(s[:12] for s in p.shas)}]", flush=True)
            # The device's memory every 100 steps, logged or not (no sync: the allocator's own counts and the driver's free).
            if step % 100 == 0 and DEVICE == "cuda":
                print(f"  memory at step {step}: {torch.cuda.memory_allocated() / 2**30:.2f} GiB allocated, {torch.cuda.memory_reserved() / 2**30:.2f} "
                      f"reserved, peak {torch.cuda.max_memory_allocated() / 2**30:.2f}, {torch.cuda.mem_get_info()[0] / 2**30:.2f} free", flush=True)
                torch.cuda.reset_peak_memory_stats()
            if profiler:
                profiler.step()
                if step == 43 + args.profile:  # its wait (40 steps, past the shapes' first compiles) and warm-up (3) done
                    profiler.stop()
                    profiler = None
        names = sorted(totals)
        values = torch.stack([totals[n] for n in names]).cpu().tolist() if names else []
        if skipped:
            print(f"  {len(skipped)} steps skipped for memory this run so far", flush=True)
        print(f"epoch {epoch + 1} ({time.time() - started:.0f}s): " + " ".join(f"{n} {v / documents:.3f}" for n, v in zip(names, values)), flush=True)
        # Detect and the stylesheet frozen once their heads stop gaining (their loss down under 1% in an epoch; FreezeOut,
        # Brock et al. 2017; AutoFreeze, Liu et al. 2021): each pack's line states read once and kept, the later epochs
        # Order's and the trees' alone, no line touched again.
        line_loss = sum(v for n, v in zip(names, values) if n in LINES)
        if args.freeze and {"detect", "templates"} <= trained and epoch + 1 < epochs and previous_line is not None \
                and previous_line - line_loss < 0.01 * previous_line:
            if all(p.resident for p in train + dev):
                for stage in ("detect", "templates"):
                    getattr(model, stage).requires_grad_(False)
                trained -= {"detect", "templates"}
                heads -= LINES
                for p in train + dev:
                    keep_states(model, p, False)
                train_mode(model, trained)
                print(f"  Detect and the stylesheet frozen after epoch {epoch + 1}: their line states kept, {sum(bool(heads & p.has) for p in train)} packs train on", flush=True)
            else:
                print("  not frozen: some packs are not held on the device", flush=True)
        previous_line = line_loss
        # Development every fifth epoch and each epoch of the rate's fall, where the best stands (every epoch from
        # --init); the checkpoint kept is the best by its heads' mean accuracy.
        if not start and (epoch + 1) % 5 and epoch + 1 <= epochs - last:
            continue
        # A fixed half of development (every other pack) chooses the checkpoint, the same half each time; the last epoch
        # reads all of it too, for the report.
        evaluating = time.time()
        report = evaluate(kept_model, dev[::2], heads)
        print(f"  evaluated in {time.time() - evaluating:.1f}s", flush=True)
        if epoch + 1 == epochs:
            whole = evaluate(kept_model, dev, heads)
            print("  development whole: " + " ".join(f"{n} {a:.4f} ({c})" for n, (a, c) in sorted(whole.items())), flush=True)
        train_mode(model, trained)
        # Heads with no development examples (a count of nought), and the partial golds' trees, are left out of the mean.
        score = float(np.mean([a for n, (a, c) in report.items() if c and not n.startswith("partial_")]))
        print(f"  development {score:.4f}: " + " ".join(f"{n} {a:.4f} ({c})" for n, (a, c) in sorted(report.items())), flush=True)
        if score > best:
            best, since = score, 0
            # The checkpoint copied to the host and written in the background: the next epoch does not wait on the disk.
            # The sparse layers' weights kept as the fit read them, pruned 2:4: the export is the model fitted.
            state = {k: (SPARSE["prune"](v.detach()) if k in SPARSE.get("names", ()) else v.detach()).to("cpu", copy=True)
                     for k, v in kept_model.state_dict().items()}
            saving = [t for t in saving if t.is_alive()]
            saving.append(threading.Thread(target=torch.save, args=({"model": state,
                                           "width": args.width, "row_width": row_width, "epoch": epoch + 1}, os.path.join(args.out, "docparser.pt"))))
            for t in saving[:-1]:
                t.join()
            saving[-1].start()
        else:
            since += 1
            if since == 3:
                print(f"  no gain in three epochs; best {best:.4f}", flush=True)
                break
    for t in saving:
        t.join()
    # The best checkpoint exported as the engine reads it (OUT/export: the stages' graphs, docparse.json, the text model).
    if best >= 0:
        export([os.path.join(args.out, "docparser.pt"), manifest["text"], os.path.join(args.out, "export")])
    open(os.path.join(args.out, "fit.done"), "w").write("done\n")


def roles(argv):
    """python docparse.py roles CHECKPOINT PACKS STORE OUT_JSON: Detect's line roles on development's documents against
    the gold's, every document's counts of (gold region, read region) and of openings read right, and the free lines'
    (the gold says only one of `UNMARKED`) read regions; with its source.json's genre, yardstick and label source."""
    checkpoint, packs, store, out = argv
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    manifest = json.load(open(os.path.join(packs, "manifest.json"), encoding="utf-8"))
    model = model_of(saved, manifest["text"]).to(DEVICE).eval()
    rows = []
    with torch.no_grad(), autocast():
        for p in load_packs(packs, manifest["dev_packs"]):
            p = moved(p, DEVICE)
            guesses = model.detect.role(line_states(model, p)).float().argmax(1).cpu().numpy()
            golds, frees = p.role.cpu().numpy(), p.free.cpu().numpy()
            at = 0
            for sha, n in zip(p.shas, p.doc_lines):
                guess, gold, free = guesses[at:at + n], golds[at:at + n], frees[at:at + n]
                at += n
                named = (gold != -100) & ~free
                pairs, read_free = {}, {}
                for g, r in zip(gold[named] // 2, guess[named] // 2):
                    key = f"{REGIONS[g]}>{REGIONS[r]}"
                    pairs[key] = pairs.get(key, 0) + 1
                for r in guess[free] // 2:
                    read_free[REGIONS[r]] = read_free.get(REGIONS[r], 0) + 1
                try:
                    source = json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8"))
                except (OSError, ValueError):
                    source = {}
                rows.append({"sha": sha, "lines": int(named.sum()), "pairs": pairs, "free": read_free,
                             "openings_right": int(((gold[named] % 2) == (guess[named] % 2)).sum()),
                             **{k: source.get(k) for k in ("genre_group", "yardstick", "label_source", "language_layout")}})
    json.dump(rows, open(out, "w", encoding="utf-8"))
    print(f"roles of {len(rows)} development documents -> {out}", flush=True)


class ContextDocuments(nn.Module):
    """`Context` over documents' lines end to end, as a pack's are read (`docs` each line's document, `shape` each
    document's), as the engine runs it over the documents it reads at once."""

    def __init__(self, context):
        super().__init__()
        self.context = context

    def forward(self, own, docs, pages, shape):
        return self.context(own, docs, pages, shape)


class DetectPages(nn.Module):
    """Detect's encoder over a document's pages in one call, as the engine runs it: the pages a batch, each padded to
    the longest (`valid` its real lines), as the fit's page batches read them."""

    def __init__(self, detect):
        super().__init__()
        self.detect = detect

    def forward(self, features, text, boxes, anchors, t0, valid):
        x = self.detect.embed(features, text, boxes, anchors, t0)
        for layer in self.detect.encoder:
            x = layer(x, valid)
        return x


class StylesheetDocuments(nn.Module):
    """The templates over documents' lines end to end, as a pack's are read: every line's state given its template's
    (`templates` numbered across the documents, `rows` theirs end to end), each document's templates read together
    (`at` each document's templates a row of their places, padded; `valid` its real places; `flat` their places in
    the flat rows)."""

    def __init__(self, templates):
        super().__init__()
        self.templates = templates

    def forward(self, states, templates, rows, at, valid, flat):
        return self.templates(states, templates, rows, (at, valid, flat))


class LinesPages(nn.Module):
    """Detect's heads over a document's pages in one call, their states the stylesheet's, the pages padded as
    `DetectPages` takes them: each line's role and its two flags, and of the successor and predecessor heads every two
    lines' query-key score on each page (one batched product a head). The spatial term of the pairs within the window
    is `LinesSpatial`'s; the far bias the pairs beyond take is `docparse.json`'s (`line_far`). The engine adds them, as
    the fit does."""

    def __init__(self, detect):
        super().__init__()
        self.detect = detect

    def forward(self, states, valid):
        d = self.detect
        links = [(head.q(states) @ head.k(states).transpose(-1, -2) / states.shape[-1] ** 0.5).masked_fill(~valid[:, None, :], -1e4)
                 for head in (d.successor, d.predecessor)]
        return links[0], links[1], d.role(states), d.flags(states)


class LinesSpatial(nn.Module):
    """The line heads' spatial term over the pairs within the window (`pair_i`, `pair_j`: each line and the lines within
    `LINE_WINDOW` of it on its page), of the successor and the predecessor."""

    def __init__(self, detect):
        super().__init__()
        self.detect = detect

    def forward(self, boxes, pair_i, pair_j):
        m = measures(boxes[pair_i], boxes[pair_j])
        return self.detect.successor.r(m).squeeze(-1), self.detect.predecessor.r(m).squeeze(-1)


class TreeNodes(nn.Module):
    """A tree's nodes through Construct as the engine reads them: each node's parent and sibling query and key and its
    gap. The engine scores a node only against the nodes the decoding can choose (the tree's right-most path, the paper's
    Algorithm 1), each pair's score its query-key product and its codes' biases (`tree_codes`, `pair_bias`, the tables in
    `docparse.json`'s `trees`): the scores the fit reads, for the pairs the decoding reads."""

    def __init__(self, construct):
        super().__init__()
        self.construct = construct

    def forward(self, states, heading_states, family, value, prefix, x0, size, roles):
        c = self.construct
        x = c.nodes(states, heading_states, family, value, prefix, x0, size, roles)
        return c.parent.q(x), c.parent.k(x), c.sibling.q(x), c.sibling.k(x), c.gap(x)


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
    """python docparse.py export CHECKPOINT TEXT OUT_DIR: the fitted stages as ONNX graphs the engine runs (context.onnx a
    document at a time: what Detect reads of its lines, their texts' vectors read by the engine off the text model's
    folder, which docparse.json names; detect.onnx a page at a time;
    order.onnx a document; headings.onnx and bodies.onnx a tree's nodes), docparse.json (the sizes, the regions and
    the text model's folder; the features' scales are the parser's own, `doc::scale`)."""
    # `--order-window`: the Order window the export names (`ORDER_WINDOW`), as wide as every pair for a checkpoint fitted
    # before it had one.
    # `--line-window` likewise, for a checkpoint fitted before the line heads had one.
    for flag, window in (("--order-window", ORDER_WINDOW), ("--line-window", LINE_WINDOW)):
        if flag in argv:
            at = argv.index(flag)
            window[0] = int(argv[at + 1])
            argv = argv[:at] + argv[at + 2:]
    checkpoint, text_model, out = argv
    globals().update(EAGER)
    FLEX.clear()
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    model = model_of(saved, text_model).eval()
    width, text_dim, d = model.detect.look[0].in_features, model.detect.text[0].in_features, saved["width"]
    os.makedirs(out, exist_ok=True)
    n, m, k = 12, 5, 9
    with torch.no_grad():
        # What Detect reads of a document's lines (`Context`) and of their texts (`Text`), a document at a time.
        docs = torch.arange(n) // 6
        torch.onnx.export(ContextDocuments(model.context), (torch.randint(-127, 128, (n, width - CONTEXT), dtype=torch.int8), docs, torch.arange(n) // 4,
                                                            torch.randint(-127, 128, (2, 4), dtype=torch.int8)),
                          os.path.join(out, "context.onnx"), input_names=["own", "docs", "pages", "shape"], output_names=["features"],
                          dynamic_axes={"own": {0: "lines"}, "docs": {0: "lines"}, "pages": {0: "lines"}, "shape": {0: "documents"}, "features": {0: "lines"}},
                          opset_version=18, dynamo=False)
        pages, length = 3, 4
        paged = lambda *shape: {0: "pages", 1: "lines"}
        valid = torch.arange(length)[None, :] < torch.tensor([4, 2, 3])[:, None]
        torch.onnx.export(DetectPages(model.detect), (torch.randn(pages, length, width), torch.randn(pages, length, text_dim), torch.rand(pages, length, 4),
                                                      torch.randint(0, ANCHORS, (pages, length)), torch.rand(pages, length, T0), valid),
                          os.path.join(out, "detect.onnx"), input_names=["features", "text", "boxes", "anchors", "t0", "valid"], output_names=["states"],
                          dynamic_axes={name: paged() for name in ("features", "text", "boxes", "anchors", "t0", "valid", "states")}, opset_version=18, dynamo=False)
        templates = 4
        templates = 4
        at = torch.tensor([[0, 1, 0], [2, 3, 0]])
        torch.onnx.export(StylesheetDocuments(model.templates), (torch.randn(n, d), torch.arange(n) % templates, torch.randn(templates, model.templates.row_width),
                                                                 at, torch.tensor([[True, True, False], [True, True, False]]), torch.tensor([0, 1, 3, 4])),
                          os.path.join(out, "stylesheet.onnx"), input_names=["states", "templates", "rows", "at", "valid", "flat"], output_names=["styled"],
                          dynamic_axes={"states": {0: "lines"}, "templates": {0: "lines"}, "rows": {0: "templates"}, "at": {0: "documents", 1: "places"},
                                        "valid": {0: "documents", 1: "places"}, "flat": {0: "templates"}, "styled": {0: "lines"}}, opset_version=18, dynamo=False)
        torch.onnx.export(LinesPages(model.detect), (torch.randn(pages, length, d), valid),
                          os.path.join(out, "lines.onnx"), input_names=["states", "valid"], output_names=["successor", "predecessor", "role", "flags"],
                          dynamic_axes={"states": paged(), "valid": paged(), "role": paged(), "flags": paged(),
                                        "successor": {0: "pages", 1: "lines", 2: "lines"}, "predecessor": {0: "pages", 1: "lines", 2: "lines"}},
                          opset_version=18, dynamo=False)
        pair_i, pair_j = torch.arange(n).repeat_interleave(3).clamp(max=n - 1), (torch.arange(3 * n) % n)
        torch.onnx.export(LinesSpatial(model.detect), (torch.rand(n, 4), pair_i, pair_j),
                          os.path.join(out, "spatial.onnx"), input_names=["boxes", "pair_i", "pair_j"], output_names=["successor", "predecessor"],
                          dynamic_axes={"boxes": {0: "lines"}, "pair_i": {0: "pairs"}, "pair_j": {0: "pairs"}, "successor": {0: "pairs"}, "predecessor": {0: "pairs"}},
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
            torch.onnx.export(TreeNodes(construct), (torch.randn(m, d), torch.randn(m, d), torch.randint(0, 10, (m,)), torch.randint(-1, 5, (m,)),
                                                     torch.randint(0, 3, (m,)), torch.rand(m), torch.randn(m), torch.randint(1, 17, (m,))),
                              os.path.join(out, f"{name}.onnx"),
                              input_names=["states", "heading_states", "family", "value", "prefix", "x0", "size", "roles"],
                              output_names=["parent_q", "parent_k", "sibling_q", "sibling_k", "gap"],
                              dynamic_axes={**{name: {0: "nodes"} for name in ("states", "heading_states", "family", "value", "prefix", "x0", "size", "roles")},
                                            **{name: {0: "nodes"} for name in ("parent_q", "parent_k", "sibling_q", "sibling_k", "gap")}},
                              opset_version=18, dynamo=False)
    # Each tree's pair tables (`Construct.table`, rows from `OFFSETS`, a parent and a sibling bias each) and its left-edge
    # and size scales (`pair_bias`), as the engine adds them to the pairs it scores.
    trees = {name: {"table": construct.table().tolist(), "scale": construct.cont_scale.tolist(), "offsets": list(OFFSETS)}
             for name, construct in (("headings", model.headings), ("bodies", model.bodies))}
    json.dump({"width": int(width - CONTEXT), "text_dim": int(text_dim), "d": int(d), "row_width": int(model.templates.row_width), "classes": CLASSES, "regions": REGIONS,
               "text": os.path.abspath(text_model), "trees": trees, "line_window": LINE_WINDOW[0], "order_window": ORDER_WINDOW[0],
               "order_far": {head: float(getattr(model.order, head).far) for head in ("goes_on", "note_of", "successor")},
               "line_far": [float(model.detect.successor.far), float(model.detect.predecessor.far)], "epoch": saved.get("epoch")},
              open(os.path.join(out, "docparse.json"), "w", encoding="utf-8"))
    print(f"exported epoch {saved.get('epoch')} to {out}", flush=True)


if __name__ == "__main__":
    # Run as the module `docparse`, so what it pickles (the prepared tensors) names its classes there and any tool
    # importing the module reads them back.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import docparse
    if sys.argv[1:2] == ["export"]:
        docparse.export(sys.argv[2:])
    elif sys.argv[1:2] == ["roles"]:
        docparse.roles(sys.argv[2:])
    else:
        docparse.main()
