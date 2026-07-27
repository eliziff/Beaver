# Beaver

Beaver is a local-first legal workspace for research, document review,
drafting, and tables of authorities. Account-free mode stores files and chats
on disk; Supabase and cloud storage remain optional.

The checkout includes the Beaver web app, a shared legal-data layer, the
universal legal-PDF engine, and the standalone/embedded Table of Authorities
Maker.

## Requirements

- Windows PowerShell
- Node.js 22.13+
- Python 3.11+
- npm
- A signed-in Codex CLI or one supported model-provider API key
- Optional: LibreOffice for Office-to-PDF conversion

## Install

If `OpenLegalData`, `TableOfAuthoritiesMaker`, or
`universal-legal-pdf-engine` is empty, restore it using
[the bundled-subrepository instructions](docs/local-subrepositories.md).

```powershell
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.local.example frontend\.env.local
npm ci
npm ci --prefix backend
npm ci --prefix frontend
python -m venv universal-legal-pdf-engine\.venv
.\universal-legal-pdf-engine\.venv\Scripts\python -m pip install -e .\universal-legal-pdf-engine
```

Keep `AUTH_MODE=anonymous` and `NEXT_PUBLIC_AUTH_MODE=anonymous` for local use.
Replace `DOWNLOAD_SIGNING_SECRET` in `backend\.env`; add only the provider keys
you use. A2AJ lookup and local Library storage do not require cloud accounts.

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

For development, run `npm run dev --prefix backend` and
`npm run dev --prefix frontend` in separate terminals.

Local databases, caches, and Library data default to
`%LOCALAPPDATA%\OpenLegalProducts\LegalData`. Override that root with
`OPEN_LEGAL_DATA_HOME`.

## Documentation

- [Documentation index](docs/README.md)
- [Local subrepositories](docs/local-subrepositories.md)

## License

AGPL-3.0-only.
