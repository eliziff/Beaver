# Text-fragment fidelity results

Status: v26 is proved over the complete gettable corpus and promoted to the
production link builder. The running Beaver service was not stopped or
restarted.

## Contract and corpus

The corpus contains 2,371 seeds over 1,217 complete flattened A2AJ documents.
`FCA_2026_FC_103_p20_short-exact` is excluded because its official publisher
URL was manually confirmed to be a genuine 404. The other 2,370 seeds are the
product corpus.

The builder and router receive only complete flattened A2AJ text, requested
quotes, citation/source metadata, and the publisher URL. Chrome results,
expected labels, citations as row identities, and live-page structure are never
runtime inputs. Multiple nearby text directives are supported. Every safely
paintable substantive word is preserved; only source furniture that cannot be
painted with certainty may be omitted.

## v26 publisher preference refinement

Five bounded publisher-side methods were checked against the 166 v25 fallback
rows. Direct combined-URL PDF geometry restored 54 rows, longest-first PDF
directive ordering restored 10, and full-document-rarity-first ordering
restored 4. Removing HTML anchors restored 0/74, while removing Decisia's
`site_preference=mobile` flag restored 0/17 and failed to render the quotes.

The PDF verifier now measures the actual combined production URL when all
intended islands occupy its naturally landed page. Isolated single-directive
reloads remain diagnostic and cannot reject an exact combined paint. The two
ordering methods are selected only by the same no-oracle structural signatures
used by production; the target replay matches all 14 rewritten URLs exactly.

The final routes are:

| route | rows | share |
|---|---:|---:|
| original publisher | 2,272 | 95.9% |
| A2AJ Law Web | 98 | 4.1% |

This removes 68 of the 166 v25 fallbacks and 514 of the 612 v24 fallbacks. The
98-row routed target SHA-256 is
`728e0a10a8f7c934bfd240775b07c43449ff82b10192af46b0233192f601436b`.
The 68 new headed-Chrome exact publisher proofs have SHA-256
`32932570d471da842dfad0e81495698d772877eba60f7bd4f2970cd57ddc8757`.

The final 2,370-row composite remains 2,369 strict exact results plus the one
documented Saskatchewan PDF geometry limit. Every proof is bound to cached
page bytes and there are no failures. Its SHA-256 is
`802de1f3aaf985894727ad1b9f4fed7f934c6eef2c0b79bc3388e2f92877c33f`.

## v25 publisher preference refinement

The v25 router refines, but never broadens, the v24 failure classes with three
facts already available to production: total painted words, the word count of
each painted island, and the complete source-block word count. No URL identity,
citation, seed label, expected verdict, or browser result is a runtime input.

Across the 2,365 publisher rows eligible for exact fallback, the refined
classifier selects exactly the 166 headed-Chrome-proved publisher failures and
zero publisher successes. The final product routes are:

| route | rows | share |
|---|---:|---:|
| original publisher | 2,204 | 93.0% |
| A2AJ Law Web | 166 | 7.0% |

This removes all 446 unnecessary v24 Law Web switchovers, a 72.9% reduction in
fallback traffic. The routed target SHA-256 is
`5f0615ab6f59cfba45ef446e2f4e869eeabee1ddc22ed3d2a557e64ae249c2cb`.

A fresh full gate used six BelowNormal headed-Chrome workers over 24 isolated
shards. It completed in 112.4 seconds with zero restarts and proved 166/166
strict exact paints. Its SHA-256 is
`95b9b9eb2ae7bb113e8ee21c7ea8a11a8385642acd84beb96bd05448e7523325`.

The final 2,370-row composite remains 2,369 strict exact results plus the one
documented Saskatchewan PDF geometry limit, with all 2,370 proofs bound to
cached page bytes and no failures. Its SHA-256 is
`8995098b2b3d16c996bfe2a823921facc215d1b1eb632a13fda37db7812a6e34`.

## No-oracle system

The v24 baseline retained the established PDF and case behavior. Legislation
HTML may replace one cross-block range with independently unique block
directives only when the split is source-complete, paints the same number of
words, and every resulting quote occurs exactly once in the full flattened A2AJ
document.

The fallback router uses categorical production-visible facts only: document
type, publisher host and static URL family, directive topology, source interval
topology, source completeness, opening/early/body source position, and
full-document occurrence classes for paint quotes and directive parts. The
position class captures the real opening-furniture risk without a citation,
seed, expected verdict, or live-page oracle.

The routed v24 target contains 612 Law Web rows and keeps 1,758 publisher rows:
25.8% Law Web and 74.2% original provider. It covers all 166 publisher
residuals that require fallback and makes 446 publisher-exact switchovers that
share those blind equivalence classes. Its SHA-256 is
`67589dbde983b05ad868280d66a7e3240037d6f1d577e04a55b96ed004745591`.

## Real Chrome proof

All newly required citation-only Law Web pages were fetched in headed
ChromeDriver sessions and cache-bound. The final Law Web gate used six
BelowNormal headed-Chrome workers over 24 isolated shards. It tested the actual
fragment URLs against complete cached pages, including duplicate text outside
each target. It completed in 136.8 seconds with zero worker restarts and proved
612/612 strict exact paints. The proof SHA-256 is
`b1f240673127feac8c5bd156dbef33b05932db9ea92ef206d94db29b599803d7`.

The final composite receipt binds every row to its exact target and cached page
bytes:

| result | rows |
|---|---:|
| strict exact | 2,369 |
| documented best-effort PDF limit | 1 |
| missing proof or cache identity | 0 |

`LEGISLATION-SK_SS_2015_c_I-9.11_sec4-3_hard-act-name` is the sole limit.
Its Law Web passage starts beyond the initial render, so the blind router keeps
the publisher PDF. Chrome paints all 16 substantive words there with no
omission, but the PDF viewer adds natural paint geometry.

The composite receipt is `results/final-composite-proof-v24.jsonl`, SHA-256
`2ee7bd7d33ecd287f3ae50e2143895a491fcf37c5c1167535d89456f52929207`.

## Harness hardening

Candidate generation now calls the production builder instead of duplicating
its planner. Fallback derivation refuses promotion unless every selected
runtime signature has an identical headed exact Law Web proof. Publisher proof
binding accepts only target-identical controlled reruns for explicit browser
errors or an isolated PDF check.

The headed cache path was repaired to match the shared Chrome lifecycle and
current PDF geometry fixture. Missing live sources no longer masquerade as
verifier outcomes. Authorization crawls use citation-only Law Web URLs with
`citation` and `doc_type`; no fragments are fetched during caching. Chrome
processes and temporary profiles are owned and closed per shard.

## Production integration

Production selects the legislation-only independent-block plan at the existing
legal-source boundary and applies the v26 no-oracle publisher-method and
fallback classifiers there. The classifier receipt reports 68 exact publisher
recoveries, 98 exact Law Web fallbacks, zero unproved selected rows, and
promotion-ready status. The focused backend
contract passes 36/36 tests; the full backend suite passes 678/678 executed tests.
