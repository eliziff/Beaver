# Block quotations from their words

Two witnesses for whether a set-in block of a PDF is a display quotation, tried beside the
parser's existing cues (an opening mark, a lead-in ending in a colon, a smaller or italic face).
The block's extent stays the layout's: these weigh a block, they do not find one.

- **Rules** (parser patch `LEVER_QUOTERULES`; `cues.py` measures each cue's lift in the training
  units): words left out ("...", "…"), words
  altered in brackets run into a word ("[t]he", "assess[ed]", "[sic]"), a note of the alteration
  ("emphasis added"), or an introducing line, on a block that reads as sentences (no form blanks,
  five words a row, a sentence's end).
- **Lexical model** (`train_lr.py`, parser patch `LEVER_QUOTELEX`): a hashed logistic scorer over
  the block's opening and closing words, its vocabulary, the introducing line's last words and the
  next line's first word. Trained on journal regions (`build_journal_set.py`, the Open Access
  Journals Database's `text`/`block_quote` regions) and A2AJ judgments (`build_a2aj_set.py`: the
  unnumbered paragraphs between numbered ones are what a judgment quotes).

## Results

Held out by article, the lexical model alone reaches F1 0.607 on A2AJ paragraphs and 0.619 on
journal regions (P >= 0.8 at recall 0.34 and 0.20).

On the structure gold (477 runs, 336 gold quotations: 208 inline, 128 display, 102 attributed),
with quotations emitted as `quotation` sections (`evaluator-quotations.patch` maps them):

| arm | quotation P | R | F1 |
|---|---|---|---|
| existing cues only | 0.17 | 0.015 | 0.028 |
| + rules | 0.087 | 0.020 | 0.033 |
| + lexical model, log-odds >= 0 | 0.046 | 0.021 | 0.029 |

Every other layer is unchanged within 0.002. By line overlap, nine in ten predicted blocks have no
gold quotation under them; before the prose gate the rules fired on court forms' bracketed
blanks and on list items' wrapped lines, and a set-in line opening in lower case proved as often a
list item's continuation as a quotation joined mid-sentence. Most of the gold's quotations are
inline or carry an attribution, which display-block detection does not produce.

Neither witness is in the parser. `parser-witnesses.patch` applies both to `legal-pdf-parser`
(switches `LEVER_QUOTENODES`, `LEVER_QUOTERULES`, `LEVER_QUOTELEX=<threshold>`).
