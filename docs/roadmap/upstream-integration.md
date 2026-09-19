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

## Upstream disposition

All 125 first-parent changes in the target range are accounted for below.
Adapted means the behavior is implemented through Beaver owners; it is not a claim
that every upstream diff was copied or every external environment is certified.

| Area / commits | Disposition |
| --- | --- |
| Security and authentication: `57bd8776a`, `961457c70`, `3775d534c`, `20c0ed267`, `8c678e65b`, `dd91a85ba`, `d8118dea8`, `9fd5aefea`, `d97f3491b`, `a2d093f80`, `ef06b2db7`, `83db35279` | Adapted: guarded network boundary, origin-bound OAuth, progressive SSO, existing session cookies and validated inputs. |
| Organizations and access: `a4d668c54`, `7b14ab324`, `e335bfabd`, `867f735e9`, `ba979eea2`, `b44cec754`, `4d1b792d6`, `a3ab1b389` | Adapted: resourceAccess, organizationApplication and relational owners; inherited roles, deny, invitations, exports and last-admin protection. |
| Models and assistant execution: `a94ff4c33`, `c83a23880`, `64e2865a1`, `2ae4ca793`, `aba3cfca9`, `1b58c7aa0`, `6a62d01ae`, `47d164709`, `4c90d034d`, `90472a304`, `e37aba03c`, `7b42ea645` | Adapted: AI SDK provider loop, configured models and encrypted overrides. Existing Read returns version-bound evidence; it has no upstream placeholder-content duplicate-read path. Stop/empty-response notices are explicit. |
| Catalogue and workflow documents: `e89d3230d`, `a4126eabe`, `3382734de`, `54681b550`, `fdd4ed194`, `afe163a3f` | Adapted: validated installable snapshots plus bundled offline assets. Custom workflow attachments use ordinary versioned documents, inherited workflow access, durable uploads and ZIP exports. Existing workflow picker/trigger resolves the common catalogue. |
| Memory: `1672f7361`, `72f2579d2` | Adapted: opt-in private app/shared project memory, delayed curator, audience-bound continuation, revision/epoch fences and deletion protection. |
| Uploads and tabular work: `0648fbaef`, `e7c69fc3f`, `5f78bb22c`, `5ed80dd53`, `18974c934` | Adapted: upload sessions for documents, versions and workflow references; existing directory upload/multiselect and tabular/agents durable jobs provide folder grouping, leases, cancellation and resume. |
| Word: `c059e6ce4`, `204d2d533`, `7d5c06530`, `7269447e3`, `5989c3a46`, `cbe6fa153`, `9905fbf05` | Existing shared Word tools, native Review and approval/continuation retained; client replay fenced before mutation. Add-in builds with Beaver frontend; upstream separate Docker source-copy fix does not apply. Real Word remains a host gate. |
| Document output and PDF: `d8183be43`, `8362692a6`, `2e3c17ebd`, `593970290`, `c725d73ca`, `aa1079cb7`, `8a36c3446`, `27b8b24a8`, `e8f21502b`, `8313af19b`, `25833cb71`, `7d1ea6f9b` | Adapted attribution, Unicode, arbitrary-file downloads, signed exports and key errors. Existing DOCX Markdown preserves text and explicit numbering; pinned native PDF Inspector owns layout/forms. Existing version-bound PDF geometry and multi-span highlighting retained instead of a second JS extraction/order engine. |
| Workspace and interface behavior: `f024fe014`, `53cb54e80`, `26f4597b2`, `469478b18`, `7ec5a8657`, `d79c9a426`, `a6ec11386`, `c0ef3e3b0`, `a2571b53d`, `78dbac19c`, `3ad9a5ffa`, `6c77dda0a` | Existing project explorer, retained dock viewers, history and relational paging remain the owners. Added persistent system/light/dark appearance. Beaver controls and bundled icons retained; no parallel upstream component hierarchy. |
| Visual redesign and developer catalogue: `5b441de08`, `7411b1be1`, `66c5338da` | Not imported: glass/design-system replacement conflicts with the accepted Beaver appearance; Storybook-only component catalogue adds no requested product capability. Functional appearance/accessibility work is handled above. |
| Local hosting: `7219da42d`, `1ff6e7f1d`, `fc6911922` | Local-auth removal rejected explicitly: local/offline operation is required. Existing launcher/runtime provides local and cloud composition; no second Docker deployment stack. |
| Project documentation: `31ee5da35`, `83b5ce057` | Existing CONTRIBUTING and master-plan/spokes remain authoritative. No parallel PRD template or upstream README overwrite. |
| Quality and architecture: `8c305620d`, `83026bac3`, `4df3edd5d`, `1af923104`, `9df42324a`, `2266446b0`, `c6aa6bea6`, `33073c43b`, `9179dd2b7`, `b0ee67e4d`, `1b00314d9`, `14de15093`, `133ecb3f6` | Existing module/source/schema checks, real behavior suites and runtime config retained. Removed silent nonexistent-eval gate; isolated FullSweep runs validation stages serially and includes production browser smoke. Upstream mock/coverage-ratchet suites are not copied. No new tests after the user prohibition. |
| Connectors: `9d95ecbcf`, `7e3607e76` | Adapted Slack/Google client configuration and Google offline consent through existing origin-bound MCP OAuth. Generic MCP connection flow retained; provider sign-in needs real accounts. |
| Dependency batches: `f24f0f913`, `085cae5f7`, `23c3f2d40`, `1b5763732`, `a6ae6bfd1`, `8b3466fc0`, `d46449df6`, `555f48f79`, `605395636`, `389774d60`, `fbd7dd957`, `e2dc753db`, `def1797cc`, `ef5532541`, `52ccb7dcb`, `ac4a17e25`, `14d32d3f3`, `a8dba0ddf`, `85e0f174f`, `64be58c33`, `f219c0d93`, `f4f6a5654`, `39200073c`, `5008eac7b`, `1ce648e53`, `f9e7fcc42` | Applied relevant installed-package security/provider updates and audited all three lockfiles. Checkout/setup-node/upload-artifact/Supabase CLI actions use pinned upstream major revisions. Packages exclusive to removed Next.js/upstream tooling are not introduced. |

## Validation and current position

The accepted implementation is present on `integration/upstream-20260919`.
The final candidate is undergoing the authorized FullSweep and direct browser
inspection; it is not yet certified by those pending results.

Focused validation covers network/OAuth and SSO, AI SDK wires and key errors,
organization permissions/deletion/exports, scoped memory and delayed curation,
durable document/version uploads, workflow access and Word continuation.
The pinned PDF Inspector preserved a filled AcroForm value through Beaver's
projection. Its extraction semantics and native pins are unchanged.

The existing production browser smoke previously passed upload recovery after
reload and project memory/export integrity. The three lockfile audits reported
zero high or critical advisories. Fresh-clone validation proved the public
workflow replacement pin and bundled offline assets. These are focused results;
the combined candidate receipt supersedes earlier suite/build runs.

FullSweep uses a fresh library, separate port and launcher state. Backend tests
retain their own per-case data homes.
The mocked process-startup suite was deleted after its asynchronous imports
outlived teardown; real launcher/browser checks cover process startup. No new
tests are written after the user's prohibition.

Pending candidate checks: finish FullSweep, inspect its dock screenshots, and
exercise appearance and workflow reference uploads/versioning/downloads directly
in the browser. The user authorized `[FullSweep]` on September 19, including its
isolated synthetic live-model checks.

External gates remain: real Word host behavior, provider/SSO account sign-in,
PostgreSQL concurrency and live S3/CORS. The native repositories continue to own
their independent corpus/gold gates; local application checks do not certify
those environments. Personal key overrides require the existing
`USER_API_KEYS_ENCRYPTION_SECRET` in local mode as well as cloud mode.
