# Citation grammar source policy: Eyecite comparison

Finding date: **2026-08-14**

Updated: **2026-08-19**

Status: **Use mature external grammars to fill measured coverage gaps in
Beaver's one authored grammar corpus; do not add a competing runtime parser or
resolver.** This update supersedes the earlier Canadian-only prioritization
below. The implementation sequence and corpus gate are maintained in
`experiments/legal_pdf_corpus/LEGAL_PDF_SILVER_MASTER_PLAN.md`.

## Conclusion

`freelawproject/eyecite` and the independent `eyecite-ts` port remain
inappropriate as Beaver runtime dependencies, but their U.S. citation
grammars, ambiguity cases, and span behavior are relevant source/oracle
material for the universal legal-PDF corpus. The earlier conclusion treated
Beaver as Canadian-first; the 1,500-PDF parser and silver program spans U.S.
and other legal materials and therefore invalidates that prioritization.

The goal is not to adopt Eyecite wholesale. Beaver retains one portable,
authored corpus for citations, footnote labels, pinpoints, provisions, and
references. A missing dialect may be sourced from Eyecite or another mature
grammar only after corpus evidence, licence/provenance recording, positive and
negative vectors, portable compilation, and exact-span differential checks.

Beaver already owns the relevant deterministic machinery across its shared
grammar tables, citation identity and alias graph, Table of Authorities,
DOCX-linking pipeline, and legal-PDF footnote pipeline. In particular, Beaver
already has:

- Canadian and French neutral, reporter, statute, regulation, journal, book,
  URL, legal-title, pinpoint, signal, and cross-reference grammars;
- provider-grounded citation identities and alternate-citation aliases;
- two-pass Ibid and party-name/supra-note resolution;
- conservative ambiguity abstention and manual correction;
- merging of resolved references into the parent TOA authority;
- exact source spans and fidelity-preserving DOCX mutation; and
- footnote cross-reference detection for supra, infra, op. cit., and explicit
  note references, including restarted-numbering ambiguity.

## What is actually different

### Nested citations inside explanatory parentheticals

`eyecite-ts` can retain a host/child relationship when one citation occurs
inside another citation's explanatory parenthetical, and it prevents a later
Id. or supra from selecting the nested authority. Beaver splits and classifies
such citation strings but does not appear to preserve a comparable
parenthetical citation tree.

This remains a credible relation to test in parenthetical-heavy documents. If
the corpus establishes a failure, add the smallest host/child relation to
Beaver's existing citation parts rather than introducing a universal citation
AST.

### Normalized-to-original transformation maps

Eyecite can map spans found after HTML and whitespace cleanup back onto the
original marked-up source. Beaver already preserves exact text spans and maps
citations into DOCX XML. A generic transformation map might help a future HTML
or OCR caller, but it duplicates existing capability unless a real non-DOCX
coordinate-loss problem is demonstrated.

### U.S.-specific typed citation coverage

Eyecite parses a much broader range of U.S. reporters, federal and state
statutes, constitutional provisions, public laws, registers, dockets, and
reporter-only short forms. This coverage is relevant to the actual universal
PDF corpus and must now be compared against the authored Beaver corpus.

Canadian subsequent citations ordinarily use the case name (often shortened)
or Ibid with a pinpoint, not a neutral-citation or reporter-only shorthand.
Accordingly, Eyecite's reporter-short-form resolver remains unnecessary for
Canadian materials, but its grammar coverage can expose real U.S. span and
classification gaps. Grammar coverage and resolution remain separate
decisions.

### Reporter catalogue and tokenizer scale

Eyecite uses `reporters-db` to validate reporter variants, jurisdictions, date
ranges, and ambiguous abbreviations. Beaver instead builds aliases from corpus
and provider identities, which answers the separate question of whether two
citations identify the same authority. Reporter metadata may be consulted as
provenance-bearing authoring/oracle material, but it does not become a Beaver
runtime database without a separately measured need.

Eyecite's Aho-Corasick and optional Hyperscan tokenizers are useful only because
it carries a very large reporter grammar. Beaver's smaller Canadian grammar has
no demonstrated dispatch-performance problem.

## Material to qualify against the corpus

The repositories may supply:

- missing U.S. reporter, statute, regulation, constitutional, docket, and
  short-form grammar families;
- fixtures for citations nested in parentheticals;
- normalization-to-original-span invariants;
- overlap, ordering, ambiguity, and regex-runtime tests; and
- reporter metadata used as an authoring check rather than a runtime identity
  system.

Qualify these against actual false positives and false negatives in the corpus.
Do not import fixtures, patterns, or metadata without recording licence and
provenance.

## Decision

- Inventory the corpus dialects and current Beaver coverage, then add proven
  missing families to the one authored grammar corpus.
- Use Eyecite, `eyecite-ts`, and other mature projects as source/oracle
  material where applicable; do not add them as shipping runtime dependencies.
- Do not import `reporters-db` as a runtime database.
- Do not build a competing citation resolver, alias system, or citation AST.
- Require provenance, licence review, positive/negative vectors, all-runtime
  compilation, corpus precision/recall evidence, and exact source-span
  differentials for every added grammar.
- Feed typed citation and pinpoint spans into the shared structure engine so
  citation numbers cannot be promoted casually as headings, notes, page
  labels, or numbered units.
- Keep citation identity, provider resolution, aliasing, and TOA grouping in
  their existing services.

## Beaver implementation reviewed

- `legal-structure/data/grammar-corpus.json`
- `packages/legal-grammar-tables/check.mjs`
- `legal-pdf-parser/rust/src/grammar_tables.rs`
- `legal-pdf-parser/rust/src/deterministic_citations.rs`
- `backend/src/lib/legalReferenceGrammar.ts`
- `backend/src/lib/citationKey.ts`
- `backend/src/lib/caselawCitator.ts`
- `backend/scripts/build_citator_graph.py`
- `backend/src/lib/legalTextAnchors.ts`
- `backend/src/lib/docxCitationLinking.ts`
- `backend/src/lib/docxDeterministicCleanup.ts`
- `AuthoritiesHelper/toa_maker.py`
- `AuthoritiesHelper/tests/test_toa_maker.py`

## External sources reviewed

- <https://github.com/freelawproject/eyecite>
- <https://github.com/freelawproject/reporters-db>
- <https://github.com/medelman17/eyecite-ts>
