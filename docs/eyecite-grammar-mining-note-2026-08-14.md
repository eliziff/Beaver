# Eyecite comparison findings

Finding date: **2026-08-14**

Status: **No high-value Beaver feature identified.** No dependency, experiment,
or production change is proposed.

## Conclusion

`freelawproject/eyecite` and the independent `eyecite-ts` port are mature or
interesting U.S. citation parsers, but they do not presently offer Beaver an
important Canadian legal capability. Earlier notes overstated their value by
comparing their advertised features with only part of Beaver's implementation.

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

This is the most credible new idea, but no current Beaver failure or Canadian
corpus measure establishes material value. If one appears, add the smallest
host/child field to Beaver's existing citation parts rather than introducing a
universal citation AST.

### Normalized-to-original transformation maps

Eyecite can map spans found after HTML and whitespace cleanup back onto the
original marked-up source. Beaver already preserves exact text spans and maps
citations into DOCX XML. A generic transformation map might help a future HTML
or OCR caller, but it duplicates existing capability unless a real non-DOCX
coordinate-loss problem is demonstrated.

### U.S.-specific typed citation coverage

Eyecite parses a much broader range of U.S. reporters, federal and state
statutes, constitutional provisions, public laws, registers, dockets, and
reporter-only short forms. This is real coverage but not presently useful to a
Canadian-first Beaver.

Canadian subsequent citations ordinarily use the case name (often shortened)
or Ibid with a pinpoint, not a neutral-citation or reporter-only shorthand.
Accordingly, Eyecite's reporter-short-form resolver addresses a predominantly
American problem and should not be treated as a Beaver feature gap.

### Reporter catalogue and tokenizer scale

Eyecite uses `reporters-db` to validate reporter variants, jurisdictions, date
ranges, and ambiguous abbreviations. Beaver instead builds aliases from corpus
and provider identities, which answers the more important question: whether two
citations identify the same authority. Reporter metadata might classify an
unresolved U.S. string before provider lookup, but that marginal benefit does
not justify another database.

Eyecite's Aho-Corasick and optional Hyperscan tokenizers are useful only because
it carries a very large reporter grammar. Beaver's smaller Canadian grammar has
no demonstrated dispatch-performance problem.

## Low-priority crib material

The repositories may still supply inexpensive test-design ideas:

- fixtures for citations nested in parentheticals;
- normalization-to-original-span invariants;
- overlap, ordering, ambiguity, and regex-runtime tests; and
- reporter metadata schemas if Beaver later acquires a demonstrated U.S.
  citation requirement.

These are references to consult after a measured Beaver failure, not a roadmap.
Do not import fixtures or code without recording licence and provenance.

## Decision

- Do not add Eyecite or `eyecite-ts` as a dependency.
- Do not import `reporters-db`.
- Do not build a competing citation resolver, alias system, or citation AST.
- Do not start the previously suggested comparison experiment absent a concrete
  Canadian corpus failure.
- Revisit only if nested-parenthetical attribution or cleaned-source coordinate
  loss becomes a measured problem for an existing Beaver feature.

## Beaver implementation reviewed

- `shared/grammar-tables/citations.json`
- `backend/src/lib/citationKey.ts`
- `backend/src/lib/caselawCitator.ts`
- `backend/scripts/build_citator_graph.py`
- `backend/src/lib/legalTextAnchors.ts`
- `backend/src/lib/docxCitationLinking.ts`
- `backend/src/lib/docxDeterministicCleanup.ts`
- `TableOfAuthoritiesMaker/toa_maker.py`
- `TableOfAuthoritiesMaker/tests/test_toa_maker.py`
- `universal-legal-pdf-engine/src/legalpdf/deterministic_citations.py`
- `universal-legal-pdf-engine/src/legalpdf/note_crossrefs.py`

## External sources reviewed

- <https://github.com/freelawproject/eyecite>
- <https://github.com/freelawproject/reporters-db>
- <https://github.com/medelman17/eyecite-ts>
