# Authoritative table parity

This experiment takes the first 500 DOCX and spreadsheet artifacts in stable
repository-path order, invokes Beaver's existing format adapters, and freezes
their native cell facts, masked detector input, and complete legacy table-node
projection. It does not parse DOCX, XLSX, XML, or ZIP content itself.

Raw text and projections stay under ignored `results/`; `baseline.json` is the
bounded corpus receipt.

```powershell
.\backend\node_modules\.bin\tsx.cmd experiments\authoritative_table_parity\freeze.ts
```
