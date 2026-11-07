# Opinion layer: what duplicates the engine

One implementation per concept. Each row is a reader in `legal-structure/src/opinion_layer` and the engine code for the
same concept.

**Diff of 2026-11-04 (18,392 plain-text records, both readers).** `text.rs` keeps plain opinions. Pages 235,399 to the
engine's 3,387 and notes 105,757 to 999. The engine's extra 141,687 headings read as running titles, caption lines and
sentence fragments; its extra numbered paragraphs as footnote labels and page numbers on their own lines; its extra
paragraphs as splits at page turns. The engine's provider reader stays for its other callers. Merging the two is still
owed: the engine takes the last column, which changes the default path, so it waits for his word.

| Concept | Opinion layer | Engine | Layer branches the engine must keep or take |
|---|---|---|---|
| Plain case text, whole reader | `text.rs::read` | `provider_text_document_structure`, `inference/case.rs::detect_case` | all below |
| Pages | `page_chains`, `pages_of`, `heads_pages` | `inference/pages.rs::detect_pages`, `form_feed_pages` | any repeating shape with a climbing number; header vs footer; ECF stamps; running titles as furniture; stray number; margin-count pages; `page_count` guard; `Page \| of 21` |
| Margin line numbers | `margin_numbers` | check `inference/case.rs::case_source_layout` | taken off each line, restart gives a page |
| Paragraph numbers | `paragraph_marker`, `own_numbers`, `lettered_paragraphs` | `inference/paragraphs.rs::paragraph_markers`, `rooted_count`, `rooted_chain` | `¶` and `{n}` kept as printed in any order; `n]` residue; restarts and repeats; `(a)` and `(1)` runs; `Question 1`; number on a title carried to the text under it |
| Plain notes | `note_zones`, `notes_of` | `text_notes.rs::text_note_blocks`, `pair_numbered_footnotes` | page-foot zones; rule lines; glued `5See`; `1/`; symbol notes; skip and restart past a rule; `[n]` paragraphs vs notes |
| Headings | `heading_line`, `section_word`, `run_in`, `fused_titles` | `inference/headings.rs` (`formal_heading`, `heading_levels`, `sentence_heading`), `paragraphs.rs::run_in_heading`, `formatted_headings.rs` | enumerated sentence-case titles; `Ill`; letter-spaced titles; page suffix; contents lines refused; fused lead and tail titles |
| Quotation editorial lines | `quotations` marks | `numbered_paragraphs.rs::editorial_line` | editor's marks inside a quotation, `(emphasis added)` |
| Tables | `data_tables`, `flat_tables` | `tables.rs` | rows out of paragraphs; flat plain tables by shared columns |
| Case parts | `separate_parts` | `case_outline.rs` | second author line; run-in `concurring`; appendix, rehearing, order, judgment parts |
| Short names | `defined_terms` | `common-law-cite` `metadata.rs` (`attach.defined-term`) | engine's is a citation's short form only; parties, acronyms and `means` stay in the layer unless the grammar takes them |
