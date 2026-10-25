# Markers and footnote glyphs: plan (2026-10-22)

Experiment only. Nothing here changes a release package or `legal-browser-ocr`.

## What the parser consumes

- Native OCR lines carry plain recognized text and word boxes. `make_ocr_line` sets no spans,
  so an OCR line has no superscript flag. Note calls reach the structure layer as ordinary
  characters ("2021:1"). `reread.rs` repairs only a kept text layer's lost raised numbers
  (its `LOST` set: quotes, primes, degree, asterisk, `I l t s`), and `note_regions.rs` folds
  Unicode superscript digits to plain digits. `ocr_markers.rs` rejoins a marker the detector
  read as its own line with its body line.
- Structure gold v4 encodes a note call as plain characters in the corrected line plus a
  `typed[].references[].spans` range (shown as `[^n]` in typed text); list markers are
  `typed[].markers` ranges. The corrected line is `lines[].text` with `text_edits` applied;
  span offsets index into that corrected text (checked: all 350 reference labels match).
  No gold text uses Unicode superscript digits.
- Training target: the corrected line text with superscripts as plain characters. The harness's
  NFKC normalization already maps any `¹` to `1`, so the Arrow corpus and gold crops share one
  encoding. A raised flag would need parser work that nothing consumes today; out of scope.

## Current recognizer

Quality and Balanced share the `standard` recognizer (the 8-block student, epoch 19; Arrow
dev 1.402% / test 0.883% CER). They differ only in detector side (1024 vs 896). The gold's
authoring extraction (`inputs/<sha>.json.gz`) is not our recognizer's output on most OCR
pages: only 1,843 of 5,504 development lines equal what native `legalocr` reads today; the
rest come from scans' own text layers (ABBYY-style `¬` hyphens) kept by the parser. So the
baseline was measured by running the shipped native `legalocr.exe` (runtime v0.2.0 pack in
the desktop `lsg-v4` dist, Hayro render at 144 dpi, DirectML) on PDFs holding only each gold
document's OCR pages (pages copied, not re-rendered).

## Baseline (measured)

Development split, 60 documents / 5,504 gold OCR lines; 5,189 have at least one recognized
line inside their box (all recognized lines inside a gold box are joined left to right, since
the detector often reads a tab-separated marker as its own line). Lines are usable when the
gold is non-empty, has no U+FFFD and is within 0.5 CER of the authoring text (box/text sanity).
Marker = gold list-marker span at line start; reference = gold note-call span. A span is an
error unless every gold character in it aligns as equal (Levenshtein opcodes).

| Stock tier | Lines | CER | Marker errors | Reference errors |
| --- | ---: | ---: | ---: | ---: |
| Quality, 300-line sample (all 54 reference lines + 246 marker lines) | 300 | 4.52% | 97/254 (38.2%) | 22/54 (40.7%) |
| Quality, all usable marker/reference lines | 575 | 5.46% | 203/529 (38.4%) | 22/54 (40.7%) |
| Quality, all other usable lines | 4,586 | 13.01% | n/a | n/a |
| Balanced, 300-line sample | 300 | 5.14% | 107/254 (42.1%) | 24/54 (44.4%) |

Quality marker errors by kind (sample): numeric 63/166, letter 11/47, symbol 7/13, roman 2/5,
other (`Panel:`, `C7`, `✓ E6`) 14/23. Of the 97 marker errors 78 are misreads, 19 dropped
(no glyph read inside the box). Of 22 reference errors 15 are misreads, 7 dropped.

Ten examples (gold span → native Quality reading):

1. `[9] On 27 January…` → `19) On 27 January…` (bracket read as 1, closing as `)`)
2. `[5] The Judicial…` → `5] The Judicial…` (opening bracket lost)
3. `(b) of which at least…` → `(6) of which…` (letter in parentheses read as digit)
4. `(d) to cause surveys…` → `(4) to cause surveys…`
5. `1 Marsich v R [2012]…` → `4Marsich v R…` (leading note number misread)
6. `3 For example…` → `8 For example…`
7. `…acquire a cheque1. If…` → `…acquire a cheque’. If…` (superscript call read as apostrophe)
8. `…in this case”7. They…` → `…in this case””. They…`
9. `…echelons of responsibility.1` → `…responsibility.` (superscript call dropped)
10. `✓ S3 During operation…` → `S3 During operation…` (check-mark marker dropped)

The 30%-vertical-padding probe on crops is not informative (it pulls in neighbouring lines on
dense pages: CER 25%), so detector clipping is assessed instead from the dropped counts: 19/97
marker and 7/22 reference errors have nothing read in the box. The recognizer is the larger
lever; detector work is not indicated by this evidence alone.

Note: reference lines are rare in the OCR gold (344 lines in all splits, 54 in development),
so superscript results will carry wide uncertainty.

## Training data

- Boxes from our own detector: native `legalocr` Quality on the train-split documents' OCR
  pages (238 documents, 931 pages), matched to gold lines on the same page. A recognized line
  is a training example when it is the only line inside a usable gold box and covers it
  (IoU >= 0.7), with the corrected gold line as target; when the detector splits a line into
  a narrow marker and a body, the marker crop gets the gold marker text and the body the rest.
- Pixels: pypdfium2 at 144 dpi (Hayro is not available to Python), cropped exactly like
  `prepare_crop` (ink box, 0.3h/0.2h margins, height 32). Render parity is checked first by
  running `legalocr` on the pdfium page images and comparing with its PDF run.
- Mix: the full Arrow train split (26,981) plus all gold-train marker/reference lines, plus an
  equal number of other gold-train lines so the model does not learn to emit digits
  everywhere. No synthetic rendering.

As run, a second arm (B) added all usable gold-train lines instead of an equal sample; both
arms repeat note-call lines four times. Results: RESULTS.md, "Markers and footnote glyphs".

## Models and selection

Fine-tune the shipped student8 weights (same graph and codec rows; new characters appended),
AdamW 5e-5 halving on plateau, frozen batch-norm statistics, batch 16, seed 714, at most 12
epochs (~90 GPU minutes cap). Checkpoint selection (fixed before training): lowest mean of
Arrow-dev CER and gold-dev marker/reference-line crop CER. Test (Arrow test, gold test split)
is scored once, after selection. Detector fine-tuning only if the recognizer results leave
dropped glyphs as the dominant error.

## Reporting

Before/after: Arrow dev/test CER (must not regress materially); gold crop CER and marker /
reference error rates on development and test; then the end-to-end native A/B: the selected
model exported to ONNX in the shipped compact-ID form, placed in a copied model pack, run with
`legalocr --model-pack` on the development and test documents against the stock pack (same
detector, so the same boxes). A parser-level structure A/B would use `extract.mjs` with a
`model_pack` setting; that changes the request hash, so it fills a separate cache entry and
needs no source change to the recognition cache key.
