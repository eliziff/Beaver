# Installed-provider structure parity freeze

## Full baseline

The installed-provider freeze ran exactly once over the complete locally
registered production denominator. It records length-prefixed SHA-256 source
digests and exact UTF-8 `JSON.stringify(SourceDoc)` byte lengths/digests without
persisting source text or private paths. The ignored, content-addressed receipt
is `results/installed-provider-freeze-full/`.

- Baseline production commit: `e4c8aa35a9bf0714848cb228ef33c7f591d34ae1`
- Serializer contract: `95cffe3b9db96a4accae2d817ec27de8fc5c85139d08416652b70cfe23c8c453`
- Manifest root: `4ac13b37c59f3a1e235c6e0434bcdc2ecffe100c43ce43acf922bc92a0cef5f8`
- Attempts: 323,374 = 322,738 pass + 636 failure; no skips
- Source bytes hashed: 30,368,316,430
- Public `SourceDoc` bytes hashed: 10,338,239,008
- Receipt: 337 gzip parts, 29,496,144 bytes; phase summary 5,139 bytes
- Wall time: 721.677 seconds; warmed processing wall 686.580 seconds

| Provider | Attempted | Pass | Failure | Native | Hybrid | Flat | Source bytes | Warm MiB/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A2AJ primary | 248,685 | 248,640 | 45 | 0 | 0 | 248,640 | 10,892,507,375 | 26.210 |
| CourtListener opinions | 55,504 | 55,503 | 1 | 38,652 | 3,260 | 13,591 | 3,067,149,043 | 19.980 |
| Journal truth + unreachable registrations | 19,185 | 18,595 | 590 | 10,162 | 8,433 | 0 | 16,408,660,012 | 106.558 |

A2AJ's primary denominator is separately closed as 225,162 cases
(225,117 pass + 45 provider-unavailable) and 23,523 laws (all pass). The
225,017-row cases-search database is recorded as a derivative store and is not
double-counted as provider truth.

CourtListener has one provider-unavailable opinion. Its successful corpus modes
sum exactly to its pass count.

The journal denominator consumes all 18,958 source articles and all 404,506
attached page rows (zero orphan page rows). Article output has 18,595 pass and
363 provider-unavailable failures. The additional 227 final-contract
registrations whose source article is absent remain explicit
`not_applicable_missing_source_row` failures, not skips.

All 6,937 registered final-contract packages received a separate bounded-root
standalone proof: 6,937 hashes, 6,937 applicable payloads, and 179,722 package
pages. The 6,710 matched registrations are aliases of journal truth; the 227
unmatched packages are standalone evidence, not duplicate truth. Production's
safe relative-path resolver can use 6,828 registrations and reports 109 as
unresolved because their database registrations are absolute paths. The
standalone proof does not alter or displace that production behavior.

## Gates

The baseline is complete but is not acceptance-green. The warmed 50 MiB/s
per-provider gate fails honestly for A2AJ (26.210) and CourtListener (19.980),
and the overall staged rate is 41.822 MiB/s. Journal passes at 106.558 MiB/s.
The full run also exposed equal-row shard byte skew: A2AJ took 411.026 seconds
cold wall despite faster bounded samples. Future engine work must improve these
red gates; it must not redefine the denominator or exclude slow rows.

The preserved 2,000-row/provider candidate preflight is also red. Its three
persistent BELOW_NORMAL sidecars processed 6,000 provider rows (5,984 engine
documents) in 96.851 seconds, using 240 batches and a conservative 1.103 GB
combined peak-RSS upper bound. Aggregate measured throughput was 41.478 MiB/s;
the whole-corpus projection was 1,543.981 seconds at 18.758 MiB/s, failing both
the 600-second and 50-MiB/s gates.

| Provider | Measured MiB/s | Dominant measured work |
| --- | ---: | --- |
| A2AJ | 6.728 | derive 5.729 s of 7.738 s processing |
| CourtListener | 4.107 | derive 13.615 s of 15.070 s processing |
| Journal | 40.145 | final-contract preparation 71.647 s, then derive 17.488 s |

A later current-source preflight, pinned to engine SHA-256 `8dac4bab...cb562`,
remained red: 6,000 rows and the same 5,984 engine documents took 103.622
seconds, measured 35.829 MiB/s, and projected the full corpus at 1,672.770
seconds and 17.313 MiB/s. Its provider rates were 6.210 MiB/s A2AJ, 6.511
MiB/s CourtListener and 34.677 MiB/s journal. This disproved the hypothesis
that the shared line index and page-marker scan alone could clear the corpus
performance gate.

No current candidate full run has been launched. Raw receipts remain ignored
and compact.

## Bounded parity fixes

| Boundary | Durable result |
| --- | --- |
| A2AJ identity | Provider compilation now separates the structure document ID from the public citation ID. The first 100 installed rows are exact against the authoritative full baseline. |
| CourtListener native ranges | Deterministic leading/trailing trim overhang retains the historical public block range while evidence receives a separate valid clamped range; all other invalid ranges still fail closed. The first 100 installed rows are exact. |
| Journal tied blocks | Journal projection now stable-sorts equal start/end blocks in provider order; CourtListener keeps its existing label tie-break. The pure projection control is 2/2. Against a receipted current-source debug sidecar, the first 100 installed rows contain 99 exact outputs and one exact receipt-bound quality delta (article 1: provider-unavailable to native); there is no structure-input drift. |
| Shared text index | Recovery now constructs scalar, UTF-16 and line offsets in one pass and reuses the line index across detector lanes. Current-source semantic gates are Rust 10/10, instrument skeleton 44/44 and frozen provider vectors 24/24. Empty-target release builds still exceed the hard 15-second ceiling; a later dependency-cached current-source link is recorded separately and does not relabel that cold gate. |
| CourtListener dotted newline | Exact baseline reproduction for opinion 2075946 isolated one tuple delta: `par9` ended at scalar 10,580 before the next line-only `1.`, but Rust ended it at 15,221. The copied TypeScript regex treats the newline after `1.` as whitespace; the line-local Rust scanner had discarded it. A semantic-only warm debug sidecar now reproduces all 26,729 baseline bytes exactly (SHA-256 `b7df3f46...ab80`), and the 24-vector/44-skeleton gates remain green. The earlier current-source test/link exceeded 15 seconds, so this semantic proof does not qualify the build gate. |
| Journal ECMAScript whitespace | Artifact classification of the 2,000-row preflight found 1,967 exact rows, 31 identical-input `provider_unavailable`→output quality candidates, and two same-status output deltas (articles 7419 and 7420; class digest `e9a21ca9...e21b`). Historical reproduction reduced both deltas to heuristic paragraph starts one scalar late: Rust treated U+0085 as whitespace although JavaScript `\S` does not. The shared predicate now preserves U+0085 and still skips U+FEFF. Current release SHA-256 `d6954081...7c0d` rebuilt in 12.64 seconds, reproduces both historical SourceDocs byte-for-byte (`23526fff...684c`, `57f0c4c8...db7b`), and passes the frozen 24-vector gate. The build is under the hard 15-second ceiling but still misses the preferred five-second target. The 31 quality candidates remain fail-closed pending a current-source bounded receipt; they are not silently waived. |
| Journal final-contract authority | `pages.jsonl` is consumed once by the pure journal adapter: ordered exported regions become geometry-informed paragraph slices, while exported pages, title regions and paired footnote facts project directly to native claims. A registered final contract marks every structure family complete, including an absent family, so Rust validates/composes it but never rediscovers missing headings, sections or notes. Production and the freeze harness share this projector. The real-vector gate is 23 historical outputs exact plus one explicit quality delta: sparse export 9284 now contains only its native page and drops the old invented whole-document paragraph (`cc51a668...3a02` public, `9dbf5cfc...8daa` canonical). Focused present/absent final-contract tests are green. The registry's 6,937 `payload_json` values were inspected read-only and contain package metadata only, so `pages.jsonl` remains the necessary authority. |
| A2AJ detector floor | A bounded first-2,000 control sent the same 57,558,569-byte evidence stream through release `d6954081...7c0d` with all seven kinds certified complete. Materialization plus transport/validation took 0.860 seconds (0.775 seconds in the client derive window), versus 5.729 seconds for real recovery in the comparable preflight. The raw detector, not JSON IPC or batching, is therefore the remaining A2AJ target. |
| Harness digest allocation | The length-framed source digest now reuses one eight-byte prefix buffer instead of allocating one per field. A current 2,000-row A2AJ run reproduced all three compressed-part hashes and manifest root `096684d6...4246` exactly. Its wall time varied upward, so this is accepted only as an allocation cleanup, not a throughput improvement. |
| Provider-subset inventory | Bounded coordinator runs compare only the selected provider's frozen inventory and required companion signature. A one-row A2AJ-only coordinator run completed with exact row root `979fe774...6a36`, parent root `96790bbc...1263`, and BELOW_NORMAL orchestrator/sidecar receipts without requiring unrelated journal inputs. Full mode still requires all providers and all journal contract evidence. |
| Full A2AJ census | The first complete candidate covered all 248,685 installed rows (248,640 passes and the same 45 failures): 225,162 cases and 23,523 laws. Exact inputs produced 21,821 public-output deltas. Replaying the untouched TypeScript compiler with the real provider section map made 6,899 of those byte-exact, proving that class is a correction to the frozen baseline's omitted native facts. The remaining 14,922 rows are retained for tuple-level classification; they are not waived as parity. |
| One enumerator | The Rust port no longer has separate flat and instrument child ladders. Legislation, provider-bounded sections and general instruments use one marker grammar, reading selector, hierarchy stack and equal-or-shallower span closer. A single census over all 11 frozen A2AJ fixtures found eight byte-identical outputs and three law-only quality deltas. The three share the same explained change: dotted nodes such as `(6.01)`, `(6.1)`, `(1.1)` and `(4.1)` are retained; restarted definition lists receive occurrence labels instead of disappearing; parents are immediate; parent spans cover descendants; inline child ranges begin at the marker. The old TypeScript tuples were captured once before patching, so no fixture was diagnosed by whack-a-mole. The post-change rebinding test was killed at the 15-second build ceiling and is therefore not claimed green. |

Executed harness source hashes used for the one full freeze:

- `canonical.ts`: `8f4b75f86ecf70f456af01b1b1e679fa0e58c85155701ac11f9bfbdbf5f0c3c4`
- `freezeInstalledProviders.ts`: `7ba9e40748f81cf9c6208416a6ef96d2ba49d5878c99c1b5500abdf55dd9c1bd`
- `freezeInstalledProvidersParallel.ts`: `bf7f8efbd9c0d2fcd9bf75fdf9fe222efe30e9ac227064f7d01f36d4245b4b68`

After the freeze, three TypeScript non-null assertions (erased at runtime) were
added to make the isolated strict check pass. The tracked
`installed-provider-baseline.json` preserves both the executed hashes above and
the current reproduction/verifier hashes, so this distinction is not hidden.

## Reproduction and candidate verification

The baseline above is immutable historical evidence. The cutover runner writes
to a separate candidate directory, uses exactly one persistent sidecar per
provider, and runs the three providers concurrently. It resumes only when the
engine binary, adapter and harness source, corpus signatures, serializer,
bounds, and configuration match. A full journal run fails closed unless the
6,937-registration database and bounded package root are supplied explicitly;
the 227 orphan registrations remain in the denominator.

The coordinator records exact sidecar batch/document/request-byte totals,
startup separately, a conservative summed peak RSS, every compressed-part
hash, denominator and journal-proof equations, and the artifact caps. Journal
outer batches stay at 25 to bound memory; A2AJ and CourtListener use 1,000-row
outer batches while the wire still enforces 25 documents/128 MiB. A full
candidate remains prohibited while the bounded projection exceeds 600 seconds
or aggregate throughput is below 50 MiB/s.

The independent verifier accepts only `installed-provider-freeze-full` as its
baseline, streams old and candidate receipts in provider/ID order, and compares
public `SourceDoc` byte hashes for each identical-input row. A2AJ and
CourtListener inventory identity is authoritative; raw proof-framing changes
are reported separately. Journal rows additionally bind the exact registered
final-contract validation, bytes, hash, page count and alias. Only a changed or
missing contract identity is classified as `structure_input_drift`; it is never
silently skipped. The verifier neither invokes providers nor retains the corpus
in memory. Its self-check covered all 323,374 frozen rows in 2.9 seconds; the
authoritative-full comparisons for the fixed A2AJ and CourtListener 100-row
receipts were each 100/100 exact.

New receipts also carry `structure_input_sha256` under contract
`b42dfab0a40faa12ff06f4bbad5fc857b8470f636b86fd31777d3f3291ae1481`.
It length-frames the actual provider-neutral evidence: text, ordered native
claims and exclusions, profile/options/scope and representation identity. This
proof does not replace or weaken the separate raw-source hash or the journal
contract/page facts in each receipt. The historical full baseline predates the
field, so its installed inventory signatures and journal contract facts remain
the fail-closed comparison authority.

```powershell
$journalDb = 'C:\Users\elias\Desktop\Open Access Journals Database\oajd\journals.db'
$contractRoot = 'C:\Users\elias\Desktop\Open Access Journals Database\data\final_contracts'
$env:LEGAL_STRUCTURE_BINARY = (Resolve-Path '..\legal-pdf-parser\target\release\legal-structure.exe').Path

node --import tsx experiments/source-structure-parity/freezeInstalledProvidersParallel.ts `
  --limit 2000 --journal-final-db $journalDb --journal-contract-root $contractRoot `
  --output ..\.tmp\source-structure-preflight

$env:STRUCTURE_SIDECAR_CONTRACT='1'
npx vitest run --config experiments/vitest.config.mts `
  source-structure-port-oracle/candidateParity.test.ts --reporter=dot

node --import tsx experiments/source-structure-parity/verifyInstalledFreeze.ts `
  --candidate ..\.tmp\source-structure-preflight

# Only after the preflight gates are green, omit --limit and use a new output.
```
