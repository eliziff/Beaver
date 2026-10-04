# Repositories and local checkout

Beaver owns the application and integration. [repositories.json](../../repositories.json)
records the independent owner checkouts. First-party repositories use `main`;
there are no consumer Git links, revision pins or required binding releases.

| Checkout | Owner and role |
| --- | --- |
| `AuthoritiesHelper` | Standalone Authorities deployment, launcher and packaging |
| `legal-structure` | Legal structure, bounded queries and provider adapters |
| `legal-pdf-parser` | PDF extraction, geometry, OCR and our vendored Firecrawl PDF Inspector patchset |
| `common-law-cite` | Citation grammar and bindings |
| `legal-browser-ocr` | Browser/HTML OCR application |
| `legal-pinpointer` | Legal-source aliases consumed directly by Authorities Lite |
| `mike-workflows` | Workflow definitions, schema and upstream integration |
| `OpenLegalData` | Shared data access; local source bundle, no public remote |

[Legal Pinpointer](https://github.com/eliziff/legal-pinpointer) also consumes
structure WASM and legal-source metadata. An existing checkout elsewhere can be
selected for Lite with `LEGAL_PINPOINTER_ROOT` instead of making another copy.

## Fresh checkout

```sh
git clone https://github.com/eliziff/Beaver.git
cd Beaver
python scripts/bootstrap-repositories.py
```

The bootstrap clones missing public repositories from `main` and restores
OpenLegalData from `subrepos/OpenLegalData.bundle` on `main`. Existing directories
are left untouched, including dirty working trees. Select only needed owners by
passing their names, for example `python scripts/bootstrap-repositories.py
legal-structure legal-pdf-parser common-law-cite`.

Then follow [application setup](../../README.md#run-locally). Native and OCR model
assets remain separate from source checkouts.

## Existing checkout and changes

Work and commit in the owning repository. Inspect its working tree before any
ordinary `git pull --ff-only`; bootstrap never pulls, resets or checks out over
existing work. No Beaver pin update is needed after publishing an owner change.
Release packaging happens only when explicitly requested.

PDF Inspector is third-party code with required local modifications, maintained
once in `legal-pdf-parser/vendor/pdf-inspector`. Its recorded upstream revision
supports explicit three-way updates; ordinary edits need no separate release or
pin bump. Follow the parser's `docs/pdf-inspector-agent-guide.md` for updates.

OpenLegalData has no remote: commit its source changes there and refresh its
source bundle with `git -C OpenLegalData bundle create ../subrepos/OpenLegalData.bundle main`.
The bundle carries source, not corpora, caches, models or credentials.

CI resolves owner `main` revisions once per run and passes that transient source
identity to native, backend and browser jobs. Those jobs test the same combination
without maintaining checked-in revision pins. Native cache keys hash actual
build inputs and the toolchain, so documentation-only owner commits reuse the addon.
