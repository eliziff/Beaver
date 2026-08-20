# Legal grammar tables

This directory is the single authored corpus for Beaver's portable legal-text
grammars. It contains citation, footnote-label, pinpoint, provision, and
reference dialects together with every frozen positive and negative vector.

Beaver, the legal PDF parser, and Authorities Helper all load their
applicable entries from a byte-identical bundle. Consumers compile the
patterns in their own runtime. The patterns use a small portable dialect:
JavaScript-style named groups, `ims` flags, and `{{def}}` fragments. Runtime
adapters may translate syntax, but must not change the corpus.

`grammar-corpus.json` is authored. `manifest.json` and the copies under the
standalone PDF parser and Table of Authorities projects are derived. After a
corpus edit, run:

The US citation families are a runtime-free snapshot derived from eyecite
2.7.8 and reporters-db 3.2.66 (BSD-2-Clause). Exact commits, source hashes,
counts, licence, and the resulting corpus hash are pinned in
`eyecite-us-receipt.json`; `check.mjs` refuses receipt or corpus drift. Neither
upstream package is a shipping dependency.

```console
npm run sync
npm run check
```

`check` fails closed on an unknown field, duplicate ID, missing vector,
undefined fragment, invalid flag, manifest mismatch, or stale/missing bundle.
The PDF parser additionally runs every vector in Python and Rust. A consumer
can bundle this directory without Beaver or npm; the JSON files are the public
data contract and `check.mjs` uses only Node's standard library.
