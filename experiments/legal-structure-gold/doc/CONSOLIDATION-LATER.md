# Improvements found during the consolidation, held for later

The consolidation keeps the parse output byte-identical (DOC off and on, every split, against the baseline dumps in
`F:\fable-doc\base`). Anything found along the way that would change a byte is written here instead of being done, with
where it is, what it would change, and how it was found. Each is its own piece of work, measured when taken up.

| # | Where | What it would change | Found |
|---|-------|----------------------|-------|
| 1 | `machine/lines.rs` `unmarked_notes` | The mark recovery for a note label with no body mark lives in the line table DOC reads, not in the one note pairer (`note_pairing::pair_notes`); moving it there would give t0's output the recovered marks too. | 2026-11-07, footnote-links work |
| 5 | `transition/doc.rs` (DOC with `export9`) | DOC's output differs between two runs of one binary on the same documents: 12 of 1,124 test parses (30 of 9,950 development) came out otherwise on a second run of the baseline grader (nodes' extents, roles, continuations). Byte identity with DOC on is therefore checked against a second baseline run. Making DOC's reading the same every run (its ONNX sessions' threads, or an order read off a hash map) would fix those parses' output to one of their readings. | 2026-11-07, consolidation units 1-2 check |
| 7 | `evidence/mod.rs` `opening_marker`, `machine/lines.rs` `line_readings` | Two readings of a line's opening marker by the numbering grammar: evidence's reads the first token against the families the lines before it opened (`&mut families`, state carried line to line) into one `Marker`; the machine's reads every reading of the line, its variants and its text before the repair, with no such context. One list read once with `opening_marker` its first (plan unit 8) would change a line's marker wherever the families' context picks another reading than the first. | 2026-11-07, plan unit 8 |
| 2 | `legal-citations` `reference_names::reference_name_ends` | It runs a full citation `extract` over a whole source decision (all jurisdictions) to collect statute titles; a Canadian-only pass is 2.3x faster on 40 decisions but finds one more statute on one of them ("Employment Insurance Act (Can.), ss. 22 and 23"), so links could change. | 2026-11-07, quote-check profile |
