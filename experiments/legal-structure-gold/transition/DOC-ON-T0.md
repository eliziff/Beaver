# DOC on t0

The ruling (2026-11-04): "The DOC stage was supposed to be the model working from what t0 output; the DOC is actually
working quite well in general so I don't want to upset that too much but it certainly should not be a duplicate stack
entirely."

Everything here is proved from the source as of 2026-11-05 unless it names a measure. Line references are by function:
the files are moving under other agents.

## 1. The state I found

**The model.** `doc.rs` passes a `t0` input to Detect, so export5 no longer runs with this source: Detect errors, and the
reader falls back to the walker. export7 (`C:\Users\elias\fable\doc\export7` on the desktop) is the first export that
takes `t0`, fitted on the 2026-11-04 copy of the store (`gold-store-new`, 5,051 train documents). It had never been graded
on development by any reader run. Its fit reports development role accuracy 0.827, heading openings F1 0.778 (epoch 20).
Pinpoint binaries from docm7 on fall back to the walker on export5 (the DOC agent's handback); m12 is an oracle run. No
pinpoint run has read export7.

**The source.** Every DOC-related edit since `14ede90` is uncommitted in `legal-pdf-parser` (branch `transition-parser`):
the T0 row (`lines.rs`), `LineView::margin` and `count`, `margin_links`, `goes_on_in_column`, the MARGIN and OPENING
readings, the emit's numbered-paragraph extent, the notes' explicit answers. `structure-gold-doc.exe` (2026-11-04 23:44) was
built after the last of them but before this week's `fences.rs` work, so no grader of the current tree existed.

**How far DOC stood on t0.** Less than the T0 row suggests:

- `derive_cached` returns from `transition::output` *before* `Notes::read`, `Decision::decide`, `write`, `pair_notes` and
  the graph. DOC gets Evidence, Fences and `runs.before`. It has never seen t0's notes, final roles, heading levels,
  units or pairs.
- T0's role is `fences.role`, the fence stage's, not the decision's. On 300 documents of the lines7 dump (204,715 lines)
  it reads `Open` on 95.0% of lines; no line in the sample is Note, Heading (6 aside), Body, Quote or ListItem. What T0 really
  carries is furniture, page and line labels, contents, tables, the band, the margin numbers, the judgment reader's
  count and held, and `continues`.
- DOC's numbered paragraphs were a second reading beside the judgment reader's: t0 answered which line opens (`count`), and
  the emit then worked out each paragraph's extent again.

**Two gaps worth knowing.** The grader scripts set `LEGALPDF_TRANSITION_LOCAL`, but `docm5.cmd` does not: without the forest
every line's local probability is 1/34, so a template row's `heading` measure, which the stylesheet graph reads, differs
between the grades and the pinpoint runs. And DOC cannot run without the walker's forest at all if it is to read what it
was fitted on: that is a dependency on the walker tier, not on t0.

## 2. Inventory

Each fact DOC reads or works out, against t0. "Read" means DOC already takes t0's. "Decoder" means post-model Rust,
removable now. "Feature" means a model input, which cannot change without a refit (export7 learned on these values).

| Fact | Where DOC derives it | Where t0 decides it | Can they disagree | What DOC gains or loses | Outcome |
|---|---|---|---|---|---|
| A numbered paragraph's extent | `emit.rs`, the `members` loop (63 lines) | `Fences::read_paragraphs` (`held`), written by `graph::read_judgment_paragraphs` | Yes. The emit's stopped only at headings; it had none of `judgment_end`, `judgment_division`, the signature or colon rules | Loses nothing t0 reads; where t0 read no paragraphs the extent falls back to the tree's, as t0's own output does | **Removed**, t0's writer called |
| Which numbers are paragraphs | emit label from the opening token | `count`, `held` | Yes | A number off t0's count loses its label; a number t0 holds and no unit carries gets its node, unless the model reads that line as a provision | **Removed**, same call |
| A paragraph printed in the other language | `printed_again`, `numbers_seen` | `held`'s language, `translated` | Yes, on a report setting its languages one after the other | Takes t0's: `write_paragraphs` gives the first node of a number both printings' extent | **Removed** |
| A line opening on t0's number is marked | Detect's flag alone | `count` | Yes | A paragraph t0 counts stays a marked unit where the flag missed it | **Consumed** (`read_with`, after `margin_links`) |
| A note's number | three Rust readers (`note_number`, the `number` closure in `read_with`, `leading_figures`) and two Python copies | `evidence.label`, read first | Yes, between DOC's own readers: the closure took any digits in four characters | One reader; `pair_match` now sees labels, readings and symbols | **Consolidated** |
| Margin numbers and their twins | no: `margin_links`, `LineView::margin` | `margin_number`, `margin_twin` | No | | Read |
| Where a paragraph opens | Detect's role, links; Order's `goes_on` | `count`, `margin_*` | Forced to t0's in `margin_links` and the `before` loop | | Read |
| Translation column | no | `fences.translation` | No | | Read |
| Reading order | no: Order's reading is off by default | `fences.order` | Only with `DOC_ORDER=on` | | Read |
| Page's printed label | which line: Detect | `fences.folios`, `furniture::printed_label` | Yes | Model refines; folio still chosen by t0 | Kept |
| Table cells | `gap_cells` only where the reader found none | `fences.tables` | No: `gap_cells` is a fallback t0 lacks | Capability of its own | Kept |
| A line going on past a page or column | `goes_on_in_column` | `fences.continues` | Yes | `continues` is a T0 input, so Detect's unset opening bit already weighs it; this function only finds which open unit the line joins, which `continues` does not say | Kept: a lookup, not a second decision |
| Note lines | Detect, Order | `Notes::read`, `Decision` | Yes | Never reaches DOC. `fences.band` does | **Not consumed**, needs a refit |
| A note's pair | `note_of` head, `moves_of`, then `State::apply`'s `unanswered` where a region holds no mark of the number | `note_pairing::pair_notes` | Yes | DOC 0.866, t0 0.859 (11-02, 184 documents): the model is not worse, and t0's runs after the write | Kept as the model's |
| Heading openings, levels | Detect, Construct | `residual`, `levels`, `Decision::level` | Yes | DOC 0.747 and 0.559 against t0's 0.500 and 0.336: the model learned this | Kept as the model's |
| Body depth, sequences, provisions, list items | Construct | `runs`, `rules` | Yes | DOC well ahead on every one | Kept as the model's |
| Quotations | Detect | `read_quotations`, `fences.quotation` | Yes | Not in T0 | **Not consumed**, needs a refit |
| Constituent documents | Detect's `start` flag, `State::document` | `fences.starts`, `fences.document` | Yes | `start_kind` reaches the walker's features only; emit reads the kind | **Not consumed**, needs a refit |
| Repeated edge line | `lines::repeated_at_edges` | `furniture.rs`, `Role::Furniture`, `PageLabel` | Yes, 1.1% of lines: of 3,094 flagged, 2,707 are t0's and 387 open; 1,832 of t0's furniture lines are unflagged | Model input; also the stylesheet's `edge` | Feature: kept till a refit |
| Under the note separator | `below_separator` | `fences.band` | Slightly: 2,535 against 2,407, 2,403 shared | Model input, and band is in T0 already | Feature: kept till a refit |
| Body type | `Looks::body` (commonest style over all lines) | `fences.body`; `notes::body_size` is a third | Yes, not measured how often | Model input | Feature: kept till a refit |
| Outline anchors | `anchors(.., &[])`, bookmarks only | the same function with the contents entries | By design (`66d0aa6`) | `doc.rs`'s header said otherwise; corrected | Kept |
| Contents rows | `stylesheet::contents_rows`, `State::answering` | `read_contents`, `contents_entries` | Yes | Walker features only; DOC computes them and reads nothing of them | Kept: the walker's, see section 5 |
| Numbering runs | `State`'s stack, replayed | `runs.rs` | Yes | DOC's moves never read the stack | Kept: the walker's |

The refit-gated rows are real duplication I did not remove, because export7's weights are fitted to those values and the
task was to leave what the model learned.

## 3. What I removed

- `emit.rs`: the extent loop, its `headed`, `loose`, `numbered` and `language` helpers, `printed_again` and `numbers_seen`.
  Its last step is now t0's `graph::read_judgment_paragraphs`, the same writer t0's own path ends on.
- `doc.rs`: the `number` closure now calls `note_number`; `note_number` and the emit share `leading_figures`.
- `doc.rs`: a line t0 reads opening on a number it prints is marked, whatever the flag says. This is done on the heads'
  answers in `read_with`, not in `moves_of`, so the oracle still reads the gold's flags alone.
- `emit.rs`: one guard keeps what the model learned: on a line DOC reads as a provision, the number stays the provision's.
  Without it `read_judgment_paragraphs` laid paragraph nodes over a contract's clauses, and `units_provision` lost in
  10 of the 184 documents.
- `docparse.py`: both Python copies of the note's number are gone; it reads `note_numbers`, which the dump now carries.
  A refit therefore needs a fresh dump: lines7 lacks the field.

### Configuration and loop state (the order of 2026-11-05)

No behaviour change is intended in either; section 4 says what proves that and what does not.

- **Configuration.** `Settings` is now a value. `Settings::from_environment` is the one place in `transition/` that reads a
  `LEGALPDF_TRANSITION_*` name, `DOC_ORDER` and `DOC_TIMES` included, and `parse`, `walk`, `locals_of`, `views_of`,
  `write_labels` and `LineTable::read` take what they need as arguments. The entry points (`run`, `output`, `enabled`,
  `emitting`) still get it from the process, because `derive_cached` calls them and is not mine to edit (section 6).
  `LEGALPDF_ONNX_RUNTIME` is the engine's, not this module's, and stays.
- **Loop state named.** `machine.rs` gains one enum, `Stands` (`Opens`, `GoesOn`, `Resumes`), and one machine, `Streams` (its
  transitions `stands` and `step`). The emit's three maps and `labelled`'s `first_of` were two tellings of this one thing, and
  both now run on it. `doc::moves_of` answers in `Stands` too.
- **Flags that needed no state.** `pending_start` and `running` are gone, not renamed: a unit starts a document where a start
  stands after the last unit's first line, and a table row joins its run where nothing breaks it since the run's last row.
  `last_held` is a pair by language, not a map.
- **One small case differs on purpose.** `labelled` and the emit disagreed on a `resume` with no earlier unit of its region: the
  emit opened a unit there, `labelled` did not. On one `Streams` they agree, with the emit's reading. Only the walker can
  reach it: DOC sets `resumes`, which takes the other branch.
- **Also consolidated on the way.** `read_gold`, `read_ranks` and `read_pieces` read one file three times and are one reader now;
  `parse` builds its views, texts and pages once, not per branch.
- **Left as they are.** `machine::State` is explicit, as ordered. Tallies and group-bys (`Looks`, `by_page`, `setting`, `members`)
  hold no state across a decision. The cursors in `read_with`'s reading loop are one bounded algorithm's. `doc::oracle` and
  `whole.rs`'s gold readers run only with the gold; `whole.rs` is not DOC's scope.

**Net lines of code in `transition/`: -16 (-29 without comments and blanks).**

| File | Lines | Code only |
|---|---|---|
| `emit.rs` | 684 to 610 (-74) | -69 |
| `machine.rs` | 735 to 783 (+48) | +36 |
| `doc.rs` | 968 to 978 (+10) | +9 |
| `mod.rs` | 730 to 730 (0) | -5 |
| `lines.rs` | 464 to 464 (0) | 0 |

`docparse.py` is -1. Outside the product, `doc-on-t0.cmd` (31 lines) and `doc_diff.py` (34) are new harness scripts. The
removal alone came to -59; the state and configuration order took most of that back, so this margin is thin.

### Rule ledger for the deleted emit code

| Branch | Where it lives now |
|---|---|
| A paragraph holds its own lines and following text in its language | `held`: `read_paragraphs` holds each line to its paragraph per language |
| Stops at the next number | `held`: each number's lines end where the next opens |
| Stops at a heading, title, headnote, contents | `read_paragraphs`'s `trailing_headings` and the bold or short heading rules, more of them than the emit had |
| A heading set over a quotation stays in | t0's rule on a heading in a quotation standing further in or smaller |
| Quotations, lists, provisions, tables held by the paragraph | `held`, and `write` of tables a paragraph holds whole (`read_judgment_paragraphs`' second loop) |
| The last paragraph of a language keeps only set-in text | t0's `judgment_end`, `paragraph_tail`, `closing_line`: finer |
| A constituent start clears open paragraphs | `read_paragraphs`' second count ("another decision in the file") |
| A loose line beside a heading in the other column ends that column's paragraph | t0's parallel handling of the two languages |
| A number printed again is marked `translation` | `write_paragraphs` joins both printings on the first node. **Differs:** the second node loses its label. t0 behaves the same |
| Extent where `held` is empty | **Lost.** Falls back to the assembled tree, as t0's output does. Only a document t0 read no paragraphs in |

The deleted extent was never graded by the structure grade, which does not read `node.extent`. Only a pinpoint run would see
what this replacement gains, and none has run with it (section 9).

## 4. Measures

**How this was measured.** Both readings ran from one binary, on the same gold: the old reading behind a temporary
`LEGALPDF_ABLATE=doc_on_t0`, removed afterwards. That was necessary because the main session edited `fences.rs`,
`evidence.rs`, `paragraphs.rs` and others between my first two builds, and a build of the working tree broke once
on another agent's half-finished edit, so two builds could not be compared. The store is the desktop's two copies,
neither touched by the repair: `gold-store` (2026-10-29, the 184 documents of the commit's baseline) and `gold-store-new`
(2026-11-04, what export7 was fitted on, 331 development documents, 9 of them failing on inputs in both arms). All 197 development
sources of the old store are development in the new one, so export7 has not seen them.

**The reader is export7, not export5.** The commit's baseline was export5 on a grader of 2026-11-02, and export5 cannot run on
this source. So the commit's column below differs from mine in model, build and t0, and is context only.

**Result: DOC's general quality held.** 184 documents, DOC:

| Layer | Commit baseline (export5, 11-02) | Before | After | Before, without the 3 transcripts | After, without them |
|---|---|---|---|---|---|
| Hierarchy | 0.729 | 0.629 | 0.629 | 0.706 | 0.705 |
| Sequences | 0.887 | 0.779 | 0.773 | 0.876 | 0.876 |
| Body depths | 0.809 | 0.699 | 0.699 | 0.809 | 0.809 |
| Headings | 0.747 | 0.764 | 0.764 | 0.771 | 0.771 |
| Provisions | 0.834 | 0.839 | 0.839 | 0.839 | 0.839 |
| Numbered paragraphs | 0.921 | 0.616 | 0.604 | 0.913 | 0.913 |
| Paragraphs | 0.740 | 0.571 | 0.571 | 0.705 | 0.705 |
| List items | 0.635 | 0.651 | 0.651 | 0.651 | 0.651 |
| Footnote refs | 0.909 | 0.904 | 0.907 | 0.904 | 0.907 |
| Footnote pairs | 0.866 | 0.888 | 0.888 | 0.888 | 0.888 |
| Heading levels | 0.559 | 0.577 | 0.577 | 0.582 | 0.582 |
| Line numbers | 0.999 | 0.541 | 0.541 | 0.797 | 0.797 |
| Speakers | 0.971 | 0.633 | 0.633 | 0.384 | 0.384 |
| Order | 0.952 | 0.813 | 0.813 | 0.923 | 0.923 |

**Speed.** 184 documents in 22.5 s after, 23.7 s before (commit: 24.6 s). Stage totals after: embed 6.1 s, Detect 19.9 s,
Order 18.7 s (worst 7.3 s), trees 6.0 s.

**331 documents, DOC, before and after:** hierarchy 0.674, 0.673; sequences 0.773, 0.770; headings 0.756, 0.755; numbered
paragraphs 0.660, 0.647; paragraphs 0.643, 0.642; provisions 0.732, 0.732; footnote refs and pairs unchanged at 0.800 and 0.899.

**Judgments by mode, 184:** digital-born (21) numbered paragraphs 0.990, 0.990; hierarchy 0.845, 0.845; footnote refs 0.959, 0.984.
OCR (12) unchanged. On the 331, OCR judgments (106) fall in numbered paragraphs, below.

### Every metric that fell, and why

- **The big fall from the commit's baseline is not DOC.** Hierarchy 0.729 to 0.629, numbered paragraphs 0.921 to 0.616, line
  numbers 0.999 to 0.541, order 0.952 to 0.813. It is t0's reading order on three digital-born transcripts (section 6, item 1):
  t0's own line numbers fall from 0.989 to 0.365 on this tree, and the walker's with them. On the other 181 documents, against the 11-02 grade of those
  same documents, DOC on export7 is level or above on every layer but four: order 0.927 to 0.923, footnote refs 0.909 to 0.907,
  line numbers 0.918 to 0.797 and speakers 0.585 to 0.384. I did not trace those last two; ad9901646910 is among them.
- **Numbered paragraphs 0.616 to 0.604, sequences 0.779 to 0.773 (184):** one document. 03a0961a is one of those transcripts: its
  numbers are now all present (586 to 699 predicted of 700) but score 0 correct because the order fault misaligns them. Without the
  three, both are unchanged. This should turn into a gain once the fault is fixed; that is expected, not measured.
- **Numbered paragraphs on OCR judgments, 0.925 to 0.879 (331):** `correct` is unchanged at 160 of 181; predicted goes from 165 to
  183. All 18 extra are t0's numbers on 6 A2AJ-aligned golds that mark almost none (`0353996797e4` 0 expected, 5 predicted).
  So no right answer was lost. I did not open those PDFs: they may be t0's false numbers or gold the alignment left unmarked.
- **Headings and hierarchy, one line:** 87ea221164e8 loses one heading to a marked unit (96/83 to 96/82).
- **Paragraphs and hierarchy, 331:** `units_text` is down in 5 documents and up in 2, `hierarchy` down in 6 and up in 4, mostly by one
  (0.642 from 0.643, 0.673 from 0.674). The likely cause is a number t0 holds getting a node beside DOC's unit; I did not confirm it.

### Per-document diff

Layer `predicted/correct` before and after, of the same expected. Full files: `C:\Users\elias\fable\doc\ot-pair-diff-184.txt` and
`ot-pair-diff-new.txt` on the desktop.

184 documents:

```
11 documents changed, 173 unchanged (of 184; layer predicted/correct, of the same expected)
03a0961a54d5 transcript digitalborn markers_text 586/0->699/0; sequence_steps 586/0->700/0
113c622e257a other ocr markers_text 3/0->4/0; sequence_steps 3/2->4/3
2f768474ff90 contract ocr markers_text 1/0->0/0; units_text 14/2->17/2; depth_steps 34/10->37/10; sequence_steps 10/2->13/5; hierarchy 35/9->38/10
5071f63ad908 unknown digitalborn markers_text 35/1->36/1; note_references 5/0->6/0; sequence_steps 42/9->43/9
75a18bf11b76 unknown digitalborn markers_text 92/0->93/0; sequence_steps 249/191->251/191
87ea221164e8 contract digitalborn units_heading 96/83->96/82; units_text 141/129->142/129; depth_steps 924/779->925/779; hierarchy 1020/816->1021/815
9f908174b252 other digitalborn units_text 23/15->24/17; depth_steps 23/19->24/20; hierarchy 27/23->28/23
a5ba808b1d23 publication ocr note_references 78/74->80/76
b216b8c881c7 judgment digitalborn note_references 8/8->11/11
b442b0a3e283 publication digitalborn note_references 259/259->260/260
e9e615f909dc publication ocr note_references 65/59->66/60
layer                docs gained  docs lost
units_heading                  0          1
markers_text                   0          0
units_text                     1          0
units_provision                0          0
units_list_item                0          0
units_quote                    0          0
note_references                4          0
note                           0          0
heading_steps                  0          0
depth_steps                    1          0
sequence_steps                 2          0
hierarchy                      1          1
```

331 documents:

```
45 documents changed, 286 unchanged (of 331; layer predicted/correct, of the same expected)
0045aa20194f judgment ocr units_text 127/65->128/65; hierarchy 165/107->166/107
0353996797e4 judgment ocr markers_text 0/0->5/0; units_text 234/157->235/156; hierarchy 300/242->301/242
03a0961a54d5 transcript digitalborn markers_text 586/0->699/0; sequence_steps 586/0->700/0
0474e2bd122b judgment ocr note_references 0/0->1/0
04cec4ee74ee judgment ocr note_references 9/0->10/0
0f84d8911c4e filing digitalborn units_text 82/48->83/49; depth_steps 239/152->240/153; sequence_steps 154/79->153/78; hierarchy 277/109->278/109
113c622e257a other ocr markers_text 3/0->4/0; sequence_steps 3/2->4/3
14d1e565f443 judgment ocr hierarchy 150/106->150/99
2077fdb96d18 judgment ocr units_text 115/70->117/69; hierarchy 157/128->159/128
23920de44fcb judgment ocr note_references 7/1->9/1
2f768474ff90 contract ocr markers_text 1/0->0/0; units_text 14/2->17/2; depth_steps 34/10->37/10; sequence_steps 10/2->13/5; hierarchy 35/9->38/10
352e0ac4d2e4 judgment ocr note_references 10/3->15/6
40ccdd44b546 legislation digitalborn units_text 57/22->59/22; units_provision 235/83->235/84; depth_steps 294/245->296/246; sequence_steps 206/190->216/200; hierarchy 338/251->340/262
40da8096e708 judgment ocr note_references 4/0->3/1
4526da858e21 judgment ocr note_references 0/0->9/2
4b183f02a980 judgment ocr units_text 183/141->184/140; hierarchy 203/164->204/164
5071f63ad908 unknown digitalborn markers_text 35/1->36/1; note_references 5/0->6/0; sequence_steps 42/9->43/9
6c6d3a9cff3e judgment ocr note_references 9/0->11/0
6e9bb2afeaa5 judgment ocr note_references 4/0->7/0
6efb9ea4891f judgment ocr markers_text 0/0->2/0; hierarchy 185/141->185/131
75a18bf11b76 unknown digitalborn markers_text 92/0->93/0; sequence_steps 249/191->251/191
78e034f3a3bc publication digitalborn note_references 62/61->63/62
87ea221164e8 contract digitalborn units_heading 96/83->96/82; units_text 141/129->142/129; depth_steps 924/779->925/779; hierarchy 1020/816->1021/815
899f85571d97 legislation digitalborn markers_text 3/0->8/0; units_text 1079/1->1080/1; depth_steps 1080/3->1081/3; sequence_steps 3/0->8/0; hierarchy 1080/3->1081/3
8a4cf89ee632 legislation digitalborn units_text 27/4->29/4; depth_steps 164/123->166/125; sequence_steps 106/97->108/100; hierarchy 191/120->193/121
8a51b18ccad6 judgment ocr note_references 9/0->8/0
8dd3e46dee32 filing digitalborn note_references 81/81->83/83
936d94da0b97 judgment ocr markers_text 1/0->3/0; note_references 3/0->4/0
9f908174b252 other digitalborn units_text 23/15->24/17; depth_steps 23/19->24/20; hierarchy 27/23->28/23
a5ba808b1d23 publication ocr note_references 78/74->80/76
b1b4d58b8baf judgment ocr note_references 1/0->4/0
b216b8c881c7 judgment digitalborn note_references 8/8->11/11
b3db4d88cf30 filing digitalborn markers_text 150/150->151/151; sequence_steps 200/191->201/192; hierarchy 256/215->256/216
b442b0a3e283 publication digitalborn note_references 259/259->260/260
b56f06c2f54f judgment ocr note_references 0/0->3/2
be7717c447e0 judgment ocr markers_text 0/0->3/0
d5063f6c23ef judgment ocr note_references 0/0->1/1
d962332ad162 judgment ocr markers_text 0/0->5/0; units_text 673/313->674/313; hierarchy 828/498->829/497
d9fec76eb13d judgment ocr note_references 5/0->8/0
e9e615f909dc publication ocr note_references 65/59->66/60
f05d5aba519a judgment ocr note_references 0/0->1/0
f3592b0786a4 judgment ocr hierarchy 197/153->197/148
f46bf84aea89 judgment ocr note_references 0/0->3/0
f85d457a61b2 judgment ocr units_text 63/56->65/54; hierarchy 80/75->82/75
fc5db8aa4870 judgment ocr markers_text 0/0->1/0; units_text 220/128->221/127; hierarchy 316/223->317/222
layer                docs gained  docs lost
units_heading                  0          1
markers_text                   1          0
units_text                     2          5
units_provision                1          0
units_list_item                0          0
units_quote                    0          0
note_references               11          0
note                           0          0
heading_steps                  0          0
depth_steps                    4          0
sequence_steps                 5          1
hierarchy                      4          6
```

### What the refactor's neutrality rests on

No run isolates it. The walker grade on my first build and on the paired build differs in 4 of 184 documents, but the main
session's t0 edits lie between those builds, so this neither proves nor refutes it. By reading: `Streams` keeps the emit's
semantics line for line, and the one known difference is listed in section 3. The paired build held the temporary code; the
final tree differs from it only by removing that code, and passed `cargo check`. It was not built again.

## 5. What I could not remove, and why

- The refit-gated rows in section 2. Each needs a new dump and fit; a fit took about two hours on the desktop GPU and
  this task did not order one.
- The second output path. `emit.rs`, 610 lines after this change, still writes what `write`, `note_pairing` and the graph
  write for t0: line regions, page labels, footnotes, paragraphs, tables, sections' aliases. It cannot go while DOC
  produces moves rather than a `Decision`. See section 7.
- The walker's machinery under DOC. `views_of`, `LineTable`'s readings, `Stylesheet`, `locals_of` and the replay through
  `State` all run for DOC, which uses only part of them. They serve the walker and `whole.rs`, so they are not
  DOC's duplication to delete. `whole.rs` (1,531 lines) and `joint.rs` (218) are other readers: out of scope, and deleting
  them needs a ledger of their own.
- `pairs_of` in `docparse.py` copies `read_with`'s pair candidates. Fitting needs the pairs over gold regions, so it must
  run in Python, unless the pair rule moves into the exported graph.

## 6. Small changes needed from the main session

1. **A fault in t0, not in DOC: transcripts' line numbers leave their rows.** `page_order` (`layout/order.rs`, uncommitted)
   takes `margin_lane` out of the body and appends it after the page. A transcript's line numbers are bare numbers clear
   of the prose, and line labels are `Stream::Body`, so they go there too, all of them after the page's text;
   `read_margin_numbers` puts nothing back, as it reads `Role::Open` lines only. On the same 184 documents t0 goes from line
   numbers 0.989 to 0.365, speakers 0.972 to 0.660 and order 0.955 to 0.823, and t0, the walker and DOC all fall together.
   03a0961a's alignment shows it: `split_reference_sources` 6119 to 0, `unmatched_candidate_sources` 0 to 6119.
   Exact change: leave `Role::LineLabel` lines out of `margin_lane`'s result, by giving `page_order` a test the way it takes
   `stream` (`read_order` passes `|slot| self.role[start + slot] != Role::LineLabel`). This is from the code and the
   metrics; I did not rebuild to prove it. The pinpoint measure does not see it.
2. `structure.rs`: `Decided::of` wants a `Decision`, and `read_judgment_paragraphs` reads none of it. The emit passes
   `Decision::default()`. Give `read_judgment_paragraphs` `(slots, fences)` in place of `decided` (`held` and `translated`
   read only those) and the empty decision goes.
3. `structure.rs` and the coupling agent's globals: `derive_cached` should take the transition parser's `Settings` from its
   caller and pass it to `transition::run` and `output`, with `emitting` and `enabled` becoming methods on it. The harnesses
   then call `Settings::from_environment` in their own `main`, and the `OnceLock` goes. Until then `transition/`'s configuration
   is one value, but it still starts in the process's environment.
4. For the next refit, T0 should be read from the decision. No change outside `transition/` is needed:
   `Notes::read` and `Decision::decide` take shared references and can run inside `transition::run`. Replace
   `fences.role[at]` with `decision.role[at]` in `lines.rs`, add `notes.note`, `fences.quotation`, the `fences.starts`
   kind and `decision.level` to the row, and bump `T0` and `docparse.T0` together. It invalidates export7, so it is one
   batch with the fit.

## 7. Why is transition a separate thing at all

**The design** (2026-10-31): one parser whose moves build the consumer API, three tiers that change only what scores the
moves. **The code** does not do this, in four provable ways.

1. *t0 is not a scorer of moves.* `decide/` has no `Move` and no `State`. It claims lines in stages (`Fences::set`,
   "a line some fence took already keeps its own"; `rules.rs`, "A rule fills only an open line"). The design's tier 0
   ("Rust evidence plus state, through a learned table") was built as the walker, which is a tier-1 reader, and never
   replaced `decide/`.
2. *`transition` is a fork, not a tier.* `derive_cached` shares Evidence, Fences and Runs, then returns early. Everything
   after is t0-only (`Notes`, `Decision`, `write`, `pair_notes`, `resolve_structure_graph_with_assembler`) or
   transition-only (`emit`).
3. *DOC does not score moves either.* `moves_of` turns the heads' answers into moves after the fact, as an encoding
   for `emit`. Only the walker, `joint` and `beam` score candidates. So `transition/` holds three different readers
   (walker, `whole`, DOC) sharing a move format.
4. *Tiers are not chosen per document.* `settings()` reads `LEGALPDF_TRANSITION_*` once for the process; there is no
   mode gate.

**No reason to be apart from `decide/`:**

- `lines.rs`'s measuring: `Looks`, `repeated_at_edges`, `text_shape`, `marker_variants`, `misread_variants`,
  `below_separator` are evidence. They are measures of a line, and half have a `decide/` twin.
- `stylesheet.rs`'s template ordering against `levels.rs` and `residual.rs`'s look groups.
- `machine.rs`'s numbering stack against `runs.rs`.
- `emit.rs` against `write.rs`, `note_pairing.rs` and `graph/`.

**A reason to be apart:** the model itself (`doc.rs`'s `model` module, `encoder.rs`), which needs `ort` and a feature gate,
and the fitting dump.

**One parser here would be:** Evidence, Fences, Runs, Notes, Decision as the one reading, always; each tier then an
optional step that takes that `Decision` and returns an edited `Decision` (roles, units, levels, starts, pairs); `write`
and the graph once. T0 is the first reading, not a rival, and the model's input is that reading.

**What it would take:**

1. T0 from the `Decision` and a refit (section 6).
2. A mapping from DOC's answers onto `Decision`. `Decision::unit` names a run and a member, and DOC's units have neither:
   provisions, list items and depths need a form that does not presuppose a run. This is the hard part.
3. `write` and the graph reading those units, in place of `emit.rs`. Provision paths, gap-cell tables and depth attributes
   exist only in `emit.rs` today, so they move, they are not dropped.
4. A per-mode gate in the engine, off for digital-born until the census proves it.

I did not start this.

## 8. Is the transition parser merged, and what is it worth

Evidence only. Nothing here is a settled recommendation.

### 8.1 Merge status

| Reader path | What runs | Proof |
|---|---|---|
| Digital-born default | `decide/` | `transition::emitting()` and `enabled()` need `LEGALPDF_TRANSITION_EMIT`, `_DUMP` or `_LABELS`; nothing in `backend/src`, `scripts/` or `native/legal-structure-node/src` outside the pinpoint tool sets them |
| OCR | `decide/` on recognized lines | Same gate; `pdfProfile.ts` adds a recognizer, no reader |
| Backend profile | `decide/`; the GRU tagger only with `MIKE_PDF_TAGGER=gru` | `configuredLegalPdfProfile`. That tagger is `legal-pdf-tagger::retag`, not `transition/` |
| Authorities WASM | `decide/`, and `transition/` is not compiled | wasm32 takes `legalpdf` with `language`, plus `legalpdf/pdf`; `tier1` comes only with `tagger`, which comes only with `full`, a non-wasm dependency |
| Node addon | `transition/` and `doc.rs` compiled in, never entered | `full` includes `tagger`, so `encoder`; `settings()` finds no environment |
| Harnesses | Walker or DOC where the environment asks | `structure-gold`, `pinpoint-corpus` |

**Built and never called in the product:** `doc.rs`, `emit.rs`, `whole.rs`, `joint.rs`, `encoder.rs`, `machine.rs`, the
walker, `beam`. About 6,400 lines of `transition/` run for no user today.

**On the branch and not on main.** `legal-pdf-parser`'s checkout is on `transition-parser`, which exists only locally
(no `origin/transition-parser`). `main` and it split at `45cecd6` (2026-10-03): 283 commits on main, 342 on the branch,
274 of the subjects shared, which reads as a rewrite. `git ls-tree main` has no `transition/`. 55 branch commits touch
`transition/`, from `8bdb925` (2026-10-31). `legal-structure` is likewise on `paragraph-spine`, one commit ahead of main.
The product builds these checkouts' working trees, so this week's paragraph work, all uncommitted, is on no remote either.

**The design's moves that were never built:** a mid-line split (`Move` has no such field), a speaker's turn (`REGIONS` has
no speaker; `WORD_SPEAKER` is evidence for a regime measure only), a page:line counter (`Open::line_number` holds a line
number alone), grammars that set which moves are allowed (`grammar.rs` gives features, it allows and forbids nothing),
tier 2's k-best rescoring (`beam` keeps readings, nothing rescores them).

### 8.2 Value ledger

t0, walker and DOC grades are `C:\Users\elias\fable\doc\spine.txt` (2026-11-02, 184 development documents, before this
week's paragraph work, so t0's numbers there are stale). Pinpoint figures are the strict rate from
`E:\OpenLegalData\pinpoint`.

| Capability | Transition design | `decide/` and the judgment reader | Better | Evidence |
|---|---|---|---|---|
| Open stack and depth | `State`'s frames; DOC's Construct tree does not use them | `runs.rs`'s runs, `rules.rs` | DOC's tree, then t0, then the walker's stack | Body depths: doc 0.809, t0 0.678, walker 0.626. Sequences: 0.887, 0.762, 0.640. Hierarchy: 0.729, 0.461, 0.566 |
| Provisions | Walker and DOC region | Sections by runs | DOC on the grade. t0's 0.000 may be a labelling gap rather than a failure to read: **not checked** | 0.834, walker 0.716, t0 0.000 |
| Numbered paragraphs | Counters on moves | `read_paragraphs`, one count per language | t0, by a wide margin, on digital-born | Pinpoint b39 (t0): digital English 99.36%, parallel 99.11%, A2AJ 99.03%. DOC on export5, docm5: 89.81%, 67.09%, 72.09% (older harness, 4,986 of 5,000 rows). Grade 11-02: walker 0.944, doc 0.921, t0 0.742 predates the week |
| Note counter, unanswered references | `State::unanswered`; DOC's `note_of` | `Notes`, `pair_notes` | About even | Pairs: doc 0.866, t0 0.859, walker 0.821. Refs: 0.909, 0.892, 0.900 |
| Transcript line numbers | `line_number` in state | `read_transcripts`, `line_numbers.rs` | All high | doc 0.999, walker 0.996, t0 0.989 |
| Transcript page:line | Designed, not built | Printed labels and line numbers apart | t0, by existing | **Not measured** |
| Speakers | Designed as a move, not built | Evidence word class, `fences` | Even | t0 0.972, doc 0.971, walker 0.966 |
| Mid-line splits | Designed, not built | `held` spans are UTF-16 ranges inside a line, so a paragraph may open mid-line | t0, by existing | DOC's round trip: about 350 mid-line pieces it cannot hold (handback, 2026-11-05) |
| Grammars by document type | Features only | `instrument` and transcript branches in code | **Not measured** | Tables in `grammar.rs` are features to the walker; DOC reads none |
| k-best rescoring | `beam` only | None | **Not measured** | No grade found |
| Heading openings | Detect | `residual` | DOC | 0.747, walker 0.670, t0 0.500 |
| Heading levels | Construct with gaps | `levels.rs` | DOC | 0.559, walker 0.441, t0 0.336 |
| List items | Detect, Construct | `runs`, `rules` | DOC | 0.635, walker 0.457, t0 0.276 |
| Consumer API output | `emit.rs`: units to nodes | `write`, graph, `resolve_structure_graph` | t0 for the product: it is the only one consumers receive. `emit.rs` alone has depth attributes, gap cells | Tables: t0 0.018, doc 0.005 |
| Whole-document joint solve | `whole.rs` | None | **Not measured here**: `fable\whole\result.txt` is absent | Superseded in practice by DOC; research note in `RESEARCH.md` |

Grade and pinpoint are different harnesses and dates. The numbered-paragraph row must be read with that in mind. On this tree and export7 (the paired run above), DOC reads 0.764 headings, 0.839 provisions, 0.651 list items, and 0.990
numbered paragraphs on digital-born judgments in the grade, where the grade counts markers and not whole paragraphs. No t0 row
was graded on the final tree; t0 on the baseline build reads 0.492 headings, 0.233 list items.

### 8.3 What `decide/` learned that transition lacks

A merged design must keep all of this. The walker and DOC have none of it as rules; some they may have learned.

**`Fences::read_paragraphs` and `read_margin_numbers`:**
- One count per language, a margin number before its row in both; a marker alone on its line opens the row beside it.
- A figure far smaller than the body is a note's label, unless beside a line in the body's type (a tribunal's small numbers).
- One language quoting a statute in two columns numbers nothing (`one_text`), against a parallel report numbering both.
- The judgment's own place: where its numbers print on the page; a number further in is a quotation's, a number no line at
  that place prints is the judgment's however it stands.
- A new count at a "1" in the body's type, five or more on, going on 2, 3, 4, 5: another decision in the file. Notes listed
  after the reasons in body type open none.
- Notes known by type, band, label run, tab after the label, carry-over; a figure opening a note's line is its words
  ("2012 ABQB 375"); a colon sets out a quotation; a note goes over a page only as `carried`.
- A figure in the margin beside no words and out of turn numbers nothing; folios that lost their figures; a recognizer's
  folio; a folio in words; a letterhead.
- A first number fused to a drop capital ("1I" / "ACOBUCCI J.").
- A marker alone opens the line after it, not "2025." ending a sentence, nor a range's end ("at paras. 11-" / "13.").
- Printed-paragraph tracking across pages (`continues_onto`), last lines before a number, last-number leading rule,
  signatures, authors, signers over their titles.
- Headings over a paragraph: bold or underlined at the margin under a sentence's end; all-bold runs; a heading in a
  quotation further in or smaller; an enactment's marginal note; a run-in label; an open bracket goes on; a table's head.
- A quotation's last lines in its indent are the paragraph's. An enactment quoted in both languages beside a paragraph is
  that paragraph's.

**`legal-structure/src/inference/paragraphs.rs`:**
- `cited_figure`: a bare figure that is a citation's volume or a date's day (long reporter list).
- Lossy counts: first numbers lost, read by steps of up to eight (`monotone_scopes`).
- `whole_list`: a count stitched across two lists reads the list it ended in.
- `quoted_runs`: nested writings each with their own count; the outermost is the judgment's; only a number the judgment's
  count also holds is quoted. Its 2026-11-05 nested form cost 449 of 501 new misses at b36: the edge is sharp.
- Numbers run into the line before ("… by the end of 2018? [34] The Claimant …"), misprints ("{3]"), bare numbers run into a
  run-in heading ("Introduction 1The …").
- Note list detection: a second count from 1 in the text's tail; a count sited in the last quarter; a list a paragraph quotes
  is no note list.
- `extend_over_gaps`: dropped numbers carried on. `paragraph_tail`, `closing_line`, `own_matter`: where a paragraph ends.
- Parenthesized numbers only where no other count; unnumbered provider text from where reasons open.

**`legal-structure/src/inference/headings.rs`:** formal and sentence headings, enumerators, levels, `cited_heading`,
`trailing_headings`, `heading_between`, joined headings.

**`legal-structure/src/case_outline.rs`:** `judgment_end`, `judgment_division`, `reasons_go_on` (numbers that are a list the
reasons quote, not their paragraphs), `two_printings` (a decision printed twice over, four-fifths rule), `front_role`,
lists within paragraphs, and matter before and after the reasons.

Note `judgment.rs` too: signature, date, disposition, author, end matter, figure caption lines.

### 8.4 Options

None is chosen. The cost figures are my estimates, not measures.

| Option | What it is | Cost | Risk | Must be measured to choose |
|---|---|---|---|---|
| A. Refiner over `Decision` | Section 7's one parser: `decide/` always runs, a model edits its `Decision`, one writer | High: the unit mapping, a refit, moving `emit.rs`'s capabilities into the writer | t0's output path changes shape; provision and list units have no run to name | Each layer by mode against DOC's today |
| B. t0's numbers, DOC's outline (this change) | Two writers stay. Judgment paragraphs are t0's, the rest DOC's | Done, less the refit-gated rows | Two output paths remain, and the consolidate rule is still unmet at `emit.rs` | Whether DOC beside t0 gains enough to carry a second path |
| C. Model as an annotator on t0's graph | `decide/` writes the graph, a model re-labels headings, levels, lists, quotes on it, as `retag` already does for the GRU tagger | Medium: DOC's heads over graph nodes, `retag`'s slot exists | Limited to what a re-label can change: it cannot move a unit's lines | Layers against B; whether `retag`'s earlier loss of numbered paragraphs recurs |
| D. Moves as the single reader | The design as written: rewrite `decide/` as scored moves | Very high | Rewrites the rules in 8.3 into a new form; the likeliest way to lose them | Every row of 8.3 re-proved |
| E. `decide/` alone | Delete `transition/`, keep research | Low | Loses DOC's lead on headings, levels, lists, depth, hierarchy on the grade | Whether consumers read those layers |

**A guard for any of them:** the digital-born pinpoint rate (b39: 99.36%, 99.75%, 98.54%, 99.11%, 98.75%; A2AJ 99.03%) must not
fall. Every option but D leaves `decide/`'s numbers in place, so the guard is a per-document diff on b39's set, plus the grade
by mode. A digital-born reader change needs that diff before a default moves.

**To choose, still unmeasured:** DOC's pinpoint rate with export7; whether consumers use the layers DOC leads on; DOC's
cost in the product (a 512 MB embeddings file, ONNX runtime, per-document seconds), against the CPU limit in
`beaver-inference-hardware-constraint`; and which of DOC's gains survive with T0 read from the `Decision`.

## 9. Not measured

- **DOC's pinpoint rate.** The replacement of the emit's extent is the change a pinpoint run would show, and the structure grade
  cannot: it does not read `node.extent`. No pinpoint run has read export7 at all. Expect the gain to be large; it is unproved.
  It also needs `LEGALPDF_TRANSITION_LOCAL` set, or the stylesheet's inputs differ from the fit's (section 1).
- **The test split.** Development only.
- **The final tree as built.** See section 4's last paragraph.
- **The t0 reading-order fix.** Found from the code and metrics; neither applied nor rebuilt.
- **How often `Looks::body` and `fences.body` disagree.** The other two feature duplicates were measured on 300 documents of lines7.
- **T0 read from the `Decision`, and what a refit gains.** No refit was run. export7 stands, and the refit-gated rows stay.
- **`doc-reach` and `doc-roundtrip`.** Not re-run. `moves_of` is meant to be unchanged for the oracle (the t0 mark is applied in
  `read_with`), but the oracle's graded output now goes through `read_judgment_paragraphs` too, so a reach grade would move.
- **The 8.2 rows marked not measured**, and 8.4's cost figures, which are estimates.
