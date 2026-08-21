# External pinpoint robustness

Status: Decisia path restored; remaining providers parked for research
Observed: 2026-08-21

## Problem

Beaver correctly binds citation pills to exact evidence receipts. For a
Decisia URL supplied by A2AJ, the exact A2AJ text and native paragraph locator
are sufficiently source-aligned to build the official deep link. That mature
path is restored for all detected Decisia deployments.

For other publisher pages, an exact passage in A2AJ is not proof that the same
text-fragment directive will resolve in the rendered DOM. Outcomes can vary:

- some citations carry a very long `:~:text=` target;
- some fail closed to a provider-native `#par` anchor or the bare source URL;
- some directives are unique in A2AJ but do not land on the publisher page.

The internal source viewer remains the correct final fallback. Do not weaken
quote/source verification merely to emit more external fragments.

## Reproduction

Chat `36211f92-ec9d-4c62-931c-47ca9a1eee29` exposes all three cases.

- King’s Printer citations 1 and 3 contain the exact displayed text, but fresh
  Chrome 151 navigation to Beaver's stored directives remained at
  `scrollY = 0`.
- On the same document, short prose-only targets landed correctly at
  `scrollY = 21,465` (s 49) and `9,021` (s 77). This proves that King’s Printer
  supports text fragments and isolates the failure to target construction.
- Citation 5 fell back to the bare statute URL because its passage crosses a
  source line/block boundary.
- Colucci citations 7, 10, and 11 exposed a separate regression: A2AJ supplied
  the official Decisia source, but the canonical evidence projector bypassed
  the A2AJ link builder and manufactured CanLII URLs. The projector now routes
  both live and rehydrated A2AJ receipts through that builder.
- CanLII remains the correct target when it is the A2AJ source or no safe
  official alternative exists. Fresh automated sessions were blocked during
  this investigation, so new claims about additional CanLII DOM edge cases
  still require browser evidence.

## History

- `1da1a1bd` introduced the original whole-document uniqueness check. It proves
  uniqueness against canonical source text, not the external DOM.
- `c3ddae9d` removed leading decision paragraph markers such as `[36]`, but did
  not establish provider-neutral structural-label handling.
- `b1b29b6f` added a long start/end range shortcut. It caused incorrect early
  matches and is being removed; it is separate from the older cross-provider
  limitation described here.
- `daf5ccb0` restored full-source hydration so follow-up evidence can use the
  mature uniqueness check. It does not make A2AJ text a target-DOM fixture.
- `aa7acfa3` centralized citation presentation but kept a CanLII-first evidence
  path instead of calling `buildA2AJPinpointUrl`. This was the concrete Decisia
  regression; the canonical projector now uses the existing A2AJ builder.

## Intended design

Keep the existing evidence-ID, A2AJ/Decisia builder, and citation projection
path. Any later work applies only to publisher classes without the proven
Decisia relationship:

An ordinary case-authority link may resolve to CanLII. Text-fragment building
is separate: it must use the retrieved provider document URL and must never
silently swap providers while constructing a fragment.

1. Preserve a known native anchor whenever the provider genuinely supports it.
2. Derive several bounded prose candidates from the exact evidence span,
   excluding structural labels and avoiding cross-block runs.
3. Require each candidate to be unique in the immutable source document.
4. Validate candidate compatibility against checked-in rendered-text fixtures
   for each supported provider class. Do not fetch publisher pages during a
   chat turn.
5. Choose the shortest provider-compatible candidate; otherwise keep the
   native anchor or internal source-viewer fallback.
6. Maintain a ChromeDriver gate covering CanLII decisions and legislation,
   Decisia, Alberta King’s Printer, federal legislation, direct PDFs, and one
   provider with no native paragraph/section anchors.

This should reduce anchor-only fallbacks without pretending that A2AJ
normalization alone guarantees an external highlight.

## Provider DOM projection and directive variants

Observed: 2026-08-21, live Chrome verification against SCC Decisia
(Colucci, item 18909).

The relationship between A2AJ text and a publisher page is an engine-level
projection, deterministic per provider class, and it matters because
Chromium matches text fragments positionally:

- one NBSP folds onto one space, but whitespace runs are never collapsed
  across element boundaries;
- each `text=` directive that matches nothing is silently ignored, while
  every matching directive renders its own highlight.

Known projection entries so far:

| Source (A2AJ) | Rendered form | Fragment consequence |
| --- | --- | --- |
| `s. 17` mid-target | linkified `s.<NBSP>17<NBSP>` + plain `" of"` | target continuing past a cluster needs the padded spelling |
| `s. 17` at target end | same padding | plain ASCII works; the match ends at the digit |
| `[n]` paragraph markers | anchor element plus NBSP-run span | strip from targets and boundaries |
| prose punctuation restyled by the engine (`—` → `,` observed between an SCC headnote and body para 138 of Colucci) | silently different characters | such directives fail closed; catalog via corpus alignment |

A2AJ source text includes publisher-front matter (the SCC headnote and its
Cases Cited list ship inside the retrieved document), so every DOM duplicate
of a target is also a source duplicate. That keeps the generic duplication
check fully informed: repeated phrases raise `directiveMatchCount`, context
windows qualify the directive, and range pairing counts reject ambiguity -
all computed against immutable source text, with no per-provider or
per-region logic.

Two safety properties follow:

1. **Variants share one proof.** A padded spelling of a target whose
   uniqueness was proven against immutable source text needs no separate
   check; emit plain and padded as sibling directives and exactly one can
   match on any rendering.
2. **Duplication is not variant-safe.** When a phrase occurs more than once
   in the document, every matching directive highlights its own first match,
   so bare and context-qualified spellings must never be emitted together -
   qualification replaces, never joins. The existing generic guard is the
   right and sufficient infrastructure: because the retrieved source text
   includes publisher-front matter, source-side duplicate counting sees what
   the DOM sees (verified 5=5 on Colucci), so context windows and range
   pairing counts prevent headnote or body lock-ons without any special
   handling. The fidelity gate keeps an after-the-first-body-anchor landing
   check purely as a verification metric that this agreement continues to
   hold at corpus scale.

Long-term default: one form per proven provider projection; variants are
the bridge until the fidelity corpus proves each class.

## Corpus-scale fidelity loop

Random passage seeds drawn from local corpora, built through production
link code, verified against live pages (scroll landing plus screenshot),
then aligned source-vs-rendered to mine new projection rows. See
`benchmarks/text_fragment_fidelity/`; wrong-place lock-on rate and silent
directive failure rate are its acceptance metrics.

## Acceptance

- A fixture-backed provider emits a text fragment only when a fresh browser
  lands on the intended passage.
- Structural labels, punctuation, inline markup, Unicode spaces/dashes, and
  source line breaks do not cause false confidence.
- Unsupported or changed provider markup degrades to a real native anchor or
  Beaver's source viewer, never a fabricated anchor or an unverified fragment.
- The same evidence receipt always produces the same URL for a fixed provider
  fixture/version.
- The cross-provider gate records fragment landing, native-anchor landing, and
  post-navigation scrollability separately.
