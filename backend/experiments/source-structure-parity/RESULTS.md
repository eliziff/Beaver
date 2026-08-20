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

The frozen fixture suite remains below one second: smoke was 609 ms and the
final opt-in real-capture acceptance suite was 922 ms. Both passed. The four
executable experiment files total 1,105 physical lines, while factoring 70 net
lines out of the fixture test (net +1,035 executable lines in this experiment
lane). Raw receipts remain ignored and compact.

Executed harness source hashes used for the one full freeze:

- `canonical.ts`: `8f4b75f86ecf70f456af01b1b1e679fa0e58c85155701ac11f9bfbdbf5f0c3c4`
- `freezeInstalledProviders.ts`: `7ba9e40748f81cf9c6208416a6ef96d2ba49d5878c99c1b5500abdf55dd9c1bd`
- `freezeInstalledProvidersParallel.ts`: `bf7f8efbd9c0d2fcd9bf75fdf9fe222efe30e9ac227064f7d01f36d4245b4b68`

After the freeze, three TypeScript non-null assertions (erased at runtime) were
added to make the isolated strict check pass. The tracked
`installed-provider-baseline.json` preserves both the executed hashes above and
the current reproduction/verifier hashes, so this distinction is not hidden.

## Reproduction and verification

The runner is atomic and resumes only when the baseline, corpus signatures,
serializer, bounds, and configuration match. The parallel coordinator verifies
every compressed part hash, exact denominator equations, mode sums, contract
proof sums, the 40 MiB manifest cap, and the 64 KiB phase-summary cap. A full
run intentionally exits nonzero after writing the complete receipt while a
provider is below the throughput gate.

The independent verifier does not invoke provider production or reconstruct
outputs. It checks the tracked expected root and current harness hashes, every
part/shard/root digest, the manifest field allowlist, absence of raw/path fields,
all count/byte/mode equations, the journal proof, and both artifact caps. It
verified all 323,374 records in under three seconds.

```powershell
node --import tsx experiments/source-structure-parity/freezeInstalledProvidersParallel.ts `
  --workers 8 --batch 1000 --warmup-rows 25 --require-mib-s 50

$env:SOURCE_STRUCTURE_ACCEPTANCE='1'
npx vitest run --config experiments/vitest.config.mts `
  experiments/source-structure-parity/sourceStructureParity.test.ts --reporter=dot

node --import tsx experiments/source-structure-parity/verifyInstalledFreeze.ts
```
