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
width graph is not eligible merely by setting a flag. None of these future
changes has a measured full-document gain yet.

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

The larger unmeasured options are crop-robust student training, a 96-channel
middle point, a small-model/teacher recognition cascade, detector distillation,
a low-rank full-alphabet classifier, and different CPU thread/session allocation. Crop-robust training can reuse the
existing human transcripts with conservative crop perturbations or
geometrically matched training-page detections; it does not require treating
Kraken geometry as independent detector gold. The 64-channel model's native
line CER versus browser-page CER motivates this experiment, but the difference
also includes detection and reading-order errors, so it does not measure the
recoverable fraction. A cascade needs development-calibrated error detection
and must charge both passes. Simple confidence alone can miss confident errors.

The current recognition pool hardcodes one inference thread per worker; changing
only the main-thread `threads` query does not test fewer multi-threaded sessions.
[ORT's web guidance](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)
requires cross-origin isolation for WASM threading. That experiment would be a
hosted configuration rather than the direct-from-disk offline package measured
here. Earlier worker-count and batch sweeps do not cover it.

A scanned-PDF image fast path could reduce PDF render/composite overhead on
simple scans. This remains unmeasured: inspect the
[PDF.js operator list](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)
and reuse a simple page's image where geometry and appearance can be proven,
with normal rendering for unsupported pages. Rotated, clipped, masked,
composited and vector pages prevent a generic direct-image assumption. Moving
preview creation off the main thread, fusing crop/gray/tensor passes and
trying another CPU backend also remain unmeasured. None has a pages/s estimate.

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
