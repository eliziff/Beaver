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

Remaining: all other accepted scope, whole-range reconciliation, local/cloud
integration, configured real-host Word/SSO checks, native independent-gold gates,
full application suites/builds, fresh-checkout proof and assistant-dock smoke
with screenshot inspection. Backend build artifacts needed by the existing
experiment boundary check have been built successfully.
No full sweep without `[FullSweep]`; metered model tests require authorization.
