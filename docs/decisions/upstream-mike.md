# Mike upstream review ledger

Mike is an upstream product and idea source, not a branch Beaver merges.
`origin/main` is Mike; `eliziff/main` is Beaver.

Reviewed through: `1b58c7aa0520ff185c44698cea1a9e0c96af50ab`
(`2026-08-27`, Mike PR #383). Review recorded `2026-08-29`.

Rows citing paths describe the current Beaver working tree. Replace the path
with the Beaver commit when that adaptation is committed; a path is still
enough to prevent the same upstream behavior from being rediscovered and
reimplemented in the meantime.

## Rules

1. Fetch Mike and review first-parent changes after the cursor:

   ```powershell
   git fetch origin
   git log --first-parent --reverse --oneline <cursor>..origin/main
   ```

2. Add one row for every merged PR before advancing the cursor. The only
   dispositions are:
   - `have`: Beaver already provides the behavior; cite the Beaver commit or
     implementation path.
   - `todo`: Beaver wants the behavior but has not finished the adaptation.
   - `skip`: Beaver deliberately does not want it; give the reason.
3. Adapt behavior through Beaver's current operations and persistence ports.
   Do not preserve Mike module boundaries, deployment branches, migrations, or
   compatibility paths.
4. Add this trailer to every adaptation commit:

   ```text
   Upstream-Mike: #<PR> @ <merge-sha>
   ```

   Use `git cherry-pick -x` only for a small unchanged leaf patch.
5. Git computes literal commit differences. This ledger records semantic
   equivalence and decisions because patch IDs cannot recognize rewrites.

## Review from the saved 2026-08-11 snapshot

| Mike PR / merge | Status | Beaver evidence or decision |
| --- | --- | --- |
| #308 `26f4597b` pagination | have | Rewritten through the consolidated collection/runtime paths in `02aff487b`. |
| #271 `53cb54e8` audit history | have | Adapted in `42eaf66b6`. |
| #254 `9df42324` test-depth stretch | skip | Beaver tests its own public contracts and fidelity gates. |
| #293 `1af92310` schema drift | have | Adapted in `5f02e5f58`. |
| #317 `7ec5a865` Settings and local MFA | have | `userApplication.ts` owns shared profile/settings behavior; the HTTP edge retains auth/MFA and runtime injects the optional Supabase account capability. |
| #299 `7d5c0653` Word task pane | have | One Beaver Vite task pane uses the ordinary frontend and backend at `frontend/word.html`, `frontend/src/app/components/word/WordPage.tsx`, and `backend/src/lib/wordManifest.ts`; there is no second Word application. |
| #309 `3382734d` workflow refactor | have | Superseded by Beaver's existing workflow repository, optional collaboration adapter, cohesive HTTP/resource route, and pinned offline system catalog; no one-consumer application wrapper is needed. |
| #332 `867f735e` auth-user foreign keys | have | Fresh-schema ownership and cascade constraints are in `backend/schema.sql`; Beaver has no migration or compatibility layer. |
| #333 `e335bfab` case-insensitive sharing | have | Adapted in `31754a6fe`, hardened in `3fdf3ff5d`. |
| #334 `8c678e65` storage/auth hardening | have | Beaver's storage port and cached server client are stricter; current cache is in `3fdf3ff5d`. |
| #342 `d79c9a42` quick actions and directories | have | Web quick actions and nested directories exist; the Word directory projection belongs to #299. |
| #343 `a6ec1138` icon relocation | skip | Beaver uses its current Lucide/static-asset system; no second shared icon mirror. |
| #345 `c0ef3e3b` UI/source normalization | have | Superseded by Beaver's Vite UI and canonical source/document projections. |
| #348 `a2571b53` shared pill/edit-card controls | have | Beaver already routes these surfaces through shared UI primitives. |
| #350 `c83a2388` model routing, ask-input text, version panels | have | Provider-neutral LLM/tool contracts, open text input, and version-bound document panels exist; Vercel gateway is deliberately omitted. |
| #352 `83b5ce05` README simplification | skip | Documentation-only and Mike-specific. |
| #353 `64e2865a` model-router hardening | have | Beaver's model allowlist and provider loop fail closed on unsupported models and truncated streams. |
| #347 `7269447e` Word edit approval | todo | Replace the provisional text-as-locator edit with version/session-bound targets and inspect/preview/apply; emit native tracked changes by default. |
| #360 `5989c3a4` Word review flow | todo | Add Review/Direct modes and durable preview/change receipts through the shared document-operation contract, without a Word-only chat store. |
| #325 `31ee5da3` PRD template | skip | No demonstrated Beaver product need. |
| #362 `d97f3491` email confirmation and recovery | have | The one-origin cookie flow, confirmation, callback, forgot-password, and reset-password routes live in `backend/src/routes/auth.ts` and `frontend/src/app/components/account/AuthFlowPages.tsx`. |
| #357 `5b441de0` design-system refactor | skip | Preserve Beaver's current component primitives; do not import a visual rewrite. |
| #340 `2ae4ca79` OpenCode Go | have | `backend/src/lib/llm/openCodeGo.ts` is a small adapter over Beaver's existing provider wires; the live catalog is exposed by `backend/src/routes/models.ts` and unsupported models fail closed. |
| #328 `d8183be4` DOCX numeric text | have | Beaver-originated and upstreamed; current implementation is centralized in `3fdf3ff5d`. |
| #368 `a94ff4c3` Vercel AI SDK backend | skip | Conflicts with Beaver's provider-neutral native adapters. |
| #372 `e37aba03` safe public errors | have | Independently implemented and expanded in `3fdf3ff5d`. |
| #337 `8362692a` generated-letter numbering | have | Beaver's semantic heading/list renderer in `d1ed8f19c` supersedes it. |
| #365 `9d95ecbc` Google auth and onboarding | have | Google sign-in and the skippable profile flow use `backend/src/routes/auth.ts`, `backend/src/lib/userApplication.ts`, and `frontend/src/app/components/account/PersonalisationPage.tsx`. Local mode remains account-free; cloud uses the same authoritative profile contract. |
| #373 `e7c69fc3` folder upload and multi-select | have | `frontend/src/app/lib/beaverApi.ts` preserves uploaded directory paths and `frontend/src/app/components/documents/DocTable.tsx` provides folder upload and range selection through the shared Library/project surface. The Word host operates on Word's active document instead of inventing a second folder projection. |
| #374 `5ed80dd5` isolated/stoppable tabular generation | have | Tabular rows are ordinary durable agents in `backend/src/lib/tabular/agents.ts`, queued and cancelled through the shared `application_jobs` worker in `backend/src/lib/jobQueue.ts`; no tabular-only runtime was added. |
| #375 `78dbac19` UI consistency | have | Current Vite interface supersedes the Mike-specific cleanup. |
| #376 `a4126eab` database/runtime workflow catalog | skip | Beaver keeps the catalog pinned and available offline; no runtime GitHub download. |
| #335 `3ad9a5ff` dark mode | skip | Revisit as a Beaver-wide design decision, not an upstream transplant. |
| #377 `7411b1be` liquid-glass tiers | skip | Visual rewrite without product behavior. |
| #380 `54681b55` workflow/document review UX | have | Current workflow autosave, versioned document panels, and PDF task cancellation cover the useful behavior. |
| #366 `cbe6fa15` Word client tool loop | have | `backend/src/lib/chat/wordClientTools.ts` and the shared job/event transport forward bounded client work and return results through Beaver's existing turn ledger; the Office.js adapter is `frontend/src/app/lib/wordHost.ts`. The provisional exact-string edit contract is not the long-term document-operation contract (#347/#360 remain open). |
| #382 `83db3527` HttpOnly authentication | have | `backend/src/lib/authSession.ts`, `backend/src/middleware/trustedOrigin.ts`, and `backend/src/routes/auth.ts` keep Supabase tokens in one-origin HttpOnly cookies with trusted-origin checks; web and Word use the same backend session. |
| #379 `6a62d01a` empty model response | have | Independently implemented in `aa7acfa35`. |
| #383 `1b58c7aa` model/reasoning persistence | have | Normalized model and reasoning choices persist through `backend/src/lib/relationalUserPreferencesRepository.ts`, the chat repositories, and `frontend/src/app/hooks/useSelectedModel.ts`; chat, tabular, web, and Word consume the shared selection. |

## Remaining Mike-derived frontier

Only #347 and #360 remain `todo`. They are one piece of work, not two product
stacks: replace the provisional exact-string Word edit with Beaver's
version-bound inspect/preview/apply/review protocol, and have both the Library
package executor and live Office.js executor use it. The implementation plan is
[Document capabilities, legal actions, and portable features](../roadmap/document-capabilities.md).

Everything else reviewed through the cursor is `have` or deliberately `skip`.
Do not reopen a row merely because Beaver's implementation has different module
boundaries from Mike's.
