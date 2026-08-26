# Legal grammar tables

The authored portable legal-text grammar corpus lives in
`../../legal-structure/data`. This directory contains its validation tool and
the receipt for the imported US citation families.

Beaver and the legal PDF parser load the standalone Rust engine's corpus.
Authorities Helper receives a byte-identical bundle. Consumers compile the
patterns in their own runtime. The patterns use a small portable dialect:
JavaScript-style named groups, `ims` flags, and `{{def}}` fragments. Runtime
adapters may translate syntax, but must not change the corpus.

`legal-structure/data/grammar-corpus.json` is authored. Its manifest and the
Table of Authorities bundle are derived. After a corpus edit, run:

The US citation families are a runtime-free snapshot derived from eyecite
2.7.8 and reporters-db 3.2.66 (BSD-2-Clause). Exact commits, source hashes,
counts, licence, and the resulting corpus hash are pinned in
`eyecite-us-receipt.json`; `check.mjs` refuses receipt or corpus drift. Neither
upstream package is a shipping dependency.

Corpus and bundle JSON use LF bytes on every platform. The receipt and
manifest hash those exact bytes; the generator and `.gitattributes` preserve
that invariant on Windows.

```console
npm run sync
npm run check
```

`check` fails closed on an unknown field, duplicate ID, missing vector,
undefined fragment, invalid flag, manifest mismatch, or stale/missing bundle.
The PDF parser additionally runs every vector in Python and Rust. A consumer
can bundle this directory without Beaver or npm; the JSON files are the public
data contract and `check.mjs` uses only Node's standard library.
