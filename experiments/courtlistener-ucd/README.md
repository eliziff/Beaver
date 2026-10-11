# CourtListener UCD corpus acquisition

The browser module is the complete ALR undetected-chromedriver pathway copied
from `canlii_ext/canlii_browser.py` at the revision in [source.json](source.json).
Apache-2.0 attribution is retained in LICENSE-ALR and NOTICE-ALR.

The only edits inside that module are provider/domain/environment names and
imports of the standalone runtime helpers and no-op resolver. The original
challenge delay (10 seconds plus its original jitter), humanization, post-load
delay (1.5–4 seconds), window behavior, retries, page loading, cache behavior and
shutdown implementation remain as supplied. Do not shorten or disable them.
The collector consolidates the resulting cache files into the shared
content-addressed legal corpus after capture; that storage integration is outside
the copied browser module.

Candidates require the official cluster ID **and source slug**. The native
metadata join and selection commands produce those URLs from the snapshot,
retaining their cluster, docket and court metadata. ID-only opinion URLs are
rejected. A captured opinion must have an opinion body and identify the requested
cluster in its published canonical URL. Opinion content can include images,
diagrams, equations or embedded material without text. Challenge and error pages
do not count.

The original 5,000-page batch, from the Beaver workspace root:

```powershell
python -u -X utf8 experiments/courtlistener-ucd/collect.py `
  --candidates benchmarks/local-data/courtlistener-renditions/browser-candidates.json `
  --count 5000
```

Raw HTML lives once by SHA-256 under `%LOCALAPPDATA%/OpenLegalData/corpus`.
Its `selenium.page_source` representation is serialized browser DOM; it is not a
raw HTTP-response-byte archive. Complete original bulk rendition strings retain
their separate source identities and remain available for parser comparisons.
Private manifests, independent browser DOM evidence, progress, failures and
coverage live in `benchmarks/local-data/courtlistener-ucd/`. Resume uses validated
distinct clusters, never the number of requests or HTML files. The original
delays mean collection is a sustained acquisition job; parser iteration on the
saved corpus uses Rust and needs no further downloads.

The current continuing target is 12,000 distinct opinion HTMLs, with a minimum
of 7,000 validated pages: the completed original 5,000-page batch plus at least
2,000 more. The single continuation uses the same copied browser module,
delays and retries. The hidden
[`resume-after.ps1`](resume-after.ps1) continuation waits for the active
collector's verified PID and start time, then resumes the same validated ledger
to the target in `acquisition-request.json`. It does not run two publisher
collectors concurrently. `acquisition-worker.json` records the collector and
continuation identities. `acquisition-request.json` and
`acquisition-coverage.json` in the private corpus directory record the target
and candidate coverage. The queue contains 12,001 candidates; refresh it from the
broader joined corpus for further diversity and replacements for unavailable
pages. Selecting the original cached pool took 416 milliseconds.

To refresh the queued pool, first select a longer prefix from the **completed**
broad native catalog into a separate private preview. Use at least the desired
queue size plus the current validated capture count plus five rows, allowing for
captured and pinned cluster overlap. The existing command preserves full native
candidate rows and their canonical URLs:

```powershell
native/legal-structure-node/target/release/courtlistener-corpus.exe select `
  COMPLETED_BROAD_CATALOG.jsonl.zst `
  benchmarks/local-data/courtlistener-renditions/metadata/browser-prefix.json `
  PREFIX_COUNT
node benchmarks/local-data/courtlistener-renditions/metadata/refresh-browser-candidates.mjs `
  benchmarks/local-data/courtlistener-renditions/metadata/browser-prefix.json
```

The helper defaults to a separate `metadata/browser-candidates-prepared.json`
and refresh receipt for review. `--count N` selects the queue size; `--output`
chooses another private preparation file. It prepends the unchanged uncaptured
five-case index-two CAP source-gold cohort, excludes validated captured clusters,
then retains the native prefix order. Every selected metadata, rendition-feature
and citation field stays intact. Receipts bind the preview, original queued pool,
CAP source/queue evidence and collector-owned validated capture snapshot.

Coverage reports measure raw nonempty **docket** `nature_of_suit` values separately
from keyword `subject_hints`; spelling/code variants remain original source
values, not inferred legal classifications. A cached longer prefix can supply
additional observed nature values without classifying opinions again. Inspect the
receipt's dimensions, nature counts and first-5,000 coverage before publishing.

Optional `--promote-nature` keeps the source-gold priorities first, then promotes
the first uncaptured native-ranked row for each exact nonempty docket value absent
from captured coverage. Values absent from the ordinary reachable prefix come
first, followed by rarity within the supplied preview and native order. Remaining
rows retain native order. Preparation refuses to write if promotion loses an
existing reachable marginal; its receipt compares the captured union plus the
prefix needed for the saved target, with full-row and pin parity.

Refresh also preserves the measured marginal values of the prior uncaptured
queue and captured union. `--preserve-marginals ORIGINAL_NATIVE_PREVIEW.json`
adds complete immutable source witnesses from a previous catalog when the broad
preview does not contain those values. It inserts only needed unchanged rows
after the five pins, keeps the existing native ordering for the remaining rows,
and refuses publication if the full union or reachable prefix loses an existing
value. The receipt binds the additional preview, exact row ordinals and hashes;
older rows keep their original field presence rather than inventing richer
source-feature or citation metadata.

Optional `--supplemental VERIFIED_SOURCE_CANDIDATES.json` accepts complete
candidate rows independently compared with retained originals and joined
metadata. The helper validates their official cluster/slug identity, metadata
relationships, citation wrappers and source hash references, then inserts
uncaptured distinct rows after the five pins and required prior marginal
witnesses. It preserves every source row and array unchanged, binds the supplied
array SHA/bytes and source ordinals in the receipt, and applies the same full
union/reachable marginal preservation checks. This adds observed source families
without changing native ranking or the copied browser pathway. Raw shape names
remain source observations rather than semantic gold.

After review, rerun with the same preview/count/promotion option and `--publish`, omitting
`--output`. It reads fresh capture
exclusions and atomically replaces the queued pool, continuation count and queued
coverage; the final receipt records the published snapshot. A longer prefix may
be necessary if more captures completed during review. The active copied UCD
collector keeps its loaded list; its delays, browser pathway and process remain
unchanged. The existing continuation loads the refreshed queue after that process
exits and independently skips any later completed captures.

The original startup pool's first 5,000 candidates span 435 courts, 14 jurisdiction categories, 14 era
buckets, 10 opinion types, both OCR states, five size buckets, 21 source classes,
seven rendition kinds, and the indexed structure and metadata features. Subject
categories are 25 keyword hints, not verified classifications. The captured
coverage in `summary.json` is separate from this candidate coverage.

The latest October 6 publication bound 4,637 validated captures and 12,001 queued
rows. It kept the five source priorities and three historical raw docket witnesses
first, then added 22 complete original-source witnesses for rare raw structural
tokens. Independent source comparison verified every complete row, canonical URL
and published digest. Raw shape coverage increased from 1,958 to 2,437 observed
tokens: 382 classes, 95 attribute names, one `aside` tag and one literal
`data-label` observation. Every other prior queue, captured-union and reachable
marginal remained present. The captured-plus-queued union has 1,311 courts,
20 jurisdiction categories, 17 eras and 1,018 raw docket variants; the queue alone
has 1,305 courts and 1,015 raw docket variants. These counts describe source
observations and projected future captures, not verified legal roles, subject
classifications or completed served-page observations. The private
`browser-candidates.refresh-receipt.json` and independent
`shape-gap-22/publication-audit.json` bind this publication. The running collector
retained its original loaded pool and delays.

The configured shared iteration budget is 45,000,000,000 bytes (decimal 45 GB),
covering the corpus, metadata, browser captures and comparison outputs. The
earlier 30 GB cap is historical; already-running original processes retain their
loaded limit, and subsequent hosts import the configured cap from `budget.py`.
Budget checks leave space for temporary source
blocks and capture outputs. Profiles are disposable and cleaned in `finally`;
only the exact profile created by this collector may be removed.

The existing `resume-after.ps1` accepts `-PublisherPilot` for this continuation.
It waits for the original collector's exact PID and start time, runs the prepared
42-target publisher corpus with one worker, validates the terminal scope and
source hashes, then resumes the saved target with the original collector. A live
run's successful exit records completed observations; individual links may still
be rejected or unverified. The 40 pilot pages are recaptures in a separate ledger
and do not count as the 2,000 additional distinct cached websites. Budget refusal
or an incomplete pilot stops the sequence.

New host collector processes serialize actual persistence bytes before writing,
using the shared budget writer lock for cache HTML, the complete temporary cache
index, the owned resolver failure log, canonical HTML, DOM evidence, ledgers and
report rewrites. Windows newline translation and the copied cache's UTF-8
replacement behavior are included in those bounds. The existing 256 MiB
pre-fetch floor remains, with a further 16 MiB reserved during each write for
small checkpoint and cleanup receipts. Fetching, browser scripts and all original
delays occur outside the persistence lock. A budget refusal stops acquisition,
retains any already-written original cache HTML, skips further failure/report
writes and still closes the original browser and cleans its owned profile.
The shared SQLite index and other corpus collections, plus disposable browser
profiles, are outside the five collection locations counted by this iteration.
No SQLite schema, flags or source are changed.

These guards are outside the copied browser module, whose SHA-256 remains
`8bae8d4b04de350e025b8e37411aeb1edc535a3ec23dc01a9d64fc8fc7d02968`.
They are statically reviewed and await the next authorized original-UCD run;
no tests or synthetic runs were performed. Its first real capture must retain
the exact queued sampling row and canonical cluster/slug, match the original HTML
byte count and SHA-256, retain the unchanged evidence schema and DOM inventory,
and match the evidence bytes to their recorded digest. Confirm its cache index
points to the same canonical file and every completed ledger/report row agrees
with that capture. This is an actual corpus check, without a second browser or
changes to acquisition timing.

The separate [`verify-cached-anchors.py`](verify-cached-anchors.py) adapter reuses
the existing cached Chrome runner for ordinary source-ID links. It reads the
frozen native `web-run` output, checks each complete HTML hash, and navigates
candidate anchors on a local cache server. It observes actual `:target`, source
tag, whole-page ID uniqueness, opinion membership, visibility and viewport
landing. It navigates the emitted URL fragment unchanged, including symbols and
Unicode IDs. Browser navigation and two animation frames precede each observation.
The retained publisher stylesheets are supplied with `--styles`. Their original
order and media conditions are respected. Because CourtListener requests smooth
scrolling, landing observation waits until natural target and viewport geometry
are unchanged for four frames, with a five-second limit. It never scrolls a
target manually or disables the publisher's scrolling behavior. Earlier
two-frame outcomes are insufficient to establish final styled-page landing.
This is cached-page evidence; it makes no publisher requests and does not modify
the UCD acquisition pathway.

The same adapter has a bounded `--live --limit-targets N` publisher mode, using a
single original `CachedHtmlResolver` and guarded host capture. It consumes the
private `publisher-live-inputs.jsonl` beside a retained native corpus run. Each
input contains a complete unchanged collector-owned capture, its original
sampling metadata and an exact emitted target with its original body index.
Before acquisition it checks ledger membership, native target membership and
the original HTML/evidence digests. Live results and fresh complete DOM evidence
go to that run's `publisher-live/` directory; cached outputs remain separate.

```powershell
python -u -X utf8 experiments/courtlistener-ucd/verify-cached-anchors.py `
  benchmarks/local-data/courtlistener-renditions/web-source-context `
  --live --limit-targets 42 --workers 1
```

The prepared pilot has 42 targets on 40 distinct pages, covering 11 emitted kinds,
40 courts, 13 jurisdiction categories, 13 era buckets, all seven rendition kinds
and all 25 observed keyword hints. Heading, table and footnote-label targets occur
only on one retained page, so its three observations remain contiguous after one
original fetch; the other pages each supply one target. Keyword hints remain
source observations rather than verified issue classifications. The ignored
`web-source-context/prepare-publisher-live.mjs` regenerates these inputs from the
retained collector ledger and emitted targets; its preparation receipt records
all original-source hashes, exact input bytes and the marginal-selection rule.
Run preparation while holding the existing shared writer lease, allocating
16 MiB for its bounded two outputs plus the 16 MiB receipt reserve.

Execute this pilot only after the original 5,000-page collector has closed and
cleaned its profile, with the queued 12,000-page continuation deferred until the
pilot finishes. It requires a fresh owned cache. The copied fetch strips URL
fragments, so the host first completes its unchanged fetching, retries and delays,
then applies `location.assign` to the exact emitted URL only when its base matches
the live document. This is ordinary same-document fragment navigation. The
natural-scroll observer checks the actual `:target`, whole-page ID
uniqueness, source tag, opinion membership, visibility and viewport landing.
No stylesheet replacement or manual scrolling occurs. A changed base retains the
fresh source and is reported as `redirected_base` with `pinpoint_unverified`;
`fetch_failure` stays distinct from a missing target. Success is named `publisher`,
not a cached verdict. Receipts bind original and fresh HTML/DOM evidence plus the
copied browser, host, runner and native engine/query source identities. This
includes the loaded configured cap and budget source hash. The actual bounded
pilot persisted all 42 outcomes: 13 in-view observations, one initial offscreen
observation and 28 fetch failures. Profile cleanup failed afterward, so the
original exit code remains 1 and its summary was never written. The existing
cleanup helper cleared that exact orphaned profile after an absence check.
[`audit-publisher-terminal.mjs`](audit-publisher-terminal.mjs) binds retained
outcomes and original producer blobs; its collector binding uses the original
append-only ledger prefix, so later captures do not invalidate the pilot audit.
The early offscreen observation returned after 59.1 ms; it does not prove eventual
publisher failure. After the pilot, the observer was changed to keep observing an
offscreen target through the existing five-second limit. That change awaits an
actual cached corpus run. The resumed served-page phase must reach
at least 7,000 validated pages before continuing toward the saved 12,000 target
within the shared 45 GB cap.

```powershell
python -u -X utf8 experiments/courtlistener-ucd/verify-cached-anchors.py `
  benchmarks/local-data/courtlistener-renditions/web-expanded-structure --workers 6
```

`anchor-browser.jsonl` retains each result with its original canonical URL and
full HTML digest. `anchor-browser-summary.json` records kinds, verdicts, browser
version and adapter hash. Frozen native receipts retain the engine/query hashes.
Overwrite these latest outputs when rerunning the same cohort. A failed oracle
must be marked invalid rather than interpreted as source-link yield.

`--structure-gold` saves an independent DOM inventory of all selected source
structures, including elements without IDs, into `browser-structure-gold.jsonl`.
It records attributes, visible text and `textContent`, parent indexes, actual
anchors and browser table-span observations. Retain that inventory separately
from native output; [`compare-source-structure.mjs`](compare-source-structure.mjs)
compares it with a Rust `web-run` receipt and records gaps with input hashes.
It also compares table-query text, ranges and spans with the browser's cells.

`--all-elements --source-context` includes the opinion wrapper, every descendant
and actual ancestor attributes. Each opinion remains separate from its siblings.
`--body-selector .casebody --include-root` inventories retained public CAP HTML.
`capture-xml-source.ps1` provides an independent .NET XML inventory, while
`capture-source-html.py` uses the existing HTML parser dependency to check literal
source nesting where HTML5 reparsing repairs nested anchors. These are real
source inventories; their textContent is not a claim about browser rendering.

`collect-cap.py` retains exact CAP JSON from official cluster archive paths and
exact CSS from captured publisher hrefs. It uses the existing corpus acquisition
helper's delays/retries and stores original bytes by hash. Text equality is never
used to substitute one markup representation for another. Original CAP citation
arrays and all other fields remain intact. The Rust `source-run` command consumes
those sources directly for rapid structure iteration.

New collector processes also preserve a preorder DOM node inventory, including
actual attributes, namespaces, parents and text/comment node values, alongside
the original HTML and live body text. A collector already running keeps the code
and evidence format it loaded at startup; no live process is patched and no
acquisition delays are changed.

New DOM evidence files use the complete serialized evidence's own SHA-256 as
their filename. The source HTML SHA remains inside the evidence. Different DOM
observations of identical HTML therefore remain separate original files rather
than overwriting one another. Existing files and recorded paths remain unchanged;
consumers use the recorded evidence path and digest. The same actual-byte capture
guard covers this write.

[`project-captured-source.mjs`](project-captured-source.mjs) freezes independent
gold from that existing inventory without another browser render. It accepts
complete original capture rows as JSON or JSONL, verifies canonical HTML and DOM
evidence hashes, validates the saved node preorder and parents, and projects every
element including the opinion root. Direct parents use element indexes;
`text_content` concatenates descendant text and CDATA values, excluding comments
and processing instructions. Attributes, empty IDs and namespaces retain their
recorded values. Complete original `source_nodes`, body `innerText`, anchors and
links remain in their hashed evidence file, without a second full graph copy.
Gold binds the original evidence path/SHA, body and node-inventory hashes.

Keep the output `*-gold.jsonl` beside the input capture ledger. Its companion
`*-opinions.json` preserves the original capture rows and evidence-relative paths
for Rust `web-run`; identical repeated captures are deduplicated by HTML SHA and
conflicting rows are rejected. The projector refuses existing outputs, so an
engine iteration cannot silently regenerate its independent baseline. Freeze gold
before native output. Missing inventories are rejected, including old captures
from the already-running collector. `--limit` bounds the initial actual-corpus
cohort; `--max-output-bytes` bounds the combined gold, frozen manifest and summary.
Run persistence under the existing shared writer lease, reserving that bound plus
the 16 MiB receipt reserve. No separate mutex or budget implementation is added.

For the first fresh pilot capture, after its original capture and evidence commit:

```powershell
node experiments/courtlistener-ucd/project-captured-source.mjs `
  benchmarks/local-data/courtlistener-renditions/web-source-context/publisher-live/captures.jsonl `
  (Join-Path $env:LOCALAPPDATA 'OpenLegalData') `
  benchmarks/local-data/courtlistener-renditions/web-source-context/publisher-live/first-capture-gold.jsonl `
  --limit 1 --max-output-bytes 16777216

& native/legal-structure-node/target/release/courtlistener-corpus.exe web-run `
  benchmarks/local-data/courtlistener-renditions/web-source-context/publisher-live/first-capture-opinions.json `
  (Join-Path $env:LOCALAPPDATA 'OpenLegalData') `
  benchmarks/local-data/courtlistener-renditions/publisher-source-first --structure-only

node experiments/courtlistener-ucd/compare-source-structure.mjs `
  benchmarks/local-data/courtlistener-renditions/publisher-source-first `
  benchmarks/local-data/courtlistener-renditions/web-source-context/publisher-live/first-capture-gold.jsonl
```

The projector and capability-aware comparison have run against the terminal
publisher pilot's 12 fresh pages and 16 opinion bodies: all 4,767 elements match
in tag, order, attributes, direct parent and valid range, with zero typed or
generic structure gaps. All complete captured body texts match. The separate
[`explain-captured-text.mjs`](explain-captured-text.mjs) inspection confirms all
80 textContent-versus-rendered diagnostics differ only in whitespace, without
rerunning the parser or regenerating gold. The
new gold automatically binds the frozen capture manifest and checks the original
whole-body `innerText` separately. It compares tags, attributes, direct parents,
source-ID queries and native range validity, and keeps existing declared legal
role, footnote-label and printed-page checks. Per-element `innerText`/visibility,
browser-reflected table spans, outside ancestors and native namespace comparison
are explicitly unsupported. Their counts cannot become passing observations;
element textContent versus native rendered text remains a labelled diagnostic.
The older full-browser gold path retains its existing strict checks. Extend this
same freeze-before-native sequence to the actual additional served-page cohort
with saved inventories; it does not extend the old 3,059-body gold by assertion.
