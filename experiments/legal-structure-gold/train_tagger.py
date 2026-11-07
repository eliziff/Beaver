"""Train the tier-1 structure tagger on `structure-gold rows` output and report it against tier 0.

  python train_tagger.py ROWS_DIR --out OUT_DIR [--model gru|transformer] [--epochs N]

Each row is one piece of the parser's lines (a line cut at the parser's block boundaries) in its
reading order, with its evidence, the parser's labels (tier 0) and the gold's. The tagger reads a
whole document and predicts, per piece, its region, what starts there (inside, a unit, a resumed
unit), a document start, a note reference and, on a heading's first piece, the heading's step from
the heading before it in its document (first, same, down or up some; `step` in the tagger's labels),
so a heading read one level off costs one step, not every level below it. Parents are not
predicted: the decoder derives them from regions and the levels the steps rebuild by the hierarchy
rule (CONVENTIONS section 2). A resumed piece resumes the latest earlier unit of its region. Each
piece's whole text is read. Development selects the epoch; test is never read. Predictions
for development go to OUT_DIR/predictions-development-<model>.jsonl as {sha256, ids, labels, p_heading,
level_p} for `grade --labels` and for a second stage (p_heading: p(region heading) x p(unit start) per piece;
level_p: the step distribution of pieces with p_heading >= 0.02, by piece index). --fold k/n trains without
the train documents of fold k (index modulo n) and writes their predictions to OUT_DIR/crossfit-k.jsonl.
"""
import argparse
import json
import math
import random
import re
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

# The tagger's regions, in the order `structure-gold rows` numbers them (the tagger's REGIONS).
REGIONS = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote",
           "marginal_note", "furniture", "page_label", "line_label", "title", "note_quote", "provision"]
STARTS = ["inside", "unit", "resume"]
# Label columns: region, start, document, reference, heading step, marker, resumed row, body depth step.
LABELS = 8
# A step is one of 19 classes (the tagger's `step`: 0 none, 10 plus the change).
STEPS = 19
HEADS = [("region", 0, len(REGIONS)), ("start", 1, len(STARTS)), ("document", 2, 2), ("reference", 3, 2), ("level", 4, STEPS), ("marker", 5, 2),
         ("depth", 7, STEPS)]
# The body regions that take a depth (the tagger's RANKED, headings aside).
BODY = [REGIONS.index(r) for r in ("text", "provision", "list_item", "quote", "table", "caption", "headnote")]
UNRANKED = {0, 5, 7, 10, 11, 12, 13, 14, 15}


def fnv1a(token):
    h = 0x811C9DC5
    for byte in token.encode("utf-8"):
        h = ((h ^ byte) * 0x01000193) & 0xFFFFFFFF
    return h


def padded(rows):
    """Rows of codes padded with 0 to the longest (at least one column)."""
    width = max([len(r) for r in rows] + [1])
    return np.asarray([r + [0] * (width - len(r)) for r in rows], dtype=np.int64)


def words(texts):
    """--text wide: each piece's every word hashed (FNV-1a over the lowercase token's UTF-8 bytes, 16,383 buckets)."""
    return padded([[fnv1a(t) % 16383 + 1 for t in re.split(r"[^0-9A-Za-z\u00C0-\u024F]+", text.lower()) if t] for text in texts])


def load(path):
    with open(path, encoding="utf-8") as stream:
        return [d for d in map(json.loads, stream) if d["ids"]]


def load_compact(path):
    """load(), each row's evidence and tier 0 made arrays as it is parsed (as lists of Python numbers they
    are most of a row's memory)."""
    rows = []
    with open(path, encoding="utf-8") as stream:
        for line in stream:
            d = json.loads(line)
            if d["ids"]:
                d["features"] = np.asarray(d["features"], dtype=np.float32)
                d["tier0"] = np.asarray(d["tier0"], dtype=np.int64)
                rows.append(d)
    return rows


def ragged(rows, dtype):
    """Rows of codes as one flat array and each row's length (padded() without the padding)."""
    lengths = np.fromiter((len(r) for r in rows), dtype=np.int64, count=len(rows))
    flat = np.fromiter((c for r in rows for c in r), dtype=dtype, count=int(lengths.sum()))
    return flat, lengths


def char_codes(texts):
    """chars()'s codes (each character min(code point, 0x2FFF) % 2048 + 1), ragged: one flat run and each text's length."""
    points = np.frombuffer("".join(texts).encode("utf-32-le", "surrogatepass"), dtype=np.uint32)
    lengths = np.fromiter((len(t) for t in texts), dtype=np.int64, count=len(texts))
    return (np.minimum(points, 0x2FFF) % 2048 + 1).astype(np.int16), lengths


def word_codes(texts):
    """words()'s codes, ragged."""
    return ragged([[fnv1a(t) % 16383 + 1 for t in re.split(r"[^0-9A-Za-z\u00C0-\u024F]+", text.lower()) if t] for text in texts], np.int16)


def unragged(flat, lengths):
    """Ragged codes padded with 0 to the longest (at least one column), as padded() returns them."""
    out = np.zeros((len(lengths), max(int(lengths.max(initial=0)), 1)), dtype=np.int64)
    out[np.arange(out.shape[1])[None] < lengths[:, None]] = flat
    return out


class Vocab:
    def __init__(self, values):
        counts = {}
        for value in values:
            counts[value] = counts.get(value, 0) + 1
        self.index = {value: n + 1 for n, value in enumerate(sorted(v for v, c in counts.items() if c >= 5))}

    def __call__(self, value):
        return self.index.get(value, 0)

    def __len__(self):
        return len(self.index) + 1


def chars(texts):
    """Each piece's whole text as codes in 1..2048."""
    return padded([[min(ord(c), 0x2FFF) % 2048 + 1 for c in text] for text in texts])


FRENCH = re.compile(r"\b(le|la|les|des|du|une|est|sont|aux|dans|pour|qui|sur|par|au|ou|et|de)\b|[éèêàçùâîô]", re.I)
ENGLISH = re.compile(r"\b(the|of|and|to|in|is|for|that|by|with|or|any|shall|under|be|on|a)\b", re.I)
# Evidence beside the exported features: the piece's language.
EXTRA_FEATURES = 1


def language(text):
    """From -1 (English function words) to 1 (French), 0 where neither shows."""
    french, english = len(FRENCH.findall(text)), len(ENGLISH.findall(text))
    return (french - english) / max(french + english, 1)


def witness_scores(path):
    """Per piece p(heading) from a witness file ({sha256, ids, p_heading} rows), by sha and piece id."""
    scores = {}
    if path:
        for line in open(path, encoding="utf-8"):
            d = json.loads(line)
            scores[d["sha256"]] = dict(zip(d["ids"], d["p_heading"]))
    return scores


def sight(raw, vision):
    """--vision: each piece's visual evidence (`vision_features.py`): its box pooled from its page,
    its page, and the pages before and after it, (pieces, 4 x 256); zeros where a page has no render."""
    if vision is None:
        return np.zeros((len(raw["ids"]), 0), dtype=np.float32)
    path = vision / f"{raw['sha256']}.npz"
    if not path.exists():
        return np.zeros((len(raw["ids"]), 4 * 256), dtype=np.float32)
    stored = np.load(path)
    piece, page = stored["piece"].astype(np.float32), stored["page"].astype(np.float32)
    slots = np.asarray(raw["pages"], dtype=np.int64)
    padded = np.concatenate([np.zeros((1, page.shape[1]), np.float32), page, np.zeros((1, page.shape[1]), np.float32)])
    return np.concatenate([piece, padded[slots + 1], padded[slots], padded[slots + 2]], axis=1)


def document_types(path):
    """--doctype: the gold's parts by sha256 (the gold's own types, an oracle for what a document-type
    signal would add), from {sha256: [[type, first_line, lines], ...]}. Returns (sha256 -> [(first
    line id, code)], codes); each piece then reads its own part's code (piece_types)."""
    if not path:
        return {}, {}
    parts = json.load(open(path, encoding="utf-8"))
    codes = {name: n + 1 for n, name in enumerate(sorted({p[0] for own in parts.values() for p in own}))}
    return {sha: [(p[1], codes[p[0]]) for p in own] for sha, own in parts.items() if own}, codes


def piece_types(raw, parts):
    """Each piece's part type code: a part runs from the piece on its first line to the next part's;
    0 for a document the types do not name."""
    out = np.zeros(len(raw["ids"]), dtype=np.int64)
    if not parts:
        return out
    opens = dict(parts)
    code = parts[0][1]
    for k, piece in enumerate(raw["ids"]):
        code = opens.pop(piece.split("@")[0], code)
        out[k] = code
    return out


class Document:
    """One document's tensors: normalized evidence, tier 0, text, reader codes, gold, sight, type. Its text
    (and with `wide` its hashed words) is kept ragged; `text` and `words` give it padded."""

    def __init__(self, raw, names, vocabs, mean, std, witness=None, vision=None, doctype=None, wide=False):
        self.sight = sight(raw, vision)
        self.doctype = piece_types(raw, (doctype or {}).get(raw["sha256"]))
        values = np.asarray(raw["features"], dtype=np.float32)
        self.language = np.asarray([language(t[0]) for t in raw["text"]], dtype=np.float32)
        extra = [self.language[:, None]]
        if witness is not None:
            # The lexical witness's p(heading) per piece, 0 where it has none.
            own = witness.get(raw["sha256"], {})
            extra.append(np.asarray([own.get(i, 0.0) for i in raw["ids"]], dtype=np.float32)[:, None])
        self.features = np.concatenate([(values - mean) / std] + extra, axis=1).astype(np.float32)
        self.tier0 = np.asarray(raw["tier0"], dtype=np.int64)
        texts = [t[0] for t in raw["text"]]
        self.chars, self.char_lengths = char_codes(texts)
        self.word_codes, self.word_lengths = word_codes(texts) if wide else (np.zeros(0, np.int16), np.zeros(len(texts), np.int64))
        region_types, note_modes, families = vocabs
        self.reader = np.asarray([[region_types(t[1]), note_modes(t[2]), families(t[3])] for t in raw["text"]], dtype=np.int64)
        self.gold = np.asarray([g if g is not None else [-100] * LABELS for g in raw["gold"]], dtype=np.int64)
        # The steps are learned on heading starts and body unit starts; elsewhere the columns are no target.
        heading = REGIONS.index("heading")
        self.gold[(self.gold[:, 0] != heading) | (self.gold[:, 1] != 1), 4] = -100
        self.gold[~np.isin(self.gold[:, 0], BODY) | (self.gold[:, 1] != 1), 7] = -100
        self.length = len(values)

    @property
    def text(self):
        return unragged(self.chars, self.char_lengths)

    @property
    def words(self):
        return unragged(self.word_codes, self.word_lengths)


def upload(array, device):
    """A host array on the device, copied from pinned memory without waiting for the device."""
    tensor = torch.from_numpy(np.ascontiguousarray(array))
    if device.type != "cuda":
        return tensor
    return tensor.pin_memory().to(device, non_blocking=True)


class Packed:
    """Documents' tensors laid end to end on the device, built once and read by every batch: each piece's
    evidence, tier 0, reader codes, sight, type and gold, and its text's codes (and words') as one flat run
    with each piece's start and length."""

    def __init__(self, docs, device):
        self.device = device
        self.offset = np.cumsum([0] + [d.length for d in docs])

        def put(array):
            return torch.from_numpy(np.ascontiguousarray(array)).to(device)

        self.features = put(np.concatenate([d.features for d in docs]))
        self.tier0 = put(np.concatenate([d.tier0 for d in docs]))
        self.reader = put(np.concatenate([d.reader for d in docs]))
        self.sight = put(np.concatenate([d.sight for d in docs]))
        self.doctype = put(np.concatenate([d.doctype for d in docs]))
        self.gold = put(np.concatenate([d.gold for d in docs]))
        # Which label columns have a target, per document (a head with none in a batch adds no loss).
        self.present = np.stack([(d.gold >= 0).any(axis=0) for d in docs])
        self.char_lengths = np.concatenate([d.char_lengths for d in docs])
        # How far each piece's max-pool reaches: over its document's padded width (its longest text's, as
        # Document.text pads and the export reads), beyond 3 past its own end only empty positions alike.
        self.reach = np.minimum(np.repeat([max(int(d.char_lengths.max(initial=0)), 1) for d in docs], [d.length for d in docs]),
                                self.char_lengths + 3)
        self.word_lengths = np.concatenate([d.word_lengths for d in docs])
        # A trailing 0 so a padded read past the last code stays in bounds.
        self.chars = put(np.concatenate([d.chars for d in docs] + [np.zeros(1, np.int16)]))
        self.words = put(np.concatenate([d.word_codes for d in docs] + [np.zeros(1, np.int16)]))
        self.char_starts = put(np.cumsum(self.char_lengths) - self.char_lengths)
        self.word_starts = put(np.cumsum(self.word_lengths) - self.word_lengths)
        self.char_lengths_device = put(self.char_lengths)
        self.reach_device = put(self.reach)
        self.word_lengths_device = put(self.word_lengths)

    @staticmethod
    def codes(flat, starts, lengths, width):
        """Each piece's codes from a flat run, padded with 0 to `width`."""
        position = torch.arange(width, device=flat.device)
        at = (starts[:, None] + position[None]).clamp(max=flat.numel() - 1)
        return torch.where(position[None] < lengths[:, None], flat[at], 0).long()

    def read(self, model, pieces, budget=1 << 21):
        """The text vectors of pieces `pieces` (indices into the packed pieces), (pieces, width). Each piece's
        text is read on its own, as if padded to its document's longest (its reach), so the pieces are read
        shortest first in chunks of at most `budget` codes."""
        lengths = self.reach[pieces]
        order = np.argsort(lengths, kind="stable")
        ranked = lengths[order]
        on_device = upload(pieces[order], self.device)
        chunks, lo = [], 0
        while lo < len(order):
            fits = np.flatnonzero((np.arange(1, len(order) - lo + 1) * ranked[lo:]) > budget)
            hi = lo + max(1, int(fits[0]) if len(fits) else len(order) - lo)
            ids = on_device[lo:hi]
            text = self.codes(self.chars, self.char_starts[ids], self.char_lengths_device[ids], int(ranked[hi - 1]))
            words = None
            if model.wide:
                width = max(1, int(self.word_lengths[pieces[order[lo:hi]]].max()))
                words = self.codes(self.words, self.word_starts[ids], self.word_lengths_device[ids], width)
            chunks.append(model.read_text(text, words, self.reach_device[ids]))
            lo = hi
        inverse = np.empty_like(order)
        inverse[order] = np.arange(len(order))
        return torch.cat(chunks)[upload(inverse, self.device)]


class Tagger(nn.Module):
    def __init__(self, features, vocabs, kind="gru", hidden=128, layers=2, dropout=0.1, text_dropout=0.0, wide=False, vision=0, doctypes=0, film=False):
        super().__init__()
        region_types, note_modes, families = vocabs
        self.wide = wide
        # The visual evidence, read down to 64 values a piece.
        self.see = nn.Sequential(nn.LayerNorm(vision), nn.Linear(vision, 64), nn.GELU()) if vision else None
        # Each piece's document type (--doctype), its part's code.
        self.doctype = nn.Embedding(doctypes + 1, 8) if doctypes else None
        # --film: the type also scales and shifts each piece's state before the heads read it (zero at
        # the start, so training begins from the unconditioned tagger).
        self.film = nn.Embedding(doctypes + 1, 4 * hidden) if doctypes and film else None
        if self.film is not None:
            nn.init.zeros_(self.film.weight)
        self.char = nn.Embedding(2049, 24, padding_idx=0)
        self.conv = nn.Conv1d(24, 64, 3, padding=1)
        if wide:
            self.conv5 = nn.Conv1d(24, 64, 5, padding=2)
            self.word = nn.Embedding(16384, 32, padding_idx=0)
        text_width = 64 + (64 + 32 if wide else 0)
        self.tier0 = nn.ModuleList([nn.Embedding(n, 8) for _, _, n in HEADS])
        self.region_type = nn.Embedding(len(region_types), 8)
        self.note_mode = nn.Embedding(len(note_modes), 4)
        self.family = nn.Embedding(len(families), 8)
        width = features + text_width + 8 * len(HEADS) + 8 + 4 + 8 + (64 if vision else 0) + (8 if doctypes else 0)
        self.project = nn.Sequential(nn.Linear(width, 2 * hidden), nn.GELU(), nn.Dropout(dropout))
        # Hiding a piece's text at times keeps the encoder from leaning on remembered wording.
        self.text_dropout = text_dropout
        self.kind = kind
        if kind == "gru":
            self.encoder = nn.GRU(2 * hidden, hidden, num_layers=layers, batch_first=True, bidirectional=True, dropout=dropout)
        else:
            layer = nn.TransformerEncoderLayer(2 * hidden, 4, 4 * hidden, dropout=0.1, batch_first=True, norm_first=True)
            self.encoder = nn.TransformerEncoder(layer, layers)
            self.position = nn.Embedding(1024, 2 * hidden)
        self.heads = nn.ModuleList([nn.Linear(2 * hidden, n) for _, _, n in HEADS])


    def read_text(self, text, words=None, reach=None):
        """Each piece's text vector from its codes, (pieces, codes) padded with 0, and with --text wide its
        hashed words: the characters' convolutions max-pooled over the padded width (or each piece's first
        `reach` positions), the words' mean."""
        e = self.char(text).transpose(1, 2)
        if reach is None:
            pool = lambda y: y.max(dim=2).values
        else:
            # The positions past a piece's reach are left out (0 is below no ReLU output's maximum).
            past = (torch.arange(text.shape[1], device=text.device)[None] >= reach[:, None])[:, None, :]
            pool = lambda y: y.masked_fill(past, 0).max(dim=2).values
        c = pool(F.relu(self.conv(e)))
        if self.wide:
            c5 = pool(F.relu(self.conv5(e)))
            mask = (words > 0).unsqueeze(-1).float()
            wm = (self.word(words) * mask).sum(1) / mask.sum(1).clamp(min=1)
            c = torch.cat([c, c5, wm], dim=-1)
        return c

    def encode(self, features, tier0, c, reader, sight, doctype, lengths):
        """Each window's pieces' states: (windows, length, 2 * hidden), from each piece's text vector c
        (read_text's, laid out like the windows) and its other inputs; lengths on the host."""
        b, t, _ = features.shape
        if self.training and self.text_dropout > 0:
            c = c * (torch.rand(b, t, 1, device=c.device) >= self.text_dropout)
        parts = [features, c, self.region_type(reader[..., 0]), self.note_mode(reader[..., 1]), self.family(reader[..., 2])]
        parts += [embed(tier0[..., column].clamp(min=0, max=embed.num_embeddings - 1)) for embed, (_, column, _) in zip(self.tier0, HEADS)]
        if self.see is not None:
            parts.append(self.see(sight))
        if self.doctype is not None:
            parts.append(self.doctype(doctype))
        x = self.project(torch.cat(parts, dim=-1))
        if self.kind == "gru":
            # cuDNN's recurrence, in single precision.
            with torch.autocast(device_type=x.device.type, enabled=False):
                packed = nn.utils.rnn.pack_padded_sequence(x.float(), lengths, batch_first=True, enforce_sorted=False)
                x, _ = self.encoder(packed)
                x, _ = nn.utils.rnn.pad_packed_sequence(x, batch_first=True, total_length=t)
            return self.condition(x, doctype)
        mask = torch.arange(t, device=x.device)[None] < lengths.to(x.device)[:, None]
        x = x + self.position(torch.arange(t, device=x.device))[None]
        return self.condition(self.encoder(x, src_key_padding_mask=~mask), doctype)

    def condition(self, x, doctype):
        if self.film is None:
            return x
        gamma, beta = self.film(doctype).chunk(2, dim=-1)
        return x * (1 + gamma) + beta

    def tag(self, states):
        return [head(states) for head in self.heads]


WINDOW, CONTEXT = 768, 128
# --whole: each document read in one pass (the GRU's, with no window); a batch holds documents up to
# this many pieces together, one longer document alone.
WHOLE, BUDGET = False, 768 * 16


class Windows:
    """Documents cut into windows of WINDOW pieces with CONTEXT more on each side, stacked for the
    encoder; each piece's state is read from the window that holds it in its core. With --whole, a
    document is one window."""

    def __init__(self, docs, device, packed=None, members=None):
        """docs: Documents, held in `packed` at positions `members` (packed here when not given)."""
        if packed is None:
            packed, members = Packed(docs, device), range(len(docs))
        if WHOLE:
            spans = [(k, 0, d.length, 0, d.length) for k, d in enumerate(docs)]
        else:
            spans = [(k, max(0, core - CONTEXT), min(d.length, core + WINDOW + CONTEXT), core, min(d.length, core + WINDOW))
                     for k, d in enumerate(docs) for core in range(0, d.length, WINDOW)]
        length = max(hi - lo for _, lo, hi, _, _ in spans)
        # The batch's pieces, document after document (their places in `packed`), and each window
        # position's piece among them (0 past a window's end: padding the encoder does not read).
        first = np.cumsum([0] + [d.length for d in docs])
        self.pieces = np.concatenate([packed.offset[m] + np.arange(d.length) for m, d in zip(members, docs)])
        rows = np.zeros((len(spans), length), dtype=np.int64)
        index = np.zeros(len(self.pieces), dtype=np.int64)
        for w, (k, lo, hi, a, b) in enumerate(spans):
            rows[w, :hi - lo] = first[k] + np.arange(lo, hi)
            index[first[k] + a:first[k] + b] = w * length + np.arange(a - lo, b - lo)
        self.packed, self.device = packed, device
        self.lengths = torch.as_tensor([hi - lo for _, lo, hi, _, _ in spans])
        self.on_device = upload(self.pieces, device)
        self.rows = upload(rows, device)
        self.index = upload(index, device)
        self.present = packed.present[list(members)].any(axis=0)

    def gold(self):
        """The pieces' gold, (pieces, LABELS), in the order states() gives them."""
        return self.packed.gold[self.on_device]

    def states(self, model):
        """Each document's pieces' states, (pieces, 2 * hidden), in one tensor document after document.
        Each piece's text is read once, however many windows hold it."""
        p = self.packed
        text = p.read(model, self.pieces)
        at = self.on_device[self.rows]
        x = model.encode(p.features[at], p.tier0[at], text[self.rows], p.reader[at], p.sight[at], p.doctype[at], self.lengths)
        return x.reshape(-1, x.shape[-1])[self.index]


def batches(docs, windows, rng):
    """Documents of like length together, at most `windows` encoder windows a batch."""
    order = sorted(range(len(docs)), key=lambda n: docs[n].length + rng.random() * 50)
    groups, current, used = [], [], 0
    for n in order:
        need = docs[n].length if WHOLE else -(-docs[n].length // WINDOW)
        if current and used + need > (BUDGET if WHOLE else windows):
            groups.append(current)
            current, used = [], 0
        current.append(n)
        used += need
    if current:
        groups.append(current)
    rng.shuffle(groups)
    return groups


def tag_loss(outputs, gold, weights, present=None):
    """The heads' cross-entropies summed; a head with no target in the batch (silver rows carry region and start only)
    adds nothing rather than NaN. present: which label columns have a target, when known on the host."""
    total = 0.0
    for output, (name, column, n) in zip(outputs, HEADS):
        if not (present[column] if present is not None else bool((gold[:, column] >= 0).any())):
            continue
        total = total + F.cross_entropy(output.float(), gold[:, column], weight=weights.get(name), ignore_index=-100)
    return total


@torch.no_grad()
def predict(model, docs, device, packed=None, windows=64):
    """Per document: each head's prediction; the step stays on heading starts, and a resumed piece
    resumes the latest earlier unit of its region. Parents are not predicted: the decoder derives
    them from regions and the levels the steps rebuild by the hierarchy rule. Documents are read
    `windows` encoder windows at a time (each window on its own, as one document alone would be)."""
    model.eval()
    if packed is None:
        packed = Packed(docs, device)
    results = [None] * len(docs)
    heading = REGIONS.index("heading")
    for group in batches(docs, windows, random.Random(0)):
        states = Windows([docs[n] for n in group], device, packed, group).states(model).float()
        outputs = model.tag(states)
        chosen = torch.stack([output.argmax(dim=-1) for output in outputs], dim=1).cpu().numpy()
        p_heading = (torch.softmax(outputs[0], dim=-1)[:, heading] * torch.softmax(outputs[1], dim=-1)[:, 1]).cpu().numpy()
        level_p = torch.softmax(outputs[4], dim=-1).cpu().numpy()
        at = 0
        for n in group:
            doc = docs[n]
            own = slice(at, at + doc.length)
            at += doc.length
            labels = np.zeros((doc.length, LABELS), dtype=np.int64)
            for k, (_, column, _) in enumerate(HEADS):
                labels[:, column] = chosen[own, k]
            labels[:, 6] = -1
            labels[labels[:, 0] == 0, 1] = 0
            labels[(labels[:, 0] != heading) | (labels[:, 1] != 1), 4] = 0
            labels[~np.isin(labels[:, 0], BODY) | (labels[:, 1] != 1), 7] = 0
            labels[labels[:, 1] != 1, 5] = 0
            latest = {}
            regions, starts = labels[:, 0].tolist(), labels[:, 1].tolist()
            for k in np.flatnonzero(labels[:, 1] > 0).tolist():
                if starts[k] == 2:
                    labels[k, 6] = latest.get(regions[k], -1)
                    if labels[k, 6] < 0:
                        labels[k, 1] = starts[k] = 1
                if starts[k] == 1:
                    latest[regions[k]] = k
            results[n] = (labels, p_heading[own], level_p[own])
    return results


def report(docs, predictions, label):
    """Per head accuracy against gold, beside tier 0."""
    lines = []
    for name, column, _ in HEADS:
        gold = np.concatenate([d.gold[:, column] for d in docs])
        mine = np.concatenate([p[0][:, column] for p in predictions])
        tier0 = np.concatenate([d.tier0[:, column] for d in docs])
        keep = gold != -100
        lines.append(f"{label} {name:9} n={int(keep.sum()):7} accuracy tier0 {np.mean(tier0[keep] == gold[keep]):.4f}"
                     f" model {np.mean(mine[keep] == gold[keep]):.4f}")
    return lines


def write_predictions(path, raws, predictions):
    """{sha256, ids, labels, p_heading, level_p} per document."""
    with open(path, "w", encoding="utf-8") as out:
        for raw, (labels, p_heading, level_p) in zip(raws, predictions):
            candidates = {int(n): [round(float(v), 3) for v in level_p[n]] for n in np.flatnonzero(p_heading >= 0.02)}
            out.write(json.dumps({"sha256": raw["sha256"], "ids": raw["ids"], "labels": labels.tolist(),
                                  "p_heading": [round(float(v), 4) for v in p_heading], "level_p": candidates}) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", choices=("gru", "transformer"), default="gru")
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--text-dropout", type=float, default=0.0)
    parser.add_argument("--train-share", type=float, default=1.0, help="train on this share of the train documents")
    parser.add_argument("--epochs", type=int, default=16)
    parser.add_argument("--windows", type=int, default=16)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--witness", nargs=2, metavar=("TRAIN", "DEV"), help="lexical witness scores for the train and development rows, one more feature")
    parser.add_argument("--text", choices=("narrow", "wide"), default="narrow", help="wide: a 5-wide conv beside the 3-wide, and the hashed words")
    parser.add_argument("--hidden", type=int, default=128)
    parser.add_argument("--layers", type=int, default=2)
    parser.add_argument("--predict-train", action="store_true", help="also write predictions-train-<model>.jsonl (train fit)")
    parser.add_argument("--fold", help="k/n: hold out the train documents with index k modulo n and write their predictions to OUT/crossfit-k.jsonl")
    parser.add_argument("--pretrain", type=Path, help="silver rows directory (rows-train.jsonl of text-only units): region/start pretraining before the gold epochs")
    parser.add_argument("--pretrain-epochs", type=int, default=2)
    parser.add_argument("--pretrain-docs", type=int, default=0, help="at most this many silver documents (0 = all)")
    parser.add_argument("--whole", action="store_true", help="the GRU reads each document whole, with no window")
    parser.add_argument("--vision", type=Path, help="vision_features.py output: each piece's box, page and neighbouring pages, seen")
    parser.add_argument("--doctype", type=Path, help="gold document types by sha256 ({sha: [[type, first_line, lines], ...]}): each piece's part type as one more input")
    parser.add_argument("--film", action="store_true", help="with --doctype: the type also scales and shifts each piece's state before the heads")
    args = parser.parse_args()
    if args.whole:
        if args.model != "gru":
            parser.error("--whole reads with the GRU")
        global WHOLE
        WHOLE = True
    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    started = time.time()
    names = json.loads((args.rows / "features.json").read_text())
    train_raw, dev_raw = load_compact(args.rows / "rows-train.jsonl"), load_compact(args.rows / "rows-development.jsonl")
    if args.train_share < 1.0:
        train_raw = random.Random(args.seed).sample(train_raw, max(1, round(len(train_raw) * args.train_share)))
    held_raw = []
    if args.fold:
        k, n = (int(x) for x in args.fold.split("/"))
        held_raw = [d for i, d in enumerate(train_raw) if i % n == k]
        train_raw = [d for i, d in enumerate(train_raw) if i % n != k]
        print(f"fold {k}/{n}: {len(train_raw)} train documents, {len(held_raw)} held out", flush=True)
    vocabs = (Vocab(t[1] for d in train_raw for t in d["text"]), Vocab(t[2] for d in train_raw for t in d["text"]),
              Vocab(t[3] for d in train_raw for t in d["text"]))
    stacked = np.concatenate([np.asarray(d["features"], dtype=np.float32) for d in train_raw])
    mean, std = stacked.mean(axis=0), stacked.std(axis=0) + 1e-6
    witness_train, witness_dev = (witness_scores(args.witness[0]), witness_scores(args.witness[1])) if args.witness else (None, None)
    doctype, doctype_codes = document_types(args.doctype)
    wide = args.text == "wide"
    train = [Document(d, names, vocabs, mean, std, witness_train, args.vision, doctype, wide) for d in train_raw]
    dev = [Document(d, names, vocabs, mean, std, witness_dev, args.vision, doctype, wide) for d in dev_raw]
    held = [Document(d, names, vocabs, mean, std, witness_train, args.vision, doctype, wide) for d in held_raw]
    del stacked
    # The rows are read once: what the outputs name a document by is all that is kept of them.
    for d in train_raw + dev_raw + held_raw:
        for key in [k for k in d if k not in ("sha256", "ids", "tier0")]:
            del d[key]
    if args.doctype:
        print(f"document types: {len(doctype_codes)} ({sum(d.doctype.any() for d in train)} train / {sum(d.doctype.any() for d in dev)} development documents typed)", flush=True)
    print(f"loaded {len(train)} train / {len(dev)} development documents, {sum(d.length for d in train)} / "
          f"{sum(d.length for d in dev)} pieces in {time.time() - started:.1f}s", flush=True)
    # Starts weigh each class by the inverse square root of its frequency, at most 8:1.
    g = np.concatenate([d.gold[:, 1] for d in train])
    counts = np.bincount(g[g >= 0], minlength=len(STARTS)).astype(np.float64) + 1.0
    w = (counts.sum() / counts) ** 0.5
    w = np.minimum(w, 8 * w.min())
    weights = {"start": torch.tensor(w / w.mean(), dtype=torch.float32, device=device)}
    # Every document's tensors on the device once, read by each batch from there.
    packed_train, packed_dev = Packed(train, device), Packed(dev, device)
    model = Tagger(train[0].features.shape[1], vocabs, kind=args.model, hidden=args.hidden, layers=args.layers,
                   dropout=args.dropout, text_dropout=args.text_dropout, wide=args.text == "wide", vision=train[0].sight.shape[1], doctypes=len(doctype_codes), film=args.film).to(device)
    print(f"{args.model}: {sum(p.numel() for p in model.parameters()):,} parameters", flush=True)
    if args.pretrain:
        # The text prior: silver units carry text and text-shape features only. Every other feature is
        # set to the gold's mean (0 after normalization), tier 0 reads none, the reader vocabularies 0;
        # the loss is the region and start heads'. Fresh optimizer and schedule for the gold epochs after.
        silver_raw = load(args.pretrain / "rows-train.jsonl")
        if args.pretrain_docs:
            silver_raw = random.Random(args.seed).sample(silver_raw, min(args.pretrain_docs, len(silver_raw)))
        shape_columns = {names.index(n) for n in ("length", "upper", "digits", "punctuation", "spaces", "starts_digit", "starts_upper",
                         "starts_lower", "starts_open", "starts_mark", "ends_period", "ends_colon", "ends_comma", "ends_hyphen", "ends_digit") if n in names}
        keep = np.asarray([k in shape_columns for k in range(len(names))])
        for d in silver_raw:
            values = np.asarray(d["features"], dtype=np.float32)
            values[:, ~keep] = mean[~keep]
            d["features"] = values.tolist()
        silver = [Document(d, names, vocabs, mean, std, vision=args.vision, wide=wide) for d in silver_raw]
        for d in silver:
            d.gold[:, 2:] = -100
        packed_silver = Packed(silver, device)
        print(f"pretraining on {len(silver)} silver documents, {sum(d.length for d in silver)} units, {args.pretrain_epochs} epochs", flush=True)
        pre_optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
        pre_steps = args.pretrain_epochs * len(batches(silver, args.windows, random.Random(0)))
        pre_schedule = torch.optim.lr_scheduler.OneCycleLR(pre_optimizer, max_lr=args.lr, total_steps=pre_steps, pct_start=0.1)
        pre_rng = random.Random(args.seed)
        for epoch in range(args.pretrain_epochs):
            model.train()
            began, total, count = time.time(), torch.zeros((), device=device), 0
            for group in batches(silver, args.windows, pre_rng):
                batch = Windows([silver[n] for n in group], device, packed_silver, group)
                pre_optimizer.zero_grad(set_to_none=True)
                with torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                    states = batch.states(model)
                    outputs = model.tag(states)
                loss = tag_loss(outputs, batch.gold(), weights, batch.present)
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                pre_optimizer.step(); pre_schedule.step()
                total += loss.detach(); count += 1
            lines = report(dev, predict(model, dev, device, packed_dev), f"pretrain {epoch + 1}")
            print(f"pretrain epoch {epoch + 1} loss {float(total) / max(count, 1):.4f} in {time.time() - began:.1f}s", flush=True)
            for l in lines[:2]:
                print("  " + l, flush=True)
        del silver, silver_raw, packed_silver
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = args.epochs * len(batches(train, args.windows, random.Random(0)))
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.lr, total_steps=steps, pct_start=0.1)
    rng = random.Random(args.seed)
    best, best_state = -1.0, None
    args.out.mkdir(parents=True, exist_ok=True)
    for epoch in range(args.epochs):
        model.train()
        began, total, count = time.time(), torch.zeros((), device=device), 0
        for group in batches(train, args.windows, rng):
            batch = Windows([train[n] for n in group], device, packed_train, group)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                states = batch.states(model)
                outputs = model.tag(states)
            tagged = tag_loss(outputs, batch.gold(), weights, batch.present)
            tagged.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            # An epoch's batch count varies with the grouping's jitter; the schedule is sized from one draw.
            if schedule.last_epoch + 1 < schedule.total_steps:
                schedule.step()
            total += tagged.detach(); count += 1
        predictions = predict(model, dev, device, packed_dev)
        lines = report(dev, predictions, f"epoch {epoch + 1:2}")
        # Selection: region, start and marker accuracy on development, alike.
        named = {name: l for (name, _, _), l in zip(HEADS, lines)}
        selected = float(np.mean([float(named[h].split("model ")[1].split()[0]) for h in ("region", "start", "marker")]))
        print(f"epoch {epoch + 1:2} loss {float(total) / max(count, 1):.4f} in {time.time() - began:.1f}s; selection {selected:.4f}", flush=True)
        for l in lines:
            print("  " + l, flush=True)
        if selected > best:
            best, best_state = selected, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    torch.save({"state": best_state, "model": args.model, "hidden": args.hidden, "layers": args.layers, "text": args.text, "vocabs": [v.index for v in vocabs], "vision": train[0].sight.shape[1], "whole": args.whole, "doctypes": doctype_codes, "film": args.film,
                "mean": mean.tolist(), "std": std.tolist()}, args.out / f"tagger-{args.model}.pt")
    predictions = predict(model, dev, device, packed_dev)
    if args.fold:
        write_predictions(args.out / f"crossfit-{args.fold.split('/')[0]}.jsonl", held_raw, predict(model, held, device))
    write_predictions(args.out / f"predictions-development-{args.model}.jsonl", dev_raw, predictions)
    if args.predict_train:
        write_predictions(args.out / f"predictions-train-{args.model}.jsonl", train_raw, predict(model, train, device, packed_train))
    note = REGIONS.index("note")
    with open(args.out / f"predictions-development-{args.model}-hybrid.jsonl", "w", encoding="utf-8") as hybrid:
        for raw, (labels, _, _) in zip(dev_raw, predictions):
            # Tier 0 keeps its notes (their pairs are its own) and its document starts.
            tier0 = np.asarray(raw["tier0"], dtype=np.int64)
            mixed = labels.copy()
            notes = (tier0[:, 0] == note) | (labels[:, 0] == note)
            mixed[notes, :2] = tier0[notes, :2]
            mixed[notes, 4:] = tier0[notes, 4:]
            # Note references are tier 0's as well: their pairs belong to its notes.
            mixed[:, 3] = tier0[:, 3]
            mixed[:, 2] = tier0[:, 2]
            hybrid.write(json.dumps({"sha256": raw["sha256"], "ids": raw["ids"], "labels": mixed.tolist()}) + "\n")
    for l in report(dev, predictions, "best"):
        print(l)
    print(f"done in {time.time() - started:.0f}s; best selection {best:.4f}")


if __name__ == "__main__":
    main()
