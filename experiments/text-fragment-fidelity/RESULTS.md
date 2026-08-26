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

The v22 router is fully production-derivable. It uses only normalized occurrence
counts in the complete A2AJ document, document type, publisher host, painted
word count, legal-reference words already present in the planned paint, the
publisher plan's directive/source-interval shape, and
`max(sourceWordIntervals.end) <= 200001`. It does not use labels, fixture
`shape`, publisher verifier results, Chrome output, or live-page structure.

The router selects all 171 recoverable publisher residuals and excludes the
Saskatchewan beyond-chunk row. It selects 1,203 Law Web rows in all: the 171
residuals plus 1,032 publisher-exact switchovers. A general source/plan predicate
also excludes the repeated multi-island Northwest Territories class whose
cached Law Web page did not activate its otherwise valid range. No seed label is
special-cased.

Routed target artifact:
`results/a2aj-document-routed-targets-v22.jsonl`, SHA-256
`2228ac94b730031f849418addb6182f4046ac7aa5070d178c4f86babb35a465c`.

The isolated production router was replayed over all 2,370 gettable seeds and
selected exactly the same 1,203 labels as v22: no missing or extra routes. Its
focused production test has 34/34 passing outcomes. The rebuilt Law Web target
artifact is byte-identical to v22 (the same SHA-256 above), proving parity of
all directives, intervals, paint quotes, targets, and routing metadata.

The publisher-preserving mode was also replayed through the candidate native
planner for all 2,371 original rows over 1,217 documents. All 2,371 plans are
byte-identical to the stored publisher corpus. This gate initially exposed four
Quebec section-label changes; label recognition was then isolated to Law Web
mode and the complete publisher gate passed with zero mismatches.

The final no-network headed-Chrome cache audit proved 254/1,203 routed rows
strict exact. The other 949 rows are cache misses representing 587 unique Law
Web citation-only pages. There are zero non-cache failures. The audit artifact
is `results/webdriver-exact-final-routed-lawweb-v22-cache.jsonl`, SHA-256
`71755dcb562b8d9ed9e638cf92c567147255f4469d0af57c9e07ddbedb3b3a0b`.

The attempted live proof was rejected because it would send fragment-bearing
URLs, including publisher-success passages, to an external service. The safer
remaining operation is to fetch the 587 missing citation-only
Law Web base pages in headed Chrome, cache their rendered HTML, and run the
complete fragment proof offline. That external cache expansion requires explicit
authorization. Until it is done, the 1,203-row router is a candidate rather than
a production-proven rule.

The authorization-gated crawl has a generated citation-only manifest covering
all 949 misses as 587 unique pages. Every URL is HTTPS on `law.a2aj.ca/document`,
contains only `citation` and `doc_type`, and has no fragment. Its SHA-256 is
`61bee28f29d72aa0c94e9656de0835eecd69fe74ecfcda61c154dec89732f81d`.
The crawler dry run independently reports 587 pending URLs, one allowed host,
and zero fragment-bearing requests. Before writing a page to cache, the headed
crawler now requires every routed paint quote assigned to that citation to be
present in stable rendered `innerText`; an early-loading document shell cannot
be accepted as a complete page.

## Prepared production worktree

The unapplied production candidate lives only under
`results/worktrees/root-seam`. It updates `legal-structure`, the Node adapter,
and the backend call boundary so publisher plans retain publisher mode while Law
Web plans use block mode. It also contains the v22 blind router. Focused contracts
cover three-block multi-directive paint, bilingual-furniture omission, repeated
case routing, and unique legal-reference routing. The reversible candidate patch
bundle is `CANDIDATE-production-patches.zip`, SHA-256
`36e081847696158928faa2c74bbeedb1eea91202b04144b9c8aab40a704cca05`.
Both patches pass `git apply --check` against their production repositories.
The bundle will remain unapplied until the user authorizes production changes.
