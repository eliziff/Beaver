"""Dense lane for LegalBench-RAG (Stage 18 arm D, committed for the Stage 18R
re-trace): embed the passage index and the queries with a sentence-transformers
model on CUDA and build the six registered pool arms.

The original arm D lived in scratchpad files (`dense_eval.py` fastembed/CPU,
then `qwen_dense_eval.py` / `qwen_dense_pools.py` on the RTX 3080 Ti) with the
work directory and the header sidecar hardcoded. An arm that cannot be
re-derived from the repo cannot be re-traced, so it is committed here with the
paths parameterized. Arm definitions, pooling, and the RRF fusion rule are
unchanged from the original run.

Arms (all pools are top-`--pool-k` with a per-document cap):
  lex       plain lexical pool               (from tests.jsonl `lex_pool`)
  ctx       context-enriched lexical pool    (from tests.jsonl `ctx_pool`)
  dense     dense-only, passages embedded as name+text
  densectx  dense-only, passages embedded as name+header+text
  fused     RRF(ctx, densectx)   -- the production-shaped hybrid
  fusedlex  RRF(lex, dense)      -- pre-header hybrid, for attribution

This script only BUILDS pools; it never scores. Scoring is the committed
instrument's job (`legalbench_pool_rescore.py --coords lf --arm <arm>`), so the
GPU box needs no benchmark gold and the scoring conventions live in one place.

Inputs are produced by `legalbench-dense-dump.ts`:
  <dir>/passages.jsonl  {pid, doc_id, language, citation, name, start, end, text}
  <dir>/tests.jsonl     {test_id, source, query, gold, lex_pool, ctx_pool, coords}

Usage (on the GPU host):
  python legalbench_dense_pools.py --dir C:\\Users\\elias\\stage18r-dense \\
      --context-jsonl <headers.jsonl> [--model Qwen/Qwen3-Embedding-4B] \\
      [--out dense-pools.jsonl] [--fused-sidecar fused-pools.jsonl]

Passage embeddings are cached as .npy beside the inputs and reused when their
row count matches, so the header-dependent pass does not re-embed the plain
matrix. `--no-cache` forces a recompute.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from collections import defaultdict

import numpy as np

ARMS = ("lex", "ctx", "dense", "densectx", "fused", "fusedlex")


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", required=True, help="work dir holding passages.jsonl / tests.jsonl")
    ap.add_argument("--model", default="Qwen/Qwen3-Embedding-4B")
    ap.add_argument(
        "--context-jsonl",
        default=None,
        help="situating-header sidecar keyed by (doc_id, language, start, end); "
        "omit to run without headers (ctx arms then degenerate to their plain twins)",
    )
    ap.add_argument("--out", default="dense-pools.jsonl", help="arm pools, relative to --dir")
    ap.add_argument(
        "--fused-sidecar",
        default=None,
        help="also write the fused arm alone in the {test_id, source, pool} sidecar "
        "shape the grounding runner's --pool-jsonl consumes",
    )
    ap.add_argument("--pool-k", type=int, default=48)
    ap.add_argument("--per-doc-cap", type=int, default=24)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--max-seq", type=int, default=1024)
    ap.add_argument("--rrf-k", type=int, default=60)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--no-cache", action="store_true")
    return ap.parse_args()


def read_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def load_headers(path):
    """Situating headers, last-wins on duplicate keys (same semantics as
    loadContextHeaders in the TypeScript retrieval lane); error rows skipped."""
    headers = {}
    if not path:
        return headers
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("error"):
                continue
            headers[(row["doc_id"], row["language"], row["start"], row["end"])] = row["header"]
    return headers


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest().upper()


def dense_pool(matrix, query_vector, passages, pool_k, per_doc_cap):
    scores = matrix @ query_vector
    hits, per_doc = [], defaultdict(int)
    for index in np.argsort(-scores):
        passage = passages[index]
        if per_doc[passage["citation"]] >= per_doc_cap:
            continue
        per_doc[passage["citation"]] += 1
        hits.append(
            {
                "citation": passage["citation"],
                "start": passage["start"],
                "end": passage["end"],
            }
        )
        if len(hits) >= pool_k:
            break
    return hits


def rrf_fuse(lists, rrf_k, top):
    """Reciprocal-rank fusion, 1/(k + rank + 1), summed across lists."""
    scores, items = {}, {}
    for ranked_list in lists:
        for rank, span in enumerate(ranked_list):
            key = (span["citation"], span["start"], span["end"])
            scores[key] = scores.get(key, 0.0) + 1.0 / (rrf_k + rank + 1)
            items[key] = span
    return [items[key] for key in sorted(scores, key=lambda key: -scores[key])[:top]]


def main():
    args = parse_args()
    passages = read_jsonl(os.path.join(args.dir, "passages.jsonl"))
    tests = read_jsonl(os.path.join(args.dir, "tests.jsonl"))
    headers = load_headers(args.context_jsonl)
    matched = sum(
        1
        for p in passages
        if (p["doc_id"], p["language"], p["start"], p["end"]) in headers
    )
    print(
        "model=%s passages=%d tests=%d headers=%d matched=%d"
        % (args.model, len(passages), len(tests), len(headers), matched),
        flush=True,
    )
    if args.context_jsonl and matched == 0:
        raise SystemExit(
            "context sidecar matched 0 passages -- wrong coordinate space for this index"
        )

    import torch  # noqa: PLC0415 -- keep the import cost on the GPU path only
    from sentence_transformers import SentenceTransformer  # noqa: PLC0415

    print(
        "device=%s cuda=%s gpu=%s"
        % (
            args.device,
            torch.cuda.is_available(),
            torch.cuda.get_device_name(0) if torch.cuda.is_available() else "-",
        ),
        flush=True,
    )
    model = SentenceTransformer(
        args.model,
        device=args.device,
        model_kwargs={"torch_dtype": torch.float16},
        tokenizer_kwargs={"padding_side": "left"},
    )
    model.max_seq_length = args.max_seq

    def embed(texts, label, prompt_name=None, cache=None):
        path = os.path.join(args.dir, cache) if cache else None
        if path and not args.no_cache and os.path.exists(path):
            matrix = np.load(path)
            if matrix.shape[0] == len(texts):
                print("%s: cache %s shape=%s" % (label, cache, matrix.shape), flush=True)
                return matrix
            print(
                "%s: cache %s has %d rows, need %d -- recomputing"
                % (label, cache, matrix.shape[0], len(texts)),
                flush=True,
            )
        start = time.time()
        matrix = model.encode(
            texts,
            prompt_name=prompt_name,
            batch_size=args.batch,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        ).astype(np.float32)
        print(
            "%s embed: %.1fs dim=%d" % (label, time.time() - start, matrix.shape[1]),
            flush=True,
        )
        if path:
            np.save(path, matrix)
        return matrix

    # The lexical lane's name column carries document identity; the dense lane
    # gets the same signal in-band. The ctx variant adds the situating header,
    # mirroring the adopted FTS config.
    plain_texts = ["%s\n%s" % (p["name"] or p["citation"], p["text"]) for p in passages]
    ctx_texts = []
    for p in passages:
        header = headers.get((p["doc_id"], p["language"], p["start"], p["end"]))
        ctx_texts.append(
            "%s\n%s%s"
            % (p["name"] or p["citation"], header + "\n" if header is not None else "", p["text"])
        )

    plain_matrix = embed(plain_texts, "passage(plain)", cache="P_plain.npy")
    if args.context_jsonl:
        # Cache key carries the sidecar hash: a header regeneration must not be
        # served a matrix embedded over the previous sidecar's text.
        ctx_matrix = embed(
            ctx_texts,
            "passage(ctx)",
            cache="P_ctx.%s.npy" % sha256(args.context_jsonl)[:12].lower(),
        )
    else:
        print(
            "no --context-jsonl: ctx arms degenerate to their plain twins "
            "(ctx==lex, densectx==dense, fused==fusedlex)",
            flush=True,
        )
        ctx_matrix = plain_matrix
    queries = embed([t["query"] for t in tests], "query", prompt_name="query", cache="Q.npy")

    out_path = os.path.join(args.dir, args.out)
    fused_path = os.path.join(args.dir, args.fused_sidecar) if args.fused_sidecar else None
    fused_fh = open(fused_path, "w", encoding="utf-8", newline="") if fused_path else None
    coords = tests[0].get("coords", "unknown") if tests else "unknown"
    with open(out_path, "w", encoding="utf-8", newline="") as fh:
        for i, test in enumerate(tests):
            dense = dense_pool(plain_matrix, queries[i], passages, args.pool_k, args.per_doc_cap)
            densectx = dense_pool(ctx_matrix, queries[i], passages, args.pool_k, args.per_doc_cap)
            arms = {
                "lex": test["lex_pool"],
                "ctx": test["ctx_pool"],
                "dense": dense,
                "densectx": densectx,
                "fused": rrf_fuse([test["ctx_pool"], densectx], args.rrf_k, args.pool_k),
                "fusedlex": rrf_fuse([test["lex_pool"], dense], args.rrf_k, args.pool_k),
            }
            fh.write(
                json.dumps(
                    {
                        "test_id": test["test_id"],
                        "source": test["source"],
                        "model": args.model,
                        "coords": coords,
                        "headers_matched": matched,
                        "arms": {arm: arms[arm] for arm in ARMS},
                    }
                )
                + "\n"
            )
            if fused_fh:
                fused_fh.write(
                    json.dumps(
                        {
                            "test_id": test["test_id"],
                            "source": test["source"],
                            "model": args.model,
                            "coords": coords,
                            "pool": arms["fused"],
                        }
                    )
                    + "\n"
                )
    if fused_fh:
        fused_fh.close()
        print("wrote %s\nsha256 = %s" % (fused_path, sha256(fused_path)))
    print("wrote %s\nsha256 = %s" % (out_path, sha256(out_path)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
