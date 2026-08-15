# Document-family and text-reuse research note

Finding date: **2026-08-14**

Status: **Parked. Do not build yet.** No dependency, experiment, or roadmap
promotion is proposed.

## Possible capability

Detect when documents in one matter reuse substantial passages even though
their filenames, formats, pagination, or surrounding text differ. Possible
examples include:

- successive drafts saved under unrelated filenames;
- a DOCX draft and its executed PDF;
- amendments or correspondence reproducing clauses from an agreement;
- repeated exhibits or schedules in a disclosure package; and
- agreements derived from the same precedent.

The useful output would not be a generic similarity score. It would identify
document-family candidates and show aligned, source-addressable reused passages:

```text
Document A section 8.2 <-> Document B section 9.1
742 matching words
Changed terms: notice period, address, cure period
```

Confirmed pairs could then enter Beaver's existing document-comparison and
evidence machinery.

## Candidate deterministic machinery

There are two distinct problems:

1. **Candidate generation:** cheaply find likely related documents in a large
   matter. MinHash plus locality-sensitive hashing is a conventional option.
2. **Passage alignment:** locate the actual shared spans. Winnowing fingerprints
   or exact n-gram seeds followed by local alignment are more useful than a
   document-level score.

Beaver should preserve original `SourceDoc` addresses throughout. Normalization
may ignore presentation noise, but every reported match must map back to exact
source text in both documents.

If this is ever tested, begin with a dependency-free implementation over
Beaver's existing extracted blocks. At small matter sizes, an inverted index of
stable word-shingle hashes may be sufficient; LSH is unnecessary until measured
all-pairs cost requires it.

## Existing Beaver primitives

Any future work should reuse rather than replace:

- canonical `SourceDoc` projections and structural addresses;
- document content hashes and version lineage;
- DOCX/PDF extraction and fidelity contracts;
- existing document-version comparison and redline machinery; and
- evidence receipts and verbatim-source-span invariants.

This capability would discover candidate relationships. It would not become a
second document store, parser, diff engine, or semantic identity system.

## Why this is a can of worms

- Boilerplate can make unrelated agreements appear to be one family.
- Headers, footers, signature blocks, standard conditions, and court forms can
  dominate similarity unless treated deliberately.
- A short but decisive amendment may have low whole-document similarity.
- OCR errors and DOCX/PDF extraction differences can hide genuine reuse.
- Reordered clauses complicate version ordering and alignment.
- Common precedent ancestry does not establish that one document is a version
  of another.
- Similarity is symmetric; legal lineage and chronological succession are not.
- Privileged or sensitive documents must remain local and matter-scoped.
- Thresholds will vary among pleadings, agreements, correspondence, exhibits,
  and authorities.
- Large clusters require an intelligible review interface, not a graph hairball.

The system must therefore distinguish at least:

- byte-identical duplicate;
- same rendered/substantive document in another format;
- probable version;
- shared precedent or boilerplate; and
- isolated passage reuse.

It must not label any of these relationships as established provenance without
independent metadata or user confirmation.

## Possible value

- Group messy draft families despite unreliable filenames.
- Avoid repeated review of substantially identical material.
- Find the exact clauses that recur across a disclosure package.
- Identify which documents deserve a full comparison.
- Surface precedent-derived language with exact locations.

These are hypotheses. No evidence presently shows that automatic family
detection would outperform user-selected comparison in Beaver's actual use.

## Revisit trigger

Revisit only when a real or representative Beaver matter contains enough
poorly labelled duplicates, versions, or repeated clauses that manual pairing
is materially burdensome.

Before implementation, freeze a small adjudicated corpus containing true
versions, format conversions, shared-boilerplate non-versions, partial reuse,
OCR noise, and unrelated controls. Measure family precision, family recall,
passage-boundary accuracy, runtime, and false relationships caused by
boilerplate. A useful experiment must outperform filename/date heuristics and
simple exact normalized hashes.

## External references

- [Copietje](https://github.com/NetherlandsForensicInstitute/copietje) —
  forensic near-duplicate discovery using MinHash and LSH.
- [Passim](https://github.com/dasmiq/passim) — matching-passage detection,
  alignment, and clustering.
- [Copydetect](https://github.com/blingenf/copydetect) — a compact example of
  winnowing fingerprints and matched-span reporting, although designed for
  source code rather than legal prose.
- [datasketch](https://github.com/ekzhu/datasketch) — general MinHash/LSH
  reference implementation.

These projects are algorithm references, not proposed Beaver dependencies.
