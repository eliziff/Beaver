# Calamine

Crates.io `calamine` 0.38.0, upstream commit
`a4dba3b5309d81b2774018a13be39e68d938c3c7`
([upstream](https://github.com/tafia/calamine)). Package identity, author attribution
and source headers remain upstream's.

The XLS reader retains number-format codes and each cell's XF index while reading
the existing BIFF records. It exposes them through the existing `Reader::worksheet_style`
and `StyleRange` APIs. Date classification and cell/formula decoding are unchanged.
The native workbook reader uses that style data with its existing number formatter.

Regression: `backend/src/lib/__tests__/spreadsheet.test.ts` checks exact text, numeric
display, merged cells and UTF-16 ranges for the same XLS, XLSX and XLSM workbook.

`LICENSE-MIT.md` is the upstream package's unchanged MIT licence.
