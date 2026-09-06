# Beaver agent guide

- Keep changes small, local-first, and consistent with `docs/roadmap/master-plan.md`.
- Preserve both account-free local mode and cloud/Supabase support.
- Beaver has no users. Unless the user specifically requests it, replace old designs outright; do not add transition states, backward compatibility, or migration infrastructure.
- Before building a feature, canvass the repository for existing primitives and route the feature through them instead of reimplementing them.
- No half-measures in refactors. Preserve user-facing capabilities, not current module boundaries: decompose monoliths and fix root architectural problems even when multiple subsystems or consumers must change together.
- Reuse existing code and data before adding implementations, dependencies, or network fetches.
- When implementing an existing package, repository, runtime, or library becomes troublesome, or a task appears to be a standard software-engineering challenge, check the official documentation and established online best practices instead of probing blindly.
- Keep the modular monolith and respect boundaries in `subrepos.lock.json`.
- Treat PDF Inspector as one automatically synchronized `pdf-inspector` branch in `legal-pdf-parser`: pin Beaver to a gated commit and never create or hand-maintain a second fork copy.
- Route shared features through runtime/application operations and the existing
  persistence ports. Do not branch on local/cloud or import deployment adapters
  in feature code; `npm run check:source-boundaries` freezes that boundary.
- Optimize the edit-feedback loop: short feedback loops are a known way to
  improve coding-agent results because they permit more validated iterations
  and less speculative work. For example, during Rust work, use `cargo check`
  on the affected crate and a crate-local focused test or benchmark; do not
  rebuild the workspace, native addon, or release binary after each edit. Batch
  changes, rebuild the narrow integration boundary at checkpoints, and reserve
  full release builds and corpus gates for a complete candidate. The same
  principle applies outside Rust to virtually all LLM coding work.
- Test behaviour and durable contracts, not incidental UI copy or implementation presence.
- Actively eliminate the recurrent LLM UI slop of compulsive over-labelling and redundant explanation: design the whole visible interface rather than making every component explain itself independently, and remove headings, descriptions, helper text, badges, icons, and nested containers that restate or decorate what context already makes clear, retaining each element only when it adds distinct information, enables a necessary action, or resolves a real ambiguity.
- Prefer the smallest test that proves a public outcome or resulting state. Use doubles only to control expensive or hard-to-trigger dependencies; delete tests that merely replay stubbed values or assert internal call choreography.
- Changes touching the right-hand assistant dock, including its menus, popovers, or modals, must run `scripts/mike.ps1 smoke -WithAssistantDock` and visually inspect the resulting screenshots.
- When the user requests a new experimental feature, put it in the `experiments/` folder.
- When the user requests a refactor, do not propose deleting, consolidating, or working through the `experiments/` folder.

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
.\scripts\mike.ps1 smoke
```

AI agents must run `.\scripts\full-sweep.ps1` only when the user includes the exact token `[FullSweep].
That battery runs the release checks, launcher-owned production browser smoke, and isolated live `codex:gpt-5.6-luna` low-effort tool-loop tests.
