# Provenance

Vendored working tree of github.com/harveyai/harvey-labs, branch
`beaver/codex-route` (13 local integration commits over origin/main),
HEAD 01ce67e3c5dcc4b7935250db8e69778265b77c6d.

Deliberately partial: only the dev and validation tiers of the corpus
split (210 of 1,207 tasks) are present — assignments and per-task
SHA-256 hashes in `../lab/corpus-split.json`, policy in
`../lab/PROTOCOL.md` ("Corpus split"). The sealed tier exists only
upstream; restore via git and verify against the manifest before any
sealed evaluation. Git history was stripped at vendoring; the
integration commits are additionally preserved in
`<local-harness-root>/harvey-beaver-patches.bundle`. `results/` are
Beaver-side run artifacts, not upstream content. `.venv/` is local and
untracked — recreate with `python -m venv .venv` plus
`pip install anthropic openai`.
