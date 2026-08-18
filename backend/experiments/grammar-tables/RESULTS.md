# Canonical grammar-table runtime

`packages/legal-grammar-tables/grammar-corpus.json` is the complete authored
corpus for the citation, reference, pinpoint, and footnote grammars currently
inventoried. The legal PDF engine loads a byte-verified bundle of that one file;
the ToA project carries the same bundle for a future output-identical migration.
The package verifier rejects incomplete tables, bad fragments, missing vectors,
and stale bundles.

The TypeScript loader previously lived under `src/lib/detect/` but had no
production consumer; only its own test imported it. It is kept here with its
cross-runtime vector gate until a complete TypeScript consumer migration exists.
Do not promote it merely to share a regex or two. Promotion requires an inventory
of every displaced shipping grammar, exact span differentials against those
implementations, and a fail-closed check for missing, extra, or drifted packaged
entries.
