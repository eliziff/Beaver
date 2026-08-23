# Beaver agent guide

- Keep changes small, local-first, and consistent with `docs/roadmap/master-plan.md`.
- Preserve both account-free local mode and cloud/Supabase support.
- Beaver has no users. Unless the user specifically requests it, replace old designs outright; do not add transition states, backward compatibility, or migration infrastructure.
- Before building a feature, canvass the repository for existing primitives and route the feature through them instead of reimplementing them.
- No half-measures in refactors. Preserve user-facing capabilities, not current module boundaries: decompose monoliths and fix root architectural problems even when multiple subsystems or consumers must change together.
- Treat corpus-scale legal ingestion and structure derivation as high-fidelity systems. Refactor them deliberately, and require corpus-scale output-fidelity checks unless the change inherently cannot affect their output.
- Reuse existing code and data before adding implementations, dependencies, or network fetches.
- When implementing an existing package, repository, runtime, or library becomes troublesome, or a task appears to be a standard software-engineering challenge, check the official documentation and established online best practices instead of probing blindly.
- Keep the modular monolith and respect boundaries in `subrepos.lock.json`.
- Route shared features through runtime/application operations and the existing
  persistence ports. Do not branch on local/cloud or import deployment adapters
  in feature code; `npm run check:source-boundaries` freezes that boundary.
- Long-running scripts must report progress and preserve usable partial results.
- Optimize the edit-feedback loop: short feedback loops are a known way to
  improve coding-agent results because they permit more validated iterations
  and less speculative work. For example, during Rust work, use `cargo check`
  on the affected crate and a crate-local focused test or benchmark; do not
  rebuild the workspace, native addon, or release binary after each edit. Batch
  changes, rebuild the narrow integration boundary at checkpoints, and reserve
  full release builds and corpus gates for a complete candidate. The same
  principle applies outside Rust to virtually all LLM coding work.
- Test behaviour and durable contracts, not incidental UI copy or implementation presence.
- Prefer the smallest test that proves a public outcome or resulting state. Use doubles only to control expensive or hard-to-trigger dependencies; delete tests that merely replay stubbed values or assert internal call choreography.
- Never commit credentials, AppData, downloaded corpora, caches, generated artifacts, or managed runtimes.
- Do not use metered APIs unless explicitly authorized.
- Never use the Codex in-app browser or its `browser-client`/Node connector for Beaver testing. Use ChromeDriver and/or screenshots.
- Keep experiments in `experiments/` or a package's `experiments/` directory.
  Experiments may import production; production and its tests must never import
  experiments. Keep experiment checks beside the experiment, raw output ignored,
  and durable findings in `RESULTS.md`. Promotion moves proven code and tests into
  production without a compatibility shim.

## GENERAL GUIDANCE FOR DRAFTING PROMPTS FOR LLMs

When writing or revising a model prompt, treat product requirements and the user's design clarifications as instructions for the prompt designer—not text to copy into the target model's prompt. Include only what the model needs to perform its task; express the intended task directly instead of narrating internal architecture or unrelated responsibilities.

Examples:

1. The user asks for a prompt that evaluates the legal accuracy of treatment characterizations; citation formatting and mechanical validation happen elsewhere.

   **Wrong:** “Assess legal accuracy, but ignore citation formatting, source locators, deterministic validation, opinion-boundary metadata, and internal identifiers.”

   **Correct:** “Assess whether each legal characterization accurately describes the cited decision's treatment.”

2. The user asks for a prompt that makes Beaver summarize a selected Library document; Beaver already exposes the same tool in local and cloud modes.

   **Wrong:** “Summarize the document. Do not branch between local and cloud storage or access SQLite/Supabase directly; Beaver's persistence ports handle that.”

   **Correct:** “Summarize the selected Library document, focusing on the passages relevant to the user's question.”

Release checks:

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 smoke -WithTableOfAuthorities
```
