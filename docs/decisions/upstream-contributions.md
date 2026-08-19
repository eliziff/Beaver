# Potential pull requests to upstream Mike

## 1. DOCX extractor numerically coerces text runs

`extractDocxBodyText` builds its XML parser without `parseTagValue: false`,
so numeric-looking `w:t` runs round-trip through numbers: `"12.10"` becomes
`12.1` and `"1.0"` becomes `1`. Section numbers, amounts, and version strings
are silently altered in the text served by `read_document` and
`find_in_document`. A focused fix is already being proposed upstream.

## 2. Pagination duplicates visibility and filter predicates

The paginated project and workflow queries have separate full-row and ID-only
paths. The ID-only path avoids expensive display joins, but copies the same
visibility, ownership, search, and filter predicates; comments require future
changes to keep the copies synchronized by hand. A mismatch can make “select
all matching” disagree with the visible result set and could become an access
control defect.

Future focused PR: extract the parameterized matching-row set once in SQL, then
derive both the paginated display query and lightweight ID query from it. Keep
the ID path free of count/display joins and add equivalence tests across owned,
shared, searched, and filtered collections.
