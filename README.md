# Beaver

A local-first application for Canadian legal research, document review, drafting,
and court materials, forked from [Mike](https://github.com/Open-Legal-Products/mike).
Beaver is experimental software, not a filing-readiness or legal-accuracy guarantee.
Review sources, quotations and generated documents before relying on them.

## What is here

The application combines an assistant, a versioned Library, saved research with
labels/highlights and an optional memo, tabular review, document operations, and
Authorities/Court Records workspaces. Authorities has embedded and standalone
hosts for the same TypeScript application and shared Rust operations; the older
Python AuthoritiesHelper is a reference, not Beaver's runtime.

React/Vite provides the UI and Express/TypeScript the application. Local mode uses
SQLite and local document storage; cloud mode retains PostgreSQL/Supabase and
object-storage adapters. Shared Rust components own legal structure and PDF work.
Deployment differences belong at those boundaries, not in duplicate features.

[Current behavior](docs/current/behavior-contracts.md) describes implemented
contracts. The [master plan](docs/roadmap/master-plan.md) identifies remaining work
and release evidence; a checked-in feature is not proof that every integration,
corpus or court-output gate has passed.

## Run locally

The launcher below is Windows/PowerShell. Install Node.js **22.13 or newer**, npm,
Python **3.11 or newer**, and the Rust toolchain. Restore the checkout using
[repository setup](docs/current/local-subrepositories.md) first: public submodules
and the bundled OpenLegalData repository use different initialization paths.

From the Beaver root:

```powershell
if (!(Test-Path backend\.env)) { Copy-Item backend\.env.example backend\.env }
npm ci
npm ci --prefix backend
npm ci --prefix frontend
cargo build --locked --release --manifest-path native/legal-structure-node/Cargo.toml
npm run build --prefix backend
npm run build --prefix frontend
```

Configure `backend/.env` from [the example](backend/.env.example): use
`AUTH_MODE=local`, replace placeholder signing/encryption secrets, and configure
only the providers and optional services needed. The native addon above is what
the launcher checks; building only the standalone `legalpdf` executable is not a
substitute. OCR/layout models and optional Office conversion need their separate
runtime assets; see the component guides in [repository setup](docs/current/local-subrepositories.md).

```powershell
.\scripts\mike.ps1 doctor
.\scripts\mike.ps1 start
.\scripts\mike.ps1 smoke
# Later:
.\scripts\mike.ps1 stop
```

The app opens at `http://127.0.0.1:3000`. The launcher stops only processes it owns.
Shared legal data defaults beneath
`%LOCALAPPDATA%\OpenLegalProducts\LegalData`; `OPEN_LEGAL_DATA_HOME` overrides it.
Do not put local stores, corpora, credentials or model packs in Git.

Local mode is a single-OS-user, loopback-only boundary—not a remotely exposed
server. Local storage does not make an external model local. Cloud deployment,
provider data handling and vulnerability reporting are covered by
[SECURITY.md](SECURITY.md).

## Develop

[Documentation](docs/README.md) is the project index.
[CONTRIBUTING.md](CONTRIBUTING.md) owns contribution and validation instructions;
[AGENTS.md](AGENTS.md) adds agent-specific safeguards. Standalone Authorities setup
is in [its current guide](docs/current/authorities.md).

## License

Beaver is [AGPL-3.0-only](LICENSE). Standalone repositories, upstream components,
model assets and legal data retain their own licenses and notices; Beaver's
license does not replace them.
