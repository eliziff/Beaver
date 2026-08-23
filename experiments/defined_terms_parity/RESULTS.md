# Defined-term parity

The Rust `DefinitionsResult` detector matched the ECMAScript oracle exactly on
every readable registered DOCX and every instrument text available on
2026-08-22.

- Registered DOCX: 27 byte-unique files; 26 readable and 26/26 exact; the one
  truncated ZIP reproduced the frozen error outcome.
- Instrument corpus: 872/872 exact (124 agreement texts and 748 settled PDF
  extraction texts); 1,171 terms.
- Complete Rust facts: 1,365 definition occurrences, 30,584 use occurrences,
  and 98 duplicate terms across both corpora.
- Remaining mismatch groups: 0.

The differential compares definition and use ranges after exact UTF-16 to
Unicode-scalar conversion, term order, paragraph deduplication, singular/plural
uses, asymmetric whole-word boundaries, defining-paragraph exclusion, and
source IDs. Owner-node ID propagation is covered by the focused Rust check
because the legacy detector has no owner-node output. The old instrument freeze
is also retained as the 872-document term-count ratchet. Raw diagnostics remain
in `.tmp/defined-terms-parity/`.

Run after building the small Rust runner:

```powershell
cargo build --offline --manifest-path legal-pdf-parser\experiments\defined-terms-parity\Cargo.toml
.\backend\node_modules\.bin\tsx.cmd experiments\defined_terms_parity\gate.ts
```
