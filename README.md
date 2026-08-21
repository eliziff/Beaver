# Beaver

Beaver is a local-first legal research, document review, drafting, and
authorities workspace, geared primarily toward Canadian law.
Forked from Mike. This is a hobby project. I am not a software engineer.
This project has bugs and jank and changes frequently, it
makes no attempt to be a stable product.
Making it available in case anyone wants
to experiment with it or borrow parts of it. 

## What Beaver adds

### A legal assistant that can use a Codex subscription

Beaver can run through a locally authenticated Codex CLI session. Run
`codex login`, choose **Sign in with ChatGPT**, and Beaver can use the Codex
access included with the selected ChatGPT workspace; this path does not require
copying an `OPENAI_API_KEY` into Beaver. OpenAI documents ChatGPT sign-in as the
subscription-access path and API-key sign-in as the separately billed,
usage-based path in its [Codex authentication guide](https://developers.openai.com/codex/auth).

Beaver keeps the Codex process local, maintains resumable threads, and exposes
only Beaver's authorized tool registry through a narrow MCP bridge. Model and
reasoning-effort controls remain visible in the UI. OpenAI, Claude, Gemini,
DeepSeek, OpenRouter, and local Ollama-style endpoints can instead be selected
through the same turn, event, evidence, and tool contracts when configured.

### One legal-source plane, not a set of one-off integrations

Legal sources enter Beaver through one small provider contract: `search`,
`resolve`, and `readPassage`. Current adapters cover A2AJ data,
CourtListener, The National Archives Find Case Law, GOV.UK Employment Tribunal,
and GovInfo. The registry preserves each provider's
native identifiers and structure while presenting one bounded search and exact
passage interface to the Library, HTTP API, assistant, and authorities tools.

Provider-native paragraphs, sections, pages, footnotes, and anchors are kept
when available. Where a source lacks that structure, a provider compiler
derives a `SourceDoc` rather than flattening the source into undifferentiated
text. Selected and contextual blocks receive stable hashes, source revisions,
and evidence receipts; safe link builders—not the language model—construct
pinpoint and text-fragment URLs. This lets a chat citation be rehydrated and
verified against the exact source unit that supported it.

### A standalone native legal-PDF parser

[legal-pdf-parser](https://github.com/eliziff/legal-pdf-parser) is Beaver's
standalone Rust parser for legal PDFs. It extracts stable pages, words, lines,
paragraphs, semantic sections, footnotes, references, and propositions without
a server or cloud dependency. Its public contract prepares a content-addressed
cache and supports exact page, paragraph, section, and footnote lookup.

The parser attempts native extraction first, records diagnostics and text
quality, and routes only weak pages to configured OCR. Ordinary digital-born
PDFs therefore avoid OCR and network work. For scanned legal material, Beaver
can use the custom Kraken Lite native/browser runtime and a legal-domain
fine-tune of **CATMuS Print Small** through ONNX Runtime; Tesseract supplies the
lightweight layout lane. Only pages selected by the quality router enter that
OCR path. The parser cache is the only stored parse representation; Beaver
keeps compact job and evidence records, validates evidence hashes on read, and
can prepare uploaded PDFs as durable background work. Remote vision is never a
silent fallback; optional local layout analysis remains a separately selected,
bounded provider.

### Reviewable tables and books of authorities

[AuthoritiesHelper](https://github.com/eliziff/AuthoritiesHelper) supplies the
single Authorities engine and workspace used both inside Beaver and in its
standalone launcher. Beaver hosts the workspace itself and talks to the Python
handlers through a private process channel rather than launching another web
server. It deterministically finds citation occurrences in DOCX or PDF input,
lets the user correct authority and pinpoint spans, resolves sources through
shared legal data, and builds reviewable tables or tabbed books of authorities.
Scanned authorities retain their original page images; OCR and passage marking
are explicit, reviewable choices.

The parser and Authorities application consume the same versioned legal
grammar corpus as Beaver. The corpus is checked for schema, vector, manifest,
and bundled-copy drift so citation grammar is not independently reimplemented
in three places.

### Deterministic document work

Beaver reads PDF, DOCX, XLSX, PPTX, text, and provider-native resources through
one resource grammar. Common DOCX edits use a compact deterministic operation;
specialist tracked-change and OOXML editing remains available when exact run,
style, numbering, or revision properties matter. Generation and editing return
typed document events, and version writes use the same authorization and
compare-and-swap rules in local and cloud deployments.

## Architecture

Beaver is a modular monolith:

- a Vite/React desktop-oriented web client;
- an Express/TypeScript application and assistant runtime;
- one relational repository contract implemented by SQLite locally and
  Postgres/Supabase in cloud deployments;
- immutable document bytes in the local filesystem or object storage;
- standalone process boundaries for `legal-pdf-parser`, Codex, and the
  Authorities application; and
- `OpenLegalData` read-only indexes for bulk legal corpora.

Local and cloud are composition choices, not separate products. Routes,
application rules, assistant tools, DTOs, and UI behavior are shared. Cloud
adapters add identity, storage, and deployment primitives; local mode supplies
the same ports without requiring an account or cloud service.

## Requirements

- Windows PowerShell
- Node.js 22.13+
- Python 3.11+
- npm and Rust/Cargo
- either a signed-in Codex CLI or one configured model-provider credential
- optional LibreOffice for Office-to-PDF conversion
- optional local OCR dependencies for scanned PDFs

## Clone and install

Clone the two public submodules with Beaver:

```powershell
git clone --recurse-submodules https://github.com/eliziff/Beaver.git
Set-Location Beaver
```

`OpenLegalData` is not public and remains recoverable from the committed local
bundle; see [Local subrepositories](docs/current/local-subrepositories.md).

```powershell
Copy-Item backend\.env.example backend\.env
npm ci
npm ci --prefix backend
npm ci --prefix frontend
cargo build --manifest-path legal-pdf-parser\Cargo.toml --release --locked `
  --features full,fast-allocator
python -m venv AuthoritiesHelper\.venv
.\AuthoritiesHelper\.venv\Scripts\python -m pip install `
  -r AuthoritiesHelper\requirements.lock.txt
```

For Codex subscription access:

```powershell
codex login
codex login status
```

Keep `AUTH_MODE=local` for account-free use. Replace
`DOWNLOAD_SIGNING_SECRET` in `backend\.env` and add only provider credentials
you actually use. A2AJ lookup, the local Library, deterministic PDF parsing,
and local document operations do not require a cloud account.

## Build and run

```powershell
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 doctor -WithTableOfAuthorities
.\scripts\mike.ps1 start -WithTableOfAuthorities
.\scripts\mike.ps1 smoke -WithTableOfAuthorities
```

Open <http://127.0.0.1:3000>. Stop only launcher-owned processes with:

```powershell
.\scripts\mike.ps1 stop
```

Local databases, caches, document bytes, and Library state default to
`%LOCALAPPDATA%\OpenLegalProducts\LegalData`. Override that root with
`OPEN_LEGAL_DATA_HOME`.

## Verification

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 smoke -WithTableOfAuthorities
```

High-fidelity parser, SourceDoc, DOCX, and authorities changes have additional
corpus or byte-identity gates documented beside those subsystems.

## Documentation

- [Documentation index](docs/README.md)
- [Current architecture](docs/current/architecture.md)
- [Background jobs](docs/current/background-jobs.md)
- [Master plan](docs/roadmap/master-plan.md)
- [Architecture and contraction roadmap](docs/roadmap/contraction.md)
- [Local subrepositories](docs/current/local-subrepositories.md)

## Licenses

Beaver is AGPL-3.0-only. The two standalone repositories carry their own
licenses and notices.
