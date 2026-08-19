# Local subrepositories

Beaver pins three independent repositories as gitlinks. The public
`legal-pdf-parser` and `AuthoritiesHelper` repositories are ordinary Git
submodules. `OpenLegalData` has no public remote and remains recoverable from a
committed Git bundle.

## Fresh clone

Clone Beaver and initialize its public submodules:

```powershell
git clone --recurse-submodules https://github.com/eliziff/Beaver.git
Set-Location Beaver
```

Then restore the private-without-credentials OpenLegalData source checkout from
the local bundle:

```powershell
git clone .\subrepos\OpenLegalData.bundle .\OpenLegalData
```

For an existing checkout:

```powershell
git submodule sync -- legal-pdf-parser AuthoritiesHelper
git submodule update --init --recursive -- legal-pdf-parser AuthoritiesHelper
if (-not (Test-Path .\OpenLegalData\.git)) {
  git clone .\subrepos\OpenLegalData.bundle .\OpenLegalData
}
```

## Verify pinned commits

```powershell
git -C .\OpenLegalData rev-parse HEAD
git -C .\AuthoritiesHelper rev-parse HEAD
git -C .\legal-pdf-parser rev-parse HEAD
```

The values must match `subrepos.lock.json`. The OpenLegalData bundle contains
committed source history only; local corpora, databases, managed runtimes,
caches, and generated artifacts are excluded.

## Updating a public submodule

Commit and push the standalone repository first. Then stage its gitlink in
Beaver and update the corresponding `commit` in `subrepos.lock.json`. Do not
reintroduce a bundle for a repository that has a public remote.

OpenLegalData remains bundle-backed until it has an approved remote. After an
OpenLegalData source commit, regenerate only that bundle and update its lock:

```powershell
git -C .\OpenLegalData bundle create ..\subrepos\OpenLegalData.bundle --all
```
