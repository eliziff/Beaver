# Eyecite US grammar integration results

## Pinned oracle

- eyecite 2.7.8, commit `09165c2d90b4295b4967b1b01b83963c37ab2a98`
- reporters-db 3.2.66, commit `fad63b383b92f9446c223ddc12bf0b6fd1a6b44c`
- both upstream repositories declare BSD-2-Clause

## Authored snapshot

- Production corpus: 407,193 bytes (512 KiB cap), 72 entries, 296 vectors.
- US coverage: 3,341 standard reporter surfaces, 805 journal surfaces, and
  1,353 custom full/short reporter/law extractors after exact-pattern
  deduplication.
- The standard full/short reporter and journal catalogues are factored once;
  custom reporter entries remain separate so nominate-reporter overlaps do
  not suppress a later valid reporter span.
- Python's nonportable `{,N}` quantifier spelling is authored as the equivalent
  `{0,N}`. Capturing groups inside combined custom alternatives become
  noncapturing; match language and source span are unchanged.
- `packages/legal-grammar-tables/eyecite-us-receipt.json` pins versions,
  commits, licence, source counts, source hashes, and the exact production
  corpus SHA-256. The package checker refuses drift.

## Exact-span gates

Run 2026-08-20 at Windows `BelowNormal` priority:

- Catalogue differential: all 8,292 standard full/short synthetic witnesses
  passed exact source-span and alphanumeric-boundary checks. Every witness was
  also routed through the public production splitter with zero missed anchors.
- Upstream examples: all 503 reporter and 391 law examples matched eyecite's
  resolved spans exactly. The experiment explicitly derives precedence from
  upstream ambiguity examples (including CCH compound pages) rather than
  relying on regex-source length.
- Custom extractors: 1,145 of 1,353 have an upstream or mechanically derived
  exact-span witness, and every witnessed extractor reaches the public
  production splitter. The remaining 208 have no reporters-db example; their
  patterns still pass portable compilation and representative production
  vectors rather than receiving invented fixtures.
- CourtListener provider census: all 18,123,788 installed citation rows across
  989 reporter surfaces were checked in 30.081 s. Eyecite recognizes
  17,881,480; Beaver has zero span mismatches on those rows. The 242,308 rows
  unsupported by eyecite are recorded separately, not misreported as Beaver
  failures.
- Full-text precision probe: 100 installed CourtListener opinions, 1,946 US
  citations, zero false negatives and zero false positives. This probe exposed
  and then pinned eyecite's nominate-reporter overlap behavior.

## Runtime gates

- JavaScript package check: 1.36 s; all US entries compile and execute their
  vectors.
- Python corpus check: 5.95 s; all 296 vectors pass.
- Backend citation scanner: focused 9-test suite passes in 1.25 s and covers US
  reporters, short cites, journals, and statutes through the shared corpus.
- Legal-PDF Python splitter: focused 3-test suite passes; US reporter/statute
  anchors reach public split output.
- AuthoritiesHelper: focused US TOA behavior test passes.
- Rust consumes the same IDs with per-pattern lazy compilation. After repairing
  three mechanical error conversions in the ongoing crate split, all four
  `grammar_tables` tests execute and pass, including every frozen vector and
  the anchor-window/full-scan differential (39.93 s at `BelowNormal`).

## Performance finding

A direct six/eight-pattern full scan is rejected: the 100-opinion probe ran at
5.8 opinions/s over a 1.5-billion-character corpus. The durable corpus gate
uses the provider's 18.1-million structured citation rows (30.081 s) and keeps
the full-text probe for precision/overlap.

The explicit cold 37,000-input shipping-backend gate initially failed to reach
its first 3,700-input checkpoint in 60 s. Its corpus-derived standard-surface
index and bounded common-law fast path now finish all 37,000 distinct inputs in
0.476 s (0.530 s in the final release rerun) at `BelowNormal` priority, with
the complete authored regexes retained
as the residual fallback. That fallback is behavior-pinned on custom reporter
and law surfaces. The ignored Python reference path independently finishes the
same-size gate in 8.599 s. Both are below the 15 s ceiling. Shipping consumers
compile lazily; they do not run the corpus harness or depend on
eyecite/reporters-db. A Rust rewrite was not needed.
