# Potential pull requests to upstream mike

Defects found while building the pin-faithful benchmark arm (`2266446b`,
evidence in `upstream-native-arm-audit-2026-08-05.md` and
`harvey-lab-run-mining-signals-2026-08-05.md`).

## 1. DOCX extractor numerically coerces text runs

`extractDocxBodyText` builds its XML parser without `parseTagValue: false`,
so numeric-looking `w:t` runs round-trip through numbers: `"12.10"` → `12.1`,
`"1.0"` → `1`. Section numbers, amounts, and version strings are silently
altered in the text served to the model by `read_document` /
`find_in_document` (and quoted back to users). Affects ~17.5% of our corpus
DOCX files. Fix: pass `parseTagValue: false` (the option the shared edit
parser at `docx/core.ts` already uses).

## 2. `find_in_document` misses quoted defined terms

Contracts define terms as `"Term" means …`; models query `Term means` without
quotes, and the literal substring search returns zero hits — 7/7 such probes
failed in mined runs, and the model then proceeds as if the definition does
not exist. Fix: on zero hits, retry with quote-wrapped and `shall mean`
variants of the query (small deterministic normalization, no ranking change).
