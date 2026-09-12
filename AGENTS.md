# Beaver agent guide

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[master plan](docs/roadmap/master-plan.md). The former owns shared check commands;
the latter owns project priorities and remaining gates.

## Architecture and scope

- Preserve local and cloud/Supabase support, the modular monolith and the boundaries
  in `subrepos.lock.json`. Features use runtime/application operations and existing
  persistence ports, not deployment imports or local/cloud branches.
- Before adding code, trace existing primitives, data and all consumers. Refactors
  must fix the root problem and preserve capabilities, not current module boundaries.
  Replace obsolete designs outright; no transitions, compatibility or migration
  infrastructure unless explicitly requested.
- PDF Inspector is one automatically synchronized `pdf-inspector` branch in
  `legal-pdf-parser`. Pin a gated combination; never maintain a second fork copy.
- Put a requested new experimental feature in `experiments/`. An ordinary refactor
  must not delete, consolidate or work through experiments.

## Working safely

- This workspace maintains its own forks, not their upstream projects. Follow
  fork-owned validation and contribution instructions. Do not ask the user for
  upstream maintainers' private corpora, accounts or runners. Use and maintain
  the existing independent local/public gates; never fabricate baselines or
  suppress regressions to replace unavailable upstream infrastructure.
- Concurrent sessions can share a tree. Stage explicit paths, never `git add -A`;
  preserve unrelated work, commit coherent changes, and push only when requested.
- Check local data and existing implementations before fetching or adding a
  dependency. Consult official documentation for unfamiliar packages or standard
  engineering problems instead of probing blindly.
- No per-token API spend: use approved flat-rate surfaces. Never assume a checked-in
  example or placeholder credential authorizes live calls or private-document transmission.
- Exact deterministic operations return typed refusals instead of guesses. Models
  handle residual semantics over bounded excerpts, not whole-document dumps.

## Validation and interface quality

- Measure behavior before changing it. Native grammar/profile changes require the
  appropriate independent corpus/gold result, not a self-regenerated baseline.
- Iterate with affected-crate `cargo check` and focused behavior tests. Do not rebuild
  the workspace/addon/release binary or replay full corpora after each edit. Batch
  changes; run the narrow integration gate and then the required candidate gates.
- Test outcomes and durable contracts, not incidental copy, implementation presence
  or internal choreography. Use doubles only for expensive or hard-to-trigger edges.
- Remove redundant headings, explanations, badges, icons and nested UI chrome.
  Retain an element only for distinct information, a necessary action or real ambiguity.
- Assistant-dock changes, including menus/popovers/modals, require
  `scripts/mike.ps1 smoke -WithAssistantDock` and inspection of its screenshots.

Agents may run `.\scripts\full-sweep.ps1` only when the user includes the exact token
`[FullSweep]`. That battery includes release, browser and isolated live-model checks;
ordinary documentation or refactor work does not implicitly authorize it.

## Writing model prompts

Product requirements and design clarifications are instructions to the prompt
writer, not prose to copy into the target prompt. State the task directly and
include only what the model needs. Do not narrate internal architecture or list
unrelated responsibilities that another component already owns.
