# Claude working notes for Beaver

Read `AGENTS.md` (same directory) — it is the source of truth for agent
etiquette here, including the session-learned working notes.

The five rules that prevent the most damage:

1. Pathspec-only staging; never `git add -A`. Concurrent sessions share
   this tree. Commit as you go; push only when asked.
2. Measure first: prove behavior with real runs/probes before changing
   it, and no deterministic-grammar change without a corpus/gold number.
3. No per-token API spend. Flat-rate surfaces only (codex CLI route,
   headless `claude -p`); the `backend/.env` Anthropic key is a stub.
4. Check local data before the network: A2AJ bulk corpus at
   `%LOCALAPPDATA%\ALR Quote Verifier\a2aj_corpus`, gold in-repo under
   `benchmarks/legal-generalization-corpus/`. US case law is local too:
   CourtListener bulk sqlite (5.5 GB) under
   `%LOCALAPPDATA%\OpenLegalProducts\LegalData\providers\courtlistener\`
   via `courtlistenerLocalBulk.ts`.
5. Prefer typed refusals over best-effort guesses in deterministic
   tools; the model handles residual semantics over bounded excerpts,
   never whole documents.
