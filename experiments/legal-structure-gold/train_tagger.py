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
import torch.utils.checkpoint

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
    """One document's tensors: normalized evidence, tier 0, text, reader codes, gold, sight, type."""

    def __init__(self, raw, names, vocabs, mean, std, witness=None, vision=None, doctype=None):
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
        self.text = chars([t[0] for t in raw["text"]])
        self.words = words([t[0] for t in raw["text"]])
        region_types, note_modes, families = vocabs
        self.reader = np.asarray([[region_types(t[1]), note_modes(t[2]), families(t[3])] for t in raw["text"]], dtype=np.int64)
        self.gold = np.asarray([g if g is not None else [-100] * LABELS for g in raw["gold"]], dtype=np.int64)
        # The steps are learned on heading starts and body unit starts; elsewhere the columns are no target.
        heading = REGIONS.index("heading")
        self.gold[(self.gold[:, 0] != heading) | (self.gold[:, 1] != 1), 4] = -100
        self.gold[~np.isin(self.gold[:, 0], BODY) | (self.gold[:, 1] != 1), 7] = -100
        self.length = len(values)


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


    def encode(self, features, tier0, text, reader, words, sight, doctype, lengths):
        """Each window's pieces' states: (windows, length, 2 * hidden)."""
        b, t, _ = features.shape
        flat_text, flat_words = text.reshape(b * t, text.shape[-1]), words.reshape(b * t, words.shape[-1])

        def read(lo, hi):
            # Pieces lo..hi, each text read whole: padded only to the longest text among them.
            chunk = flat_text[lo:hi]
            chunk = chunk[:, :max(1, int((chunk > 0).sum(dim=1).max()))]
            e = self.char(chunk).transpose(1, 2)
            c = F.relu(self.conv(e)).max(dim=2).values
            if self.wide:
                c5 = F.relu(self.conv5(e)).max(dim=2).values
                w = flat_words[lo:hi]
                mask = (w > 0).unsqueeze(-1).float()
                wm = (self.word(w) * mask).sum(1) / mask.sum(1).clamp(min=1)
                c = torch.cat([c, c5, wm], dim=-1)
            return c

        # Each piece's text is read on its own, so reading the pieces in chunks changes nothing but
        # memory; while training, a chunk's activations are recomputed for the backward pass.
        step = 2048
        chunks = []
        for lo in range(0, b * t, step):
            hi = min(b * t, lo + step)
            if self.training:
                chunks.append(torch.utils.checkpoint.checkpoint(read, lo, hi, use_reentrant=False))
            else:
                chunks.append(read(lo, hi))
        c = torch.cat(chunks).view(b, t, -1)
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
                packed = nn.utils.rnn.pack_padded_sequence(x.float(), lengths.cpu(), batch_first=True, enforce_sorted=False)
                x, _ = self.encoder(packed)
                x, _ = nn.utils.rnn.pad_packed_sequence(x, batch_first=True, total_length=t)
            return self.condition(x, doctype)
        mask = torch.arange(t, device=x.device)[None] < lengths[:, None]
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

    def __init__(self, docs, device):
        if WHOLE:
            spans = [(k, 0, d.length, 0, d.length) for k, d in enumerate(docs)]
        else:
            spans = [(k, max(0, core - CONTEXT), min(d.length, core + WINDOW + CONTEXT), core, min(d.length, core + WINDOW))
                     for k, d in enumerate(docs) for core in range(0, d.length, WINDOW)]
        length = max(hi - lo for _, lo, hi, _, _ in spans)
        f = torch.zeros(len(spans), length, docs[0].features.shape[1])
        t0 = torch.zeros(len(spans), length, LABELS, dtype=torch.long)
        # Text and words padded to the longest piece's in the batch.
        tx = torch.zeros(len(spans), length, max(d.text.shape[1] for d in docs), dtype=torch.long)
        rd = torch.zeros(len(spans), length, 3, dtype=torch.long)
        wd = torch.zeros(len(spans), length, max(d.words.shape[1] for d in docs), dtype=torch.long)
        sg = torch.zeros(len(spans), length, docs[0].sight.shape[1])
        dt = torch.zeros(len(spans), length, dtype=torch.long)
        index = [np.zeros(d.length, dtype=np.int64) for d in docs]
        for w, (k, lo, hi, a, b) in enumerate(spans):
            d = docs[k]
            dt[w, :hi - lo] = torch.from_numpy(d.doctype[lo:hi])
            f[w, :hi - lo] = torch.from_numpy(d.features[lo:hi])
            t0[w, :hi - lo] = torch.from_numpy(d.tier0[lo:hi])
            tx[w, :hi - lo, :d.text.shape[1]] = torch.from_numpy(d.text[lo:hi])
            rd[w, :hi - lo] = torch.from_numpy(d.reader[lo:hi])
            wd[w, :hi - lo, :d.words.shape[1]] = torch.from_numpy(d.words[lo:hi])
            sg[w, :hi - lo] = torch.from_numpy(d.sight[lo:hi])
            index[k][a:b] = w * length + np.arange(a - lo, b - lo)
        lengths = torch.as_tensor([hi - lo for _, lo, hi, _, _ in spans])
        self.inputs = [x.to(device) for x in (f, t0, tx, rd, wd, sg, dt)] + [lengths.to(device)]
        self.index = [torch.as_tensor(i, device=device) for i in index]

    def states(self, model):
        """Each document's pieces' states, (pieces, 2 * hidden), in one tensor document after document."""
        x = model.encode(*self.inputs)
        flat = x.reshape(-1, x.shape[-1])
        return flat[torch.cat(self.index)]


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


def tag_loss(outputs, gold, weights):
    """The heads' cross-entropies summed; a head with no target in the batch (silver rows carry region and start only)
    adds nothing rather than NaN."""
    total = 0.0
    for output, (name, column, n) in zip(outputs, HEADS):
        if not bool((gold[:, column] >= 0).any()):
            continue
        total = total + F.cross_entropy(output.float(), gold[:, column], weight=weights.get(name), ignore_index=-100)
    return total


@torch.no_grad()
def predict(model, docs, device):
    """Per document: each head's prediction; the step stays on heading starts, and a resumed piece
    resumes the latest earlier unit of its region. Parents are not predicted: the decoder derives
    them from regions and the levels the steps rebuild by the hierarchy rule."""
    model.eval()
    results = []
    heading = REGIONS.index("heading")
    for doc in docs:
        states = Windows([doc], device).states(model).float()
        labels = np.zeros((doc.length, LABELS), dtype=np.int64)
        outputs = model.tag(states)
        for output, (_, column, _) in zip(outputs, HEADS):
            labels[:, column] = output.float().argmax(dim=-1).cpu().numpy()
        p_heading = (torch.softmax(outputs[0].float(), dim=-1)[:, heading] * torch.softmax(outputs[1].float(), dim=-1)[:, 1]).cpu().numpy()
        level_p = torch.softmax(outputs[4].float(), dim=-1).cpu().numpy()
        labels[:, 6] = -1
        labels[labels[:, 0] == 0, 1] = 0
        labels[(labels[:, 0] != heading) | (labels[:, 1] != 1), 4] = 0
        labels[~np.isin(labels[:, 0], BODY) | (labels[:, 1] != 1), 7] = 0
        labels[labels[:, 1] != 1, 5] = 0
        latest = {}
        for n in range(doc.length):
            if labels[n, 1] == 2:
                labels[n, 6] = latest.get(int(labels[n, 0]), -1)
                if labels[n, 6] < 0:
                    labels[n, 1] = 1
            if labels[n, 1] == 1:
                latest[int(labels[n, 0])] = n
        results.append((labels, p_heading, level_p))
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
    train_raw, dev_raw = load(args.rows / "rows-train.jsonl"), load(args.rows / "rows-development.jsonl")
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
    train = [Document(d, names, vocabs, mean, std, witness_train, args.vision, doctype) for d in train_raw]
    dev = [Document(d, names, vocabs, mean, std, witness_dev, args.vision, doctype) for d in dev_raw]
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
        silver = [Document(d, names, vocabs, mean, std, vision=args.vision) for d in silver_raw]
        for d in silver:
            d.gold[:, 2:] = -100
        print(f"pretraining on {len(silver)} silver documents, {sum(d.length for d in silver)} units, {args.pretrain_epochs} epochs", flush=True)
        pre_optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
        pre_steps = args.pretrain_epochs * len(batches(silver, args.windows, random.Random(0)))
        pre_schedule = torch.optim.lr_scheduler.OneCycleLR(pre_optimizer, max_lr=args.lr, total_steps=pre_steps, pct_start=0.1)
        pre_rng = random.Random(args.seed)
        for epoch in range(args.pretrain_epochs):
            model.train()
            began, total, count = time.time(), 0.0, 0
            for group in batches(silver, args.windows, pre_rng):
                docs = [silver[n] for n in group]
                gold = torch.as_tensor(np.concatenate([d.gold for d in docs]), device=device)
                pre_optimizer.zero_grad(set_to_none=True)
                with torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                    states = Windows(docs, device).states(model)
                    outputs = model.tag(states)
                loss = tag_loss(outputs, gold, weights)
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                pre_optimizer.step(); pre_schedule.step()
                total += float(loss.detach()); count += 1
            lines = report(dev, predict(model, dev, device), f"pretrain {epoch + 1}")
            print(f"pretrain epoch {epoch + 1} loss {total / max(count, 1):.4f} in {time.time() - began:.1f}s", flush=True)
            for l in lines[:2]:
                print("  " + l, flush=True)
        del silver, silver_raw
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = args.epochs * len(batches(train, args.windows, random.Random(0)))
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.lr, total_steps=steps, pct_start=0.1)
    rng = random.Random(args.seed)
    best, best_state = -1.0, None
    args.out.mkdir(parents=True, exist_ok=True)
    for epoch in range(args.epochs):
        model.train()
        began, total, count = time.time(), 0.0, 0
        for group in batches(train, args.windows, rng):
            docs = [train[n] for n in group]
            gold = torch.as_tensor(np.concatenate([d.gold for d in docs]), device=device)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                states = Windows(docs, device).states(model)
                outputs = model.tag(states)
            tagged = tag_loss(outputs, gold, weights)
            tagged.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            # An epoch's batch count varies with the grouping's jitter; the schedule is sized from one draw.
            if schedule.last_epoch + 1 < schedule.total_steps:
                schedule.step()
            total += float(tagged.detach()); count += 1
        predictions = predict(model, dev, device)
        lines = report(dev, predictions, f"epoch {epoch + 1:2}")
        # Selection: region, start and marker accuracy on development, alike.
        named = {name: l for (name, _, _), l in zip(HEADS, lines)}
        selected = float(np.mean([float(named[h].split("model ")[1].split()[0]) for h in ("region", "start", "marker")]))
        print(f"epoch {epoch + 1:2} loss {total / max(count, 1):.4f} in {time.time() - began:.1f}s; selection {selected:.4f}", flush=True)
        for l in lines:
            print("  " + l, flush=True)
        if selected > best:
            best, best_state = selected, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    torch.save({"state": best_state, "model": args.model, "hidden": args.hidden, "layers": args.layers, "text": args.text, "vocabs": [v.index for v in vocabs], "vision": train[0].sight.shape[1], "whole": args.whole, "doctypes": doctype_codes, "film": args.film,
                "mean": mean.tolist(), "std": std.tolist()}, args.out / f"tagger-{args.model}.pt")
    predictions = predict(model, dev, device)
    if args.fold:
        held = [Document(d, names, vocabs, mean, std, witness_train, args.vision, doctype) for d in held_raw]
        write_predictions(args.out / f"crossfit-{args.fold.split('/')[0]}.jsonl", held_raw, predict(model, held, device))
    write_predictions(args.out / f"predictions-development-{args.model}.jsonl", dev_raw, predictions)
    if args.predict_train:
        write_predictions(args.out / f"predictions-train-{args.model}.jsonl", train_raw, predict(model, train, device))
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
