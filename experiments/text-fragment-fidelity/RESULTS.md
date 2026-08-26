# Text-fragment fidelity results

Status: candidate awaiting authorization for the final Law Web cache expansion.
No production file or running Beaver service was changed.

## Corpus and contract

The corpus contains 2,371 seeds over 1,217 complete flattened A2AJ documents.
`FCA_2026_FC_103_p20_short-exact` is the single excluded seed because its
official publisher URL was manually confirmed to be a genuine 404. The
remaining 2,370 seeds are the product corpus.

The builder receives only the complete flattened A2AJ document, requested
quotes, citation/source metadata, and publisher URL. Chrome results are never
builder or router inputs. The planner may emit multiple nearby directives.
Substantive words remain required; only exact provision/paragraph furniture,
isolated bilingual translation furniture, and previously classified duplicate
signature metadata may be omitted.

## Publisher baseline

The hash-bound headed-Chrome publisher proof is
`results/webdriver-exact-final-publisher-current.jsonl` plus its error-recovery
rows. It establishes 2,198 strict exact publisher links and 172 residuals.
Publisher pages are cached and byte-bound. The one excluded 404 is not counted
as a residual.

## A2AJ Law Web fallback candidate

The v19 source-only planner adds a Law-Web spelling/block mode. It:

- preserves source punctuation spacing instead of applying publisher spelling
  repairs;
- treats source newlines as possible rendered block seams;
- uses multiple directives for short labelled quotes spanning three blocks;
- uses rendered labels only as unpainted disambiguating context and never uses
  Markdown-only labels as browser context;
- recognizes an isolated `(« … »)` definition translation as furniture; and
- prefers safe within-block exact cores and context before cross-block ranges.

The full 172-row fallback gate used six BelowNormal headed-Chrome workers and
18 shards. It completed in 90.2 seconds with zero worker restarts:

| result | rows |
|---|---:|
| strict exact | 171 |
| initial-viewport miss | 1 |

Target artifact:
`results/a2aj-document-fallback-targets-v19.jsonl`, SHA-256
`6e88ea225708dec538658ebb6e0c1785b247f301d474be1c3b042c109448ec50`.
Proof artifact:
`results/webdriver-exact-final-a2aj-document-v19.jsonl`, SHA-256
`d3c762b6fb24e5a29964ee6e633775c43f3b006fe15d2e3a5abaec26fe591045`.

The sole miss is
`LEGISLATION-SK_SS_2015_c_I-9.11_sec4-3_hard-act-name`. Its source interval
starts beyond the approximately 200,000-character initial document rendered by
Law Web. The publisher PDF lands on page 123 and paints all 16 intended words,
but Chrome also reports extraneous natural-paint geometry. The blind router
therefore keeps this row on its best publisher result.

## Blind router candidate

The current router analysis uses NFKC/lowercase/whitespace-normalized occurrence
counts in the full A2AJ document, document type, publisher host, the corpus's
semantic `shape` fixture, and `max(sourceWordIntervals.end) <= 200001`. It selects every one of
the 171 recoverable publisher residuals and excludes the Saskatchewan
beyond-chunk row. The current compact rule selects 1,151 Law Web rows in all:
171 publisher residuals and 980 publisher-exact switchovers. It avoids 1,214
unnecessary switchovers compared with routing every within-chunk row.

The `shape` fixture is verifier-corpus metadata, not a production input. It must
be replaced by equivalent properties derived from quotes/source/plans before
the router can enter the production patch. Treating it as available at runtime
would violate the no-oracle contract.

Routed target artifact:
`results/a2aj-document-routed-targets-v19.jsonl`, SHA-256
`91d6c12ff22407d7d8a46540a8a7c9c143e00863b7240870f7fa8177fa688675`.

The local cache audit proved 257/1,151 routed rows exact. It found 893 seed
cache misses representing 538 unique Law Web document pages, plus one cached
publisher-success switchover that needs router/builder diagnosis. The audit
artifact is
`results/webdriver-exact-final-routed-lawweb-v19-cache.jsonl`, SHA-256
`7bca5e174b211e72afd9beb872ffe1475228b2018d43e1b064e831b956d138a`.

The attempted live proof was rejected because it would send 1,151
fragment-bearing URLs, including 980 publisher-success passages, to an external
service. The safer remaining operation is to fetch the 538 missing citation-only
Law Web base pages in headed Chrome, cache their rendered HTML, and run the
complete fragment proof offline. That external cache expansion requires explicit
authorization. Until it is done, the 1,151-row router is a candidate rather than
a production-proven rule.

## Prepared production worktree

The unapplied native candidate lives only under
`results/worktrees/root-seam`. It updates `legal-structure`, the Node adapter,
and the backend call boundary so publisher plans retain publisher mode while
Law Web plans use block mode. Focused contracts cover three-block multi-directive
paint and bilingual-furniture omission. The validated reversible diffs are
stored in `CANDIDATE-production-patches.zip`. The final router and production patch
will not be frozen or applied until the missing routed pages are cached and the
full routed proof is clean.
