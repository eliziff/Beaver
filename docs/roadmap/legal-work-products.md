# Durable legal work products: Court Records and Authorities

Status/order/shared gates: [master plan](master-plan.md). A saved work product is
a **Draft**: intent and input bindings, not another content store. One maintained
UI/core per product, standalone and Beaver adapters. Preserve working Authorities
behavior; replace Python product shell/state, not shared Rust citation/PDF owners.

## Release inventory

Every profile below needs exact governing sources and production output/live proof.
Existing profiles are a baseline, not the ceiling: inventory missing variants
within these families. UI consolidation must still resolve one exact internal ID.

- Alberta King's Bench: affidavit/exhibits; chambers applicant/respondent; desk;
  special applicant/respondent; originating/review/appeal applicant/respondent;
  Commercial List applicant/respondent and compendium.
- Alberta Court of Appeal: appeal record; appellant/respondent/intervener Extracts
  of Key Evidence; condensed book.
- Federal Court and Federal Court of Appeal: affidavits/exhibits, moving/responding
  motion records, applicant/respondent application records, informal motion letter
  and compendium; FCA appeal/condensed books and leave motion/response; FC trial record.
- King's Bench chambers/desk Justice and Applications Judge profiles stay distinct.
  From September 15, 2026, Applications Judge Digital Orders omits proposed-order
  files; Justice accepts applicable PDF/editable DOCX. Resolve before build.
- FC/FCA share data/renderers only for identical requirements; court/form/role/order/
  cover/output/technical differences stay separate. BC is out of release scope but
  must later require data/fixtures, not a new builder architecture.

No filing/login/payment/service/email/docket automation, legal eligibility advice,
compliance scorecards, universal Filing Builder, graph engine, watcher, new parser/
OCR/converter, automated CanLII fetching or unlicensed corpus commits.

## Draft, binding and output contract

Use a closed Court Record/Authorities draft union: ID/kind/title/project/revision,
typed state, named outputs and timestamps. Existing application/jobs/progress/
cancellation/document/evidence/source ports own execution. Beaver persists the
normal relational resource under project authorization or private user scope,
with optimistic revision and local/cloud contract parity. No deployment imports
or second store/runtime in feature code.

Inputs are retained standalone file handles, authorized Library documents
(default latest, optional exact pinned version), or another draft's named output.
Never infer identity from a filename/path. On Open/Refresh/Build resolve ready,
changed, missing(deleted/permission/unavailable) or needs-review; statuses are
computed, not persisted stale flags. Reject direct/indirect cycles with involved
drafts before output mutation.

Output roles: Authorities table/book/annotated-document/manifest only when produced;
Court record plus profile-required separate roles. First Beaver build creates
one ordinary output document per role; rebuild adds immutable versions to that
stable identity. Project outputs/uploads use the configured Project workflow
location; unbound drafts use configured/default Library target, contained
workflow-named folders rather than UUID roots. Defaults belong in Settings.

Freeze every build: draft ID/kind/revision/profile; ordered role/document/version/
hash or local hash; child draft/role/output version/hash; court-source IDs/effective
dates; user values/settings; actual OCR/conversion/assembly steps; output role/name/
MIME/page count/hash. Extend the existing build receipt rather than a second audit.

Standalone: same typed drafts in IndexedDB plus structured-cloned file handles
and only the current blob per output role, atomically replaced. Inputs/drafts
remain authoritative and older outputs rebuildable. Stable secure loopback origin/
port; queryPermission/getFile on reopen and permission request only by user action.
Missing/moved/denied files retain slot/description/metadata with Relink file, never
silent same-name substitution or raw-path storage. Chromium File System Access is
the resumable runtime; unsupported browsers get one-shot file input, not another
persistence implementation. Ship compact local-only launcher/assets/deterministic
runtimes, no account/cloud/model/Beaver assistant bundle; external navigation is
user-initiated. No second business logic, settings/progress UI or feature host.

## Grounded citations and conservative refresh

Project AuthoritySeed from registered evidence: Rust identity key, kind/provider/
stable source/hash/citation/name/version/URL/evidence IDs/locators. Models select
evidence IDs, never invent those facts. Generated DOCX provenance binds seeds,
marker/target IDs, source units/locators/displayed forms/pinpoints/evidence IDs to
exact document version/hash. Authorities consumes it without semantic rescanning;
imports/changed documents use Rust occurrences. A mutation unable to prove targets
untouched invalidates the new ledger. Pagination for cited-at pages remains valid
layout work, not rediscovery.

Refresh only on open, explicit Refresh or immediately before build/export.
Safe latest version/name/prepared-PDF changes update automatically; reviewed
semantic changes require focused review. Carry Authorities decisions by resolved
provider/citation key; occurrence decisions only on unambiguous structural target,
text hash and local ordinal. Unmatched additions/removals remain visible; never
broaden matching to retain a decision.

Affidavit exhibit extraction is a narrow new corpus-gated structure capability:
label/displayed text/exact locator/confidence, no file guesses. New unambiguous
mentions suggest ordered empty slots; disappeared mentions flag attached exhibits
without deleting them. Filename similarity ranks only user-selected candidates;
ambiguous/duplicate/non-lettered references abstain. No private UI regex parser.

Nested builds resolve dependency order: use current child output, rebuild a
deterministically ready child, otherwise focus child missing/review state and stop
before stale parent output. Parent receipt names exact child build/output.

## Court profiles and source truth

Profiles own court/division/language/family/role/variant, identity and data-driven
selection, required/ordinary/conditional/forbidden slots, order, combined/separate
mode and DOCX exceptions, cover/form geometry/electronic-paper colour, pagination/
labels/links/bookmarks/initial view, contents/date columns, page/file/volume limits
and source receipts. New court branches need a genuinely new output primitive.

Every non-generic field traces to legislation/rule/direction/official guidance
or official/real example. Internal receipts record stable ID/title/type/URL/parent/
exact locator, affected profile IDs, verified/effective dates, response hash and
ETag/Last-Modified, normative-vs-example classification, visual hash/provenance.
Offline v2 manifest coverage audit; conditional network only when due/explicitly
refreshed, retain last verified response after failures. CanLII is manual-only and
audit requests must reject it. Never run source refresh at startup.

Every generated form/cover/contents/colour/bookmark/pagination rule requires official
text plus permitted sample where available, source/hash receipt, rendered images
and comparison of text/order/geometry/spacing/colour/labels/links/bookmarks. Exact
official forms stay exact; varied examples inform documented discretionary layout.
No plausible “court-like” acceptance, source/audit/effective-date/preparation panels
or committed downloads without licence.

## Court Records interaction

- Records led by a nonrepeatable required source start with that input alone;
  reveal case details, remaining inputs and output only after it is added. Use
  compact numbered step markers, one label per task and inline required status.
  Keep style-of-cause fields visible, including populated fields. Compact Drafts:
  New/Open/Duplicate/Rename/Delete, exact links, meaningful autosave, no redundant
  Saved badges/toasts/dashboard. Restore all fields/parties/order/descriptions/
  bindings/nesting; healthy inputs silent, changed/missing inline.
- Document opens searchable native dialog for user families (affidavit, motion/
  application/appeal record, evidence extracts, condensed/trial book, filing set).
  Format shows applicable General/AB KB/AB CA/FC/FCA and only needed position/party
  variants. Buttons/dialog/labelled search/native radios, not all-profile dropdown/
  card dump/custom listbox. Motion/application families are one choice each.
- Repeatable party groups have profile roles, optional lower role and many parties;
  Add party/Add intervenor group, filing party selected from entered names, motion
  position separate from case roles. Correct filing-side/counsel placement; preserve
  exact two-party geometry, extend deterministically. Group court/file, parties,
  filing identity, hearing and counsel/service by aligned meaning, not giant grids.
  Keep required AP-5 contacts visible with their party; place filing and other-party
  contact fields together rather than sorting unrelated fields by required status.
- Explicit Save filing details stores stable lawyer/organization/address/phone/fax/
  email through existing preferences, prefills empty fields only, no unwanted copying.
- Compact labelled text dates with example/tolerant deterministic normalization;
  no native calendar or generic Index date. Every item has editable Contents
  description (Document name for separate sets), used in contents/bookmark.
  Defaults: prescribed slot, reliable PDF title/bookmark, cleaned filename.
  Separate Document date only where profile requires it—FC/FCA Rules309/310 initial
  cases, other profiles decided from sources. Only verified typed/form dates
  prefill; no filesystem timestamp/model guess. Arbitrary descriptions may contain dates.
- After initial source intake, show ordinary slots in filing order; only truly
  mandatory inputs say Required, beside their label.
  Permanent Add another document. Add file accepts PDF/DOCX in every user slot.
  Nonrepeatable replacement confirms, not duplicates. Combined DOCX uses existing
  conversion host; editable proposed-order/separate exceptions remain DOCX.
  Editable Word slots do not require a PDF conversion service to prepare, reopen,
  or import their source; preserve original bytes through both host adapters.
- Selection validates type/size/security/encryption, inspects pages/text/title/
  bookmarks and invokes existing OCR as needed. Success silent; locked file gets
  one actionable inline error. Existing progress/cancel, no OCR engine/settings
  work, Searchable badge or “open and check” instruction.
- Prevent invalid combinations; Build focuses first missing field/slot inline,
  never a successful-check lecture. One scroll owner, reachable build action.
  Exact cover/contents/tabs/order/continuous pagination/labels/links/bookmarks/
  initial view and deterministic separate court filenames/types. Assembly never
  rewrites source DOCX; native ToA/authority-field updates use ordinary Word
  operations/new versions.
- Once built, offer downloads and saving without repeating the build action.
  Multi-PDF outputs allow selecting the previewed file; show complete filenames.
  A supplied signed Form 344 removes the generated-certificate signature prompt.

## Authorities reference parity and CanLII

Keep all existing capabilities: DOCX/PDF import/manual book; citation/pinpoint
review; split/merge/relink/reorder/exclude/rename/supra-Ibid correction; exact
resolution/manual attachment; Table/Book/both; tabs/bookmarks/indexes/covers/
inserted PDFs/source review; native/linked DOCX tables/annotated outputs; passage
marking/discrepancy review; bounded progress/cancel/errors/durable outputs.

TypeScript owns review/state/source/build orchestration/rendering; existing
source apps, Word operations, Rust structure/citation and PDF/OCR primitives
retain ownership. PDF assembly may merge/bookmark/paginate/link/overlay proven
geometry. No TS copies of citation regexes/resolvers. Delete Python product
worker/bootstrap/iframe/job/project paths after parity, not unrelated corpus/dev
scripts. Keep the reference interaction; apply Beaver visual/accessibility style,
not an invented substitute.

CanLII: existing validated URL helper derives sibling PDF only from safe known
canlii.org route/neutral slug; unknown mapping abstains. Download from CanLII is
one user link, retains pending authority, accepts returned PDF via Add PDF/drop,
validates and attaches without reentering name/citation/tab. Persist binding.
No server fetch/scrape/bulk navigation. Optional session-local return funnel checks
only user-selected directory, exact expected filename plus browser duplicate suffix,
and recent PDF after explicit click. No general watcher/background surveillance;
unsupported browsers keep Add PDF. Internal terms/link receipt plus one expected
HTML/PDF pair; validate via one user-initiated navigation, not retrieval loop.

## Assistant and host integration

One specialist operation over the UI application can create/select drafts, choose
valid profiles, bind authorized Library/child outputs, add registered evidence
seeds, and fill empty case/party/counsel/description fields. Never overwrite
nonempty user values, invent IDs/URLs, upload local files, call parser/OCR internals,
bypass access or build without ordinary operation/current revision. Typed host
event returns draft ID/revision to refresh normal UI, no assistant-owned duplicate.

Workspaces may be main or right-dock placements; existing Assistant opens beside
a main draft with draft/bindings context. Standalone omits assistant controls,
empty rail and model code entirely. No workspace imports of chat/deployment logic.

Catalogue/direct/contextual entry requirements are shared with
[Workflows](document-capabilities.md#product-vocabulary-and-workflow-catalogue):
one Court Records and Authorities definition, families/results inside them, same
IDs for Library/project/assistant/nested launches, compact draft control not another list.

## UI and performance acceptance

One semantic heading hierarchy/serif-sans/type scale, spacing/alignment before
cards, clear controls versus output, 16px narrow inputs, compact desktop widths,
wrapped descriptions and fully reachable names/IDs. Verb-first consistent labels;
every sentence helps choose/enter/fix/build, actionable errors, examples not
placeholder labels. No nested decorative chrome/gradients/badges/routine animation.

Native controls, keyboard/Escape/focus return/visible focus, no positive tabindex,
field labels/aria-invalid/described errors, first-error focus, stable polite progress,
non-colour state and WCAG targets. Complete at 320px/200% zoom/text-spacing/forced
colours/reduced motion without horizontal task scrolling. Court previews are output
evidence, not mockups.

Bounded local draft/profile catalog; route opening does not search Library. Picker
opens first server-paginated page (24), no eager loads. PDF.js/assembly/DOCX/
Authorities build remain lazy; no parser/samples in initial bundle. Removing
Python/iframe must reduce first-use latency. Hash only trust/build boundaries or
cheap metadata-detected changes. Measure load/browser/build medians and production
LoC against machine baseline; reject regressions, not invent hardware-free budgets.

## Execution and live proof

1. Freeze full profile/source/gap matrix, normative/example/discretionary classification,
   official forms/real-reference hashes, CanLII terms/links, Authorities parity
   fixtures and UI/Library/startup/build/LoC baseline. No new experiment/RESULTS.md
   as a production transition.
2. Close resumable draft/repository/host contract and exact output identities,
   then Court interactions/profiles, Authorities parity/Python removal, ledger/
   nesting/exhibit corpus, then assistant handoff. Preserve every capability
   through complete cuts, no compatibility routes/old DTOs/dual reads/feature flags.
3. Before release run real ChromeDriver and rendered-PDF inspection for every
   profile and reference workflow, with screenshots at desktop/narrow/zoom.
   Required scenarios: restart with handles; moved/deleted/permission-revoked
   Relink; changed file hashes; latest vs pinned versions; original affidavit;
   multiple parties/intervenors/counsel; PDF and DOCX editable/combined paths;
   locked/textless/OCR files; full Authorities import/review/correct/attach/build/
   reopen; manual CanLII attachment without server request; direct grounded seed
   without semantic scan; brief v1→Authorities→record then v2 refresh exact chain;
   ambiguous exhibit additions/removals; empty-only assistant fill; catalogue
   uniqueness/context binding; keyboard/screen-reader/status/contrast and load.
4. Automated: SQLite/Postgres repository parity, real Chrome IndexedDB/handles
   restart, source-receipt audit, structural/rendered profile gold, Authorities
   parity, Rust ledger no-reparse, cycles/stale-child/authorization, generated
   DOCX/PDF open/search/bookmark/link validity, catalogue/audience binding, shared
   release and dock gates. No unexplained changed/unreachable normative source.

Stop with both products resumable/composable/exact/live-proven, no displaced
localStorage/non-resumable/fixed-party/all-profile/calendar/index-date/hidden-slot/
audit-noise/Python/iframe paths, and BC addable as data/fixtures. No general filing
engine, background watcher, universal court ontology or extra jurisdiction work.
