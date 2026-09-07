# Repositories and local checkout

Beaver is the application and integration repository. [subrepos.lock.json](../../subrepos.lock.json)
records repository ownership and the local-bundle strategy;
[.gitmodules](../../.gitmodules) declares four public submodules. Public revisions
are pinned by Git links, not by the upstream branch name or newest README.

| Checkout / repository | Owner and role |
| --- | --- |
| [Beaver](https://github.com/eliziff/Beaver) | Application, UI, Node adapter, persistence and cross-project roadmap |
| `legal-structure` / [Legal Structure Parser](https://github.com/eliziff/legal-structure-parser) | Provider-neutral Rust structure, citations, queries, grammar and Python binding |
| `legal-pdf-parser` / [Legal PDF Parser](https://github.com/eliziff/legal-pdf-parser) | PDF extraction, geometry, OCR and PDF Inspector integration |
| `legal-browser-ocr` / [Legal Browser OCR](https://github.com/eliziff/legal-browser-ocr) | Browser/HTML OCR application and packaging |
| `mike-workflows` / [Mike Workflows](https://github.com/Open-Legal-Products/mike-workflows) | Upstream-owned workflow definitions and schema; Beaver consumes a pin |
| `OpenLegalData` | Local repository restored from the tracked bundle; no public remote is declared |

Related repositories, **not Beaver submodules**:
[AuthoritiesHelper](https://github.com/eliziff/AuthoritiesHelper) is the Python
reference application; current Authorities runs in Beaver's TypeScript core.
[Legal Pinpointer](https://github.com/eliziff/legal-pinpointer) consumes packaged
structure WASM and legal-source metadata. Archived repositories preserve history,
not another active product or backlog.

## Fresh checkout

Do not use an unqualified `--recurse-submodules`: `OpenLegalData` is a Git link
without a `.gitmodules` URL. Initialize the four public paths explicitly, then
restore the bundled repository. From PowerShell:

```powershell
git clone https://github.com/eliziff/Beaver.git
cd Beaver
git submodule update --init --recursive -- legal-structure legal-pdf-parser legal-browser-ocr mike-workflows
git clone .\subrepos\OpenLegalData.bundle .\OpenLegalData
$lock = Get-Content .\subrepos.lock.json -Raw | ConvertFrom-Json
git -C OpenLegalData checkout --detach $lock.repositories.OpenLegalData.commit
```

Then follow the [application setup](../../README.md#run-locally). The native Node
addon is built inside Beaver; standalone parser/browser guides own their separate
executables and model/runtime packages.

## Existing checkout and changes

Inspect each working tree before updating; never reset or overwrite another
session's work. For the public paths:

```sh
git submodule sync -- legal-structure legal-pdf-parser legal-browser-ocr mike-workflows
git submodule update --init --recursive -- legal-structure legal-pdf-parser legal-browser-ocr mike-workflows
```

For an existing OpenLegalData checkout, fetch the current bundle from its absolute
path if it does not already contain the locked commit, then check out that exact
commit after preserving local work. Do not clone over an existing checkout.
Verify its HEAD against both `repositories.OpenLegalData.commit` and Beaver's
`git ls-tree HEAD OpenLegalData` entry.

Publish standalone changes in the owning repository first. Advance consumer pins
only intentionally, preserving exact structure/parser/Inspector/native identities
and their required gates. A local Cargo path override is not proof of a published
pin. Documentation updates alone do not justify incorporating unrelated newer
runtime code.

OpenLegalData has no configured remote: source changes must be committed in that
repository and carried by an updated bundle, Git link and lock entry together.
Verify that a fresh bundle clone contains the locked commit. A prose guide or
copied README is not a replacement for that source repository. Bundles contain
source, not private corpora, indexes, caches, model packs or credentials.

Upstream `mike-workflows` changes follow that project's contribution/validation
rules. Beaver's integration notes must not claim that an upstream proposal has
been accepted or that the pinned catalogue automatically tracks its branch.
