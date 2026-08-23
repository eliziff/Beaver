# Results

The deterministic 500-artifact freeze contains 417 DOCX and 83 XLSX files.
Of those, 411 supply native table facts: 2,195 tables and 93,982 authoritative
cells. One deliberately truncated DOCX is the only adapter error.

`baseline.json` records the inventory, projection, masked-input, and raw-oracle
SHA-256 receipts. Raw oracle rows remain ignored under `results/`.

The existing 872-document instrument gate contributes no table-bearing cases:
its 124 gold and 748 adversarial inputs all report zero native table maps.

Exact masked-input and complete legacy-projection parity passes for all 411
table-bearing artifacts. On the same in-memory facts, retaining outputs until
each run completes, one warm-up plus five release measurements produced
medians of 343.87 ms for TypeScript and 161.63 ms for Rust: Rust is 2.13x
faster over 117,386 emitted nodes.
