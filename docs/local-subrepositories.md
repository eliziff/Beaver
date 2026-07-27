# Local subrepositories

Mike-Canada currently records `OpenLegalData`, `TableOfAuthoritiesMaker`, and
`universal-legal-pdf-engine` as local gitlinks. They have independent histories
but no configured remotes. To keep a root checkout self-contained, exact Git
bundles are committed under `subrepos/`; `subrepos.lock.json` records the
expected commit for each checkout.

After cloning the root repository, populate each empty gitlink directory:

```powershell
git clone .\subrepos\OpenLegalData.bundle .\OpenLegalData
git clone .\subrepos\TableOfAuthoritiesMaker.bundle .\TableOfAuthoritiesMaker
git clone .\subrepos\universal-legal-pdf-engine.bundle .\universal-legal-pdf-engine
```

Verify the restored commits:

```powershell
git -C .\OpenLegalData rev-parse HEAD
git -C .\TableOfAuthoritiesMaker rev-parse HEAD
git -C .\universal-legal-pdf-engine rev-parse HEAD
```

The three values must equal the corresponding `commit` values in
`subrepos.lock.json`. The bundles contain committed Git history only; local
corpora, managed runtimes, caches, and ignored artifacts are not included.

After committing a nested repository, regenerate its bundle and update the
lock before committing the root:

```powershell
git -C .\OpenLegalData bundle create ..\subrepos\OpenLegalData.bundle --all
git -C .\TableOfAuthoritiesMaker bundle create ..\subrepos\TableOfAuthoritiesMaker.bundle --all
git -C .\universal-legal-pdf-engine bundle create ..\subrepos\universal-legal-pdf-engine.bundle --all
```
