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

`backend/scripts/consolidate_a2aj_sqlite.py <provider-directory>` is the maintenance
command for installed older split snapshots. It retains primary document IDs,
adds older-only records, uses newer source rows, preserves distinct records that
share citation identities, and checks the completed FTS index against its content.
It records snapshot metadata and counts beside the corpus. It deliberately leaves
the source files intact until consumers and the live handoff have been verified.

To refresh from complete case and law snapshots, use the configured Python
environment that already provides `legal_citations` (and `pyarrow` for Parquet):

```powershell
$dataRoot = if ($env:OPEN_LEGAL_DATA_HOME) { $env:OPEN_LEGAL_DATA_HOME } else { Join-Path $env:LOCALAPPDATA 'OpenLegalData' }
python backend/scripts/import_a2aj_bulk.py '<durable-case-snapshot-directory>' '<durable-law-snapshot-directory>' --fts --output (Join-Path $dataRoot 'providers\a2aj\a2aj.sqlite')
```

The importer builds `a2aj.sqlite.new` beside the live database, checks an actual
FTS citation match for each document type, runs SQLite `quick_check`, refuses empty snapshots, closes its
writer, then atomically replaces the live file. Keep enough disk space for both
snapshots while importing. Supply the complete corpus: this command replaces it.

Provider operations open and close readonly connections per query, so subsequent
queries read the replacement without restarting the service. On Windows, the
replacement retries every 100 ms for at most two seconds if an in-flight reader
holds the old file. If that handoff fails, the old snapshot remains live and the
validated `.new` remains beside it; retry the rename when readers have finished.
Use the preserved candidate without importing again:

```powershell
python -c "import os,sys; os.replace(sys.argv[1]+'.new',sys.argv[1])" (Join-Path $dataRoot 'providers\a2aj\a2aj.sqlite')
```

Do not delete an active SQLite WAL or SHM file. Keep raw upstream revisions and
regeneration instructions in durable storage, not scratch directories.
