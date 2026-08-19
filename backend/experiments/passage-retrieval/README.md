# Passage retrieval experiment

This is the complete opt-in A2AJ passage-index and reranking prototype. It is
not part of Beaver's production legal-source adapter. Production continues to
use the canonical provider search and exact provider/native passage reader.

From `backend/`:

```powershell
npx tsx experiments/passage-retrieval/build-passage-index.ts --db path/to/a2aj.sqlite
npx vitest run --config experiments/vitest.config.mts experiments/passage-retrieval
```

The builder writes a derived SQLite sidecar beside the source database. Do not
commit source corpora or sidecars. The experiment may import production legal
parsers; production must not import this directory.
