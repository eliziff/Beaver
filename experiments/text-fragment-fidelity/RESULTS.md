# Text-fragment fidelity results

Status: v23 is proved over the complete gettable corpus and promoted to
production. The running Beaver service was not stopped or restarted.

## Contract and corpus

The corpus contains 2,371 seeds over 1,217 complete flattened A2AJ documents.
`FCA_2026_FC_103_p20_short-exact` is excluded because its official publisher
URL was manually confirmed to be a genuine 404. The other 2,370 seeds are the
product corpus.

The builder and router receive only complete flattened A2AJ text, requested
quotes, citation/source metadata, and the publisher URL. Chrome results,
expected labels, live-page structure, and verifier verdicts are never inputs.
The planner may emit multiple nearby directives. It preserves every safely
paintable substantive word and omits only source furniture that cannot be
painted with certainty.

## No-oracle system

Publisher planning remains unchanged. Law Web planning enables a source-block
mode which preserves A2AJ punctuation spacing, treats newlines as possible HTML
block seams, and can emit multiple directives when one browser range cannot
safely cover all required words.

The blind router uses only normalized paint-quote occurrence counts in the full
A2AJ document, document type, publisher host, painted-word count, legal-reference
words already in the plan, source interval positions, and directive/interval
shape. It keeps the Saskatchewan target beyond Law Web's initial render on the
publisher PDF. It also keeps two short Northwest Territories opening ranges on
the publisher because Law Web inserts a live-only `Definitions` heading inside
their paint. No seed, citation, expected result, or verifier classification is
special-cased.

The routed v23 target contains 1,201 Law Web rows and keeps 1,169 publisher
rows. It retains all 171 recoverable publisher residuals and makes 1,030
publisher-exact switchovers. Its SHA-256 is
`9065fbbf25cfe5a6e9f39234080db3baf97e8bb7d6bcb577cbe27e43b4245ac0`.

## Real Chrome proof

The final Law Web gate used six BelowNormal headed-Chrome workers over 24
shards and cached rendered pages. It tested the actual fragment URLs against
full pages, including duplicate text outside each target. It completed in
155.7 seconds with zero worker restarts and proved 1,201/1,201 strict exact
paints. The proof SHA-256 is
`860992593bc6320c20a02d12bff56b41aa60153108c0121d3dbf9e85fe532da3`.

The final composite receipt binds every row to its exact cached page bytes and
combines the Law Web proof with the publisher proof:

| result | rows |
|---|---:|
| strict exact | 2,369 |
| documented best-effort PDF limit | 1 |
| missing proof or cache identity | 0 |

`LEGISLATION-SK_SS_2015_c_I-9.11_sec4-3_hard-act-name` is the sole limit. Its
Law Web passage starts beyond the approximately 200,000-character initial
render, so the blind router keeps the publisher PDF. Chrome paints all 16
substantive words there with no omission, but the PDF viewer adds natural paint
geometry. The composite receipt is
`results/final-composite-proof-v23.jsonl`, SHA-256
`d8dee3e05df353785390bee1540a14904c2423cca6305083af0645eb2b177a35`.

## Harness hardening

The authorization crawl fetched citation-only Law Web URLs: HTTPS
`/document` requests containing only `citation` and `doc_type`, never fragments.
All required pages are cached. The crawler now rejects page-level failures with
a nonzero exit, recognizes only actual short browser/error shells as error
pages, and accepts bounded lexical subsequences so a live heading inserted
inside a valid range cannot masquerade as an incomplete page. Missing-page
diagnostics are preserved under the ignored results directory.

## Production integration

Production now passes the block-mode flag through the legal-structure Node
adapter and applies the v23 no-oracle router at the existing legal-source link
boundary. Publisher-plan replay matches all 2,371 original rows with zero
mismatches; production router replay matches all 1,201 v23 routes with no
missing or extra labels. The focused backend contract passes 34/34 tests, the
Rust text-fragment contract passes 25/25 tests, source boundaries pass, the
warm Node adapter checks, and the backend TypeScript build passes.

The proved changes are committed directly in legal-structure and Beaver; the
temporary candidate patch bundle was removed after promotion.
