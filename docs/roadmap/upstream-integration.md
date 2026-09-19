# Upstream integration

Target: Mike `7b42ea645ef52bccf66538b314bd7239eded2532`, compared from
`416b32b17fc33c7e65044677db5c3a2ad29fb592`. Delivery is one integration branch
and combined review/release. Do not treat an implemented slice as a completed
catch-up. Current user changes are preserved in the original checkout.

## Accepted scope

1. Security, dependency/CI updates and application-policy consolidation.
2. Organization membership, role-aware grants/deny, corrected access across
   search/context/exports/jobs, progressive SSO and connector improvements.
3. AI SDK for ordinary API providers; retain specialized session transports.
   Adopt configured models, credential overrides and assistant execution fixes.
4. Explicitly installable pinned workflow catalogue revisions, offline snapshot,
   validated assets, durable upload sessions and folder/tabular improvements.
5. Opt-in app/project memory with asynchronous curation. Pause retains content;
   delete fences pending work. Private context never crosses a shared boundary.
6. Word continuation/approval, document attribution/download/export, PDF form/
   layout/highlight corrections and workspace behavior. Keep Beaver's appearance;
   adopt dark mode and accessibility, not upstream glass styling.

All work uses existing application/storage/persistence owners. Supabase/S3
coupling upstream is an adaptation task, not a feature exclusion. Update the
existing workflow policy when independently installable revisions are complete.
No migrations, compatibility framework, second queue or experiment cleanup.

## Validation and current position

Implemented so far: MCP GET/HEAD redirects with per-hop DNS checks, pinned
connections and cross-origin credential stripping; progressive SSO with
trusted callbacks and visible provider outages; three-lockfile dependency audit
with fail-closed npm/OSV fallback and no inherited advisory exceptions.

Focused results: network/OAuth 29 tests, SSO route 4, login forms 3, audit gate 9.
All three lockfile audits passed; the frontend exercised the OSV fallback after
npm returned HTTP 503. Source-boundary, TypeScript-surface and grammar checks pass.
The independently installable catalogue, captured-turn reference reads and
variant ZIP/reference downloads are implemented. The public workflow replacement
pin and generated offline templates pass fresh-clone source validation. Unicode
generated filenames and acting-user tracked-change attribution are implemented.
These are focused results, not release certification.

Ordinary API providers now use AI SDK while subscription/local transports retain
their existing sessions. Focused wire tests cover signed reasoning, compaction,
image tool results, exact Gemini schemas, malformed completion and retries.
Encrypted personal keys override environment keys in both persistence engines;
removing an override restores the environment key. Saving requires the existing
`USER_API_KEYS_ENCRYPTION_SECRET` in local mode as well as cloud mode.
Configured OpenAI-compatible endpoints join the existing model catalogue, chat,
preferences and tabular selection. Local text-tool parsing is imported with its
focused tests, without upstream's tool-specific trademark call coalescing:
Beaver executes each validated requested operation without changing its arguments.

Organization membership, one-use invitations, viewer/editor/owner grants and
organization deny overrides now use the common relational persistence owner.
Projects govern descendant documents, reviews and chats; standalone chats can be
shared. Account exports run locally and in cloud, apply current access, omit
credentials and include a canonical payload checksum. Account deletion retains
organization content under a remaining admin and protects the last admin.
Focused organization/export/account and repository checks: 51 tests passed;
access-modal tests: 3 passed. PostgreSQL concurrency and browser checks remain.

Scoped memory now has opt-in app/project storage, a settings/project editor,
revision conflict protection, permission-scoped context and delayed curation on
the existing queue. Delete/pause/manual edits fence pending work. Provider
continuations bind their memory snapshot and audience, including project-bound
draft chats before their first turn. Nine memory/service/HTTP tests, four editor
tests and thirteen queue tests passed; the organization/repository checks passed
after correcting the draft fixture to create real drafts. The native addon's
release build passed with one low-priority worker, followed by all 31 chat
durability tests, including memory turn eligibility. Further builds and tests
use one worker. FullSweep remains pending.

Project manifests and account exports now share a canonical integrity envelope
with optional Ed25519 signing, a separately retrievable public key and an offline
verifier for manifests and supplied version files. Five integrity/CLI tests and
nine organization/export/HTTP tests pass. Browser download validation remains.

Remaining: all other accepted scope, whole-range reconciliation, local/cloud
integration, configured real-host Word/SSO checks, native independent-gold gates,
full application suites/builds, fresh-checkout proof and assistant-dock smoke
with screenshot inspection. Backend build artifacts needed by the existing
experiment boundary check have been built successfully.
The user supplied `[FullSweep]` on September 19: run the full sweep against the
combined integration, including its isolated synthetic live-model checks.
