# Structural marks across the OCR stack

This experiment follows the structure gold's printed marks through extraction,
native OCR and the Rust structure engine. It measures potential training targets
in routing, detection/filtering, crop preparation, recognition, decoding and
structure inference. It changes no ordinary parser or OCR behavior.

The harness lives here. Real text, images, source identities, input hashes and
receipts live in ignored `benchmarks/local-data/ocr-structure-attribution/latest/`.
PDFs remain in the canonical OpenLegalData corpus. Repeated runs overwrite this
one output family; the report selects explicit jobs and bound receipts, never
artifacts by modification time.

## Run

The corpus analysis uses the existing saved gold observations. It does not open
PDFs, run OCR, build Rust or call a model:

```powershell
python experiments/ocr-structure-attribution/analyze.py corpus
```

This writes `corpus-report.json`, with input/script hashes, counts by mark kind
and label shape, affected lines and printed-to-extracted glyph confusions. The
2026-10-25 pass covered all 359 sources and 39,981 anchored marks in 0.37 seconds.
If the saved observations are absent, `analyze.py prepare` makes them from the
existing gold files, also without rendering PDFs or running OCR.

`prepare --out PATH` selects another output. It reads the gold store's current golds
(`experiments/legal_pdf_corpus/gold_store.py`; `OPENLEGAL_GOLD` names another copy), one
completed, hash-bound answer per source, train/development only (each source's partition). The census reads all completed golds. The native probe
selects six available OCR-mode documents of at most thirty pages, two pages each:
two sources with reference errors and one each for text, list, provision and quote
markers. Selection deliberately follows errors and retains intact marks on those
pages as controls; it is exploratory, not a population accuracy estimate.

The optional native experiment is a separate, expensive operation:

```powershell
python experiments/ocr-structure-attribution/run.py
```

It is not needed for corpus analysis. `run.py --model-pack PATH --runtime DLL`
selects explicit local weights/runtime.
The default is the native parser's current `runtime/indra`, Balanced on CPU, one
worker/thread. It waits for existing Cargo commands, builds one development
executable in the canonical incremental target with source paths remapped, and
records binary/source hashes. `--skip-build` reuses that executable. No bindings,
frontend, release artifacts, network downloads or model services are involved.
Only this executable's `hayro`, `vello_cpu` and `fearless_simd` dependencies use
optimized development profiles: samples of a slow scan found debug image
conversion and SIMD raster compositing taking minutes. The retained renderer
controls compare page pixel hashes and accepted/rejected OCR readings against
the ordinary development build.

To recalculate the analysis from retained native observations:

```powershell
python experiments/ocr-structure-attribution/analyze.py report
python -m unittest discover -s experiments/ocr-structure-attribution -p test_analyze.py -v
```

## Observations and interventions

- **Census:** each anchored marker/reference is compared with its original
  extraction using corrected scalar offsets. Added digits at span edges count.
  Spacing, changed values, missing text and changed delimiters/symbols are separate;
  replacements crossing a span boundary remain unresolved. Printed private-use
  bullets are normalized as in the owning scorer. Unanchored printed lines and
  unplaced markers are reported outside the anchored denominator.
- **Routing:** the actual current extraction identifies Indra lines and native
  lines carrying invisible embedded OCR. The manifest's `ocr` label alone never
  establishes the recognizer that produced a line. Line provenance can survive
  targeted number rereads; these route labels do not identify the recognizer
  responsible for each individual glyph.
- **Detection/filtering:** the feature-gated native probe observes decoded core
  boxes before uncovered-ink recovery, all prepared proposals and their readings,
  and the final acceptance decision. Original page renders and normalized input
  strips permit visual inspection. A gold line box cannot prove coverage of an
  individual reference glyph.
- **Crops/resolution:** rerun the native recognizer on the authoring line rectangle
  and a rectangle expanded by 35% of its height; rerun the complete native page
  detector/recognizer at 288 versus 144 dpi. These are measured sensitivities.
  Authoring rectangles inherit extraction mistakes and are not independently
  verified detection targets. Turned pages retain their rotation and omit these
  rectangle interventions when their coordinate frame is unavailable. Increasing
  dpi also reduces the relative effect of the detector's fixed pixel padding;
  this intervention does not isolate source resolution from crop preparation.
- **Decoding:** a bounded CTC prefix search uses eight prefixes and eight classes
  per step, retaining blank and repeated-label transitions. It aggregates paths
  and reports five alternatives. The report measures its first choice, not a
  gold-selected alternative. Single-line logits are checked against the ordinary
  batched greedy text; mismatches remain visible in the receipt.
- **Structure:** replay the actual extracted document through the owning Rust
  engine and existing gold scorer. Two text oracles correct mark edits alone or
  all transcription edits, restricted to unique exact original-line matches on
  the same page. They retain physical boxes/style evidence and remap word/span
  scalar offsets. Coverage is reported: unmatched and differently segmented lines
  receive no oracle correction. Inserted glyph geometry is unknown. Crop, beam
  and resolution arms currently measure transcription; their complete structural
  effects require a subsequent candidate integration.

`report.json` includes per-mark observations, overlapping sensitivity categories,
rescues and regressions on comparable marks, unobserved/unresolved counts,
oracle coverage and pooled structural expected/predicted/correct counts.
The page probes compare single-span marks on the selected pages; multi-span
marks remain in the census but are excluded from those interventions.
No single exclusive cause is inferred from an OCR/gold text difference.

The native hook is compiled only with `legal-pdf-ocr/attribution`; ordinary builds
retain no trace collection. Prefix-search repeated-character/path-aggregation
self-checks execute in the development probe. All new test text is independently
invented. Existing model-authored gold and this selected sample do not replace
independent journal pairing gold or family-separated final validation.

## Initial census (2026-10-25)

The completed local gold contains 359 unique train/development sources, 5,687
pages and 224,833 anchored lines. Of these, 146 sources have the authoring `ocr`
label. The following compares their original authoring extraction with the
corrected printed spans; it is not an accuracy measurement of current Indra.

| Printed span | Anchored marks | Intact | Different, including spacing | Unresolved |
| --- | ---: | ---: | ---: | ---: |
| Note reference | 335 | 214 | 117 | 4 |
| Note label | 332 | 266 | 65 | 1 |
| Text/paragraph marker | 983 | 867 | 116 | 0 |
| List marker | 919 | 787 | 132 | 0 |
| Provision marker | 4,575 | 4,037 | 533 | 5 |
| Quote marker | 452 | 327 | 125 | 0 |

Across both extraction modes, 1,377 printed lines have no source anchor and 72
markers have no placed span. Those are additional coverage work, outside this
table's denominators. The corpus index could not locate two otherwise eligible
probe PDFs. All available completed gold was counted; the native replay uses
the six deliberately selected sources described above.

## Findings

The saved gold supports different training priorities for different marks:

- **References:** 117 of 335 OCR-mode references differ, with another four
  unresolved. Small digits are often read as punctuation: printed `1` becomes
  an apostrophe 15 times and a quotation mark nine times; printed `3` becomes a
  quotation mark eight times. Eleven whole references disappear, and partial
  digit deletions occur too. This calls for superscript examples in their actual
  line context, including punctuation negatives, not just more ordinary numbers.
- **Lists:** 132 of 919 differ. Symbol-only marks account for 74 differences in
  224 examples, versus six in 233 alphabetic examples. Bullets become macrons,
  letters, asterisks or currency symbols; dashes and bullets also disappear.
  Explicit symbol coverage and degradation examples matter.
- **Paragraphs:** 116 of 983 differ, including three spacing differences. Of the
  remaining differences, 81 concern delimiters/symbols, 29 values and three
  missing marks. Brackets becoming vertical bars or braces dominate the glyph
  confusions. A digit-focused training set would miss most of this problem.
- **Provisions:** 533 of 4,575 differ, with five unresolved. Roman-like labels
  have 184 differences in 985 examples, compared with 155 in 2,012 numeric
  examples. Dropped `i`, closing parentheses and periods are common targets.

These are differences from the original authoring extraction, not measured
errors of the currently deployed Indra model. They identify training examples;
text alone cannot distinguish missed detection from clipped input or recognition.

The optional native replay was stopped after five completed sources and ten
selected pages. All data was retained; the sixth source is explicitly incomplete.
Its observations add narrower, exploratory evidence:

- At 288 versus 144 dpi, 20 marks were rescued and seven regressed among 90
  comparable marks. Authoring-box crops rescued 20 and regressed seven among
  80 comparable marks. These are different denominators, with unresolved cases
  excluded. Wider crops rescued none and regressed six among 56 comparable marks.
- Bounded beam decoding rescued no marks among 91 comparable observations.
  The 376 single-line/batched greedy comparisons all agreed.
- Visual inspection found neighbouring-line fragments in normalized inputs.
  Test crop boundaries and padding at fixed dpi before using these rectangles
  as training gold. Higher dpi also changes relative padding, so its effect is
  not evidence of resolution alone.
- Correcting mark text on uniquely matched lines raised pooled strict note-reference
  relation F1 from 0.443 to 0.639. Paragraph-marker F1 fell from 0.754 to 0.691 and
  list-marker F1 from 0.122 to 0.111. Improved transcription can expose false
  structure decisions; checkpoint selection must include downstream regressions.

The practical order is to review small-reference and symbol examples from the
existing gold, test crop preparation on retained imagery, then fine-tune the
recognizer on the resulting input distribution. Detector training needs reviewed
geometry for genuinely missed/clipped marks. Decoder and acceptance-filter
changes have no demonstrated rescue advantage in this selected probe. The
existing Rust structure layer still needs its own improvements and independent
pairing validation. No weights or ordinary runtime behavior changed here.

The `note_references` scorer requires the reference span **and the entire target
note extent** to match gold. It is an end-to-end relation metric, not isolated
pairing accuracy: a correct reference-to-note identity can fail when the note's
boundaries differ. The all-text substitution reached 0.696, with 852 of 933
eligible corrected lines matched across the five sources. Geometry and unmatched
lines remained unchanged. This is a partial counterfactual result, **not an OCR
ceiling**. No maximum below 1.0 has been established. Use the independent journal
pairing gold to assess pairing separately from these strict spans.

## Crop A/B (2026-10-25)

**Scoring correction:** the initial counts below used padded-box overlap, which
could select a neighbouring printed row. They are superseded by the glyph audit
described after the margin comparison. All original outputs and reports remain.

```powershell
python experiments/ocr-structure-attribution/crop_ab.py
python experiments/ocr-structure-attribution/crop_structure.py
python -m unittest discover -s experiments/ocr-structure-attribution -p 'test_*.py' -v
```

This reuses the ten retained 144-dpi page PNGs and detector traces. It neither
opens source PDFs nor reruns detection. The experiment-only native hook calls
the actual crop preparation and recognizer with the frozen model/runtime. All
404 baseline readings matched the retained readings, all page pixel hashes
matched, and all 193 available normalized-input hashes matched. The crop policy
also executes four independently invented boundary checks in the development
probe; seven Python tests passed. Ordinary OCR behavior remains unchanged.

The candidate retains each detector core and horizontal padding. It caps added
vertical padding at the midpoint of the gap to neighbouring cores with at least
half of both line widths overlapping. Short raised components and other columns
therefore do not impose a boundary. All 404 prepared lines matched cached cores;
164 crop rectangles changed, producing 162 different normalized inputs and 78
different readings. Recognition and analysis took 17.6 seconds, excluding build.

| Mark | Comparable observations | Baseline errors | Recovered | Newly broken |
| --- | ---: | ---: | ---: | ---: |
| Reference | 26 | 21 | 4 | 0 |
| Note label | 28 | 24 | 9 | 0 |
| Combined | 54 | 45 | 13 | 0 |

This is a 29% reduction of comparable footnote-related mark errors. Across all
119 annotated marks, intact readings rose from 22 to 36; one additional recovery
was previously unresolved and is excluded from the confirmed yield above. No
previously intact mark became wrong or unresolved. One previously alignable
incorrect reference became unresolved. All 15 list-marker observations remained
unaligned, so this does not establish list-marker safety. Eleven confirmed gains
came from one publication and two from another; this selected sample is not a
population estimate or held-out qualification.

Visual inspection of a recovered reference's normalized inputs confirmed that
the candidate removes following-line fragments and gives the intended line more
of the fixed 32-pixel height. Paired strips, input hashes, per-mark observations
and run identities live in ignored `latest/crop-ab/`. All previous data was retained.

The cached structure check patches only uniquely matching baseline text on the
same page, using the existing Rust edit/offset remapping and owning scorer. Only
five of the 78 changed readings matched, across three sources. The other readings
belong to different segmentation or retained embedded OCR, so they were left
untouched. This **partial candidate replay** changed strict note-reference
relation F1 from 0.443 to 0.434 (52 to 51 correct of 153 expected), and strict note
F1 from 0.579 to 0.563 (73 to 71 correct). It demonstrates no end-to-end gain and
must not be treated as the complete crop candidate's effect on production routing.
The isolated recognizer benefit and limited downstream regression are both retained.

Next input experiments should keep this crop policy fixed while separately
testing the normalizer's vertical white margin (20% versus 10% of ink height),
then the retained 288-dpi source pixels with physically identical crop geometry.
Task-focused recognizer fine-tuning follows on the resulting input distribution.
Reviewed small-glyph geometry is needed before attributing remaining exclusions
to detection or training a detector on them.

The next margin-only comparison runs with:

```powershell
python experiments/ocr-structure-attribution/crop_ab.py --margin
```

It freezes the completed crop candidate's rectangles and readings as the control,
then changes only the normalizer's vertical white margin from 20% to 10% of ink
height. The ordinary runtime default stays 20%. Both arms use the same retained
144-dpi pixels, model and decoder. All control inputs have frozen normalized-pixel
hashes. Outputs live separately in ignored `latest/margin-ab/`; previous evidence
is retained. This comparison evaluates glyphs, not linking: paired scorable spans
report character substitutions, deletions and insertions, with whitespace excluded,
alongside complete-mark recovery and newly broken or unresolved observations.

The completed margin test reproduced all 404 control pixel hashes and readings,
held all rectangles fixed, and took 18.2 seconds for recognition and analysis.
The corrected core-based association gives these complete-mark outcomes:

| Mark | 20% intact | 10% intact | Recovered | Newly wrong | Intact to unresolved |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reference (30) | 9 | 10 | 5 | 3 | 1 |
| Note label (30) | 15 | 15 | 2 | 2 | 0 |
| Paragraph marker (10) | 4 | 4 | 0 | 0 | 0 |
| Provision marker (28) | 4 | 6 | 2 | 0 | 0 |

The smaller white margin is not a clear glyph win. Keep 20% as the experimental
control. This is a selected sample, not a qualification of either margin.

`python experiments/ocr-structure-attribution/glyph_audit.py` re-evaluates both
saved experiments without inference. It chooses the frozen core with maximum
vertical overlap; equal matches on different rows remain unscored. A focused
test proves that padded neighbouring rows cannot contaminate the intended row;
nine Python tests passed. The corrected crop comparison recovers 15 marks and
breaks one among 90 comparable marks; the margin comparison recovers nine and
breaks five among 91, with one additional intact reference becoming unresolved.
All 15 list observations remain unaligned. These replace the earlier recovery
counts, including the earlier claim of zero crop regressions.

Three reference projections still contain prose because inherited authoring
line geometry/fragment alignment is imperfect. Their reviewed exclusions are
retained in private `latest/glyph-projection-review.json`; character summaries
exclude those same targets from both arms and both experiments. Raw projections
and original totals are retained. The remaining glyph totals are scoped to
paired scorable annotated marks, not whole-body transcription.

The audited character counts favour keeping the larger margin: 20% produced
63 errors on 234 scorable marker characters; 10% produced 67. Character deletions
rose from 26 to 29. Separately, the neighbour-aware crop comparison reduced
errors from 85 to 62 on its paired set of 232 scorable marker characters. The
sets differ because alignment coverage differs. `glyph_audit.py` regenerates
these summaries using the retained review exclusions, without inference.

## Training design

Train against the stage that has evidence of losing the mark. Recognition
targets are corrected text; detector targets require visually corrected geometry.
The existing gold supplies the former, while its inherited rectangles are only
proposals for the latter. The existing
[detector annotation guidance](../ocr-candidate-screen/README.md) applies: tight
ink boxes must include punctuation, superscripts and diacritics, with recognition
padding added separately. Missing lines and false proposals need review too.
[CRAFT](https://arxiv.org/abs/1904.01941) demonstrates character-region and affinity
supervision; it supports investigating explicit small-character targets if our
coverage audit calls for them, rather than treating inherited line boxes as
verified glyph labels. This is a training direction, not evidence for replacing
the current detector.

For recognition, continue from the deployed student with gold CTC targets on
the actual deployed crop preparation. Oversample lines containing references and
enumerators, retain ordinary prose as replay, and include ordinary digits and
punctuation as negative examples for mark-specific selection. Render synthetic
superscripts within complete lines, varying baseline, font, size, brackets and
scan degradation. The target remains ordinary transcript characters; superscript
position is image evidence. [SynthTIGER](https://arxiv.org/abs/2107.09313) supports
controlling synthetic length/character distributions;
[STRAug](https://arxiv.org/abs/2108.06949) supports testing text-specific noise,
artifact and geometry augmentation. Their scene-text results motivate these
experiments; they do not establish improvements on this legal corpus. Inspect
augmented examples so labels do not demand recovery of erased glyphs.

Select checkpoints using exact reference/label/enumerator accuracy and deletions,
then require improvement in the owning structure scorer and independent note
pairing gold. Keep body transcription and false marks as regression measures.
Whole-line CER alone can improve while the tiny marks stay wrong. Preserve
document-family partitions across real and synthetic data; the current selected
train/development probe is for diagnosis, not final checkpoint qualification.
