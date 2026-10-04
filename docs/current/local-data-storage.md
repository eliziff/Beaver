# Local data storage

`OPEN_LEGAL_DATA_HOME` overrides the shared data root. Defaults are
`%LOCALAPPDATA%\OpenLegalData` on Windows,
`~/Library/Application Support/OpenLegalData` on macOS, and
`$XDG_DATA_HOME/OpenLegalData` (or `~/.local/share/OpenLegalData`) on Linux.

Provider databases live in `providers/<provider>/`, reproducible caches in
`cache/<provider>/`, and application state in `apps/<application>/`. Corpora,
independent gold, histories and recovery backups remain durable data; a shared
parent directory does not make these disposable.

A2AJ cases and laws share `providers/a2aj/a2aj.sqlite`. Its `document` table is
the authoritative content store; `document_search` is an external-content FTS5
index referencing that table. Exact citation lookup and full-text search use the
same document IDs and snapshot. Case/law selection is a query filter.

`npm run a2aj --prefix backend` installs, updates and removes courts and jurisdictions in this
store from A2AJ's Hugging Face datasets (`backend/src/lib/a2ajInstall.ts`; no Python). Each court's
Parquet file is downloaded into `providers/a2aj/downloads/` (a stopped download resumes), checked
against its published SHA-256, read into the store in one transaction and deleted. The
`source_file` table records each court's file hash and dataset revision, so `-- --update` fetches
only courts whose file changed. A document keeps its ID across updates and is rewritten only when
its content changed. `-- --update` also remakes the citation lookup keys when the citation engine's
key version changed (`meta.citation_key_version`); lookups find nothing through keys of another
version.

Readers open and close readonly connections per query and the store is in WAL mode, so an install
can run while Beaver serves lookups. An install ends by checkpointing the log, which lets a browser
page read the file without SQLite's shared memory.

Do not delete an active SQLite WAL or SHM file. Keep raw upstream revisions and
regeneration instructions in durable storage, not scratch directories.
