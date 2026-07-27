# Pinpoint retrieval and vector embeddings

Status: implemented lexical baseline; vector index deferred pending an
equivalence benchmark.

## Decision

Mike uses two distinct planes:

1. **Candidate discovery** may use provider search, SQLite FTS5/BM25, or a
   future embedding index. Its output is only a small set of stable provider
   identifiers.
2. **Authoritative lookup** reopens the provider record by its exact identifier
   and resolves a page, paragraph, section, subsection, subparagraph, or
   footnote from provider-native or deterministically reconstructed structure.
   Only this text can support an answer or a link.

A retrieval score never becomes a locator, quoted passage, or URL. Stable
provider IDs and locator IDs cross the boundary between the two planes.

This is consistent with the legal-RAG evidence. LegalBench-RAG recommends small,
highly relevant passages instead of whole documents or merely document IDs
([arXiv:2408.10343](https://arxiv.org/abs/2408.10343)). Legal RAG Bench finds
retrieval to be the main performance ceiling
([arXiv:2603.01710](https://arxiv.org/abs/2603.01710)), while CanLegalRAGBench
shows that retrieval design remains highly consequential and that retrieved
documents still fail to support a material share of generated claims
([arXiv:2605.30497](https://arxiv.org/abs/2605.30497)). The practical
consequence is simple: search finds candidates; exact provider text proves the
answer.

## Implemented provider contract

| Provider | Candidate ID | Authoritative lookup | Final link |
| --- | --- | --- | --- |
| A2AJ | dataset/citation result | read-only local A2AJ snapshot first, public API fallback; exact citation plus reconstructed or native paragraph/page/section structure | provider-native paragraph, section, or PDF page anchor where supported; otherwise a verified text fragment |
| CourtListener | cluster and opinion IDs | local bulk snapshot/API/R2 paths; exact cluster/opinion fetch followed by case-structure lookup | native opinion anchor when unambiguous; otherwise a verified text fragment |
| Open Access Journals `public_endpoint.db` | `journal:<article_id>` | read-only article row plus indexed `article_pages`; page/section/paragraph/footnote blocks have stable IDs such as `journal:2:page:page9` | mapped PDF page plus one or more verified text directives |
| TNA, GOV.UK ET, GovInfo | provider result identifier | exact provider fetch and provider-specific structure | native pinpoint where supplied, verified text fragment otherwise |

The model-facing journal search tool returns compact metadata and
`article_id`/`hit_id`, but no URL. Fetch or lookup is the required next action.
The server retains the source URL and exact block privately. At citation
finalization it:

1. verifies every quoted span against the returned block and document;
2. selects a provider-native anchor or mapped PDF page when available;
3. emits a single URL containing multiple `text=` directives when a citation
   uses multiple passages from the same block.

This already provides the useful semantics of a separate
`make_fragment(hit_id, spans)` tool without spending another model round trip
or exposing URL construction to the model. Add such a tool only if measured
token usage shows that a short opaque fragment ID is cheaper than the existing
final citation payload.

Library journal entries are lightweight pointers (`provider`, `source_id`,
document type), not copied article payloads. Viewer responses are resolved from
the shared provider database and use deterministic ETags. Existing cloud,
Supabase, and R2 paths remain intact; local mode adds a preferred local source,
not a cloud-incompatible fork.

## Journal FTS5 sidecar

The source database remains read-only. The optional search sidecar is:

`%LOCALAPPDATA%\OpenLegalProducts\LegalData\providers\journals\public_endpoint-search.sqlite`

`OPEN_LEGAL_DATA_HOME` and `MIKE_PUBLIC_ENDPOINT_FTS_DB` can override the
shared root and file. Build it with:

```powershell
cd backend
npm run build:journals-fts
```

The builder uses only Python's standard library, builds beside the live file,
optimizes it, and atomically replaces the completed sidecar. FTS5 is
contentless: `article_search(metadata, body, content='')`, with the numeric
`article_id` stored as `rowid`. This retains the inverted index without storing
a second copy of every article body. BM25 weights metadata `4.0` and body
`1.0`; SQLite documents both BM25 column weighting and contentless tables in
the [FTS5 reference](https://www.sqlite.org/fts5.html).

The runtime accepts sidecar schema version 2 only and validates:

- resolved source path;
- source byte size and millisecond modification time;
- source export schema version and export creation time;
- sidecar schema version.

It rechecks the configured source path, size, and modification time even when
the sidecar connection is cached. If the source changes, the cached sidecar is
closed and ignored until rebuilt; exact provider lookup continues to work, and
metadata search is the safe fallback. The source snapshot is never written.

## Measured baseline

Measured 2026-07-26 on the development Windows machine against the real
`public_endpoint.db`: 18,958 article rows, 18,595 articles with indexable text,
and 404,506 article-page rows. Figures are warm-cache medians/p95s. Exact and
FTS queries used 300 iterations; the slower metadata scan used 40.

| Operation | Median | p95 |
| --- | ---: | ---: |
| Exact article by `article_id` | 0.168 ms | 0.247 ms |
| Exact `(article_id, page_label)` lookup | 0.019 ms | 0.026 ms |
| Metadata `LIKE` fallback | 66.613 ms | 70.870 ms |
| Weighted FTS metadata query | 0.456 ms | 0.740 ms |
| Weighted FTS body query | 0.504 ms | 0.810 ms |

The body query `consumers AND fetal AND alcohol` ranked article 2, the known
ground-truth article, first. The original full-content FTS sidecar was
1,687,199,744 bytes. The contentless sidecar is 487,321,600 bytes, a 71.1%
reduction (1,199,878,144 bytes) with no loss of candidate search behavior. Its
one-time build took 84.696 seconds. This is a strict runtime and storage win,
so SQLite FTS5 is the shipped lexical baseline.

## Vector boundary and benchmark gate

Do not add TurboVec merely because vector search is available. First create a
versioned legal retrieval set containing:

- exact citations and known provider IDs;
- case names and journal titles;
- paraphrased propositions;
- ambiguous legal terms;
- paragraph, page, section, subsection, subparagraph, and footnote targets;
- negatives where no source supports the proposition.

Measure candidate Recall@5/10, exact locator accuracy, quote-verification
success, final-link correctness, warm/cold latency, index size, build time, and
unsupported-claim rate. Compare:

1. exact citation/title routing plus SQLite FTS5;
2. embeddings alone;
3. lexical candidates plus dense reranking;
4. reciprocal-rank or weighted hybrid retrieval.

OpenAI's retrieval guidance exposes separate embedding and sparse-text weights
for hybrid ranking
([official retrieval ranking documentation](https://developers.openai.com/api/docs/guides/retrieval#ranking)).
That is a useful evaluation pattern, not a reason to make remote retrieval
authoritative.

TurboVec becomes justified only if it materially improves held-out recall for
paraphrased or concept queries without regressing exact-citation/locator
results, link correctness, weak-hardware latency, or storage enough to erase
the benefit. If it passes:

- keep FTS and exact routing as the first-stage candidate generator;
- assign every chunk a stable provider/document/block ID;
- map that ID to TurboVec's external `uint64` ID through a small SQLite table;
- use TurboVec's ID allowlist to rerank only lexical/provider candidates;
- keep final fetch, locator resolution, quote verification, and URL generation
  in the authoritative provider layer.

TurboVec documents persistent indexes, stable external IDs through
`IdMapIndex`, and search-time allowlists
([project README](https://github.com/RyanCodrai/turbovec)). A vector sidecar
must record the provider snapshot identity, embedding model and dimensions,
chunker version, normalization rules, and TurboVec format version. Any mismatch
invalidates the sidecar; it never silently reuses vectors against a different
provider snapshot.

The acceptance rule is deliberately asymmetric: embeddings must prove a
meaningful recall gain; SQLite FTS5 does not have to prove that vectors are
useless.
