# Research sets

Status: implemented

Research sets replace flat saved sources with a lightweight, movable WorkProduct.
They use the existing owner/project, revision, duplicate, move, delete, SQLite,
and Supabase paths.

Each set stores only:

- nested labels;
- canonical source references with labels and one Markdown note;
- existing verified legal-evidence receipts with labels and one Markdown note;
- existing query receipts plus their complete evidence-ID ledger;
- one Markdown memo; and
- a compact human/model audit list with chat provenance when applicable.

Source bodies remain with their provider. Human passage selections are verified
against canonical source text before Beaver creates an evidence receipt. Chat
sources and receipts remain chat-bound until promoted, optionally with query
receipts. Personal sets can be supplied to later personal chats; project sets
remain scoped to that project.

Labels are the stored ontology; circle views, ancestor filters, source counts,
and query subsets are computed. This keeps the useful CanLII Rememberer
interaction and follows Obsidian's separation of atomic
[properties](https://help.obsidian.md/properties), nested
[tags](https://help.obsidian.md/tags), stable
[links](https://help.obsidian.md/links), and computed
[views](https://help.obsidian.md/bases).

`Memo.md` is deliberately not another document system. It is one Markdown string
on the set. Export adds only the set reference, so another model can reopen the
same receipts without copying or reparsing the underlying cases.
