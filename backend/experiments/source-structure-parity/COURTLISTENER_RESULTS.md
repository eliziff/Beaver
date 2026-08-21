# CourtListener full-corpus Rust parity audit

## Census and proof

- Corpus: all **55,504** installed CourtListener opinions: **55,503** outputs and the
  same one provider-unavailable row as the frozen TypeScript run.
- Rust artifact: SHA-256
  `c16ebc6740fa6e59088af715176f35eb4cca19499b4b81cdf4aad74d0050f71a`.
- Exact public `SourceDoc` bytes: **55,406/55,504**. The remaining **98** were
  replayed through the untouched TypeScript compiler; every replayed old public
  hash matched the frozen receipt before its tuples were admitted as an oracle.
- The eight BELOW_NORMAL Rust shards finished the complete denominator without a
  restart. The longest shard processing wall was **234.578 s**. The shared subset
  coordinator then failed while aggregating absent providers, after all eight
  receipts were complete; the diagnostic reader consumed those complete receipts
  directly. Exact TypeScript replay and classification of the 98 rows took
  **11.605 s**.
- Compact exact-tuple diagnostic artifact: 174,849 gzip bytes, SHA-256
  `b82baa45d672bc6c86f43b93ec342932691ea2cee87c1d8222f4f5ce8783527d`.
  It contains ordered old/current tuples and up to twelve source excerpts per row.
  Its candidate receipt root is
  `f5e2c6927a7d405184500d80f63dbae39be656580f3f3eaea1fd8cb6c5ea24ac`.

The full ordered tuple census is:

| Kind | TypeScript | Rust | Tuple result |
| --- | ---: | ---: | --- |
| page | 776,327 | 776,327 | exact |
| footnote | 137,175 | 137,175 | exact |
| section | 0 | 0 | exact |
| paragraph | 25,946 | 24,952 | 98 documents differ |

No mismatch changes a native tuple, hierarchy, anchor, alias, page, section, or
footnote. There are **96 candidate-selection** rows and **4 range** rows (two rows
have both); therefore the remaining work is entirely in heuristic paragraph
selection/range closure, not provider-native projection.

## Source and code inspection

The first classification was too broad. It is retracted: no lexical filters for
years, headers, or local lists should be added from this C16 result.

The TypeScript and Rust CourtListener implementations already have the same
contiguous-scope selector, early-opening preference, length/style/opening-number
ranking, and substance gates. CourtListener does not use the rooted A2AJ selector.
The C16 divergence occurs earlier: TypeScript's `(?=\s)` marker expression sees a
numeric-only line because its newline is whitespace, while Rust splits the text
into newline-free lines and C16 rejected an empty suffix. That one missing marker
class changes candidate partitioning and final range closure.

Six rows show the defect directly:

- **4593113** (HTML, dotted markers): C16 selects a local Transaction-B 1-9
  sequence starting `1. On February 26, 1954...`; exact TypeScript selects a later
  competing 1-9 sequence after numeric-only table rows partition the candidates.
- **4597188** (HTML, dotted year markers): C16 selects 1951-1959; exact TypeScript
  selects 1953-1959. Neither change is an accepted paragraph-quality correction.
- **4651409** (plain text): the old generic path selected form-feed page headers
  `2 ... In re Recall Charges...` through 46; C16 instead selects petition charges
  1-8. The exact TypeScript contiguous profile, including numeric-only lines,
  returns no paragraph blocks on the normalized source.
- **9897939** (plain text): C16 selects a footnote/page run beginning
  `1 The father is not a party...`, `2 ... No. 84266-8-I/3`; the exact TypeScript
  contiguous profile returns no paragraph blocks.
- **4605872** (HTML, dotted stipulated facts): C16 selects 1-5 because it misses
  the numeric-only table total `250` between 4 and 5; TypeScript sees that marker
  and selects 7-12. The source does not prove C16's competing run better.
- **4622126** (HTML, dotted stipulated facts): C16 extends paragraph 11 from 7,446
  to 20,326, through the opinion, decision, dissent, and footnotes. TypeScript sees
  the numeric-only `1924` table row at 8,627 and closes the range there.

Only opinion **4108741** is a durable positive result from this focused set: the
explicit pilcrow sequence `¶2`-`¶12` is stronger than the unrelated generic run
beginning `1 ¶16...`, and numeric-only-line handling does not affect it.

Three other apparent improvements are unaccepted because they are accidental
products of the same scanner defect: 4589742 joins Findings 1-13 across a
numeric-only `1925` table row; 4618185 extends paragraph 9 across `1939`; and
4627726 joins Findings 2-19 across `1952`. Their source text may justify a later
table-aware improvement, but a broken line-boundary marker contract cannot be its
implementation or proof.

## One decisive production pass

Make only the exact numeric-only-newline correction already present in the dirty
Rust worktree: after stripping a line's newline, accept an empty numeric suffix
when the line ended before the document ended. Do not add lexical exclusions and
do not change the contiguous selector. Then rebuild once and rerun this complete
55,504-row census. Any surviving provider-profile quality deltas require a fresh
source-backed classification; the three accidental range deltas above are not
pre-authorized.
