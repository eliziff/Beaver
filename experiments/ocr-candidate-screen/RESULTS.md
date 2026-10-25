# OCR candidate recognition screen

Measured 2026-10-18 on the desktop RTX 3080 Ti (12 GiB) and Ryzen 5 2600X.
The initial screen and longer-training sections measure recognition using
existing rectified line crops. The browser follow-up below also measures page
segmentation, PDF rendering, previews and full-document recognition.

Workspace base: `f74e60376138555ca5d116bb979dd9c54b84bead`; parser base:
`fbde8f32f1b21464962efda047dcdde378cc36e4`. The harness is part of this change.

The one-epoch results below are a smoke test of training, export and runtime.
They do not establish converged accuracy or rank the architectures' final
quality. The follow-up trains Indra and CRNN for longer: they were the only two
candidates already faster than the installed Kraken in the CPU screen.

## v0.2.5 publication

[v0.2.5](https://github.com/eliziff/legal-browser-ocr/releases/tag/v0.2.5) publishes
the portable full/compact packages and an optional two-batch GPU edition. All
nine uploaded digests and sizes match the local release. The execution assets
and application module in all four HTML packages match the tested v0.2.4 builds
exactly; their notices differ only in version. Standard defaults remain unchanged.
The native ZIP and kernel-source archive are byte-identical to v0.2.4. Source
checks pass 56/56; four fresh Chromium queue cases pass offline CPU, hosted GPU
and injected initialization/execution failure recovery. Earlier eleven-case
Chromium/Firefox queue checks still describe the identical execution code;
Firefox currently fails to open a blank automation page before OCR loads.
Receipts belong to `browser/packaging/v025/latest/`.

## v0.2.4 delivery candidate

The final full browser package promotes the crop-robust standard and light
recognizers, GPU crop preparation/ArgMax/command replay, eight cached shapes
with the existing 256 MiB owned-buffer cap, guarded scan-image reuse, fused
SIMD128 HardSwish and the exact-order detector decoder. Automatic GPU failure
replays on CPU. Native model packs retain ordinary width-input GPU graphs.
The shared embedding API consumes the same browser execution policy and assets.

The final package uses no speed URL overrides. On the i3-1315U / Intel UHD,
Chromium 149, the frozen 55-page / 145,475-character human-gold PDF measured:

| Full browser tier | CPU pages/s | CPU CER | WebGPU pages/s | WebGPU CER |
| --- | ---: | ---: | ---: | ---: |
| Quality | 3.94 | 2.018% | 6.68 | 2.022% |
| Balanced | 3.70 | 2.211% | 7.03 | 2.213% |
| Fast | 4.61 | 2.328% | 7.74 | 2.332% |
| Turbo | 5.66 | 2.834% | 11.47 | 2.833% |
| Extreme | 9.06 | 3.962% | 12.94 | 3.954% |

All ten cases pass stable text across three warm passes, all-page PDF text,
original first-page pixels and reopening with the module worker. Model startup,
input opening and export are excluded from warm throughput. There is substantial
between-case timing drift; this does not establish a weights-only speedup or
consistent ordering between neighboring tiers.

Desktop Ryzen 5 2600X / RTX 3080 Ti, Chromium 151, measures Balanced CPU
9.48 pages/s / 2.296% CER, Quality CPU 8.86 / 2.015%, Balanced WebGPU
18.25 / 2.302%, Quality WebGPU 14.81 / 2.011%, and Extreme WebGPU
23.52 / 3.941%. Each has three warm passes and the PDF gates. A first desktop
sweep exhausted available disk space while saving Turbo's exported PDF; its
19.21 / 2.832% result is incomplete and is excluded from released throughput
tables. Subsequent completed desktop cases used fresh browser processes.

The new rounded compact CPU edition is 5,393,198 bytes (3,707,269 gzip),
Balanced 5.40 pages/s / 2.209% CER and Quality 4.98 / 2.022%. Compact Extreme
is 3,832,841 bytes (2,536,153 gzip), 8.30 / 3.966%. The full HTML is
22,840,084 bytes (16,837,946 gzip). All include PDF input/export. Compact
precision has its own development accuracy gate; computation remains FP32.

Source tests pass 53/53. The full package passes 14 Chromium/Firefox scenarios;
three further embedding checks read the actual packaged archive's assets.
Both small packages pass five Chromium/Firefox offline/hosted/JavaScript
inflation cases. Hosted PNG recognition and all five tier switches pass for
CPU and automatic GPU. The initial sandboxed Firefox attempt could not start
content processes; normal process permissions pass. Apple Safari is untested.

Native ZIP refresh preserves the verified executable, DLLs, source identities
and notices byte-for-byte, updates model inventory/checksums, and records the
base ZIP hash. Its extracted first-page CPU, DirectML and Extreme CPU smokes
pass; they are compatibility checks, not new full-document native performance
claims. The private receipts and independent gold remain in their owning stores.

### Post-release GPU width/cold-start experiment

v0.2.4 is published at [GitHub](https://github.com/eliziff/legal-browser-ocr/releases/tag/v0.2.4).
All eight uploaded asset digests match local SHA256SUMS; GitHub Pages serves
the exact released HTML (SHA-256 `dfbde9cb01afc3b2e015a6bc01b9ffd85454f8e7fb4b2aaff01d8adb4380d91e`).
Source CI passes. The local PDF parser has the new native model pack;
standalone Authorities was rebuilt to 38,360,255 bytes. Its 13 embedded OCR
assets match the released archive after offline browser inflation, its initial
screen is inspected, and its six focused asset/cache tests pass. This verifies
OCR delivery, not unrelated Rust structure or court-output readiness.

Coarser 512px GPU width buckets reduce first-document new shapes from three to
one, but raise executed recognition pixels from 49,020,928 to 58,982,400
(+20.3%). Before/candidate/after, three warm passes per configuration:

| Host | Default before pages/s | 512px pages/s | Default after pages/s | First-document seconds before / candidate / after |
| --- | ---: | ---: | ---: | --- |
| Laptop Intel UHD | 10.58 | 9.35 | 9.97 | 9.47 / 9.52 / 8.99 |
| Desktop RTX 3080 Ti | 20.28 | 19.97 | 20.19 | 7.07 / 6.96 / 6.67 |

Initialization is another 1.78/1.80/1.98 seconds on the laptop and
2.30/2.34/2.31 on the desktop. Text, positioned lines and exported PDF bytes
are exact within each host. Fewer sessions do not establish a cold-start win:
the saved session-creation work is only about 0.10-0.16 seconds, while the
coarser padding increases compute. Keep the released 256px setting; preserve
these results on the speed/accuracy/size curve. Later controls being faster
also demonstrates why the release's earlier laptop 7.03 pages/s is not a
hardware ceiling or a reason to silently replace its measured table.

### Independent seven-pass laptop repeat

The requested repeat uses the exact published v0.2.4 HTML and Balanced WebGPU
in Chromium 149.0.7827.55 on the i3-1315U / Intel UHD laptop. Two independent
fresh browser launches each run one first document followed by seven timed
whole-document passes. No source, model, worker or runtime flags change.

| Fresh launch | Median warm pages/s | Warm range | Median 55-page seconds | First document seconds | Initialization seconds |
| --- | ---: | --- | ---: | ---: | ---: |
| First | 6.35 | 5.26?7.31 | 8.66 | 15.45 | 2.27 |
| Second | 4.37 | 4.01?5.12 | 12.59 | 17.22 | 2.84 |

Both score 3,220 edits / 145,475 characters, **2.213439% CER**. The two new
receipts and the earlier 9.97/10.58 controls have exact text, positioned-line
and exported-PDF hashes. Every warm pass reexecutes 156 recognition batches
and 49,020,928 pixels; scan reuse applies to 54 pages and there are zero new
GPU sessions in warm passes. Offline recognition, all-page exported text,
original first-page pixels and module-worker reopening pass.

CPU detection-model summed time rises from about 5.2?5.6 seconds in the earlier
controls to 8.17/14.90 seconds; recognition-model time rises from 4.06?4.38 to
6.57/7.79 seconds. These are overlapping stage sums, not additive wall times.
The laptop is on AC at full battery, Windows Balanced power plan, battery saver
off. The available observations do not establish the cause of variability.
This repeat does **not** reproduce ten pages/s as a dependable sustained rate.
Public README now records these repeats beside the release measurements.
Private outputs stay under `laptop/v024-repeat/`; no private text is published.

### Detector input and queued GPU follow-up

The October 20 input-preparation screen tests reuse of one canvas/tensor per
detector worker, medium/low resize filters, CPU-backed document canvases,
eight-page groups and GPU batch sizes 8/32. Three warm passes per case retain
2.213% CER except the low filter, which increases it to 2.360% (213 extra edits).
Before/after controls measure 7.09/7.56 pages/s; reuse, medium and low measure
6.81/6.87/6.13. A later screen measures CPU-backed pages 5.19, eight-page groups
5.51, batch 32 5.63, batch 8 5.85 and its following control 5.95. These initial
screens are not mirrored speed proofs. None establishes a gain. Most measured
detector preparation time is charged to pixel readback (about 2.8 seconds summed
over the document); grayscale conversion accounts for about 0.28 seconds. The
readback measurement includes deferred drawing, not just memory transfer.

A separate prototype overlaps GPU inference with class-ID download instead of
waiting for every batch's readback before submitting the next. The same queue
orders inference, reduction and ID copy before a retained logits buffer can be
reused. Only two or four batches' packed inputs may remain live. Model weights,
shader arithmetic, detection and CTC decoding remain unchanged.

For each depth on each machine, eight fresh browser trials run in order
control/candidate/candidate/control/candidate/control/control/candidate. Every
trial includes its first document and three warm 55-page passes: four matched
pairs, two in each order, twelve warm passes per configuration. Both depths on
both machines total 5,280 timed pages plus 1,760 first-document pages.

| Browser WebGPU | Queue depth | Pooled control pages/s | Pooled candidate pages/s | Paired change | CER |
| --- | ---: | ---: | ---: | ---: | ---: |
| Laptop i3-1315U / Intel UHD | 2 | 5.82 | 6.59 | +11.1% | 2.213% |
| Laptop i3-1315U / Intel UHD | 4 | 5.49 | 5.31 | -6.2% | 2.213% |
| Desktop Ryzen 2600X / RTX 3080 Ti | 2 | 16.83 | 18.29 | +8.1% | 2.302% |
| Desktop Ryzen 2600X / RTX 3080 Ti | 4 | 18.13 | 20.75 | +11.0% | 2.302% |

Pooled rates use twelve warm document times per configuration; paired changes
are geometric means of the four neighboring candidate/control ratios. All four
desktop pairs favor either depth: depth 2 ranges +5.1% to +11.8%, depth 4 +7.5%
to +20.5%. Laptop depth 2 wins three pairs, ranging -6.6% to +32.2%; depth 4 wins
one, ranging -22.0% to +17.7%. Two queued batches are the stronger cross-device
candidate, but the laptop benefit remains variable. Four are not a shared default.

Every mirrored trial retains exact per-host text, positioned lines and exported
PDF bytes, with 156 model batches, 49,020,928 recognition pixels and zero new GPU
sessions in each warm pass. CER is unchanged from the matching control. These
are browser measurements; startup, input opening, export and native performance
are separate. Prototypes add 1,432 HTML bytes and remain experimental while the
released default is unchanged. All 55 source checks pass, including retained-input
bounds, restored line order and allocation/model-failure cleanup. Raw receipts
stay in `frontier/queued-mirrored/` and `frontier/queued-two-mirrored/` on each host.
The two-batch prototype also passes eleven Chromium/Firefox compatibility cases.
Quality and Extreme each pass one additional warm 55-page check after their first
document, retaining exact released text, geometry, exported PDFs and respectively
2.022% / 3.954% CER. These two checks cover both recognizer sizes; they are not
mirrored throughput comparisons or new accuracy claims.

### Same-session queued GPU verification

The follow-up uses one switchable HTML per host, keeping browser, workers,
models and GPU sessions alive while only the queue mode changes. Each of two
browser sessions executes six alternating ABBA/BAAB blocks of full 55-page
passes; the second session reverses the starting order. Both modes receive
untimed warmups before measurement. This adds 48 timed passes per host (24 per
mode): 5,280 timed pages and 660 untimed first/warmup pages across both machines.
Every pass is retained. The raw family is `frontier/queued-interleaved/`.

| Balanced browser WebGPU | Control pages/s | Two queued batches pages/s | Block-matched change | Blocks faster | CER |
| --- | ---: | ---: | ---: | ---: | ---: |
| Laptop i3-1315U / Intel UHD | 6.93 | 7.06 | +1.9% | 7/12 | 2.213% |
| Desktop Ryzen 2600X / RTX 3080 Ti | 18.11 | 19.08 | +5.2% | 10/12 | 2.302% |

Rates are total timed pages divided by elapsed time per mode. Block changes
compare the two control and two candidate durations, then take the geometric
mean across twelve blocks. Laptop session changes are -0.03% and +3.93%; its
block range is -8.1% to +16.8%, with +3.47% for ABBA and +0.42% for BAAB. This
does **not** establish a dependable laptop gain. The earlier +11.1% fresh-process
estimate is superseded. Desktop session changes are +6.31% and +4.17%; its range
is -8.9% to +14.0%, with +7.06% for ABBA and +3.44% for BAAB. The tighter repeats
support a modest desktop benefit, rather than a reliable shared-device default.
ABBA/BAAB reduces launch differences and linear drift; short-term contention
remains visible. Blocks are not independent samples of hardware populations.

The recognizer worker's summed model/ID-wait wall-time medians fall from 6.209
to 5.247 seconds on the laptop and 0.988 to 0.627 on the desktop. These counters
include command submission and mapping waits, not pure GPU execution. Concurrent
layout/render stages also vary, so the stage counters do not isolate the cause
of the remaining whole-document limits or prove a memory-bandwidth explanation.

All 96 timed passes retain exact released per-host text, positioned lines and
CER, with 156 model batches, 49,020,928 recognition pixels and zero new GPU
sessions. Worker counters verify 0 versus 156 queued batches and the requested
depth. Each session's exported PDF matches the released bytes. All 55 source
tests pass. The switchable HTML adds 1,592 bytes; the released HTML is unchanged.
The builder and private receipt verifier reproduce the mode/work checks. These
are browser GPU timings excluding startup, PDF opening, warmups and export;
native speed and new hardware/browser coverage were not measured in this repeat.
The prototype remains experimental; release assets and defaults are unchanged.

### Classifier, detector and cascade follow-up

This follow-up tests the remaining levers as separate artifacts. It retains the
entire 1,679-class alphabet and the existing recognition weights. All page scores
use the same 55-page PDF and 145,475 human-gold characters on the Intel UHD laptop.
These are browser WebGPU recognition measurements with CPU detection, excluding
startup, input opening, warmups and export; no native or desktop timing is added.
The released HTML and model inventory are unchanged.

Each completed candidate runs two browser sessions, with control/candidate
switching inside warmed workers and the starting order reversed. Both paths
receive full-document warmups. The integer variants have one ABBA and one BAAB
block (four warm passes per mode); classifier and cascade screens have two of
each (eight per mode). All passes are retained. Per-mode text and positioned
geometry are stable, and both modes pass all-page PDF text and original-pixel
gates. Worker counters prove which path ran. No timed pass builds a GPU session.

| Candidate | Block-matched page throughput | Page CER | Finding |
| --- | ---: | ---: | --- |
| Signed INT8 detector | -15.5% | 1.923% | Accuracy tradeoff; slower in both orders |
| Unsigned INT8 detector | -28.0% | 2.016% | Dominated by signed INT8 in these screens |
| Small recognizer / selective teacher | +3.2% versus Balanced | 2.845% | Also dominated by Fast in a separate comparison |
| GPU classifier / ArgMax fusion | -0.7% in longer confirmation | 2.216% | No dependable speed gain |
| GPU classifier / packed weights | +0.7% in longer confirmation | 2.216% | Opposite session changes; no dependable gain |
| GPU classifier / reuse + packing | +6.3% versus Balanced | 2.216% | Both sessions faster; 8/8 paired blocks |
| GPU classifier / reuse only | +4.8% versus Extreme | 3.949% | Both sessions faster; 7/8 paired blocks |
| Conv / HardSwish epilogue | Unmeasured | Unmeasured | Runtime build incomplete |

Balanced controls score 2.213% CER / 3,220 edits. Signed INT8 has 2,797 edits,
unsigned 2,933, the custom GPU head 3,223 and the cascade 4,139. The test set has
been examined in earlier experiments; these are candidate diagnostics rather
than a fresh holdout or evidence of broad hardware generalization.

**Detector INT8:** static per-channel QDQ convolution exports use 24 fixed,
uniformly spaced training pages from the existing detector cache. Four development
tensors check finite output and geometry changes; they are teacher outputs, not
human box gold. Integer calibration does not use transcripts or test pages.
The signed/unsigned models are 251,566 / 251,210 bytes. Both use the installed
stock full ORT 1.22 WASM engine, alongside a float control through that same
engine. This differs from the release's custom four-row/HardSwish CPU engine;
absolute page rates must not be compared across those builds as an INT8-only gain.

Signed control/candidate pooled rates are 5.65/4.87 pages/s; its session ratios
are 0.920/0.777. Unsigned rates are 5.14/3.72; ratios 0.777/0.668. Signed detection
returns 2,446 recognized lines versus 2,424 control, with 157 versus 156 batches
and the same 49,020,928 recognition pixels. Unsigned returns 2,442 lines,
157 batches and 49,283,072 pixels. Both return more lines than the float control.
Signed remains on the accuracy/size shortlist;
neither integer variant establishes a speed improvement.

**GPU classifier fusion:** separate feature graphs expose the tensor before the
last 1x1 classifier. A WGSL kernel computes the full classifier and reduces eight
timesteps in registers. A second variant splits classes into 64-lane partitions,
then combines their winners. Scores round to FP16 as in the original model.
Eight independent checks cover 64/128 channels, class/time tails, lowest-index
ties and optional top-two margins. The prepared 128-line screen uses complete
original graphs versus feature graphs plus the custom head. Classifier extraction
alone preserves every timestep ID; custom arithmetic changes 11/16,448 IDs on
identical real features. Full-page recognition changes only three character edits.
Both head screens retain exact raw detector boxes, 156 batches and 49,020,928
recognition pixels. The initial two-session screen disagrees (-3.0% / +15.1%),
and its apparent +5.7% aggregate does not survive the longer confirmation.
Two further browser sessions each run 24 passes, producing twelve ABBA/BAAB
blocks and 24 warm passes per mode. Pooled control/candidate rates are 9.93/9.85
pages/s; the matched change is -0.7%. Session changes are -2.74% / +1.33%; blocks
range -10.1% to +6.9%, with four wins. Raw boxes and inference work remain exact,
and no timed pass creates a session. This establishes no dependable laptop speed
gain. These high absolute rates belong to this matched run; they are not a speedup
caused by the new head. The owning family is `frontier2/head-confirmation/`;
the initial screen remains in `frontier2/head/`.

These timings use the frozen `runtime-frontier-head-measured.html`. The current
`runtime-frontier-head.html` adds an eight-byte CPU fallback selection guard and
has the same GPU computation. That rebuilt artifact receives the compatibility
checks below; throughput is attributed only to the measured artifact.

**Classifier workspace reuse:** two further laptop development sessions use
opposite starting orders and identical feature graphs/classifier arithmetic.
Each model has eight ABBA/BAAB blocks and sixteen timed passes per mode. Reuse
eliminates all 512 timed workspace allocations per model and retains 444,448
bytes under a 16 MiB cap. Sixteen numeric/tie/margin/resource checks per session
include growing/shrinking batches and concurrent calls. Both models preserve all
16,448 development IDs. The standard matched change is +0.07%, with session
changes -0.8% / +0.9% and five winning blocks. Light measures -1.25%, with changes
+0.3% / -2.8% and three wins. No dependable speed improvement is established.
Reuse remains optional and disabled by default. These are prepared-line results;
no additional full-page CER or speed is attributed to the reused workspace.
Receipts live in `browser/frontier2/fused-head-reuse/latest/`.

**Packed classifier weights:** the new shader stores pairs of existing FP16
weights in `u32` words and unpacks them into the same FP32 arithmetic. It uses
core WGSL packing operations, without a vendor feature or FP16 arithmetic
requirement. The custom standard head's weight allocation decreases from 859,648
to 429,824 bytes; light decreases from 429,824 to 214,912. These compare custom
head buffers, not total GPU memory or the released native FP16 classifier.
The HTML retains comparison models and makes no package-size reduction claim.

Two reversed-order development sessions each pass 32 numeric/tie/margin/resource
checks. Packed and unpacked heads return identical IDs on all 16,448 development
timesteps for both models. Standard prepared-line throughput improves 3.7%
(+4.7% / +2.7%, six winning blocks of eight). Light decreases 1.7%
(-2.2% / -1.2%, two wins). Workspace reuse is disabled in this comparison so
packing is the only changed lever. These dynamic four-line batches differ from
the page runtime's captured sixteen-line batches.

The standard page prototype first runs 32 warm passes, sixteen per mode in eight
ABBA/BAAB blocks, measuring 9.21 control versus 9.54 packed pages/s (+3.6%). A
longer confirmation adds 48 passes, 24 per mode in twelve blocks: 9.68 versus
9.74 (+0.7%). Session changes disagree (-2.3% / +3.7%); block changes range from
-3.9% to +6.8%, with six wins. All 80 timed page passes are retained. The initial
gain does not establish a dependable page-speed improvement. Both families keep
exact raw detector boxes, 156 batches, 49,020,928 recognition pixels and zero new
timed GPU sessions. Packed text and positioned output match the earlier fused
head, retaining 3,223 edits / 2.216% CER versus control's 3,220 / 2.213%.
Both modes pass full PDF text and original-pixel gates. The packed HTML also
passes four Chromium compatibility/fallback cases. No defaults are changed.
Prepared receipts live in `browser/frontier2/fused-head-packed/latest/`; page
families are `frontier2/head-packed/` and `frontier2/head-packed-confirmation/`.

**Captured-batch factorial follow-up:** broader component trials use the released
fixed batch of sixteen, 256px width grid, captured GPU sessions, GPU-resident
input and eight-shape/256 MiB owned-buffer budget. Two browser sessions reverse
model, profile and comparison order; each comparison has four ABBA/BAAB blocks.
Fresh buffers, buffer reuse, packed weights and both are checked separately on
the same feature graph, then the combined head is compared with the original
captured model. All fused variants preserve exact timestep IDs throughout timing.

| Recognition-component workload | Combined standard vs released | Combined light vs released |
| --- | ---: | ---: |
| 128 real development lines in width buckets | -0.01% | -6.34% |
| Sixteen narrow lines | -5.89% | -13.43% |
| Sixteen real lines padded to 2048px | +2.26% | -11.08% |
| Sixteen real lines padded to 4096px | +3.32% | -5.80% |
| Three valid lines in a fixed-sixteen body batch | +25.51% | +27.63% |
| Seven-width cache-pressure padding stress | 3.37 times | 3.43 times |

The padding profiles are diagnostic stress cases, not new human gold or page
speed. Timings exclude detection, input upload, PDF work and decoding. Ordinary
document batches do not establish a standard-head win. Light buffer reuse alone
is +4.59% versus the fresh custom head in four winning blocks; packing slows that
model. Full-page follow-ups therefore test light reuse and standard combined
separately rather than discarding both from the combined light result.

The six-width owned-buffer inventory falls from 251,789,312 bytes original to
35,790,848 standard / 26,877,952 light feature graphs. This excludes weights,
scratch, ORT intermediates and page textures. In the seven-width stress, original
captured sessions rebuild while the feature working set remains resident. Both
sessions confirm that cause; this does not establish 3.4 times page throughput.
Classifier scratch stays under its separate 16 MiB retention cap. Original/custom
arithmetic differences remain distinct from reuse/packing, which add no changed
IDs. Receipts, source snapshots and all profiles belong to
`browser/frontier2/captured-heads/latest/`.

**Full-page reuse/packing follow-up:** component findings motivate separate
standard combined and light reuse-only configurations. Each runs two fresh
browser sessions with sixteen timed 55-page passes and inverted starting orders:
eight paired blocks, sixteen passes per mode, with no discarded passes.

| Laptop browser WebGPU | Control pages/s | Candidate pages/s | Matched change | Wins | Control / candidate CER |
| --- | ---: | ---: | ---: | ---: | ---: |
| Balanced, reuse + packing | 9.50 | 10.10 | +6.30% | 8/8 | 2.213% / 2.216% |
| Extreme, reuse without packing | 11.73 | 12.30 | +4.80% | 7/8 | 3.954% / 3.949% |

Balanced's two session ratios are 1.06432 / 1.06159, with block ratios
1.03699-1.11200. Extreme's are 1.06639 / 1.02983, with blocks 0.98936-1.10261.
Both modes retain exact raw detector boxes and per-tier inference work:
156 / 157 batches and 49,020,928 / 49,283,072 pixels respectively, with zero new
timed GPU sessions. Per-mode text and positions are stable. Standard fused
outputs match the earlier fused text/positions, retaining three extra character
edits; light has seven fewer edits than released FP16. Reuse/packing preserve
all development timestep IDs. All PDF text,
original first-page pixels and module-worker reopening gates pass.

The first Extreme screen completes its sixteen timed passes and PDF gates before
a separate hosted PNG check encounters a harness assumption that PNG exposes PDF
document-line metrics. Those completed passes stay included. The harness now
collects document geometry only for PDF calls; subsequent hosted PNG/tier checks
pass. This is distinct from the measured OCR path. Owning page families are
`frontier2/head-combined/` and `frontier2/head-reused-extreme/`.

These results support keeping both configurations on the shortlist. They do not
establish other-device speed, a native improvement or a universal ten-page rate.
No released default is changed. Earlier fresh-head and packed-only confirmations
remain preserved alongside these new combined/reuse configurations.
Each configuration additionally passes four Chromium compatibility cases: CPU
offline, hosted GPU and injected GPU initialization/run failures recovering on
CPU. The light cases explicitly select Extreme, and GPU work counters confirm
that the candidate head actually runs.

**Recognition cascade:** a GPU top-two-margin reduction is independently checked
against full-alphabet numeric/tie expectations. The small model runs first; a
frozen lower-quartile emitted-character margin rule retries selected lines with
the accurate model. Both model passes, packing, metadata readback, decoding and
routing are charged. The gate is selected only on the existing 128-line ordinal
development sample, using its human transcripts. Those crops originate from
automatic Kraken geometry; no claim of gold line boxes is made.

On 7,561 development characters, the teacher scores 1.759% CER (133 edits),
small 2.328% (176), and the chosen policy 1.653% (125), retrying 15/128 lines.
The fixed threshold is 3.1875; both tested development accuracy allowances select
the same rule. Prepared-line elapsed means are 0.244 seconds for the teacher and
0.188-0.193 for the cascade, with both execution orders. This is not a page rate.

On full pages it retries 263/2,424 lines, adding 24 teacher batches to 156 small
batches and executing 56,492,032 total input pixels. It wins all four matched
page blocks, but only by 1.3-6.1%, with session gains of 2.8%/3.7%. Pooled page
rates are 8.00/8.28. CER rises by 919 edits to 2.845%, so the development gate
does not qualify for Balanced. It needs more representative development
calibration before any accuracy claim. The prototype reuses the already-packaged
models and adds 3,802 HTML bytes; it introduces an additional GPU model cache.

A separate Pareto comparison switches the control to the existing Fast tier,
retaining the same captured recognizer sessions. It has eight warm passes per
mode, four ABBA/BAAB blocks and 880 timed pages across two browser sessions.
Fast scores 2.332% CER (3,393 edits) at 10.356 pages/s; the Balanced cascade
retains 2.845% CER (4,139 edits) at 10.339. Matched throughput differs by -0.1%,
with session changes +2.5% / -2.7% and two winning blocks. Fast offers equivalent
speed with better accuracy in this laptop case, so the frozen cascade is
dominated rather than a useful new tier. This comparison intentionally changes
detector resolution with the tier; raw boxes are not expected to match across
the two modes. Both retain stable per-mode output and pass PDF gates. The owning
family is `frontier2/cascade-versus-fast/`.

**Conv/HardSwish fusion:** the graph combines 31 one-consumer Conv/HardSwish pairs
without changing initializer values. The custom MLAS activation combines bias
addition with HardSwish in one epilogue, retaining separate float multiply/add
rounding. Its source patch and expanded operator inventory are prepared, and the
one-job cached build was interrupted before linking. Temporary source patches
were reversed. No completed runtime, independent tensor parity, page timing or
CER is claimed for this candidate.

The owning private family is `browser/full-test/latest/laptop/frontier2/`; kernel
and development receipts live under `browser/frontier2/`. All 56 browser source
tests and experiment syntax checks pass. The rebuilt head passes four Chromium
cases: offline CPU, hosted GPU and CPU recovery from injected GPU initialization
and run failures. Each exports both pages with original pixels and OCR text.
Three Firefox cases fail in automation while opening a page, before loading OCR;
they provide no Firefox runtime result. Cascade portability was not run after
that failure. A separate blank-page prerequisite check reproduces the Firefox
failure both with and without an injected initialization script. Wider
browser/device coverage remains open. No release or
hosted-demo update follows these screens.

## Five-tier release and native integration

The browser/model packages are published in
[v0.2.0](https://github.com/eliziff/legal-browser-ocr/releases/tag/v0.2.0).
Its README compares Balanced and Quality with the untouched stock Indra
recognizer in the same pipeline and Tesseract.js Fast. The native implementation
and package builder live in `legal-pdf-parser`, with a Windows x64 executable and
CPU/DirectML libraries. Both runtimes consume the same model inventory.

The original v0.2.0 desktop measurements below reuse the frozen 55-page PDF and
145,475 human-gold characters. Native OCR includes PDF rendering, learned detection,
crops and recognition. Its three-pass warm medians exclude startup and parser
structure/cache work. The default backend and pool plan calibrate on each machine.

| Native OCR | Pages/s | CER | Selected recognizers / detectors |
| --- | ---: | ---: | ---: |
| Balanced CPU | 8.22 | 2.546% | 6 / 4 |
| Balanced automatic, DirectML | 10.92 | 2.548% | 4 / 2 |
| Quality automatic, DirectML | 10.73 | 2.258% | 4 / 2 |

Automatic startup took 9.5–10 seconds on the desktop. On the i3-1315U/12 GB
laptop it selected CPU, with four recognizers and three detectors: 4.31 pages/s
on the first document after 36.7 seconds of startup. Driver initialization and
shader compilation remain expensive; calibration is reused within a process.
Native Extreme measured about 5.0% CER, distinct from the browser's 4.784%.

The final extracted Windows ZIP recheck measured Balanced CPU **8.34 pages/s /
2.546% CER**, automatic GPU **10.90 / 2.548%**, and Quality automatic GPU
**10.70 / 2.258%**, each over three warm passes. Automatic startup was 9.4–9.9
seconds. Balanced selected two GPU recognizers with batch 64 in this recheck;
Quality selected four with batch 32, both with two detectors. The 26,275,138-byte
archive has SHA-256
`856ea08467b7e8623b915530df91b9157acff73da403f2a461b9f8fb717393c9`,
matching GitHub's published digest. All five CPU tiers also passed the extracted
package's invented-scan CER and overwrite/inventory checks.

Full `documentProjectionService.preparePdf` profiling found an additional 2.2
seconds spent scanning separators after OCR. Prefetching the existing 150 dpi
raster cache concurrently with OCR preserved the separator algorithm and
recognized text/word geometry exactly. Paired single warm passes improved
DirectML from **5.34 to 6.44 pages/s** and CPU from **4.97 to 5.77**. Those controls
use the explicit desktop plans above. This path also includes structure and
application persistence; its degraded structure status is not filing readiness.
Receipts and frozen comparison hashes live in private
`native/authorities/{baseline,latest}/`.

The full standalone Authorities HTML now uses released Indra models, offscreen
PDF.js 6.3 rendering at 144 dpi and CPU/WebGPU workers. On the same desktop,
four GPU detector/recognizer pairs reached **13.40 pages/s / 2.477% CER** over
three fresh-source warm passes; one pair reached **4.63 pages/s**. These numbers
include rendering, OCR, text assembly and page-cache writes, excluding Rust
structure/export. The pool control reported eight cores and 8 GB to exercise
the existing four-pair policy, rather than imposing it on every computer.
The full HTML and Lite both passed offline OCR; Lite's independently invented
scan also passed searchable-PDF readback and screenshot inspection.
The Windows standalone package was built locally and passed native loading,
loopback startup, draft creation and OCR through its bundled DLL/models on that
invented scan. Its native probe uses the shared transport adapter and an isolated,
disposable parser cache. The combined Authorities app release remains separate
from the published OCR runtime while the other Authorities changes are unfinished.

Partial-page native OCR fetches logits for real confidence scores, preserving
the existing picture/print filter. The invented cropped-title fixture passes
on CPU and DirectML. Whole-page compact-ID decoding remains the fast path.
The 14 OCR behavior tests, CLI crop/rotation/UserUnit check, installer inventory
check and provenance mutation gate passed. Broader frontend/backend TypeScript
checks still report unrelated existing Vite implicit-any and S3 client errors.

## Native startup update (v0.2.1)

The October 19 update uses provider and hardware-capability checks for automatic
selection, Windows' high-performance adapter order and CPU-capacity worker
limits. Integrated and FP16-emulating adapters default to CPU. Detector and
recognizer pools load concurrently; successfully opened GPU sessions are retained.
Explicit settings still override the defaults.

| Fresh-process Balanced latency, desktop | Frozen v0.2.0 | v0.2.1 |
| --- | ---: | ---: |
| GPU initialization | 9.492 s | 0.771 s |
| CPU initialization | 3.476 s | 0.242 s |
| GPU first-page CLI wall time | 10.339 s | 1.640 s |
| CPU first-page CLI wall time | 3.932 s | 0.706 s |
| First 55-page GPU document including initialization | 14.396 s | 5.794 s |

First-page candidate values are medians of three fresh processes; the old
first-page control is one frozen process. Initialization excludes process launch
and input loading. These runs reuse an already-used machine and may benefit from
filesystem and driver caches. Quality GPU initialization was 0.772 seconds and
its first-page command finished in 1.647 seconds.

Three-pass warm medians remain 8.27 pages/s / 2.546% CER for Balanced CPU,
11.00 / 2.548% for Balanced automatic DirectML, and 10.90 / 2.258% for Quality
automatic DirectML. The input, models and scoring are unchanged. All 55 pages'
text, confidence and geometry exactly equal the frozen CPU and GPU controls
with matching execution plans. The i3-1315U laptop selected CPU with four
recognizers and three detectors, initialized in 0.32-0.83 seconds and measured
3.90 pages/s warm under its current background load.

The 14 OCR tests and 12 source-mutation provenance checks plus DOCX isolation
passed. The extracted package passed every CPU tier and automatic selection on
both machines. A hash-valid invalid GPU graph forced initialization failure and
returned the same CPU text, confidence and boxes. The standalone package was
rebuilt with the new addon and passed native loading, loopback startup and OCR
from its bundled assets. A final native application pass took 8.907 seconds for
the first 55-page preparation and 8.329 seconds on a fresh-source warm pass
(6.60 pages/s), including structure and cache work. Its text and complete word
geometry hashes match the prior DirectML prefetch control exactly; the structure
status remains degraded. These are single integration passes. Raw inputs and receipts remain in private
`native/startup/` and `native/package/latest{,-desktop}/`; reproduction commands
are in the harness README.

## Pixel transfer and parallel rendering follow-up (v0.2.2)

The October 19 laptop profile found 133.6 summed recognition-worker seconds in
crop/tensor preparation versus 35.0 in inference. Recognition repeatedly drew
GPU-backed page bitmaps into CPU canvases. Reusing one CPU-backed page canvas per
recognition task reduced that transfer cost. All timing figures below still
include PDF rendering, learned detection, line preparation and recognition.

| Browser on i3-1315U / Intel UHD | Warm pages/s | CER |
| --- | ---: | ---: |
| Original worker, quiet CPU control (one warm pass) | 1.284 | 2.506% |
| Updated default CPU (three-pass median) | 3.887 | 2.513% |
| Updated default automatic GPU (three-pass median) | 5.039 | 2.512% |

The updated first GPU document took 13.672 seconds, plus 2.663 seconds of model
initialization; input opening and export are separate. Initial measurements
while another build ran were 1.123 pages/s for the original CPU worker and
3.692 / 4.488 for the updated CPU / GPU. CPU pageBatch=2 reached 3.993 under that
load, while pageBatch=4 with bucket=64 fell to 3.664. Two GPU detector workers
reached 4.150; two recognition workers plus two detectors reached 4.249.
Batch=64 reached 4.646. Those overrides were not promoted into default policy.

Padding GPU tensor widths to 64 or 128 reduced the number of distinct input
shapes from 76 to 46 or 36, but measured only 4.284 / 4.683 pages/s, with first
documents of 14.521 / 18.612 seconds. The 8-pixel default measured 5.039 and
13.672 seconds. A raw full-page array scan was also rejected: it changed crop
sampling and measured only 1.715 pages/s on the desktop CPU. The accepted change
retains the existing crop and resize path.

| Native on Ryzen 5 2600X / RTX 3080 Ti | Before pages/s | After pages/s | CER |
| --- | ---: | ---: | ---: |
| Balanced automatic GPU | 11.016 | 13.731 | 2.548% |
| Balanced CPU | 8.271 | 8.280 | 2.546% |
| Quality automatic GPU | 10.903 | 12.097 | 2.258% |

Native rendering now uses remaining CPU capacity, up to four renderers, with one
shared parsed PDF, thread-local render caches and bounded ordered windows.
GPU initialization remains 0.798 seconds; its first full document including
initialization took 5.000 seconds. All 55 CPU/GPU pages equal the frozen controls
exactly, including confidence and word geometry. Nine independently invented
rotation/crop/UserUnit pages also match v0.2.1 exactly. Four detector workers and
two recognizers measured 13.592, offering no gain over the default allocation.

The 14 native OCR tests and 31 browser source tests pass. Browser measurements
check all 55 exported text pages and unchanged first-page pixels. Private raw
outputs and hashes remain in the owning `runtime-speed/` receipt directories.
The browser and Windows OCR packages are published in
[v0.2.2](https://github.com/eliziff/legal-browser-ocr/releases/tag/v0.2.2), with
GitHub asset digests checked against all five local release files. The shared
model manifest remains byte-identical to v0.2.0.

The final linked application addon retained the prior DirectML OCR text and word
geometry hashes. Its current full application pass measured 7.656 seconds cold
and 7.856 pages/s on one fresh-source warm pass, including structure and cache
writes; that addon also includes the other agent's current query work, so this is
an integration result rather than an isolated rendering comparison. The native
standalone package passed loopback startup and OCR using its bundled assets.
Both standalone browser HTML builds now embed the v0.2.2 worker; the full HTML
recognized all 55 laptop pages offline on automatic WebGPU in 23.355 seconds on
its first use, at 2.452% CER, with a 0.026-second cache hit. These application
figures include their host work and are separate from the direct browser table.
The combined Authorities app release remains pending the other Authorities work.

## Browser pipeline follow-up (v0.2.3)

The browser-first follow-up keeps the released recognition/detection weights,
full recognition width and fractional Canvas crop sampling. PDF.js now receives
an explicit module-worker port in the embedded HTML. Its automatic setup had
fallen back to a fake worker when opened from disk. GPU document processing uses
fixed, ordered four-page groups with two bounded groups in flight, overlapping
CPU detection and crop preparation with one GPU recognition session. Detection
uses at most two CPU workers in GPU mode, reduced on browsers reporting fewer
cores; CPU recognition retains the existing core-based limits.

The same frozen 55-page PDF and 145,475 human-gold characters produced these
three-warm-pass medians. Timings include rendering, detection, preparation,
inference and text assembly, excluding input opening, model startup and export.
The laptop used Chromium 149 and Intel UHD WebGPU; the desktop used Chromium 151
and the RTX 3080 Ti. Actual adapter information confirmed hardware acceleration.

| Browser configuration | Warm pages/s | CER | First document | Model initialization |
| --- | ---: | ---: | ---: | ---: |
| Laptop Balanced CPU | 4.547 | 2.513% | 13.424 s | 1.821 s |
| Laptop Balanced automatic GPU | 6.055 | 2.512% | 11.338 s | 2.708 s |
| Desktop Balanced CPU | 7.725 | 2.601% | 8.556 s | 2.910 s |
| Desktop Balanced automatic GPU | 12.731 | 2.606% | 6.655 s | 3.253 s |
| Desktop Quality automatic GPU | 9.515 | 2.252% | 7.523 s | 3.236 s |

The final laptop GPU passes were 6.170 / 6.029 / 6.055 pages/s; desktop GPU
passes were 12.304 / 12.731 / 12.821. Frozen v0.2.2 GPU controls measured 5.458
and 8.561 respectively, giving 10.9% / 48.7% improvements, with identical text
hashes on each machine. CPU and GPU detection have slightly different line
coordinates. Desktop final GPU geometry also matches its frozen control.
All 55 exported text pages, original first-page pixels, repeated recognition
and PDF reopening passed. Browser source tests passed 35/35. The self-contained
HTML has SHA-256 `7e4060a0e54f06bf40d298679154e279e4a7458d28d0fa430e47b79275e7b199`.

The crop-worker ablation measured 5.888 pages/s on the laptop over three warm
passes and 10.242 on the desktop over one. It is a modest laptop gain and a
larger desktop gain. Raising recognition batch size from 32 to 64 reduced the
laptop screen from 5.938 to 5.618. The released default stays at 32. Earlier
tests during a separate eight-core citator build are retained privately but
are excluded from the accepted comparison. That process completed normally;
its scheduling was never changed.

Other investigated candidates remain experimental:

- A parallel WGSL ArgMax reduction uses 64, 128 or 256 lanes with first-index
  tie handling. Independent numeric checks cover 1x1 through 4096x1680 tensors.
  Including result download, the 128-lane component measured 4.1 ms versus
  stock's 7.6 ms on the laptop. It did not improve the ordinary page pipeline;
  the default retains the existing compact-ID graph. A desktop combination
  of two GPU recognizers, CPU detection and the kernel measured 9.329 pages/s,
  below the accepted pipeline. Component speedups do not establish page gains.
- Verbose node placement showed that ORT 1.22 automatically decomposes
  HardSwish; the detector was not doing 31 CPU HardSwish fallbacks. Its actual
  non-metadata CPU operation was Softplus. Replacing it with the stable
  `relu(x) + log(1 + exp(-abs(x)))` removed that fallback. FP32 and FP16
  detector variants measured 8.851 / 8.866 desktop pages/s in the older page
  pipeline, versus controls of 8.517 / 8.616, with worse initial latency.
  These graphs were not promoted.
- ONNX Runtime Web 1.30 offers a genuinely different C++ GPU backend, including
  JSPI, separate from its existing TypeScript JSEP backend. With stable fixed
  page groups, JSPI measured 4.706 laptop pages/s / 2.513% CER versus the frozen
  1.22 control's 5.458 / 2.512%. It is not the released backend. The initial
  variable-batch run changed a character between passes and failed the strict
  text-stability gate; that failure was not waived. See the upstream
  [backend migration design](https://github.com/microsoft/onnxruntime/blob/v1.30.0/docs/design/onnxruntime_web_jsep_to_webgpu_ep_migration.md).
- Crop atlases, canvas reuse, CPU rasterization and pipelined GPU-output
  downloads gave no convincing full-document improvement. Their production
  branches were removed; the private source patch and receipts retain them.

Private receipts live in `browser/full-test/latest/{laptop,desktop}/runtime-speed/`;
`v023-final/` is the accepted HTML run. The dedicated crop worker is packaged as
`preparation-worker.js`; native runtime behavior is unchanged in this follow-up.

[v0.2.3](https://github.com/eliziff/legal-browser-ocr/releases/tag/v0.2.3) is
published with all five asset digests verified; the Windows native ZIP is
carried forward byte-for-byte from v0.2.2. GitHub Pages built commit
`21326cc46311eced0a47c495562fab43d074a315`. Its live HTML matches the released
HTML hash above. An independently invented PDF passed repeated live recognition
and exact recognized-text export with networking disabled after app loading;
that deployment smoke is separate from the real-document accuracy benchmark.

The remaining laptop stages still justify further experiments. Its final
9.084-second median document pass contains about 5.0-5.2 seconds of serialized
recognizer runs and 4.0-4.5 crop/preparation worker seconds. Detection consumes
about 11.7-13.0 summed worker seconds across two workers. These stages overlap;
their durations are not additive wall-time savings. Candidate next steps are
GPU crop/resize/normalization feeding GPU-resident input tensors, a detector
worker sweep followed by detector pruning/distillation, static-shape graph
capture after removing CPU data fallbacks, and a guarded single-image PDF fast
path. [ORT documents GPU input tensors and preallocated outputs](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html);
its [graph capture guidance](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
requires static shapes and GPU-supported computing kernels. Our current dynamic
width graph is not eligible merely by setting a flag. These were unmeasured at
v0.2.3; the next section records their subsequent trials.

## Scan-PDF, GPU preparation and graph-capture experiments

All four proposed levers were tried using the same 55-page PDF, full recognition
width and human transcripts (145,475 normalized characters). These remain
experimental; v0.2.3 and the hosted application have not been replaced by these
results. The self-contained candidate uses stock line detection and the existing
fine-tuned recognizers. No test page or transcript selected detector weights.

| Experimental WebGPU candidate | Warm pages/s | Page CER | First 55-page document | Initialization |
| --- | ---: | ---: | ---: | ---: |
| Laptop Balanced | 8.653 | 2.498% | 10.398 s | 2.274 s |
| Laptop Quality | 6.313 | 2.237% | 15.067 s | 2.564 s |
| Desktop Balanced | 18.022 | 2.598% | 7.275 s | 3.049 s |
| Desktop Quality | 15.411 | 2.251% | 7.474 s | 3.017 s |

These are medians of three warm passes: laptop Balanced 8.982 / 8.653 / 8.064,
desktop Balanced 18.230 / 18.022 / 17.892, and desktop Quality 15.411 / 15.254 /
15.443 pages/s. Laptop Quality varied substantially: 5.585 / 7.262 / 6.313.
They include rendering, detection, preparation, inference and
text assembly, excluding input opening and PDF export. Initialization is also
excluded from the first-document column. First-document throughput is only
5.29 / 3.65 / 7.56 / 7.36 pages/s in table order: lazy shape-session setup is a real
cost, so warm throughput alone does not describe first use.

The frozen v0.2.3 laptop control measured 5.921 pages/s in an earlier screen and
5.810 over three later passes, at 2.512% CER. The desktop frozen control with
four CPU detectors measured 15.880 / 2.606%, with a 6.572-second first document.
The combined candidate improves warm throughput but makes this desktop first
document slower. Comparisons with the older released 6.05 / 12.73 GPU figures
also include different worker settings and session conditions; do not attribute
that entire difference to one kernel.

The mechanisms and ablations were:

- **Scan-page image path:** inspect PDF.js's operator list and use its decoded
  image for a single full-page scan with ordinary transforms. Text overlays,
  annotations, clipping, masks, multiple images and unsupported transforms use
  normal PDF.js rendering. Tests compare exact rendered pixels for rotations,
  odd dimensions, UserUnit and staged downscaling. The real document used the
  fast path on 54 pages, retaining identical text and line geometry on the
  laptop. Scan-only measured 6.702 laptop pages/s in a three-pass repeat and
  15.317 on the desktop with four detectors. A later desktop control reached
  15.880, so an isolated desktop throughput gain is not established. CPU-only
  laptop recognition remained about 4.40 pages/s.
- **Detector worker sweep:** three/four CPU detectors measured 5.056 / 5.641
  laptop pages/s, below its two-worker control. On the 12-thread desktop,
  three/four measured 14.272 / 14.782 in screens, and the four-worker repeated
  control reached 15.880. All retained per-machine text and CER. A core-bounded
  limit of four merits integration; hardcoding four for every laptop does not.
- **Static shapes and graph capture:** a copied browser GPU graph accepts an
  external floating-point mask instead of calculating it from integer widths.
  Original and modified CPU logits were array-exact at three independent
  shapes; the shared native GPU graph is untouched. Fixed batches of 16,
  widths padded to 256, persistent GPU buffers, graph capture and the custom
  128-lane GPU ArgMax measured 7.728 laptop pages/s with CPU preparation. A
  static-buffer screen without capture measured 7.157. Desktop CPU-prepared
  capture measured 15.628, essentially its 15.880 control. The bounded cache
  keeps at most four shapes and 256 MiB of owned input/mask/output buffers;
  ORT intermediates, model weights and page textures are additional memory.
- **GPU preparation:** WGSL scans ink bounds, resizes, converts to grayscale and
  packs normalized tensors without downloading page pixels. Only line metadata
  and final class IDs return to the CPU. Preparation fell to about 0.7 seconds
  summed over the document, but using it without static capture slowed the
  laptop to 5.286 pages/s. With capture, repeated medians were 8.078 laptop /
  17.931 desktop, followed by the bounded-candidate results in the table. One
  earlier desktop pass dropped to 8.042; the later three-pass repeat was
  18.035 / 17.931 / 17.327. GPU and Canvas fractional resampling differ: integer
  test pixels are exact; the independent fractional fixture has mean normalized
  pixel delta 0.003252 and maximum 0.109804. Full-page CER improves by only
  20 laptop and 12 desktop edits; this is not evidence from a fresh holdout.

A separate **8,115-parameter detector student** was distilled from stock Indra
predictions on the existing 538 training and 68 development pages, never the
55 test pages. Page and article overlap are zero. It stopped after 25 epochs
with six non-improving development epochs, selecting epoch 19. Its 45,054-byte
ONNX export passed PyTorch parity at two dynamic shapes. Human transcripts
then exposed unacceptable page CER: **5.203% laptop / 5.220% desktop**, versus
about 2.5-2.6% with stock detection. Desktop speed reached 20.524 pages/s in a
screen, but laptop speed fell to 7.676. It is not promoted to a default tier;
its size, accuracy and speed remain recorded for Pareto comparisons. Its targets
are teacher predictions, not human geometry gold; the older Kraken boxes were
not promoted to gold or used as the detector target.

All completed page tests passed stable repeated text, offline recognition,
all 55 exported text pages, original first-page pixel preservation and PDF
reopening. The current browser source suite passed all 44 tests, including GPU
allocation failure cleanup and the shared embedding pools. These measurements cover Chromium 149/151 on the
two existing machines. Actual GPU-init/device-loss recovery and Firefox/WebKit
validation remain separate portability gates. Keep the WASM baseline and
capability-based optional acceleration; a successful adapter query alone does
not prove that a model can run. ORT documents its
[WASM browser baseline](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)
and [cross-origin isolation requirement for threads](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html).

The initial frozen candidate is `dist/runtime-speed-gpu-capture-control.html`, SHA-256
`c3e7e048a289e00e9130475f71b88e9ecd8fc1b219d604be62f8696468699d9f`,
using `scanPages=1&gpuCapture=1&gpuPrep=1` and `layoutWorkers=4` on the desktop.
It is an HTML-only prototype; the older archive digest in the desktop receipt
does not identify a newly built runtime archive. Private receipts live under
`browser/full-test/latest/{laptop,desktop}/frontier/`; detector training and its
hash-bound derived cache live in `detector-student/`. Builder sidecars bind the
copied models to their source hashes. Shared models and public packages retain
their existing contracts and defaults.

### A larger detector paired with the accurate recognizer

The intended Extreme alternative retains the accurate eight-block recognizer
and spends accuracy on faster line detection. Combining the original tiny
detector with the smaller Extreme recognizer was a separate, unsuccessful
control: about 11.3-11.4% CER, with no desktop speed advantage over stock Extreme.

The middle detector increased channels from `[8,16,24,32]` to `[12,24,36,48]`:
16,299 parameters and 77,800 ONNX bytes, trained at 768px. Thirty epochs selected
epoch 28 on development loss. Its initial 6.0% page CER was still too high.
Refinement from those weights used binary teacher core targets with BCE plus
Dice overlap loss, keeping the distance regression target. This is a standard
text-segmentation loss family; see
[PaddleOCR's DB loss](https://github.com/PaddlePaddle/PaddleOCR/blob/main/ppocr/losses/det_db_loss.py).
Ten further epochs selected epoch 4. Development-only threshold calibration
maximized matched-box IoU against teacher predictions, folding the chosen
threshold into the final core bias without adding operators. CER fell to
3.349% desktop / 3.359% laptop, but speed was only 18.967 / 8.704 pages/s.

Pruning the expensive stem and final high-resolution features to eight channels,
while retaining the larger deeper features, produced `[8,24,36,48]`:
**15,891 parameters / 76,166 ONNX bytes**. Twenty-five further epochs selected
epoch 19. Its development-calibrated core threshold is 2.75. All training uses
the same 538/68 pages, and cache hashes reject changed teacher inputs. Both
dynamic-shape export parity and the calibrated bias equivalence checks pass.

The new profiles exposed GPU shape-cache churn. With four cached shapes, the
pruned middle model rebuilt ten GPU sessions per warm document on both machines.
Allowing eight shapes, still capped at 256 MiB of owned buffers, reduced that
to four laptop / zero desktop builds. Text and positioned-line hashes are exact
between cache settings. At 768px, median throughput improved from an 8.181
laptop / 18.980 desktop screen to **9.151 / 21.549** over three warm passes,
with unchanged **3.580% / 3.583% CER**. A 128px tensor-width grid increased
rebuilds to seven / six and reached 9.643 / 19.932; it is not a universal
improvement. The final comparison retains 256px width buckets.

At 736px, the trained detector reaches the intended accuracy range:

| WebGPU profile, eight cached shapes | Desktop warm pages/s | Desktop CER | Laptop warm pages/s | Laptop CER |
| --- | ---: | ---: | ---: | ---: |
| Middle detector 736px + accurate recognizer | 22.221 before / 21.689 after | 4.521% | 11.644 | 4.595% |
| Stock Extreme, 768px + smaller recognizer | 20.791 | 4.806% | 12.483 | 4.795% |
| Stock Turbo, 768px + accurate recognizer | 20.716 | 3.121% | — | — |

All rows use three warm passes, the same GPU capture/preparation/scan path and
per-machine detector budgets. Desktop candidate passes before the controls were
21.948 / 22.221 / 22.761, and after were 21.930 / 21.689 / 21.522; Extreme was
20.698 / 20.791 / 20.855. This is a **modest 4.3-6.9% desktop speed gain** and
0.285 percentage-point CER improvement over Extreme. The laptop candidate is
6.7% slower, with a 0.201-point CER improvement. It is a desktop GPU candidate,
not a justified replacement across machines. First-document times are 6.755 s
desktop / 8.850 s laptop, plus 3.008 / 2.225 s initialization. Extreme takes
7.007 / 8.598 s plus 2.733 / 2.080 s; desktop cold totals are essentially equal.

A stock-detector 704px control with the accurate recognizer reached 3.772%
desktop / 3.767% laptop CER, but its page rates drifted: desktop 19.614 and
laptop 11.454 before / 9.716 after a control. A nearby laptop Extreme control
also rose from 9.824 to 12.425. Those laptop sessions do not establish a speed
win from the lower stock resolution. Inference using the pruned middle detector
at 704px reached 18.251 / 5.459% on desktop, outside the target accuracy range.

The frozen trained candidate is `dist/runtime-speed-detector-middle-fast-before-direct.html`
with SHA-256 `54fc769881fd82eb6a9e314fee174eb79230dfd8b26f49658044277fac65a961`,
using `tier=turbo&detectorSide=736&gpuCapture=1&gpuPrep=1&scanPages=1&gpuCache=8`
and `layoutWorkers=4` on desktop. It intentionally uses the accurate recognizer;
the Turbo label selects that recognizer rather than the smaller Extreme one.
The matching stock-control HTML has SHA-256
`f7ddec6d088427dbdb167ad9ee1bb80a852d5d57cc857d2319efce9377041bc3`.
All selected page cases passed offline recognition, stable text and searchable-PDF
text/pixel gates. The model and HTML remain experimental and unpublished.

A mirrored laptop repeat (Extreme, middle 736px, stock 704px, then reverse order)
helps distinguish the accuracy tradeoff from drifting speed. Pooled medians of
six warm passes per setting were:

| Laptop WebGPU setting | Warm pages/s | Range | Page CER |
| --- | ---: | ---: | ---: |
| Stock Extreme | 10.219 | 8.233–11.155 | 4.795% |
| Middle 736px, accurate recognizer | 9.712 | 8.055–10.117 | 4.595% |
| Stock 704px, accurate recognizer | 10.292 | 8.880–10.717 | 3.767% |

The middle model trades about 5% throughput for 0.201 percentage points less
error than Extreme in this repeat; speed ranges overlap. The stock 704px
configuration is the stronger laptop Pareto candidate here. The middle model's
desktop result remains useful evidence rather than a universal tier choice.
Receipts live in `frontier/pareto-repeat/`; all original candidates are retained.

### Direct GPU input, repeated with an identical build

The input experiment writes crop tensors directly into the persistent captured
session buffer instead of copying from a second GPU buffer. Direct and allocated
preparation outputs match bit for bit on both machines. A before/after comparison
using different builds had substantial drift, so it did not establish a regression.

A same-build copy/direct/direct/copy sequence used frozen HTML SHA-256
`6af4b32b1a770ba022704eca68659fdce9ed8584f1288f2d6af5234c6a4b81db`.
Each case has three warm 55-page passes. Pooling six passes per setting gives
about 16.26 copy versus 16.12 direct pages/s on desktop, and 6.24 versus 6.34 on
laptop. The roughly 1–2% differences have overlapping ranges and opposite signs.
Text and geometry match, with 2.598% desktop / 2.498% laptop CER. No general gain
or regression is established; `gpuDirect=1` stays experimental. Fenced component
latency includes queue synchronization and does not isolate GPU copy cost.

### Browser portability and CPU thread allocation

The current browser pool retries GPU initialization/device-loss failures through
one shared CPU recovery, including pending page work and embedding hosts.
The application retains a canvas replay callback so successful GPU recognition
does not require cloning every bitmap. The embedding API retains a replay copy.
Cancellation disposes recovery and workers. The app and embedding API retain
their shared worker policy.

Fourteen real Chromium 149 / Firefox 151 cases pass: offline recognition,
hosted automatic selection, Extreme, GPU initialization/run failures, embedding,
a two-core CPU budget, and JavaScript decompression fallback where applicable.
All app cases retain recognized PDF text and original first-page pixels.
These are invented compatibility fixtures, not accuracy measurements. Windows
WebKit 26.5 lacks the required worker OffscreenCanvas path; Safari on Apple
hardware is not validated. No claim of universal browser coverage is made.

On hosted COOP/COEP pages, the app now passes requested inference threads into
recognition workers. The laptop allocation sweep measured 4.408 before / 4.192
after pages/s for four one-thread workers, versus 3.024 for two two-thread
workers and 2.681 for one four-thread worker. All retain 2.513% CER and identical
text/geometry. This supports keeping the existing one-thread-per-worker default
on this machine; it does not select a global policy from one laptop.

### Smaller standalone packages

Self-contained assets are gzip-compressed individually and decoded lazily, using
native decompression or the bundled existing pako fallback. File-loaded workers
receive data URLs; hosted workers share revocable blob URLs. A blob app module
also fixes ORT 1.22's invalid `file:` origin base on Firefox. Native base64
decoding and FileReader avoid callback-per-byte decoding/re-encoding at startup.

The CPU-only editions omit GPU runtime/models and optional Tesseract layout,
retaining Indra detection and PDF input/export. Full keeps CPU/WebGPU and all
five tiers. A separate minimal ORT 1.22 engine reduces WASM from 8,869,550 to
1,514,068 bytes (83%); gzip is about 0.52 MB. It retains the custom four-row
SIMD matrix kernel. Preoptimized portable ORT graphs use EXTENDED optimization,
excluding architecture-specific level-3 layout transforms. Two generated dynamic
shapes per model establish exact conversion output, followed by actual browsers.
The original-weight compact package reproduces full-package 55-page text and
positioned geometry hashes exactly.

Rounding recognizer initializer values to FP16 or BF16 and storing them back in
FP32 improves gzip compression without adding quantized operators or requiring
FP16/BF16 CPU instructions. Detector values are unchanged. Conversion parity
checks refer to each precision variant's graph; rounding itself is lossy and
requires human-transcript accuracy checks. All 3,165 development lines score:

| Recognizer | FP32 CER | FP16-rounded CER | BF16-rounded CER |
| --- | ---: | ---: | ---: |
| Accurate | 1.4023% | 1.4023% | 1.4023% |
| Smaller | 2.3788% | 2.3788% | 2.3762% |

The smaller BF16 packages qualified on development accuracy before full-page
evaluation. The FP16 variants remain retained alternatives; only their development
accuracy is measured. All computations and activations remain FP32.

| HTML edition | Disk MB | Gzip MB | Capabilities |
| --- | ---: | ---: | --- |
| Previous full offline HTML | 58.93 | — | Released five-tier CPU/WebGPU |
| Current full | 22.84 | 16.84 | Five-tier CPU/WebGPU |
| CPU, unchanged precision, minimal engine | 8.15 | 5.79 | Four accurate tiers |
| CPU, BF16-rounded, minimal engine | 5.39 | 3.71 | Four accurate tiers |
| Lite, unchanged precision, minimal engine | 4.86 | 3.31 | Extreme |
| Lite, BF16-rounded, minimal engine | 3.83 | 2.54 | Extreme |

These are decimal MB. The matched installed Tesseract.js 7.0.0 payload is
3,462,228 gzip bytes: API, worker, actual inline-WASM relaxed-SIMD LSTM core and
Fast English data. Its separate `.wasm` is not double-counted. That reference
excludes PDF.js, UI and PDF export, which are included in every OCR HTML edition.
The inventory harness hashes every decoded asset against its canonical source.

The 55-page laptop follow-up measured:

| CPU package/tier | Warm pages/s | Page CER | Initialization |
| --- | ---: | ---: | ---: |
| Rounded accurate, Balanced | 4.312 | 2.511% | 0.963 s |
| Rounded accurate, Quality | 4.087 | 2.253% | 0.708 s |
| Rounded Lite, Extreme | 6.481 | 4.788% | 0.751 s |

These are three warm document passes, with initialization/export separate.
Original precision scores 2.513% Balanced, 2.251% Quality and 4.777% Extreme:
the rounding changes -3, +3 and +16 character edits respectively, rather than
having zero numerical/accuracy cost. Balanced ordinary CPU controls drifted
from 3.195 to 3.953 pages/s around the earlier compact runs; no packaging-only
document-speed gain is claimed. First document times for the rounded packages
were 15.68 / 14.39 / 11.07 seconds, plus initialization. All cases preserve all
55 pages of exported recognized text and original first-page pixels.

Each rounded edition also passes five actual Chromium/Firefox cases covering
offline/hosted operation and JavaScript decompression where applicable. Final
packaging adds bundled upstream pako notices and batch-capacity counters;
recognition model hashes match the measured builds. Measured HTML controls are
retained under `dist/runtime-size-gold-*-control.html`. Package receipts are
in `browser/packaging/`, full-document receipts in `frontier/packaging/` and
compatibility receipts in `browser/portability/`. The release harness's old
archive SHA is not a hash of these experimental standalone packages.

The 96-channel student completes 38 epochs, stopping on development plateau
and selecting epoch 28: 629,711 parameters, a 2,542,770-byte ONNX with compact
IDs, 1.719% GPU development-line CER (1.716% native CPU) and 1.122% test-line
CER. These are line-crop scores, not page error rates. The model retains the
human-transcript and automatic-Kraken-box provenance. Its FP16 GPU export passes
development accuracy. Full 55-page browser measurements follow:

| 96-channel recognizer | Laptop pages/s | Laptop CER | Desktop pages/s | Desktop CER |
| --- | ---: | ---: | ---: | ---: |
| Balanced GPU | 6.744 | 3.085% | 17.467 | 3.156% |
| Quality GPU | 5.770 | 2.779% | 14.806 | 2.792% |
| Balanced CPU | 3.828 | 3.049% | 9.595 | 3.133% |

These are three-pass warm medians. The full five-tier HTML shrinks to 19.82 MB
from 22.84 MB. The laptop does not establish a speed advantage over the accurate
128-channel model; the desktop CPU result remains a potentially useful size,
accuracy and speed tradeoff, pending a matched control. Keep the candidate on
that basis rather than discarding it for losing the accuracy axis.

The working shared default now uses `min(4, max(1, floor(cores/3)))` CPU detectors
in both CPU and GPU modes, retaining two on the eight-thread laptop and allowing
four on the 12-thread desktop. The app and embedding API use the same policy.
This follows the worker sweep; the published v0.2.3 assets remain unchanged.

### Detector decoding and batch utilization

The JavaScript detector decoder now thresholds with a tight loop and accumulates
component statistics during its four-neighbor traversal. Traversal and floating
point addition order stay unchanged. The existing native detector maps and three
independently invented boundary masks retain exact output coordinates. Seven
alternating groups of 100 decodes reduce median component time from 14.075 ms to
0.945 ms, about 15 times faster. This is a decoder measurement, not page throughput.

On the full laptop PDF, summed detector postprocessing falls from 0.654 seconds
to 0.073 seconds, returning to 0.656 in the closing control. Text and positioned
geometry match exactly. Overall rates are 7.964 / 7.597 / 7.091 pages/s for the
before / candidate / after sequence; control drift prevents a whole-page speed
claim. The accurate BF16 CPU package also retains exact text and geometry with
the new decoder: 4.426 pages/s / 2.511% CER Balanced and 3.510 / 2.253% Quality.

GPU counters now charge the full executed capacity of captured batches, including
padded rows. On the laptop, batch 8 reduces executed input pixels by 4.7% and
128px width buckets with a 16-shape cache reduce them by 8.3%, compared with
batch 16 and 256px buckets. The corresponding rates are 6.063 before, 6.638 for
batch 8, 6.933 for narrower buckets and 7.160 after, with identical 2.498% CER.
The closing control is faster than both alternatives. Desktop controls drift
from 10.435 to 18.300 pages/s around the same sweep, so neither machine establishes
a general throughput gain. The cache still caps owned buffers at 256 MiB; this
does not include all ORT, browser or page memory.

A mirrored laptop detector-worker sweep (2, 3, 4, 4, 3, 2) gives pooled medians
of 6.806, 6.919 and 6.915 pages/s. Their ranges overlap, and all retain 2.498% CER.
The two-worker laptop default stays in place. Receipts live under
`frontier/post-fused/` and `frontier/layout-allocation-mirrored/`; the component
receipt is `browser/post-kernel/latest/results.json`.

### Crop-robust recognition at the same inference cost

The 64-channel continuation changes training crops, with the same ten blocks,
373,199 parameters, full-width input and alphabet. Half the training crops
vary existing blank margins by up to 75%, after finding all nonwhite
pixels, including faint gray ink. Ink and human labels are retained. Evaluation
does not augment crops or consume training RNG state. This is recognition
augmentation, not corrected detector gold; the original boxes remain automatic
Kraken output.

Both the augmented run and a matched unaugmented continuation start at selected
epoch 39 with fresh AdamW, learning rate 0.00005, a total 60-epoch cap, minimum
epoch 50 and patience 8. The control stops at epoch 50 and keeps epoch 39; its
exported CPU and GPU graph hashes remain identical to the original model. The
augmented run uses all 21 additional epochs and selects epoch 60, still improving
at the cap. Human development-line CER falls from 2.377% to 2.003%; reserved
test-line CER falls from 1.536% to 1.333%. Line scores do not imply page scores.

| Laptop, 55 pages, GPU Extreme | Warm pages/s | Page CER | Character edits |
| --- | ---: | ---: | ---: |
| Matched original, before | 9.548 | 4.795% | 6,976 |
| Crop-robust, 768px detector | 9.710 | **3.954%** | **5,752** |
| Crop-robust, 736px detector | 9.182 | 4.241% | 6,170 |
| Matched original, after | 9.451 | 4.795% | 6,976 |

Each rate is a median of three warm passes, with GPU preparation, scan-page
reuse and an eight-shape capture cache. At 768px this removes 1,224 character
edits, or 17.5%, without increasing inference work. The smaller detector side
loses both speed and accuracy in this session; retain its result without
promoting it. Offline recognition and all-page searchable-PDF character and
first-page pixel gates pass. Training/checkpoint receipts live under
`speed-frontier/crop-robust64/` and `crop-control64/`; full-page receipts are in
`frontier/crop-robust/`. These remain unreleased experiments.

The improvement also survives the small CPU package. With the original-precision
crop-robust weights, Compact Extreme measures 6.692 pages/s / 3.962% CER.
BF16-rounded storage measures 6.564 / 3.966%, or 5 extra character edits among
145,475 gold characters. It retains the 3.83 MB offline / 2.54 MB gzip size,
FP32 arithmetic and 0.775-second initialization. Its first full 55-page OCR
pass takes 8.89 seconds after initialization and file opening. Original rounded
weights score 4.788% at 6.511 / 6.104 pages/s in the surrounding controls; this
supports an accuracy improvement at similar inference cost, rather than a
training-induced speedup. Development rounding changes 3,800 edits to 3,810
among 189,756 characters. Full-page receipts live in `frontier/crop-compact/`.

A subsequent scan-image reuse comparison on this same 3.83 MB package measures
**8.114 CPU pages/s**, versus 6.813 before and 6.108 after with ordinary PDF
rendering. All keep 3.966% CER and exact text, raw detector boxes, positioned
geometry and exported PDF bytes. This uses the existing guarded
`scanPages=1` path; unsupported pages still use ordinary rendering. The control
drift is visible, but the candidate exceeds both controls. This is a warm
full-document rate, not startup or single-page latency. Receipts live in
`frontier/crop-compact-scan/`; the combined raw-geometry/output audit is
`browser/full-test/latest/laptop/frontier-verification.json`.

### Fused portable SIMD activation kernel

The stock detector contains 31 HardSwish activations. The pinned ORT 1.22 CPU
provider has no native HardSwish registration, so these expand to HardSigmoid
and multiplication. A new float32 SIMD128 kernel performs the same arithmetic
in one pass, using ORT's normal thread scheduler. It requires neither relaxed
SIMD nor FMA and changes no model weights. The existing four-row matrix kernel
is retained.

The standalone WASM check passes 38 cases on desktop and laptop: random float32
bit patterns, activation boundaries, infinities, NaNs, subnormals, short tails,
guard writes and in-place use. Finite results and signed zero are exact; NaN
payloads are unconstrained. On the retained real detector tensor, the complete
float32 output hash matches the old engine exactly. A separate CPU profile
confirms the native HardSwish function runs instead of the expanded operations;
sampling counts are not a precise time breakdown.

Laptop Balanced CPU measures 5.009 pages/s, with controls of 4.517 before and
4.844 after, with identical 2.513% CER, text and positioned geometry. That is
3.4% faster than the closing control, with visible drift. GPU Balanced measures
9.023 versus 9.179 / 8.913 controls, so it establishes no GPU throughput gain.
The same kernel with crop-robust Extreme measures **11.952 pages/s / 3.954% CER**
between 11.060 and 11.258 controls, a 6.2% gain over the closing control. Text and
positioned geometry remain exact. This accelerates the CPU detector alongside
GPU recognition; the GPU runtime binary itself is unchanged. Source patches,
operator configuration, compiler/runtime hashes and validation receipts are
retained in the owning custom-kernel directory. Upstream source patches are
removed in the build's exit trap.

Fourteen Chromium/Firefox cases pass for the full HTML with the fused CPU
runtime, including offline use, hosted selection, GPU failures and PDF export.
Both new compact crop variants pass five cases each, including Firefox
offline/hosted use and Chromium's JavaScript decompression fallback. Ordinary
full-package embedding cases exercise the shared API; captured alternate input
graphs are separately exercised through explicit WebGPU in the full-page gate.
Apple Safari remains untested. New desktop kernel/crop timings are deferred
because unrelated desktop work saturates the CPU; earlier desktop numbers above
are not attributed to this kernel.

### Crop-robust Balanced and Quality recognizer

Balanced and Quality share the eight-block, 128-channel recognizer. A separate
crop-robust continuation retains its 1,035,663 parameters, full-width inference
and alphabet. Both this run and its unaugmented control initialize from the
selected epoch-19 checkpoint, using fresh AdamW at 0.00005, total epoch cap 60,
minimum epoch 35, patience 8 and learning-rate patience 2. The crop variation
is the same blank-margin-only augmentation as the 64-channel experiment.
Checkpoint selection uses the unchanged development split, without page-test
selection.

The augmented run completes 40 additional epochs and stops at epoch 59 on
development plateau, selecting epoch 51. GPU development-line CER falls from
1.401% to 1.193% (2,658 to 2,263 edits in 189,756 characters). The unaugmented
control completes 16 additional epochs, stops at epoch 35 and retains the
original epoch 19. Thus extra continuation alone does not reproduce the gain.
The actual epoch counts differ under the same stopping and selection rules.

The selected CPU export retains the parameter count and scores 1.192% on
development lines, versus 1.402% originally. On the previously examined reserved
line-crop split it improves from 0.883% to 0.739% CER: 1,265 to 1,059 edits in
143,308 characters. These are human-transcript line scores; full-page results
include detection and reading order. Training, control and export receipts live
in `speed-frontier/crop-robust128/` and `crop-control128/`.

The scan-image fast path now returns control to ordinary PDF rendering if the
optimization throws. A real-PDF pixel test injects an accelerated image-draw
failure and verifies that normal rendering recovers the exact original pixels.
All 53 source tests and 14 Chromium/Firefox cases pass. The unchanged standard
recognizer also retains exact full-page text, raw boxes, positioned geometry
and PDF bytes on CPU and GPU after the source change. Exact pre-change compiled
controls are retained under `dist/controls/standard-crop/`; the new source-parity
receipt is `frontier/standard-crop/source-parity.json`.

## Data and training

Reused the existing CATMuS transfer bundle and compiled Kraken Arrow files in
place. The frozen partition has 538/68/55 pages and 280/35/35 articles in
train/development/test, with no page or article overlap. The compiled splits
contain 26,981/3,165/2,406 lines. The final test has 143,308 normalized characters.

In the initial screen, each candidate received one full training epoch, batch size 16, AdamW learning
rate 0.0001, weight decay 0.00001 and seed 714. Batch-normalization running
statistics stayed frozen; affine parameters remained trainable. Development
CER selected the checkpoint; the training protocol was fixed before test
evaluation. Character error is weighted by reference character count, using
the existing NFKC/whitespace/soft-hyphen normalization, scored per line.

| Recognizer | Stock development CER | Trained development CER | GPU epoch including development check |
| --- | ---: | ---: | ---: |
| Indra Latin | 4.636% | 1.573% | 40.3 s |
| PP-OCRv6 Tiny | 3.786% | 1.291% | 45.0 s |
| RepSVTR mobile | 3.818% | 1.032% | 134.9 s |

The epoch times exclude model loading and crop preparation. Peak PyTorch GPU
allocation was 333/2,030/6,409 MiB respectively.

## Initial one-epoch test and CPU inference

| Recognizer | Trained test CER, CPU | Warm CPU lines/s | Relative to Kraken | ONNX model |
| --- | ---: | ---: | ---: | ---: |
| Installed Kraken | 0.74% | 108.14 | 1.00x | 0.62 MB |
| Indra Latin | 1.12% | 334.56 | 3.09x | 4.97 MB |
| PP-OCRv6 Tiny | 0.81% | 68.01 | 0.63x | 4.46 MB |
| RepSVTR mobile | 0.73% | 11.99 | 0.11x | 25.16 MB |

Accuracy uses all 2,406 reserved test lines. CPU timing is warm ONNX inference
on the same frozen 512-line ordinal sample, width-bucketed batches of 16, two
intra-op threads, one inter-op thread, CPUExecutionProvider, three trials and
their median. Input preparation, CTC decoding and page processing are outside
the timing. Candidate weights are FP32; Kraken is the installed compact model.

Kraken's model SHA-256 is
`c57efb79d08bc3f56568c0b3fbb076eccfc7f0f823c57d688cd7047827e45573`;
its codec SHA-256 is
`5eb42e63e250d812b454f1c655af1dade5c2f1fdc267f4ccfc13ea62f360dd90`.
Both match this checkout's production runtime assets.

Indra is the useful speed candidate: about three times the recognition
throughput at roughly +0.38 percentage points CER after this short fine-tune.
RepSVTR's small accuracy advantage costs about nine times the CPU inference
time. PP-OCRv6 does not beat Kraken on this screen. The follow-up below adds a
fourth candidate and tests RepSVTR quantization. Longer training of the two speed
candidates is reported below. Full-page integration remains separate; these results
do not establish a replacement for Kraken Quality or an end-to-end speedup.

## Fourth candidate: docTR MobileNetV3-Small CRNN

Added the official docTR 1.1.0 recognizer: 2,077,855 stock parameters, height
32, a MobileNetV3-Small backbone and a two-layer bidirectional LSTM. It supports
native PyTorch fine-tuning. The published checkpoint's CTC blank moves from
last to first with its learned weights preserved; logits and decoded text
matched an untouched native model before training.

The stock model is a word recognizer whose vocabulary does not include spaces.
The training alphabet appended 23 characters, including space. Dynamic input
widths adapt it to complete legal lines. One epoch over the same 26,981 training
lines took 58.3 seconds including the development check, using 963 MiB peak GPU
allocation. Development CER improved from 17.491% to 2.186%; no evaluation widths
were capped, and 11 training crops required CTC alignment expansion.

| Recognizer | Reserved test CER, CPU | Warm CPU lines/s | Relative speed | ONNX model |
| --- | ---: | ---: | ---: | ---: |
| Kraken, fresh reference run | 0.744% | 108.90 | 1.00x | 0.62 MB |
| docTR MobileNetV3-Small CRNN | 1.684% | 153.52 | 1.41x | 8.36 MB |

The CPU protocol, 512-line timing sample and 2,406-line test are identical to
the initial screen. The export passed the two dynamic batch/width parity
checks (maximum logit difference 0.000378). CPU scoring had 2,414 edits;
GPU scoring had 2,413. This candidate clears the speed target but is less
accurate after the fixed one-epoch pass. Indra remains both faster and more
accurate than this fourth candidate on the measured protocol. More training
could change accuracy; it has not been measured here.

## RepSVTR setup audit

The official OpenOCR architecture and release weights load strictly after
excluding only the 43 auxiliary GTC tensors. The training path uses raw CTC
logits, enables encoder gradients by disabling the upstream inference guide,
and retains every original character class. All 193 encoder parameter tensors
changed from the stock checkpoint, while batch-normalization running statistics
remained identical. The ONNX encoder already had the
upstream RepViT fusion; exported logits passed independent PyTorch checks.

The actual upstream `RecDynamicResize` was compared against the adapted line
preprocessor on 256 uniformly spaced development lines. With trained weights
and batch size one, upstream preprocessing scored 1.202% CER and the adapted
preprocessor scored 1.195%. The adapted batch-16 run scored 1.241%. There was
no material preprocessing regression on this sample. Upstream uses linear
interpolation, ceil-width sizing and a 320-pixel minimum; the controlled line
adapter uses area interpolation when shrinking, rounded widths and an
eight-pixel batch alignment. These are deliberate line-corpus adaptations,
not an exact pixel reproduction of OpenOCR's word evaluator.

The sampled lines have median width 1,158 pixels at height 48. A separate
64-line CPU profile attributed about 74% of node time to convolutions; the
classifier's final matrix multiplication accounted for about 5%. Smaller
batches gave only a modest throughput improvement. This explains why
quantizing just matrix multiplications can reduce size without removing the
main CPU cost. Private aggregate audit and optimization receipts are retained
beside the original models.

## RepSVTR quantization

Calibrated static variants on 64 uniformly spaced **training** crops, without
using their transcripts. Compared variants on 256 uniformly spaced development
lines; the fastest model within +0.05 percentage points CER of FP32 was selected
before its reserved-test result. Development timing uses 64 ordinal samples,
batch 16, two CPU threads, and the median of three warm trials. These development
timings use a different sample from the final 512-line test timing.

| RepSVTR export | Development CER | Development lines/s | Model size |
| --- | ---: | ---: | ---: |
| FP32, already fused | 1.241% | 10.61 | 25.16 MB |
| Dynamic signed INT8, matrix multiplications | 1.215% | 10.68 | 17.00 MB |
| Signed QDQ INT8, convolutions and matrix multiplications | 2.350% | 7.00 | 6.87 MB |
| Unsigned QDQ INT8, convolutions and matrix multiplications | 1.928% | 7.96 | 6.90 MB |
| Signed QDQ INT8, convolutions only | 2.271% | 7.30 | 15.05 MB |

Dynamic INT8 retained accuracy and reduced size by about 32%, but its speed
change was under 1%. On the full reserved test it scored **0.724% CER** at
**12.10 lines/s**, versus FP32's **0.725%** and **11.99 lines/s**. This is no
useful throughput improvement. All three static QDQ variants were slower and
less accurate on development data and were excluded before final test scoring.
The unsigned format was tested as the official ONNX Runtime documentation's
suggested alternative when signed quantization loses accuracy on older x86
hardware; it did not solve this case.

No RepSVTR setup fault was found that explains away its CPU cost. It remains
about nine times slower than the installed Kraken recognizer on this desktop.
These measurements concern this CPU and ONNX Runtime provider; they do not
establish quantization behavior on other processors or inference engines.

Sources: [docTR model implementations](https://github.com/mindee/doctr/tree/main/doctr/models/recognition/crnn)
and [ONNX Runtime quantization guidance](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html).

## Longer training: Indra and CRNN

Continued only the two candidates that exceeded Kraken's CPU throughput. Both
started from their selected one-epoch weights, preserving the learned classifier
rows. The original checkpoints had no optimizer state, so this first continuation
used fresh AdamW moments. Subsequent checkpoints save optimizer, scheduler and
PyTorch RNG state; Indra's continuation was actually interrupted after epoch two
to narrow the queue, then resumed without losing that epoch or its optimizer state.
Original one-epoch weights and receipts remain unchanged.

Used the same complete training/development splits, batch size 16, seed 714,
learning rate 0.0001 and frozen batch-normalization statistics. The cap was thirty
total epochs, including the initial epoch. Each epoch scored development CER;
the learning rate halved after three consecutive non-improving epochs, using an
absolute CER threshold of 0.00001 and a minimum rate of 0.000001. Training stopped
after eight epochs without that improvement, with at least ten total epochs.
Every lower development CER remained eligible to select the best checkpoint.

| Recognizer | Total epochs run | Selected epoch | One-epoch development CER | Selected development CER | Additional training wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Indra Latin | 16 | 8 | 1.573% | 1.241% | 14.3 min |
| docTR MobileNetV3-Small CRNN | 27 | 19 | 2.186% | 1.044% | 34.8 min |

Both stopped on a development plateau, before the cap. Later epochs reduced
training loss but failed to improve development CER. Training times include
development checks and checkpoint handling, and exclude loading and crop
preparation; the shared desktop was busy during much of this run.

The selected weights were then exported and scored on all 2,406 test lines:

| Recognizer | Test CER, CPU | Exact lines | Warm CPU lines/s | Relative to Kraken |
| --- | ---: | ---: | ---: | ---: |
| Installed Kraken | 0.744% | 80.55% | 102.11 | 1.00x |
| Indra, epoch 8 | 0.833% | 81.38% | 323.69 | 3.17x |
| CRNN, epoch 19 | 0.740% | 82.04% | 138.11 | 1.35x |

CPU and GPU scoring agreed exactly: 1,194 edits for Indra and 1,060 for CRNN,
against Kraken's 1,066, over 143,308 reference characters. CRNN's six-edit
advantage is small: this supports matching Kraken's accuracy, not a claim of
quality superiority. Its CER fell from 1.684% after one epoch to 0.740% after
selection, while Indra improved from 1.125% to 0.833%. The initial one-epoch
accuracy ranking understated CRNN's potential.

The speed table uses the final paired CPU measurement: the same frozen 512-line
ordinal sample, width-bucketed batches of sixteen, two intra-op threads, one
inter-op thread, three trials and their median. Every model received a complete
warmup pass; starting model order rotated each trial. The desktop initially had
substantial background CPU/memory pressure, so this short timing pass was
repeated after the background load subsided. Timings still show variation; all trial
durations and resource snapshots are retained. This measures prepared-tensor
inference, excluding crop preparation, decoding and full-page processing.

The ordinary sequential export/evaluation pass also retained its timings:
298.97/123.59/101.65 lines/s for Indra/CRNN/Kraken. It ran during changing host
load and is separate from the paired figures above; do not mix their ratios.

Both ONNX models passed checks against CPU PyTorch at two dynamic batch/width
combinations. Maximum logit differences were 0.000212 for Indra and 0.000401 for
CRNN. Export sizes remain 4.97 MB and 8.36 MB. Selected weights, resumable last
checkpoints, per-epoch curves, exports and receipts are private in
`benchmarks/local-data/ocr-candidate-screen/convergence/`.

CRNN is now the stronger candidate for matching Kraken's recognition quality
while increasing throughput. Indra offers a larger speed gain at about +0.09
percentage points CER. Full-page performance was measured in the later browser
follow-up below. This uses the same held-out split already examined in the initial
smoke test; it is a follow-up on that test set, not a newly untouched benchmark.

## Browser packages and desktop page profile

Packaged the selected epoch-8 Indra and epoch-19 CRNN exports into the actual
`legal-browser-ocr` application, based on main commit
`d19500f809059f5d3dd79edf2b1c665b72034379`. Each has a separate hosted runtime
archive and an offline HTML file under that checkout's canonical `dist/`.
The existing Kraken package and default remain available. Candidate model
payloads are 4.97 MB for Indra and 8.36 MB for CRNN; standalone HTML files are
26.09 MB and 30.54 MB, including the full ONNX Runtime Web WASM build.
Kraken retains its compact runtime and 7.54 MB standalone HTML.

Measured on the desktop Ryzen 5 2600X, 12 logical CPUs and 16 GB RAM, using
Chromium 151 and CPU WASM, with about 18–24% background CPU use. The RTX 3080 Ti
was unused. Twelve uniformly spaced original PNG/PAGE-XML pairs from the
55-page test partition supplied independent gold: 27,736 normalized characters.
The manifest SHA-256 is
`51e58c840571709b8c747303898aaa17c470d68154fd91ddb592e5a96a1a2c25`.
These already-examined test pages form a follow-up experiment, not a fresh
model-selection or promotion set.

The harness creates a deterministic image-only PDF, assigning its original PNGs
200 dpi page dimensions, then uses the app's normal 144 dpi PDF renderer. It
drives the file input, recognition and download buttons. Throughput is the
median of three warmed 12-page document passes after one full warmup. It includes
rendering pages 2–12, previews, layout, recognition and text assembly; the first
page preview already exists when recognition starts. Model startup, file opening
and PDF export are separate. Models ran sequentially in fixed order, with host
load snapshots; short differences remain subject to run variation.

| Standalone desktop package | Quality pages/s | Quality CER | Turbo pages/s | Turbo CER |
| --- | ---: | ---: | ---: | ---: |
| Kraken | 2.98 | 2.982% | 3.45 | 3.620% |
| CRNN | 3.34 | 2.967% | 3.86 | 4.611% |
| Indra | 4.70 | 3.187% | 5.20 | 5.213% |

Indra Quality increases full-document throughput by 57% relative to Kraken;
CRNN increases it by 12% with four fewer character edits on this sample.
Turbo narrows recognition inputs to 76% of Quality width without changing
height, layout or PDF rendering. It adds 11% throughput for Indra and 15% for
CRNN, with much larger error increases than Kraken's Turbo tradeoff. Full-page
CER includes layout/order errors and the lower-resolution PDF render, so it
is a different measurement from the rectified-line recognition CER above.

Hosted packages gave similar Quality throughput: 3.05/3.34/4.76 pages/s for
Kraken/CRNN/Indra. Hosted Turbo gave 3.44/3.76/5.06 pages/s. Recognized text
matched the corresponding standalone mode. Candidate standalone model-ready
startup took 3.89–4.15 seconds, versus about 1.00–1.19 seconds when hosted
locally; warm throughput excludes that startup. Standalone Quality first
document recognition took 5.32/4.78/3.62 seconds for Kraken/CRNN/Indra,
after startup and approximately 0.4 seconds of file opening. PDF export took
about 0.18–0.22 seconds separately.

A serial warm recognition of the first original PNG separates model time from
layout without overlapping document workers:

| Stage, seconds | Kraken | CRNN | Indra |
| --- | ---: | ---: | ---: |
| Layout, including preparation | 0.447 | 0.448 | 0.446 |
| Crop and tensor preparation | 0.042 | 0.024 | 0.041 |
| Model inference | 1.563 | 1.334 | 0.516 |
| CTC decoding | 0.009 | 0.002 | 0.015 |
| Total page recognition | 2.063 | 1.809 | 1.019 |

Indra's browser model call remains about three times faster than Kraken's,
close to the native line-only ratio. Its faster recognition makes layout
about 44% of this page's OCR time; crop preparation is about 4%. The smaller
whole-document speedup therefore reflects fixed layout work plus PDF rendering,
previews and pipeline scheduling. These serial PNG fractions must not be
treated as additive fractions of the parallel PDF document wall time.

### Existing Tesseract tuning

With Indra at full recognition width, the existing flags
`layoutScale=.75&layoutTrim=1` reached **5.32 pages/s at 2.902% CER** (805 edits).
That is 13% higher throughput than default Indra Quality, and both faster and
more accurate than Indra Turbo on these pages. Serial PNG layout detection fell
from 0.421 to 0.287 seconds. The changed boxes also change recognized text, so
the small accuracy improvement needs a larger independent page set before
promotion. The default Tesseract settings remain unchanged.

### Worker balance and batching

Additional desktop trials kept Indra at full recognition width with the same
75% trimmed Tesseract layout. The existing policy creates eleven recognition
workers and two layout workers on this twelve-thread desktop. These follow-up
trials had about 9–10% background CPU use, lower than the earlier passes, so
the repeated control below is the appropriate comparison.

| Recognition workers | Layout workers | Width bucket | Pages/s | Model-ready startup |
| ---: | ---: | ---: | ---: | ---: |
| 11, repeated control | 2 | 24 | 5.60 | 3.66 s |
| 4 | 3 | 24 | 5.17 | 2.04 s |
| 6 | 3 | 24 | 5.98 | 2.49 s |
| 6 | 4 | 24 | 6.09 | 2.53 s |
| 6 | 3 | 128 | 5.83 | 2.51 s |

Every configuration produced identical text to the original layout-tuning
trial: 805 edits, 2.902% CER. Six recognition workers and four layout workers
were 8.6% faster than the repeat control and reduced model-ready startup by
about 31%. Three layout workers were close enough that a longer representative
run should decide between them. Fewer recognition workers alone do not ensure
higher throughput: the four-worker configuration was slower. Wider recognition
buckets did not help here. These are experimental URL settings, without a
default worker-policy change.

Browser validation passed all 26 focused runtime tests on both machines,
worker/main recognition equality, stable text across all three document passes,
offline HTML recognition and searchable-PDF page counts. Export checks retained
normalized non-whitespace OCR characters on every page and exactly preserved
first-page pixels; PDF.js can infer different visual whitespace from the plain
OCR display. Private inputs, screenshots, raw stage timings, PDFs and hashes
live in `benchmarks/local-data/ocr-candidate-screen/browser/`, with desktop
receipts under `latest/desktop/`. No trained model was published or made the
production default.

### Previews, line detectors and reduced WASM

The next desktop pass tested all three proposed changes in the normal offline
HTML application. It reused the same 12 pages and 27,736 reference characters,
with three warm document passes after one complete warmup. Background CPU
snapshots were 0.4–2.5%, lower than the earlier profiles. The bracketing tuned
Indra controls reached 6.48 and 6.54 pages/s; use these controls for this pass's
gains. Except for the current Kraken configuration, every row uses six
recognition workers, four layout workers and full recognition width.

| Configuration | Pages/s | Page CER |
| --- | ---: | ---: |
| Indra + 75% trimmed Tesseract, control before/after | 6.48 / 6.54 | 2.902% |
| Same + asynchronous 640px previews | 6.78 | 2.902% |
| Same previews + reduced WASM | 6.95 | 2.902% |
| Indra recognizer + stock Indra detector, 1024px | 6.65 | 2.160% |
| Same detector + reduced WASM | 6.73 | 2.160% |
| Indra recognizer + stock Indra detector, 768px | 7.82 | 2.527% |
| Same 768px detector + reduced WASM | **8.02** | **2.527%** |
| Indra recognizer + Paddle detector, published resize policy | 1.67 | 2.167% |
| Indra recognizer + Paddle detector, long side capped at 1024px | 4.73 | 2.495% |
| CRNN + tuned Tesseract + smaller previews | 3.94 | 2.776% |
| Same CRNN configuration + reduced WASM | 4.00 | 2.776% |
| Current Kraken Quality configuration, repeated | 3.33 | 2.982% |

All detector rows include smaller previews. The 8.02 pages/s combination is
23% faster than the mean of the two tuned Indra controls, and 2.41 times the
current Kraken configuration. The latter compares complete configurations,
including their worker/layout settings. It is not a model-only speed ratio or
a laptop measurement. The 1024px Indra detector offers lower page error if
its approximately 6.7 pages/s throughput is sufficient.

The smaller previews preserve OCR pixels and run after recognition. Total
document time includes preview encoding. Their average preparation/encoding
time fell from 37–38ms to 22ms per page; document throughput improved about 4%.
Indra detector inference averaged 135ms at 1024px and 71ms at 768px per page.
These worker measurements overlap and must not be added as wall-time fractions.
The fastest combination recorded 1.76s model-ready startup, 0.38s file opening,
2.66s for its first 12-page recognition and 0.21s PDF export. Only warm document
throughput appears in the table; startup was a single observation per scenario
with an already-used local filesystem cache.

The reduced runtime is ONNX Runtime 1.22.0, source commit
`f217402897f40ebba457e2421bc0a4702771968e`, built with Emscripten 4.0.4,
SIMD, thread support and one build job. It retains ONNX loading/optimization
and the union of both recognizers' and both detectors' operators. WASM shrank
from **11,210,254 to 6,488,539 bytes (42.1%)**. Indra's standalone HTML shrank
from 26.09 to 19.79 MB; CRNN's from 30.55 to 24.25 MB. The combined reduced
detector HTML is 22.76 MB and its runtime archive is 9.61 MB; it includes both
detectors and the Tesseract comparison assets. These are decimal MB.
Warm throughput gains from operator reduction alone were only about 1–3%,
within the range where longer paired trials should decide performance claims.
Its package-size benefit is clear. Text and raw/recognized line geometry
matched exactly for all full/reduced pairs and both preview controls.

Both detectors use official stock exports: Indra v3.1.1 model revision
`ed345c7f158eddbc7dee0c6a7269afb75a94f7e8` (389,948 bytes), and PP-OCRv6 tiny
revision `2ba1506c0380b8f0b03dd142459aac66d4421f6c` (1,780,590 bytes).
Indra uses its core/distance decoder and geometric XY-cut order; the existing
column/footnote ordering still applies. This does not run upstream's full
semantic-layout or learned reading-order stack, and does not discard furniture.
Paddle uses its published minimum-short-side resize policy, BGR normalization,
DB thresholds 0.2/0.4 and unclip ratio 1.4. That resize policy leaves most of
these large input pages large. Capping its long side makes it much faster,
but it remains slower than the tuned Tesseract and Indra alternatives here.

Independent native decoding on the first original page produced 47 Indra and
48 Paddle boxes. JavaScript reproduced the counts; maximum coordinate differences
were 0.000031 pixels and 2 pixels respectively. The Paddle adapter approximates
OpenCV contours/unclipping with connected components and minimum rectangles.
Browser Canvas resampling also differs from native OpenCV preprocessing; this
decoder check uses identical native output tensors, not byte-identical browser inputs.

The original PAGE-XML gives geometry-agreement diagnostics across 480
Kraken-derived reference lines. The transcripts are human-made gold; these
boxes have not been independently corrected and are not geometry gold:

| Detector | Kraken reference boxes matched at IoU ≥ 0.5 | Reference boxes with ≥80% horizontal overlap | CER on geometrically matched human transcripts |
| --- | ---: | ---: | ---: |
| Tuned Tesseract | 82.1% | 87.5% | 0.99% |
| Indra 1024px | 86.9% | 88.3% | 0.45% |
| Indra 768px | 86.0% | 87.5% | 0.48% |
| Paddle published resize | 91.3% | 95.2% | 0.56% |
| Paddle max 1024px | 96.7% | 99.0% | 0.80% |

Matching is greedy, one-to-one and uses axis-aligned boxes. The box figures
measure agreement with Kraken, not true detector recall or coverage. The matched-line
CER denominators differ, so it is a diagnostic rather than an accuracy ranking.
Visual review located the largest strict box-match differences in marginal
notes and a page of display text. Some unmatched boxes still contain recognized
text. Output order differed from stored reference order by about 0.9–1.2% of
matched pairs, on different matched subsets. Independent reading-order gold
was not established, so those differences require review rather than counting
as proven errors. Page CER also depends on the dataset's stored line order.
Paddle supplies another
proposal source; its greater agreement with Kraken does not establish that its
boxes are more accurate. Indra wins measured throughput.

The initial proposal to train the detector against these boxes needs that
provenance qualification. Kraken boxes can provide weak supervision, but
matching them cannot establish an accuracy gain. Corrected geometry or an
independent transcript-based downstream objective is needed. Human transcripts
directly support a lower-width recognizer fine-tune: recover text accuracy at
the cheaper inference width, selecting checkpoints on development CER.
More epochs with the same graph and dimensions do not reduce arithmetic cost.
Distillation into a smaller student is another candidate. QAT is conditional on a measured faster browser INT8
export; quantization can add overhead and the earlier RepSVTR trial did not
produce a useful speed win. See the
[ORT quantization guidance](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)
and [Paddle's detector training recipe](https://github.com/PaddlePaddle/PaddleOCR/blob/main/configs/det/PP-OCRv6/PP-OCRv6_tiny_det.yml).
No detector retraining was part of this speed pass. Use development pages to
choose settings; these repeatedly examined test pages are not a fresh holdout.

All 29 focused browser-runtime tests and two layout-diagnostic tests passed.
All 13 scenarios passed worker/main text equality, offline recognition, stable
text across three rounds and PDF checks retaining normalized non-whitespace
characters on every page and exact first-page pixels. Full/reduced pairs also
retain identical line geometry. Private receipts live under
`browser/latest/desktop/speed/`, native tensors under `browser/detector-parity/`,
and the reviewed overlay under `browser/latest/desktop/layout-review/`, relative
to the ignored benchmark root. Local standalone HTML hashes exactly match the
desktop-tested packages. Flags and reproduction commands are in the experiment
README and `legal-browser-ocr/experiments/ocr-speed/README.md`. Defaults remain
unchanged pending broader legal-page validation.

### Speed-focused Indra recognizer training

The dataset maintainer clarified that the transcripts are human-made gold and
the boxes were generated by Kraken. The detector box-agreement figures above
cannot serve as independent detector accuracy. The supervised speed trial
therefore trains the recognizer against the human transcripts at **76% input
width**, keeping height 32. No detector weights were trained in this trial.

The selected Quality checkpoint at epoch 8 initialized a separate run with
fresh AdamW, learning rate 0.00005, batch size 16 and the original frozen split.
The cap allowed 30 additional epochs, with at least ten and eight-epoch
development patience; three plateau epochs halve the learning rate. Training
completed **17 additional epochs in 683.2 seconds**, stopping at epoch 25.
Development CER selected epoch 17, nine additional epochs after initialization.
Peak allocated GPU memory was 258.6 MiB. Existing Quality weights and source
corpus bytes were preserved.

At Turbo width, development CER fell from **3.382% to 2.370%** on 3,165 lines
and 189,756 characters. The same earlier checkpoint at full width scored
1.243% in the preflight. On the existing 2,406-line test partition, matched GPU
evaluation at Turbo width fell from **2.743% to 1.743%** (3,931 to 2,498 edits
over 143,308 characters). Native ONNX CPU scored 1.741% (2,495 edits).
Export parity checked two dynamic shapes with maximum logit difference
0.0002995 and passed its numerical tolerances. CPU/GPU decoding differed by
three character edits.

The graph architecture and parameter count remain unchanged. The speed target
is the cheaper input width, rather than making identical-shape inference faster.
The exported model is **4,973,879 bytes (4.97 MB)**. Character mappings match
the Quality pack exactly. There is also a hard limit to horizontal compression:
23 of the development lines have too few CTC timesteps for their labels at
76% width. Evaluation does not stretch those inputs using the reference text.

The offline browser follow-up holds the stock 768px Indra detector, reduced
WASM, six recognition workers, four layout workers and smaller previews fixed.
It uses the same 12 pages and three warm rounds, with 0.5–1.6% background CPU
snapshots. Quality controls bracket the two Turbo cases:

| Indra recognizer configuration | Pages/s | Page CER |
| --- | ---: | ---: |
| Quality, earlier weights, control before/after | 7.86 / 7.91 | 2.527% |
| Turbo, earlier weights | 9.26 | 4.849% |
| Turbo, speed-trained weights | **8.98** | **3.623%** |

The trained Turbo model makes **25.3% fewer page character edits** than the
earlier Turbo model (1,005 versus 1,345). It is about **13.9% faster than the
mean Quality control**, with 1.10 percentage points higher CER. The small
throughput difference between the two Turbo runs is not evidence that the
training accelerated equal-shape inference. Quality remains the accuracy
choice; the new weights improve the Turbo tradeoff without recovering Quality
accuracy. This is a separate experimental package, with no default promotion.

The package is `legal-browser-ocr-indra-reduced-detectors-speed.html`, 22.75 MB,
with a 9.61 MB runtime archive. Select **Turbo** and use the same detector/worker
query as the earlier 768px Indra package. Its observed model-ready startup was
2.78s, file opening 0.38s, first 12-page recognition 2.52s and export 0.22s;
these are separate from the warm table and are single startup observations.

All four browser scenarios passed offline OCR, worker/main text equality,
stable three-round output and searchable-PDF character/pixel retention checks.
Raw detector geometry matched exactly across all four cases; the Quality
controls also retained identical text. All 29 runtime tests, five training
harness tests and two geometry-diagnostic tests passed. Local standalone HTML
matches the desktop-tested bytes. Receipts/checkpoints live in ignored
`recognizer-speed/` and browser receipts in `browser/latest/desktop/recognizer-speed/`.
The extra native Kraken entry in the evaluation receipt uses the
`student-ultralite-uint8` pack, not the earlier browser Kraken artifact, and is
not used for the page-speed comparisons here. Training used existing CUDA
PyTorch 2.7.1+cu126; native ONNX checks used imported ORT 1.22.0, and browser
WASM remains 1.22.0. This reuses previously examined test pages, not a fresh holdout.

### Shallower students and runtime sweep

Two full-width students retain 8 or 6 of the teacher's 10 residual blocks,
selected at evenly spaced block indices. They retain 128 channels and every
character class. Training combines human-transcript CTC with 0.25 times a
temperature-2, padding-masked KL loss from the frozen Quality teacher. Both
use fresh AdamW, learning rate 0.00005, batch 16 and seed 714. Development CER
selects checkpoints; the cap is 30 epochs, minimum ten, patience eight.

| Recognizer | Epochs / selected | Development CER, native CPU | Previously examined test CER, native CPU | Parameters | ONNX bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Quality teacher | 16 / 8 | 1.241% | 0.833% | 1,236,239 | 4,973,880 |
| 8-block student | 27 / 19 | 1.402% | 0.883% | 1,035,663 | 4,166,792 |
| 6-block student | 30 / 26 | 1.697% | 1.081% | 835,087 | 3,359,718 |

The eight-block run stopped on a plateau; the six-block run reached its cap.
Each took about 21.2 minutes including development checks. Two dynamic export
checks passed for each student. These are smaller networks, whereas the
earlier Turbo fine-tune reduced input width without shrinking the network.

The 38-case offline browser sweep tested these students at full/85%/76% width,
six convolution quantization variants, a matrix-multiply classifier, compact
greedy output, explicit normalization folding, allocator/optimization flags,
sorted batches of 4/8/16/32, wider buckets, cross-page batches, worker counts
and detector resolutions. Seven follow-up cases combined compact outputs with
students, checked reduced runtimes and repeated controls. All 45 passed offline
recognition, three-round stability, worker/main text equality and PDF text/pixel
checks. Runtime tests numbered 30; six training harness tests passed before
the student runs. Later channel/kernel work adds another training harness test.

All QDQ variants calibrate on the same 128 ordinal training crops and score all
3,165 development lines. The +0.05 percentage-point development CER gate
rejects all six: signed INT8 4.795%, unsigned 2.835%, mixed 2.911%, mixed
reduced-range 2.841%, pointwise-only 2.531%, body-only 2.836%, versus FP32
2.370%. Full quantized models are 1.52 MB, but their small browser speed gains
do not compensate for the measured accuracy loss. This does not justify QAT
as the next speed experiment on this runtime.

Selected results from the identical 12-page workload, with the full runtime:

| Configuration | Warm pages/s | Page CER |
| --- | ---: | ---: |
| Trained Turbo, controls before / after | 7.90 / 7.89 | 3.623% |
| Quality | 6.49 | 2.527% |
| Turbo, compact character IDs | 8.48 | 3.623% |
| Turbo, pointwise-only INT8 | 8.57 | 3.833% |
| 8-block student, full width | 7.19 | 2.610% |
| 8-block student, 85% width | 8.20 | 3.522% |
| 6-block student, full width | 8.36 | 2.877% |
| 6-block student, full width and compact IDs | 8.90 | 2.877% |
| 8-block student, full width and compact IDs | 8.11 | 2.610% |

Adjacent repeat Turbo/compact-ID cases measured 8.29/8.66 pages/s with identical
text. Compact IDs cut returned score data from about 23.45 MB to 28 KB per page
in the initial pair; measured decoding fell from 8.8 ms to 0.2 ms. They still
compute the full classifier. Confidence consumers can request the retained
logits. Parameter count or returned bytes alone do not predict document speed.

Allocator and graph-optimization switches showed no compelling gain. Sorted
larger batches and cross-page batches were generally slower; the existing
buckets already have only about 2.3% padding overhead. Reducing detection to
640px reached 8.65 pages/s at 4.676% CER; 512px reached 9.60 at 10.986% CER.
Students trained at full width also lose substantial accuracy when simply
squeezed to Turbo width. Those faster, higher-error settings are not selected
as accuracy-preserving replacements.

These controls are slower than the earlier reduced-runtime 8.98 pages/s run.
Current reduced Turbo measured 7.75 pages/s and reduced Quality 7.00; changing
the runtime alone does not explain the whole historical difference. Use the
matched controls within each pass. No new 2x document-speed gain is established
by this sweep.

### Full 55-page document check

Expanded the workload to all 55 original test pages, using their source images
and XML in place. The input manifest is
`cdde01301a19c848adf57de7e42efc727410c7a988d334ab727743672023c4b7`,
with 145,475 normalized reference characters. This is broader page coverage of
the existing examined partition, not a new untouched test. Settings remain
the 768px Indra detector, six recognition workers, four layout workers, smaller
previews and single-thread CPU WASM per worker. All five offline packages passed
the same output/PDF checks on every page.

| Recognizer | Warm pages/s | Page CER | Character edits | First recognition, seconds |
| --- | ---: | ---: | ---: | ---: |
| Trained Turbo, control before / after | 6.28 / 6.18 | 4.479% | 6,516 | 9.84 / 9.82 |
| Quality | 5.66 | 2.916% | 4,242 | 10.36 |
| 8-block student with compact IDs | 6.36 | 3.110% | 4,524 | 9.53 |
| 6-block student with compact IDs | 6.24 | 3.618% | 5,263 | 9.46 |

Model startup adds 2.47–2.68 seconds and file opening 0.42–0.47 seconds. From a
fresh browser instance to the first complete 55-page recognition, the measured
pieces total about 12.4–13.3 seconds, before PDF export or user interaction.
Filesystem caches were already in use. The larger workload is slower per page
than the 12-page sample; it also reverses the students' small-workload speed
ranking. The eight-block model offers the better observed full-document
accuracy/speed tradeoff here.

Quality's mean per-page recognition-model wall time is 0.615 seconds, layout
model 0.086, crop packing 0.043 and PDF rendering 0.096. These phases overlap
across workers and include contention; they must not be added or inverted into
pages/s. Working-set snapshots sum to about 2.9–3.2 GB across this Chromium
instance's processes, can double-count shared pages and are not peak memory.
Private receipts are under `browser/latest/desktop/speed-followup/` and
`browser/full-test/latest/desktop/speed/`.

### Further speed directions from primary-source research

The next architectural experiment worth screening is channel reduction, beyond
removing whole residual blocks. Indra's expensive expand/project convolutions
mix channels at every horizontal timestep. A 96- or 64-channel student can
physically shrink those operations while retaining the full character set and
the existing CTC time grid. The expensive pointwise operations scale roughly
with the square of channel width; this is an arithmetic estimate, not a browser
latency prediction. Initialization and human-transcript CTC plus teacher
distillation would need development selection and actual browser measurements.
Removing filters, rather than setting weights to zero in the same dense graph,
is the relevant mechanism in [structured filter pruning](https://arxiv.org/abs/1608.08710).
[PaddleOCR's pruning workflow](https://www.paddleocr.ai/v2.9.1/en/ppocr/model_compress/prune.html)
also uses sensitivity analysis before selecting pruning ratios. Channel-pruned
Indra is tested in the subsequent low-level follow-up; 96 channels remain
unmeasured.

An independent runtime experiment is the same trained recognizer through
[Tencent ncnn's WebAssembly SIMD build](https://github.com/Tencent/ncnn/wiki/how-to-build#build-for-webassembly).
This tests different CPU convolution kernels without changing recognition
weights; conversion parity, supported dynamic shapes and complete offline
browser performance remain unmeasured. ONNX Runtime's
[XNNPACK provider](https://onnxruntime.ai/docs/execution-providers/Xnnpack-ExecutionProvider.html)
is another optimized kernel library, but is not an interchangeable provider
option in the installed ORT Web JavaScript backend. It would require a separate
integration/build rather than a query flag. A backend's speed on unrelated
hardware or short word crops does not establish speed on these long legal lines.

Adaptive computation is a further hypothesis: accept easy lines from a much
smaller recognizer and reserve the full model for uncertain ones. Its gate must
be calibrated against development human transcripts, including confidently
wrong predictions, and account for the cost of running a second model. Related
[CTC early-exit research](https://arxiv.org/abs/2309.09546) concerns speech,
not a demonstrated OCR result. Late blank-frame removal or faster beam search
does not remove this recognizer's already-paid convolution cost; our decoder
is already greedy. No adaptive OCR speedup has been established here.

The new [PP-OCRv6 architecture report](https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.en.md)
reinforces distillation into a simple CTC tiny recognizer, but PP-OCRv6 Tiny was
already included in our measured screen and was slower than Kraken on the
desktop's long-line ONNX CPU workload. Its published end-to-end timings use
different hardware and data. It is not an untried faster candidate for this
browser workload.

### Channel pruning and the WebAssembly matrix kernel

The next speed-focused student retains all ten residual blocks and the complete
1,679-class classifier, but physically reduces base channels from 128 to
64, expanded channels from 256 to 128 and squeeze channels from 64 to 32.
It keeps full input width and the original CTC time grid. Weight-importance
initialization is followed by human-transcript CTC and the same frozen-teacher
distillation objective. After the 40-epoch cap, development selection chose
epoch 39. The selected CPU export scores 2.379% development CER and 1.536%
native test CER. These are line-recognition scores on the previously examined
partitions, not assembled-page scores. The model has 373,199 parameters and
its raw ONNX is 1,521,139 bytes, versus 1,236,239 and 4,973,880 for Quality.

A named-function CPU profile put about 80% of prepared recognition samples
inside ONNX Runtime's SGEMM path. A custom WASM SIMD kernel handles four rows
and eight columns together, reusing matrix loads; the original kernel handles
the remaining two or one rows. It preserves the packed matrix format and
float32 arithmetic order. An independent numeric check passed 1,020 cases,
including stride padding, partial vectors, all 1,679 output classes, zero/add
modes and several alpha values. Private source/build fingerprints are retained
beside the compiled runtime. The build helper reverses its temporary upstream
source patch in the shell exit trap.

The quiet browser microbenchmark uses 128 frozen development lines, prepared
tensors, one CPU WASM thread, seven warm trials and rotating model order.
Bracketing original-kernel runs measure drift; sampling happens after timing.
The detector, cropping, rendering and text assembly are outside this test.

| Recognizer | Original kernel before / after, lines/s | Four-row kernel, lines/s |
| --- | ---: | ---: |
| Quality, full width | 100.42 / 100.49 | 115.45 |
| Trained Turbo, 76% width | 127.02 / 127.57 | 149.15 |
| 8-block student, full width and compact IDs | 116.84 / 119.84 | 137.77 |
| 6-block student, full width and compact IDs | 145.55 / 145.03 | 165.46 |
| 64-channel student, full width and compact IDs | 274.68 / 276.46 | 308.95 |

The new kernel adds approximately 12% recognition throughput for the
64-channel model and 17% for trained Turbo relative to the mean of the two
controls. The small model is 2.07 times faster than Turbo with the same new
kernel, or 2.43 times the bracketing original Turbo throughput. These ratios
must not be reported as whole-document speedups.

Equivalent graphs exposing the convolutions as height-one Conv2D do not show
a useful additional gain with this backend. A separate fused SIMD classifier
reaches 936 versus 702 prepared lines/s for the 64-channel classifier
component, including input/output copies and exact greedy-ID checks against
the real full-model outputs. That is a component experiment; it has not been
integrated into document recognition. Its teacher-model gain over the new
kernel is only about 1%. XNNPACK and ncnn remain unmeasured.

Private receipts and fixtures live under `speed-frontier/`; the new runtime
assets are `assets/indra-kernels/profiling/` and `assets/indra-kernels/sgemm/`.
The former retains function names for profiling but uses optimized Release
arithmetic without execution instrumentation. Both builds share the same
source revision, compiler, operator config and settings apart from the kernel
patch. All nine models produced identical greedy-ID fingerprints across both
kernels and both control runs.

#### Full 55-page follow-up

The corresponding offline packages were measured with the same original
55-page manifest, 768px detector, thumbnail previews, six recognition workers
and four layout workers. The two Turbo controls bracket the candidates.

| Recognizer and runtime | Warm pages/s | Page CER | First recognition, seconds |
| --- | ---: | ---: | ---: |
| Trained Turbo, original kernel before / final after | 6.67 / 6.13 | 4.479% | 9.10 / 10.07 |
| Trained Turbo, four-row kernel | 6.73 | 4.479% | 8.85 |
| Quality, four-row kernel | 5.49 | 2.916% | 11.58 |
| 64-channel student, original kernel | 8.33 | 4.784% | 7.39 |
| 64-channel student, four-row kernel | 8.50 | 4.784% | 7.30 |
| 8-block student, stock runtime | 5.80 | 3.110% | 10.12 |
| 8-block student, four-row kernel | 5.90 | 3.110% | 9.78 |
| 8-block student, four-row kernel and four recognition workers | 5.42 | 3.110% | 10.96 |
| 8-block student, four-row kernel and 896px detector | 5.58 | 2.601% | 9.93 |
| 8-block student, four-row kernel and 1024px detector | 5.36 | 2.246% | 10.77 |

Every package passed offline recognition, worker/main output equality, stable
text over three rounds, searchable-PDF character retention on all 55 pages and
unchanged first-page PDF pixels. Same-model kernel pairs also retain exactly
the same OCR text and raw/recognized line geometry. Raw detection remains
unchanged; the detector has not been trained from the Kraken boxes.

The 64-channel package runs at 8.50 pages/s against Turbo controls ranging
from 6.13 to 6.67, but adds 443 character edits on this document. Its stronger native line score
does not establish stronger recognition on the browser detector's different
crops. Using roughly 3% assembled-page CER as a working target, this model
is not selected as the replacement. Quality and the eight-block student remain
the lower-error options. The standalone four-row kernel does not establish a
meaningful document-speed gain here: Turbo is effectively unchanged, and the
small model's 2% increase is within the variation of these short warm rounds.
The earlier full-runtime Quality result was 5.66 pages/s; the new 5.49 result
does not show an improvement.

The eight-block follow-up also found little document gain from the kernel
and a clear regression with four rather than six recognition workers. A
separate quiet stock-runtime microbenchmark measured Quality/Turbo/eight-block
at 98.77/126.07/120.75 prepared lines/s, supporting a real isolated arithmetic
gain without a corresponding large document gain. The earlier eight-block
whole-document result was 6.36 pages/s; report the repeated 5.80/5.90 controls
for the new kernel comparison rather than attributing cross-pass variation
to the patch.

The eight-block recognizer at 896px detection lowers CER to 2.601%
(3,784 edits), and 1024px reaches 2.246% (3,267 edits). Both remain close to
Quality's throughput while improving its 2.916% page CER at 768px detection.
These are useful accuracy tiers, without a demonstrated large processing gain.
Background CPU snapshots vary from about 2.5% to 13%; the final Turbo control
is 8% slower than the first. Small throughput differences are consequently
uncertain. Increasing detector resolution changes geometry, and those pairs
are evaluated against human text rather than asserted to have identical boxes.

Mean per-page model wall time falls from 0.451 seconds for Turbo to 0.201 for
the 64-channel model. Rendering remains about 0.10 seconds, layout about 0.17,
crop packing about 0.04, while preview completion measures 0.081 and 0.126
seconds respectively. These overlapping durations include scheduling and CPU
contention; their sums are not a document-time decomposition. They support
investigating rendering, thumbnail work and worker balance alongside kernels.

A 96-channel student is a possible middle point, with less capacity removed
than the 64-channel run. It remains untrained. Further low-level possibilities
include fusing crop/grayscale/packing passes; the new variants below also test
relaxed-SIMD FMA in the matrix kernel.
[Emscripten documents](https://emscripten.org/docs/porting/simd)
the `-mrelaxed-simd` target; the
[WebAssembly specification](https://www.w3.org/TR/wasm-core/) permits different
rounding for relaxed multiply-add. Such a build would need fresh numerical and
whole-page accuracy gates. Offscreen
preview preparation is another hypothesis; the runtime already uses workers
for recognition and detection, so moving existing worker work alone is not a
new optimization.

#### What ORT 1.30 changed, and the next custom kernels

The official npm registry reports ORT Web 1.30.0; the current browser runtime
is 1.22.0. Comparing the actual tagged source shows that the whole float32
`wasm_simd` directory is unchanged, including
[SGEMM](https://github.com/microsoft/onnxruntime/blob/v1.30.0/onnxruntime/core/mlas/lib/wasm_simd/SgemmKernelWasmSimd.cpp)
and GEMV. Their blob hashes are respectively
`43a12b37e4ffa68ea77a5342eb6ccaa860173cc9` and
`a46efd4093a34bb85abc5f8cb0622b3a67914a95` in both versions. The last directory
change is the March 2024 GEMM bug fix, already present in 1.22.

The surrounding changes are more specific than a general speed improvement:

- [NHWC convolution without transposes](https://github.com/microsoft/onnxruntime/pull/26834)
  and its depthwise extension are gated to ARM64/KleidiAI, excluding this WASM path.
- [Convolution thread partitioning](https://github.com/microsoft/onnxruntime/pull/26103)
  schedules batch/group shards; the current pooled browser workers each use one
  inference thread.
- [The scratch-buffer fix](https://github.com/microsoft/onnxruntime/pull/28482)
  repairs over-allocation introduced by that later threading change. Our 1.22
  implementation already uses the original fixed per-thread scratch size.
- The non-SIMD SGEMM fix affects the scalar build. Quantized WASM kernels and
  WebGPU/WebNN also changed, but they do not replace our FP32 SIMD hot loop.
- Emscripten updates and loader fixes can affect compilation/loading behavior;
  they do not establish faster document inference. No new ORT version is installed.

New custom variants retain ORT 1.22, its current compiler, models and operators:
`tiles` uses six rows by eight columns with the earlier four/two/one-row tails;
`fma` adds explicit relaxed-SIMD multiply-add to that tile; `depthwise` adds a
direct nine-tap, stride-one, padded depthwise kernel; `fmadw` combines both.
The depthwise dispatch is limited to matching single-thread, identity-activation
convolutions and reads the original row without im2col packing. It leaves the
existing scratch allocation contract intact. The FMA compiler option is applied
only to its matrix source and final link, avoiding a global relaxed-math build.

The numeric WASM checks pass 4,272 matrix cases and 720 depthwise cases across
both strict and FMA modules. They cover packed matrix tails, strides, alpha,
zero/add modes, untouched output padding, non-dyadic rounding bounds, small
image widths, batch/channel counts and optional bias. These checks establish
numeric behavior, not whole-page accuracy or speed. Actual-model/browser
measurements follow under `speed-frontier/custom-kernels/`.

The first quiet seven-trial sweep rejects the six-row variants on this CPU:

| Matrix/depthwise variant | Quality lines/s | Turbo lines/s | Eight-block lines/s |
| --- | ---: | ---: | ---: |
| Four-row control, before | 113.79 | 144.88 | 134.33 |
| Six-row strict | 96.90 | 124.87 | 114.99 |
| Six-row with explicit FMA | 93.07 | 118.66 | 109.25 |
| Six-row plus direct depthwise | 99.95 | 129.02 | 119.99 |
| Six-row FMA plus direct depthwise | 101.15 | 128.66 | 119.92 |
| Four-row control, after | 116.47 | 149.66 | 138.68 |

These are prepared recognition tensors, not page rates. Every model's greedy
ID fingerprint matches its before control across all six runs. Background
snapshots range from 1.3% to 10.9%; even the faster six-row variants remain
well below both four-row controls. FMA does not establish a gain here. A larger
tile is therefore not selected merely for increasing arithmetic reuse.

The direct depthwise dispatch is active: separate Quality CPU profiles reduce
im2col leaf samples from 475 to 15 in the strict pair, and 475 to 20 in the FMA
pair. Sampling follows timing and is not a precise time accounting. This
supports a follow-up `sgemm4dw` build combining the existing faster four-row
matrix kernel with direct depthwise, leaving out the slower six-row change.

The isolated four-row plus direct-depthwise trial measures
120.03/154.44/142.60 prepared lines/s for Quality/Turbo/eight-block. Its
before controls are 112.48/146.14/135.34 and after controls
114.31/147.69/137.04. This is 5.9/5.1/4.7% above the mean controls,
with identical greedy-ID fingerprints for every model. Background snapshots
are 13.7/3.1/1.9%, so compare with the later control too: gains are
5.0/4.6/4.1%. Its runtime SHA-256 is
`5cf2a377733304890502519bebe104b1e47262f396d1df92401542ad319cb73b`.

The full 55-page no-preview gate does not establish an additional document
speed gain from the direct-depthwise kernel:

| Full-width recognizer and kernel, no previews | Detector | Warm pages/s | Page CER |
| --- | ---: | ---: | ---: |
| Eight-block, four-row control before | 896px | 6.394 | 2.601% |
| Eight-block, four-row plus direct depthwise | 896px | 6.588 | 2.601% |
| Eight-block, four-row control after | 896px | 6.587 | 2.601% |
| Quality, four-row plus direct depthwise | 768px | 6.336 | 2.916% |

Each case uses seven warm passes. The candidate improves on the earlier
control by 3.0% and matches the later control; this is not a demonstrated
whole-document acceleration. Its text, raw geometry, recognized geometry and
exported PDF bytes match the eight-block control exactly. All four cases pass
offline recognition, worker/main equality, stable output and searchable-PDF
character/pixel checks. Quality retains 4,242 edits and the eight-block runs
retain 3,784. Quality has no paired same-pass Quality control, so its absolute
throughput is not a kernel-speed comparison with earlier sessions. The
eight-block background snapshots are 4.7/4.6/4.9%; Quality's is 8.2%.

Both new `-sgemm4dw-no-previews` HTML/archive pairs are retained separately;
the previously tested simpler `-sgemm-no-previews` package remains the practical
choice. No model/runtime default is promoted. All temporary upstream source
patches and copied kernel headers are removed after the build, and no owned
benchmark process or training lock remains.

### Remaining non-kernel levers

The current follow-up isolates generated document previews using the same
55-page input, eight-block recognizer, 896px detector and four-row runtime.
The separate `no-previews` package defaults to no generated document images;
thumbnail controls override that default. PDF rasterization, unchanged-resolution
OCR, text assembly and searchable-PDF export remain in the measured flow.

| Preview setting, same package and model | Warm pages/s | Page CER | Generated images |
| --- | ---: | ---: | ---: |
| 640px thumbnails, before | 6.178 | 2.601% | 54 |
| No document previews | 6.452 | 2.601% | 0 |
| 640px thumbnails, after | 6.374 | 2.601% | 54 |

Each scenario uses seven warm full-document passes. No previews saves 1.2%
relative to the later control, or 4.4% relative to the earlier control; the
controls drift by 3.2%, so this is a small gain rather than a robust large
speedup. All three retain the same 3,784 character edits, text, raw boxes and
recognized geometry. Offline recognition, worker/main equality, all-page PDF
character retention and first-page PDF pixel preservation pass. Initial
recognition is 9.79/9.35/9.74 seconds, opening about 0.41 seconds and export
about 0.42 seconds; startup is 3.20/2.09/2.14 seconds, separate observations.
Background CPU snapshots are 5.2/5.7/7.9%. The already-opened first-page view
is retained in every case. Preview durations overlap worker recognition;
they cannot be subtracted from document time to predict a large gain.

The tested HTML is
`dist/legal-browser-ocr-indra-detectors-student8ids-sgemm-no-previews.html`
with SHA-256 `fa4002e533fefc9a6410ab75fbfe6b088063ff623f0639e8d6599edf8fe934be`.
Select Quality and use
`?detector=indra&detectorSide=896&pool=6&layoutWorkers=4`.
Receipts live under `browser/full-test/latest/desktop/speed-pipeline/`.

The later experiments above cover crop-robust training, a 96-channel middle
point and CPU thread/session allocation. Larger unmeasured options include a
small-model/teacher recognition cascade and a low-rank full-alphabet classifier.
A cascade needs development-calibrated error detection and must charge both
passes. Simple confidence alone can miss confident errors. Crop-robust training
uses the existing human transcripts without treating Kraken geometry as gold;
the gap between line and page CER also includes detection and reading order,
so it does not measure the recoverable fraction.

The shared recognition pool now passes requested threads through to workers.
[ORT's web guidance](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)
requires cross-origin isolation for WASM threading. The hosted two-by-two and
one-by-four allocation experiment above measures this separately from offline
single-thread workers; neither beats four single-thread workers on the laptop.

A scanned-PDF image fast path can reduce PDF render/composite work on simple
scans; the later scan-PDF experiments above measure it using the
[PDF.js operator list](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)
and reuse a simple page's image where geometry and appearance can be proven,
with normal rendering for unsupported pages. Rotated, clipped, masked,
composited and vector pages prevent a generic direct-image assumption. The same
follow-up measures fused GPU crop/gray/tensor preparation. Moving preview
creation off the main thread and trying another CPU backend remain unmeasured.

## Reproduction

With the desktop training environment active, set the asset-location variables
to the existing data and model directories described in the README, then run:

```powershell
python experiments/ocr-candidate-screen/screen.py --data-root $env:OCR_DATA_ROOT --source-bundle $env:OCR_SOURCE_BUNDLE --openocr $env:OPENOCR_SOURCE --rep-weights $env:REPSVTR_WEIGHTS --output benchmarks/local-data/ocr-candidate-screen --epochs 1 --batch-size 16
python experiments/ocr-candidate-screen/evaluate.py --data-root $env:OCR_DATA_ROOT --openocr $env:OPENOCR_SOURCE --rep-weights $env:REPSVTR_WEIGHTS --output benchmarks/local-data/ocr-candidate-screen --kraken-pack $env:KRAKEN_PACK --kraken-runtime $env:KRAKEN_RUNTIME_SOURCE --threads 2 --batch-size 16
python experiments/ocr-candidate-screen/screen.py --data-root $env:OCR_DATA_ROOT --source-bundle $env:OCR_SOURCE_BUNDLE --openocr $env:OPENOCR_SOURCE --rep-weights $env:REPSVTR_WEIGHTS --crnn-weights $env:CRNN_WEIGHTS --output benchmarks/local-data/ocr-candidate-screen --models crnn --epochs 1 --batch-size 16
python experiments/ocr-candidate-screen/evaluate.py --data-root $env:OCR_DATA_ROOT --openocr $env:OPENOCR_SOURCE --rep-weights $env:REPSVTR_WEIGHTS --crnn-weights $env:CRNN_WEIGHTS --output benchmarks/local-data/ocr-candidate-screen --models crnn --receipt crnn-evaluation.json --kraken-pack $env:KRAKEN_PACK --kraken-runtime $env:KRAKEN_RUNTIME_SOURCE --threads 2 --batch-size 16
python experiments/ocr-candidate-screen/audit_repsvtr.py --data-root $env:OCR_DATA_ROOT --openocr $env:OPENOCR_SOURCE --rep-weights $env:REPSVTR_WEIGHTS --output benchmarks/local-data/ocr-candidate-screen
python experiments/ocr-candidate-screen/optimize_repsvtr.py --data-root $env:OCR_DATA_ROOT --openocr $env:OPENOCR_SOURCE --rep-weights $env:REPSVTR_WEIGHTS --output benchmarks/local-data/ocr-candidate-screen
python experiments/ocr-candidate-screen/screen.py --data-root $env:OCR_DATA_ROOT --source-bundle $env:OCR_SOURCE_BUNDLE --openocr $env:OPENOCR_SOURCE --rep-weights $env:REPSVTR_WEIGHTS --crnn-weights $env:CRNN_WEIGHTS --warm-start benchmarks/local-data/ocr-candidate-screen --output benchmarks/local-data/ocr-candidate-screen/convergence --models indra crnn --epochs 30 --patience 8 --min-epochs 10 --lr-patience 2 --min-delta 0.00001 --batch-size 16
python experiments/ocr-candidate-screen/evaluate.py --data-root $env:OCR_DATA_ROOT --openocr $env:OPENOCR_SOURCE --rep-weights $env:REPSVTR_WEIGHTS --crnn-weights $env:CRNN_WEIGHTS --output benchmarks/local-data/ocr-candidate-screen/convergence --models indra crnn --kraken-pack $env:KRAKEN_PACK --kraken-runtime $env:KRAKEN_RUNTIME_SOURCE --threads 2 --batch-size 16
python experiments/ocr-candidate-screen/paired_timing.py --data-root $env:OCR_DATA_ROOT --crnn-weights $env:CRNN_WEIGHTS --output benchmarks/local-data/ocr-candidate-screen/convergence --kraken-pack $env:KRAKEN_PACK --kraken-runtime $env:KRAKEN_RUNTIME_SOURCE
```

Measured software: PyTorch 2.14.0+cu126, Transformers 5.19.0, NumPy 2.5.3,
ONNX 1.23.0, ONNX Runtime 1.30.0, PyArrow 24.0.0 and OpenCV 5.0.0.
The CRNN follow-up adds python-doctr 1.1.0; exact supporting package versions
are recorded in the private environment receipt.

## Validation and interpretation

Indra's trainable graph loads the published ONNX initializers. Three independent
ONNX checks reproduced IDs and lengths exactly; maximum confidence difference
was 0.00000516. PP-OCRv6 and RepSVTR training logits reproduced their public
inference probabilities before training. The RepSVTR checkpoint's auxiliary GTC
training heads were excluded; its CTC encoder received gradients during the
fine-tune. Its final encoder export uses upstream RepViT fusion and a numerical
parity check.

Training-only horizontal expansion made 32 Indra and 64 PP-OCRv6/RepSVTR crops
wide enough for valid CTC alignment. Evaluation dimensions never use labels.
Classifier expansion retained existing indices and added 1/1/22 training
characters respectively. All evaluation lines are scored, including characters
absent from a recognizer's training alphabet.

Three focused harness tests passed: CTC repeated-character decoding and
normalization, rejection of article overlap, and training-only CTC sizing.
Final ONNX checks compare two different batch/width combinations with PyTorch.
The follow-up reran all three tests and added actual native CRNN output/decoder
parity and RepSVTR encoder-weight/batch-normalization assertions. All passed.
The longer training phase passed four focused tests, adding learned-vocabulary
checkpoint preservation, and exercised full optimizer/RNG resumption, learning-rate
reductions, early stopping, and final ONNX parity on the actual corpus.

Model checkpoints and exported inference models remain private in
`benchmarks/local-data/ocr-candidate-screen/`, alongside data hashes, exact
model revisions, software versions and aggregate receipts. The source page
corpus was neither copied nor modified. Indra's model licence still applies
to its derived weights; this experiment does not decide redistribution.

## Markers and footnote glyphs (2026-10-22)

Experiment only; no release package or `legal-browser-ocr` file changed. Plan, gold encoding
and the parser's consumption of OCR text are in [MARKERS-PLAN.md](MARKERS-PLAN.md).
Targets keep superscript note calls as plain characters, as the gold and the parser do.

**Gold.** Structure gold v4 OCR documents (desktop `lsg-v4` store): corrected line =
`lines[].text` plus `text_edits`; list markers are gold `typed[].markers` spans at line
start, note calls are gold `typed[].references` spans. Splits follow the cohort manifest:
train 238 documents / 931 OCR pages, development 60 / 248 (with test 25 documents). The
gold's authoring extraction is mostly scans' own text layers, not our recognizer, so every
measurement below runs the shipped native `legalocr.exe` (v0.2.0 pack, Hayro 144 dpi render,
Quality tier, detector side 1024) on PDFs holding only the gold OCR pages. All recognized lines
inside a gold line's box are joined left to right (the detector often boxes a tab-separated
marker on its own). A span counts as correct only if every gold character aligns equal.
Lines are usable when non-empty, free of U+FFFD and within 0.5 CER of the authoring text.

**Instrument checks.** The student8 checkpoint re-exported by this harness reproduced the
shipped pack exactly through `legalocr --model-pack` (identical scores on all 5,246 matched
development lines), and the CPU and DirectML backends agreed (development targets CER
6.456% both). Training crops come from pypdfium2 renders because Hayro is not exposed to
Python. The two renders read differently (3.1% CER between them, 64% identical lines) but
score alike against gold (other-line CER 13.5% Hayro, 13.9% pdfium; marker errors 208 vs
203 of 534), and on pdfium crops the stock model's development marker error (39.3%) matched
its native rate (39.1%).

**Training data.** Native Quality boxes on the train documents, paired with usable gold
lines when one recognized line lies inside the gold box at IoU >= 0.5 (25,487 lines), plus
262 lines where the detector split a narrow line-start marker from its body (marker crop
labelled with the gold marker, body with the rest). Usable pairs: 26,011, of which 3,450 are
marker/reference lines (244 with note calls). No synthetic rendering. Both arms add the full
Arrow train split (26,981 lines) and repeat note-call lines four times.

| Arm | Gold lines added | Train lines | Epochs run / selected | Wall time (incl. dev checks) |
| --- | ---: | ---: | ---: | ---: |
| A: marker/reference lines + equal other gold lines | 7,632 | 34,613 | 9 / 5 | 8.2 min |
| B: all usable gold-train lines | 26,743 | 53,724 | 7 / 3 | 9.7 min |

Both start from the shipped student8 weights (8 blocks, epoch 19), AdamW 5e-5 halving on
plateau, frozen batch-normalization statistics, batch 16, seed 714, patience 4, 12-epoch cap.
Selection, fixed before training: lowest mean of Arrow-development CER and the
development marker/reference-line crop CER. B had the lower objective (0.01926 vs 0.01985).
Test was scored once, after both checkpoints were selected; it selected nothing.
New output classes from gold text: 6 (A) / 7 (B), all noise characters (emoji, flags, a
lone surrogate left out of the codec).

**Arrow corpus (no regression).** ONNX CPU, all lines:

| Model | Arrow dev CER | Arrow test CER (edits / 143,308) |
| --- | ---: | ---: |
| Shipped student8 | 1.402% | 0.883% (1,265) |
| A | 1.384% | 0.867% (1,243) |
| B | 1.371% | 0.845% (1,211) |

ONNX exports matched PyTorch at two batch/width shapes (max logit delta 7.8e-5 / 3.7e-5);
the compact class-ID graphs reproduced argmax and lengths exactly on four development batches.

**Crop level** (pypdfium2 crops on native boxes, PyTorch GPU; development was used for
selection):

| Model | Dev marker/ref lines CER | Dev marker errors | Dev note-call errors | Test marker/ref lines CER | Test marker errors | Dev other CER | Test other CER |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Shipped | 3.94% | 194/494 | 19/53 | 2.44% | 49/408 | 6.37% | 2.16% |
| A | 2.58% | 109/494 | 18/53 | 1.85% | 15/408 | 4.84% | 1.80% |
| B | 2.48% | 117/494 | 16/53 | 2.07% | 15/408 | 4.17% | 1.58% |

**Native end to end** (`legalocr --model-pack`, Quality, CPU, Hayro render; same detector
so the same boxes; 5,226 development and 2,856 test gold lines matched in every arm):

| Split / model | Marker/ref lines CER | Exact lines | Marker errors | Note-call errors | Other lines CER |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dev, shipped | 6.46% | 37.9% | 209/535 (39.1%) | 22/54 (40.7%) | 13.42% |
| Dev, A | 5.33% | 55.2% | 123/535 (23.0%) | 16/54 (29.6%) | 11.82% |
| Dev, B | 5.27% | 53.7% | 139/535 (26.0%) | 16/54 (29.6%) | 11.04% |
| Test, shipped | 2.40% | 65.8% | 45/419 (10.7%) | 1/2 | 4.94% |
| Test, A | 1.90% | 83.6% | 17/419 (4.1%) | 1/2 | 4.57% |
| Test, B | 2.23% | 77.2% | 18/419 (4.3%) | 1/2 | 4.29% |

Paired span outcomes against the shipped model (exact two-sided sign test on spans that
changed): test markers A 34 fixed / 6 broken (p = 8e-6), B 34 / 7 (p = 3e-5); development
markers A 96 / 10, B 87 / 17. Note calls: development A 8 / 2 (p = 0.11), B 6 / 0
(p = 0.03), but development chose the checkpoint, and the test split holds only 2 matched
note calls, so note-call recognition has no held-out evidence either way.

The 300-line development sample in the plan (all 54 note-call lines plus 246 marker lines)
moved from 95/254 marker and 22/54 note-call errors (5.77% CER) to 56/254 and 16/54
(4.76%) with A, and 63/254 and 16/54 (4.73%) with B.

Remaining development errors are bracket and parenthesis confusions (`[4]` -> `14`,
`(b)` -> `(5)`, `(iii)` -> `(ii)`) and markers with nothing read inside the gold box (39 of
535 shipped, 39 for A, 44 for B: check marks, column codes such as `C6`, far-left numbers).
Retraining the recognizer did not touch the latter; they are detector or line-grouping misses
and are now about a third of A's remaining marker errors. The detector was not fine-tuned:
there is no corrected box gold (README), and these misses are a minority.

**Not measured.** Parser-level structure scores (an `extract.mjs` run with a `model_pack`
setting would fill a separate cache entry; not run), browser packages, and speed. The graph
is unchanged apart from 6-7 extra classifier rows (1,679 -> 1,685/1,686 classes), so no speed
claim is made. The olj-db footnote gold has page images and marker rows, but it comes from
the same journal family as the Arrow corpus and its article partition was not reconciled
with the Arrow split, so it was not used.

**Recommendation: needs more data for note calls; for list markers, worth carrying into a
tier after a parser-level check.** Training on our own detector's boxes with corrected
court-scan lines cut held-out marker errors by 60% (10.7% to 4.1-4.3% on test), improved
whole-line CER on court scans, and also slightly improved the Arrow test set. Superscript note
calls are too rare in the OCR gold (244 training lines, 2 test spans) to claim anything. A
targets the brief best on test and B generalizes better to other court-scan lines; neither
dominates. Next: gather note-call crops (scanned factums/affidavits with footnotes, or the
olj-db pages once their partition is reconciled), run the parser-level structure A/B on the
development cohort, and look at the detector for the dropped-marker class.

Artifacts: `assets/markers/{A-targets,B-all}/` (compact class-ID `model.onnx`, `codec.json`,
export and training receipts, the copied pack manifest). Model SHA-256: A
`734e2f7695ee325120e7e8e005d88b2cc78b6e8d03bdee7023730c8ce777dc50`, B
`641aab4702772e43aa4bad1f9e4e6b7f8942bcd6a369c870910557e5032d4cc9`. The harness is in
`markers/`; copy it beside `screen.py`, `indra.py` and `evaluate.py` into one desktop work
directory (`C:\Users\elias\beaver-train\markers`; paths to the gold store and `legalocr.exe`
are fixed in the scripts). `markers.py` pins Indra revision
`ed345c7f158eddbc7dee0c6a7269afb75a94f7e8`. Upstream has published a new `rec.onnx`
(height 96); an unpinned load fetched it and moved the desktop cache's `refs/main`, which was
restored to the pinned revision. Commands, run in that directory:

```bat
python -I census.py lines.jsonl.gz
python -I make_subset.py lines.jsonl.gz subset development,test
python -I make_subset.py lines.jsonl.gz subset train
py.cmd ocr_ab.py run --split train --tier quality --backend auto --out ocrout\stock-train-quality-auto
py.cmd ocr_ab.py run --split development --tier quality --backend auto --out ocrout\stock-dev-quality-auto
py.cmd ocr_ab.py run --split test --tier quality --backend auto --out ocrout\stock-test-quality-auto
py.cmd build_pairs.py train ocrout\stock-train-quality-auto pairs\train.arrow
py.cmd build_pairs.py development ocrout\stock-dev-quality-auto pairs\development.arrow
py.cmd build_pairs.py test ocrout\stock-test-quality-auto pairs\test.arrow
run.cmd train --checkpoint STUDENT8\best.pt --crops pairs --data-root DATA --output runs\A-targets --other-ratio 1 --ref-repeat 4
run.cmd train --checkpoint STUDENT8\best.pt --crops pairs --data-root DATA --output runs\B-all --other-ratio 100 --ref-repeat 4
run.cmd export --checkpoint runs/A-targets/best.pt --data-root DATA --stock-pack PACK --out export/A-targets
run.cmd export --checkpoint runs/B-all/best.pt --data-root DATA --stock-pack PACK --out export/B-all
py.cmd ocr_ab.py run --split development --tier quality --backend cpu --out ocrout\stock-dev-quality-cpu
py.cmd ocr_ab.py run --split development --tier quality --backend cpu --pack export\A-targets\pack --out ocrout\A-dev-quality-cpu
py.cmd ocr_ab.py score --split development --out ocrout\stock-dev-quality-cpu --out ocrout\A-dev-quality-cpu --out ocrout\B-dev-quality-cpu --report ab-dev.json
run.cmd final --baseline STUDENT8\best.pt --checkpoint runs/B-all/best.pt --crops pairs --data-root DATA --out final-B.json
py.cmd paired.py test ocrout\stock-test-quality-cpu ocrout\A-test-quality-cpu
```

(The test-split commands mirror the development ones. `STUDENT8` =
`benchmarks/local-data/ocr-candidate-screen/speed-followup/student8/indra`, `DATA` = the
existing `kraken-student-data/binary`, `PACK` = the desktop `lsg-v4` dist
`runtime/indra`.) `build_crops.py` and `parity.py` produced the crop and render-parity checks.
Crops, transcripts and per-line receipts stay on the desktop in that work directory.

### Parser-level structure A/B: shipped Quality pack vs pack A

Each arm re-read and re-parsed whole documents through `extract.mjs --batch` (desktop `lsg-v4`
checkout, pinned addon `867a0f8e…`, request `{ocr: indra, model_pack, tier: quality, backend:
cpu}`). Each arm wrote to its own output directory under the desktop work directory, so the
recognition cache (keyed by the OCR identity, which includes the model hash) is separate per
arm. The store's `parsed/` cache was neither read nor written. The parser's own exports were
graded with `structure-gold-r10.exe grade STORE cohort-manifest.json --candidates
<arm>-<split>.inventory.json --split <split> --group yardstick=main` and compared with
`compare_group.py … groups.json yardstick=main markers_list_item 10`.

Documents: yardstick=main, mode ocr, and at least 90% of the shipped export's lines read by our
recognizer (not a kept text layer). Only 6 development documents qualify (15 pages), so I added
the 22 qualifying train documents (88 pages) and the 4 qualifying test documents (11 pages): 32
documents, 114 pages, 111 of them read by our OCR in both arms. **Pack A was trained on the
gold OCR pages of those train documents**, so the train rows are not held out; the held-out
set is development + test (10 documents, 26 pages).

| Layer (pooled F1) | Held-out, expected | Shipped | Pack A | Delta | Docs better / worse |
| --- | ---: | ---: | ---: | ---: | ---: |
| List markers (`markers_list_item`) | 64 | 0.432 | 0.554 | +0.121 | 1 / 0 |
| List items (`units_list_item`) | 64 | 0.703 | 0.877 | +0.174 | 2 / 1 |
| Numbered paragraphs (`markers_text`) | 8 | 0.000 | 0.000 | 0 | 0 / 1 |
| Note references | 9 | 0.143 | 0.000 | -0.143 | 1 / 1 |
| Notes | 10 | 0.111 | 0.125 | +0.014 | 2 / 0 |
| Transcription (characters) | 50,926 | 0.917 | 0.928 | +0.011 | 8 / 2 |
| Text units | 138 | 0.319 | 0.315 | -0.005 | 4 / 2 |
| Hierarchy parent | 239 | 0.281 | 0.305 | +0.025 | 4 / 3 |
| Order | 982 | 0.757 | 0.756 | -0.001 | 4 / 5 |
| Coverage | 992 | 0.957 | 0.954 | -0.004 | 4 / 5 |

| Layer (pooled F1) | Dev only (6 docs) | Train (22, not held out) | All 32 |
| --- | ---: | ---: | ---: |
| List markers | 0.000 -> 0.000 (20 expected) | 0.153 -> 0.251 | 0.224 -> 0.333 |
| List items | 0.571 -> 0.732 | 0.368 -> 0.451 | 0.448 -> 0.560 |
| Numbered paragraphs | 0 -> 0 | 0 -> 0 | 0 -> 0 |
| Note references | 0 -> 0 (7 expected) | 0 -> 0 (4 expected) | 0.051 -> 0.000 |
| Transcription | 0.939 -> 0.947 | 0.772 -> 0.803 | 0.797 -> 0.824 |
| Order | 0.818 -> 0.823 | 0.724 -> 0.717 | 0.730 -> 0.724 |

Per document (held-out): the list-marker gain is one document, `30d13dbad4` (test,
38 of the 64 expected markers, 0.774 -> 0.947; its list items 0.74 -> 0.95). `4dcd1be6c1`
(dev) list items went 0.62 -> 1.00 and `367bba729d` (dev) 0.71 -> 0.67. In both of those dev
documents the parser recovers none of the 20 gold list markers in either arm, so better
recognition did not reach the marker layer there; that loss is downstream of OCR. The
note-reference change is one hit: `30d13dbad4` 0.50 -> 0.00 (2 expected). One spurious
numbered paragraph appeared in `7e5dfb4afb`. Transcription improved in 8 of 10 held-out
documents (largest `7e5dfb4afb` 0.66 -> 0.73, `1aee9290dd` 0.61 -> 0.66). On train, list
markers improved in 7 documents and worsened in 1 (`9e225cddc5`, a spurious marker with 0
expected); order worsened in 13 of 22 documents by small amounts.

OCR cost: whole-document parse wall time on CPU (render, detection, recognition and structure,
fresh caches, 32 documents, 114 pages) was 40.0 s for the shipped pack (351 ms/page) and
39.5 s for pack A in each of two runs (347 and 346 ms/page). There is no measurable difference.

Verdict for this step: **ship A as the Quality recognizer — yes on the evidence available,
with a thin margin.** No structure layer regresses beyond single-document noise. Transcription
and list items improve on held-out documents, it costs nothing, and the line-level held-out
marker gain is strong (p = 8e-6). But the parser-level list-marker gain rests on one held-out
document, and numbered paragraphs and note references show no gain. Quality and
Balanced/Fast/Turbo share the `standard` model in the shipped manifest; shipping A only for
Quality needs its own model entry. The A pack used here pointed every model key at A,
Extreme's `light` model included, and only the Quality tier was exercised.

Commands (desktop work directory): `structure_jobs.py` (selection and requests),
`extract_arm.cmd jobs-shipped.json` / `jobs-packA.json` (plus the fresh `…T` timing passes from
`structure_inventory.py timing`), `structure_inventory.py inventories`, `grade_arms.cmd`,
`structure_report.py`, then `compare_group.py merged-shipped-<set>.json merged-packA-<set>.json
C:\Users\elias\fable\groups.json yardstick=main markers_list_item 10`. `qualify.py` produced
the selection census.
