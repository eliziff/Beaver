# Recovered corpus and witness review

## General witness-composition audit

`python experiments/compound-witness-review/audit_roles.py` compares retained
native and layout-assisted SEC complaint outputs. It asserts identical line
identity, text, and geometry before comparing roles, and prints file hashes.
Fresh comparison: 275 aligned lines over nine pages; two body-to-heading
differences on page 4 (`B.` and `Defendant Misappropriated Investor Funds`).
The 72/96-DPI layout outputs have identical hashes, so they are one result,
not independent corroboration. These retained outputs are historical, not a
fresh run of current production code.

Current code inspection identifies the following priorities:

1. `graph.rs` emits SectionHeading when either final role is heading OR the
   original source region was heading/paragraph_title. Check whether this
   resurrects a rejected classification. This is a hypothesis until final
   graph behavior is reproduced; BodyProseFlow can independently support
   hierarchy sections, so deleting the source fallback alone may not help.
2. `classify_pages_with_source` applies a note cut to subsequent lines, with
   table and furniture exceptions. Audit false-positive propagation and the
   independent evidence supporting each cut before changing thresholds.
3. `assign_printed_page_labels` considers only header/footer lines. Missed
   furniture suppresses page-label eligibility; concurrent labels produce an
   ambiguity diagnostic. Preserve that abstention while auditing candidate
   coverage and provenance.
4. A document-wide article font estimate exists when source regions are
   complete. Compare it with local typography on ordinary documents before
   relying on it across inserted forms or attachments.

The first proposed repair target is consistent treatment of rejected heading
evidence through classification and graph resolution. No production change is
yet justified by the retained comparison alone. Establish an end-to-end failing
case and independently reviewed expected structure before changing inference.

The historical corpus identity is documented in
`legal-pdf-parser/experiments/structure-engine-parity/EVIDENCE.md`: 1,500 PDFs,
111,542 pages, split 750 native and 750 non-digital. The replay baseline has
748 successful native documents. These are historical denominators, not a new run.

The source PDFs are present at `experiments/legal_pdf_corpus/pdfs`: a fresh
recursive count found 1,500 PDFs and all 750 native-manifest paths exist.
The earlier search missed ignored files. The four selected affidavit, application
pack, and e-filing-guide PDFs match their recorded SHA-256 hashes. Missing old
cache directories do not block work: source evidence can be regenerated.
There are also 710 application projections under
`tmp/text-fragment-fix/app-corpus/candidate`; these contain text and anchors.

Fresh PyMuPDF inspection of the three form PDFs (75 pages total) found no
bookmarks. Both NZ packs have 36 pages with an unchanged A4 canvas. In the
one-party pack, application text begins on physical page 13 and affidavit text
on page 23, each with local page 1. These are candidate boundaries pending
visual review. Alternating sparse-text pages and form material mean native
text emptiness cannot be treated as blank-page evidence. The joint pack has
continuous package pagination plus a second numeric stream on form pages,
including a local restart at physical page 21. These require concurrent
pagination streams rather than one document-wide folio sequence.

## Review candidates identified by source SHA-256

- `144198377e8a3accbecd73d4f326d8cae21635c4fae4578acc9c7e7d9f360e36`:
  New Zealand one-party dissolution application pack.
- `164c96859686411a4cd3d28d473c41f393288706fd3af10b94d3602f02e40add`:
  corresponding joint application pack.
- `0195bb0839279c0df02a69665b5e47164f9006cab458463e26e7c629a0f296bc`:
  Australian affidavit form, exhibit index, and certificate material.
- `b18327d400a8fc59b59e789c77edc97c2de31b136d73884247e057ef65cc7e60`:
  Part 22 forms collection; distinguish collection constituents from form internals.
- `7556737226bc016553fdab51d63ae452106d2b77f51ede9b426dad300a9465eb`:
  Federal Court e-filing guide; negative control for mentions of tabs and records.
- `96d39f5a23be5068dfc9b1f8f7d1bf3c5d3d349d8e0530963d830786015bdd15`:
  Canada closing submissions; negative control for mentions of motion records.

These are discovery candidates, not reviewed boundary gold. No real motion
record has yet been verified from this shortlist.

## Existing implementation and next gate

`legal-pdf-core/src/model.rs` retains physical page size, printed label and
its source line, source/reading order, line and word boxes, span font/size/flags,
and source-region identity. `legal-pdf-structure/src/structure.rs` already
composes source regions, contents pages, table exclusions, heading grammar,
furniture, printed labels, and note pairing. Those are the relevant primitives.

Boundary review should group dependent evidence: a detected footer and its
derived page label are not independent votes. Geometry, typography, and lexical
changes require persistence across neighboring pages and counter-evidence from
continued sentences, notes, heading sequences, and alternating page furniture.
Canvas changes can indicate inserts; numbering restarts can indicate sections;
neither alone establishes a new constituent. Package pagination and local
pagination may coexist. Tabs can contain several constituents.

Recover original PDFs/native caches first, annotate actual constituent starts,
ends and uncertain spans, and compare witness ablations on those fixed cases.
The roadmap explicitly requires this before splitting compound documents.
For monodoc controls, score false boundaries as well as heading, paragraph and
note quality. Preserve parent ownership and physical-page/text offsets.
No production detector changes or Jev calls are part of this review.
