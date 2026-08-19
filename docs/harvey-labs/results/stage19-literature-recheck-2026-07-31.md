# LegalBench-RAG literature re-check (2026-07-31, Opus 5 subagent report, verbatim)

Commissioned before drafting the Stage 19 plan. Preserved verbatim; the
Stage 19 plan must cite from here rather than re-searching.

---

## 0. Headline: the CRLF artifact is real, unreported, and the mechanism is in upstream source

**Nobody has noticed.** Exhaustive check: the `zeroentropy-ai/legalbenchrag` repo has exactly **4 issues ever** (#1 License, #2 mini-split request, #3 "Do we need RAG for maud?", #4 empty "Vector Database added") and **1 PR** — none mention line endings, encoding, or span alignment. GitHub code search for CRLF/newline handling across all legalbenchrag forks and reimplementations returns nothing. No paper, no HF dataset card, no vendor blog (Ragie, ZeroEntropy, Isaacus, OpenContracts) mentions it. There is **no quotable prior report** — you are first.

### The mechanism (upstream source, `legalbenchrag/generate/generate_maud.py`)

Gold spans are computed from a **universal-newlines** read:

```python
with open(f"{save_path}/maud-main/data/contracts/{contract_name}.txt") as f:
    total_text_raw = f.read()      # newline=None -> \r\n collapsed to \n
```

…then `total_text_sourcemap` indices are indices into that **LF-normalized** string. But the corpus is shipped by a **byte-for-byte copy**:

```python
shutil.copy(f"{save_path}/maud-main/data/contracts/{contract_name}.txt",
            f"{corpus_path}/{filename}.txt")   # CRLF bytes preserved
```

**LF-coordinate gold + CRLF-byte corpus.** That is the whole bug.

### Why it is MAUD-only (verified against all four generators)

- `generate_contractnli.py:160` and `generate_privacy_qa.py:157` **write** the text themselves (`f.write(text)`) → LF on disk. Clean.
- `generate_cuad.py:189` also uses `shutil.copy` — **so CUAD has the same latent trap**, it just happens that the CUAD_v1 `full_contract_txt` sources are LF. Confirmed: 0/24 CUAD mini files have CRLF. This is luck, not design; re-check if you ever regenerate from a different CUAD release.

Local audit of `benchmarks/legalbench_rag/data/mini/corpus`:

| subset | files | CRLF files |
|---|---|---|
| contractnli | 21 | 0 |
| cuad | 24 | 0 |
| maud | **17** | **17** |
| privacy_qa | 7 | 0 |

Drift magnitude: **33,600 CRLF pairs across the 17 MAUD files**, per-file 972–3,202 (mean 1,976). Since drift accumulates monotonically, a gold span late in a 330 KB agreement is displaced by ~2–3 K chars — far beyond the median gold snippet (917 chars). Spans near the top of the doc still partially overlap, which is exactly why you see ~65% understatement rather than ~100%.

### Decisive empirical proof (run locally, 84 probe queries)

Extract each gold span under a raw byte read (Node/Rust/Go/Java behaviour) vs. Python universal-newlines, then test whether the extracted text contains the term the query asks about:

| query probe | n | CRLF-read hits | LF-read hits |
|---|---|---|---|
| `Material Adverse Effect` | 15 | 8 | **15** |
| `Definition of "Knowledge"` | 16 | 6 | **16** |
| `Specific Performance` | 14 | 3 | **11** |
| `Superior Proposal` | 14 | 10 | **13** |
| `No-Shop` | 25 | 4 | 4 |
| **total** | **84** | **31** | **59** |

LF is unambiguously the correct coordinate system.

### The nuance that changes how you should position this

**`benchmark.py:76` also reads the corpus with bare `open()`** — i.e. universal newlines — so the reference harness is *accidentally self-consistent*. **The published ZeroEntropy MAUD numbers are therefore NOT wrong.** This is a **cross-language reimplementation trap**, not a paper-invalidating data error:

- Safe: any Python consumer using `open(path)` (default `newline=None`).
- **Silently broken**: Node `fs.readFileSync(p,'utf8')`, Rust, Go, Java, `open(p,'rb').decode()`, `open(p, newline='')`, pandas `read_csv`-style byte reads, and most document-ingestion pipelines that pre-parse before offsetting. **Your TypeScript backend is in the broken class, as is anyone doing offsets after a custom ingest.**

Claim it as: *"the distributed MAUD corpus carries LF-coordinate gold against CRLF bytes; the reference harness masks this via Python's universal-newline default, so every non-Python consumer silently mis-scores MAUD and no one has reported it."* Do **not** claim published numbers are wrong — that's falsifiable and will cost you credibility.

---

## 1. End-to-end generation results on LegalBench-RAG — the gap is real

**Nobody reports answered-only char-span precision/recall with typed declines.** Closest work:

- **All for law and law for all: Adaptive RAG Pipeline for Legal Research** — arXiv:2508.13107, UCL (Keisha, Singh, Fernandes, Manivannan, Wicaksono, Ahmad, Ben Rim), Sept 2025. The *only* paper doing end-to-end generation on LegalBench-RAG proper. Metrics: RAGAS faithfulness, BERTScore-F1, ROUGE-Recall (ROUGE dropped as misaligned). K∈{1,3,5,10}; concluded K=5 general / K=10 expert. Pipeline: RCTS chunking + SBERT all-mpnet-base-v2 + cosine; **reranking hurt**. 194 QA pairs/subset. **No span-level answered metrics, no declines, no zero-credit accounting.**
- **PAKTON** — arXiv:2506.00608, EMNLP 2025 **oral**. Multi-agent contract QA; uses LegalBench-RAG for *retrieval only*, generation judged by human study + ContractNLI accuracy.
- **ClaimRAG-LAW** — arXiv:2605.21071v3 (Das, Abualhaija, Bianculli, Luxembourg), May 2026. Claim-level: Claim Recall, Context Precision, Faithfulness, Context Utilization, **Hallucination**, **Self Knowledge**. 317 QA / 968 claims, GDPR + Luxembourg Civil Code. Best ~65% F1 (FR) / 59% (EN); hallucination 1.2–17.9%. **BM25 beat dense retrievers.** Critical caveat they report: **RefChecker gets only 4.4% F1 detecting contradictions in English legal text** — NLI-based claim verification is unreliable in law, which is a strong argument *for* your verbatim-quotation contract over entailment scoring.
- **Legal RAG Bench** — arXiv:2603.01710 (A. Butler & U. Butler / Isaacus), Feb–Mar 2026. Victorian Criminal Charge Book, 4,876 passages, 100 questions. First **full factorial** design over embedding × generative model with **hierarchical error decomposition** (hallucination / retrieval error / reasoning error). Finding: retrieval dominates. Explicitly attacks LegalBench-family tasks as *"low-value, relatively trivial text classification and sentiment analysis tasks requiring simple yes or no answers."*
- **CanLegalRAGBench** — arXiv:2605.30497 (Zhao, Taranukhin, Cui, Aikenhead, Shwartz — UBC), June 2026. Canadian case law, end-to-end grounded generation, FactScore + citation grounding + abstention checks. **Directly relevant to your Canadian main goal.**

**Position:** answered-only / forced / zero-credit **char-span** P/R with typed declines against char-span gold is unoccupied. The factorial + error-decomposition framing from Legal RAG Bench is the design to mirror; the claim-level metric names from ClaimRAG-LAW are the vocabulary to adopt so you're legible to reviewers.

---

## 2. Retrieval SOTA — and a 3× unexplained spread on MAUD

| source | date | MAUD | ContractNLI | CUAD | PrivacyQA |
|---|---|---|---|---|---|
| **Paper** (RCTS, no rerank) | Aug 2024 | P@1 **2.65%**, R@64 **28.28%** | — | — | P@1 14.38%, R@64 ~84% |
| **Ragie** (hybrid, default) | Dec 6 2024 | P@1 **58.2%**, R@64 **84.6%** | — | — | — |
| **PAKTON** flagReranker *(aggregated from their released per-item JSON, n=194/subset)* | EMNLP 2025 | R@1 .2399 P@1 .2547; R@8 .4642; R@32 **.7496**; R@64 **.8280** | R@32 .9956; R@64 .9982 | R@32 .7708; R@64 .8623 | R@32 .8230; R@64 .8942 |
| **OpenContracts** (Config A/B/C @k=32) | Apr 28 2026 | **.2030 / .1848 / .5398** (paper baseline .1836) | .8969/.6274/.9780 | .4770/.6478/.7583 | .9588/.7033/.9999 |
| **SAC** (arXiv:2510.06999) | Oct 2025 | ~50% DRM reduction; abs. precision "a few percent" | ContractNLI baseline DRM **>95%** | — | — |

**Two clusters on MAUD R@64: ~28% (paper, OpenContracts) vs ~83–85% (PAKTON, Ragie).** Nobody in the field remarks on this. Note the differential signature in OpenContracts: their ContractNLI/PrivacyQA reach .90–1.00 while MAUD sits at .20 — MAUD-only depression with everything else healthy is *exactly* what a coordinate artifact looks like, and their own doc contains **no discussion of line-ending normalization** while describing a custom ingestion path (`_INVISIBLE_CHARS_RE`, paragraph filtering) that would bypass Python's universal-newline read. **This is your best candidate for someone hitting the artifact unknowingly.** Not proof — their pipeline may just be worse — but a testable hypothesis you can state.

Also on the SOTA landscape: **ZeroEntropy zerank-1 / zerank-2** (zELO training, arXiv:2509.12541; zerank-2 May 2026) are the current vendor rerankers but publish no per-subset LegalBench-RAG table. **MLEB** (arXiv:2510.19365, Butler/Butler/Malec, Oct 2025) is the main academic critique — see §6.

⚠️ **Caveat**: an initial WebFetch of arXiv:2510.06999 returned a clean per-dataset table (MAUD DRM 31.4%, precision 0.71, etc.). A second fetch of the HTML confirms **the paper has no such table** — only figures. That first table was fabricated by the fetch summarizer. Treat any per-dataset SAC numbers you've seen quoted with suspicion; go to Figures 2–3 directly.

---

## 3. Quotation-grounded contracts, and the coverage↔precision tradeoff

**The tradeoff is documented, repeatedly, by independent groups:**

- **Generation-Time vs. Post-hoc Citation: A Holistic Evaluation of LLM Attribution** — arXiv:2509.21557, Sept 2025. **Most directly on point.** Finds *"a consistent trade-off between coverage and citation correctness"* across both paradigms. **G-Cite** (cite while generating) → precision, at the cost of coverage and latency. **P-Cite** (draft then attribute/verify) → higher coverage, competitive correctness. Recommends **retrieval-centric P-Cite-first for law/health/finance**, reserving G-Cite for strict verification. Your composition contract is a G-Cite design; this paper is the reason your coverage may be structurally capped.
- **On the Capacity of Citation Generation by LLMs** — arXiv:2410.11217, Oct 2024. Explicit: **pushing models to cite more reduces precision.** Across GPT-3.5/Llama-2/Mistral/Llama-3/GLM-4/Qwen-2.
- **Cited but Not Verified** — arXiv:2605.06635, 2026. Names the **"quote-dumping"** phenomenon: agents emit excessive citations creating *"an illusion of rigor."*
- **The Extractive-Abstractive Spectrum** — arXiv:2411.17375, Nov 2024. Human subjects, 7 systems × 4 query types: moving abstractive raises perceived utility up to **+200%** but drops properly-cited sentences by **up to 50%** and triples verification time. Users prefer extractive for high-stakes.
- Foundations to cite: **ALCE** citation precision/recall (arXiv:2305.14627); **"According to..."/QUIP-Score** (arXiv:2305.13252, EACL 2024, +5–15 pts, evaluated on the **US tax code**); **Quote-Tuning / Verifiable by Design** (arXiv:2404.03862, up to **+130%** verbatim quoting); **LLMQuoter** (arXiv:2501.05554, >20-pt gains, no successor line); **Attribute First then Generate** (arXiv:2403.17104, ACL 2024); **SelfCite** (arXiv:2502.09604, ICML 2025, **+5.3 citation F1**); **LongCite** (arXiv:2409.02897 — LongCite-8B F1 **72.0** vs GPT-4o **65.6**, with *shorter* citations, 85–91 tok vs 132–220: a case where the tradeoff was beaten, not traded); **Lookback Lens** (arXiv:2407.07071); **ALiiCE** (arXiv:2406.13375, NAACL 2025 — sub-sentence positional citations; only **8–30%** of responses have genuinely fine-grained citations, and citation *utility* correlates only weakly with citation *quality*).
- **Legal-specific:** **CoCoLex** — arXiv:2508.05534, Aug 2025 — confidence-guided **copy-from-context decoding** for legal generation across 5 legal benchmarks. The closest published thing to your verbatim-quotation contract, implemented at the decoding level rather than the prompt level.
- **Verbatim-quote hallucination:** **Who Checks the Citations? Benchmarking Legal Hallucination Detection** — arXiv:2606.21155, 2026. Misquotes built by 1–2 word synonym swaps inside quotation marks, verified against CourtListener/Westlaw. Best system (GPT-5 + agentic verifier) R 82.8 / P 47.6 / **F1 60.5**; **misquote detection lags overall detection** (weak open models ~50% recall on misquotes). Also documents an access confound: Qwen3.5 false-flags **65.9%** of CourtListener-absent citations as hallucinated vs GPT-5's 24.0%.

**Gap:** no one derives a *calibrated* target quote count or a named operating point. "How many quotes should I emit" is stated qualitatively per-dataset. Your composer, which forces verbatim quotation claims + one free conclusion claim, is a concrete instantiation of a knob the literature only describes.

---

## 4. Negative controls / unanswerable methodology — metrics to mirror

- **RGB** (arXiv:2309.01431, AAAI 2024) — canonical four axes. **Negative Rejection**: negatives are topically-relevant-but-answer-free docs; **rejection rate** scored two ways — exact match against the canned refusal string, *and* an LLM judge for semantic refusal (**mirror both**; the gap is large: ChatGPT 24.67% exact vs 45.00% judged, EN). Counterfactual robustness: ChatGPT accuracy collapses ~89–91% → 9–17% once a counterfactual doc is injected.
- **Gold-removed controls, with the exact metric triple you want** — arXiv:2605.27123 (2026): 400 answer-unavailable examples by deleting gold passages from 2Wiki/HotpotQA/MuSiQue, scored as **refusal rate** (.767→.828), **hallucination rate** (.128→.083), and — the one to steal — **gold leak rate**, the fraction still answered correctly despite gold removal, i.e. a direct parametric-contamination probe.
- **Sufficient Context** (arXiv:2411.06037, Google DeepMind) — autorater labels (query, context) sufficient/insufficient **without seeing ground truth**, ~93% agreement. On insufficient context: Gemini 1.5 Pro abstains 50.0% / hallucinates 40.4%; GPT-4o 61.5% / 15.4%; Claude 3.5 Sonnet 53.8% / 36.5%. Reusable recipe for building an unanswerable split *without* gold removal.
- **RefusalBench** (arXiv:2510.10390, EACL 2026) — argues static no-answer sets are gameable; generative perturbation protocol (176 strategies × 6 uncertainty categories × 3 intensities). **Refusal accuracy <50% on multi-document tasks across 30+ models**; refusal decomposes into *detection* and *categorization*; scale and CoT don't help.
- **TRUST-SCORE / TRUST-ALIGN** (arXiv:2409.11242, ICLR 2025) — composite of correctness + attribution + **refusal groundedness**, with an explicit five-way failure taxonomy: Inaccurate Answers, **Over-Responsiveness**, **Excessive Refusal**, **Over-Citation**, Improper Citation. That taxonomy maps almost one-to-one onto your typed declines and your quotation contract — adopt it verbatim.
- **Selective prediction**: risk–coverage curves + **AURC** are the standard summary; use them for your declines.
- **FaithEval** (arXiv:2410.03727, ICLR 2025) — unanswerable / inconsistent / counterfactual contexts; GPT-4o 96.3% → **47.5%** under counterfactual context.
- **RAGTruth** (arXiv:2401.00396, ACL 2024) — **word-level** hallucination spans, the closest precedent for span-level generation scoring.
- **Legal precedent for the imbalance problem**: CUAD (arXiv:2103.06268) reports **AUPR and Precision@80%Recall** precisely *because* accuracy is meaningless when clause-absent cases dominate (~0.25% of text per contract×category pair). ContractNLI's **NotMentioned** class is the direct legal analog of insufficient context and is its hardest class. **Magesh et al., "Hallucination-Free?"** (arXiv:2405.20362 → *J. Empirical Legal Studies* 2025) — preregistered audit of Lexis+ AI / Westlaw AI-AR / CoCounsel, **17–33% hallucination rates despite RAG grounding**.

---

## 5. MAUD-specific — a mechanistic explanation the field does not have

Everyone repeats the same unfalsified folklore. ZeroEntropy's blog, the paper, and every downstream summary attribute MAUD's difficulty to *"the complexity and specialization of the MAUD dataset, which includes highly technical legal jargon."* Nobody tests it.

Measured on the mini corpus:

| subset | docs | mean doc size | gold chars/query (mean) | snippets/query | median gold **density** (gold ÷ doc) |
|---|---|---|---|---|---|
| contractnli | 21 | 10,760 | 428 | 1.46 | **0.0399** (1 in 25) |
| privacy_qa | 7 | 25,266 | 1,185 | 2.34 | **0.0326** (1 in 30) |
| cuad | 24 | 49,872 | 531 | 1.50 | **0.0107** (1 in 93) |
| **maud** | **17** | **339,552** | **1,272** | **1.72** | **0.0030 (1 in 336)** |

MAUD documents are **31× larger** than ContractNLI's and gold density is **13.4× lower**. Gold is also more scattered — median footprint (max_end − min_start) 1,704 chars, **max 249,214** — because `generate_maud.py` splits annotations on `<omitted>` tags into disjoint spans and calls `sort_and_merge_spans(spans, max_bridge_gap_len=0)`, deliberately *not* bridging. MAUD is a genuine needle-in-haystack with fragmented needles; it is not a jargon problem. Clean, original, falsifiable — and independent of the CRLF issue.

Corroborating structural point already in the wild: GitHub issue **#3** (see §6) and the fact that MAUD gold snippets average 917 chars while CUAD's average 341 — so any fixed 1600-char chunk covers MAUD gold far less completely.

---

## 6. Query–document name leakage — someone already proved the point empirically, on the repo

**The best find after the CRLF mechanism.** GitHub issue **#3**, `zeroentropy-ai/legalbenchrag`, **2026-02-21**, user **maylad31**, title *"Do we need RAG for maud?"*, verbatim:

> "First, thanks for the dataset. I see the precision for maud was very low..But then a question came do we really need rag for that? **I see every question has names of entities**, and in real world too it is expected..Instead of rag, **I tried a simple file search(fuzzy) matching the entities against files, I could get the best file which was correct almost everytime.** Once I get the correct file, getting the relevant chunks or the answer is not that hard.. I know you could set that as metadata inb vector db, but i didn't feel the need for vector db for these kind of problems."

Gist with the code: https://gist.github.com/maylad31/76238674b4c5745e00b5ea299f0d6ed5 — **still open, never answered by the maintainers.** A follow-up comment (reguorider-gif, 2026-05-23) proposes exactly the three-stage decomposition: *"1. document/file hit … 2. span hit … 3. claim support."*

Supporting evidence that the field silently exploits the leak: the UCL Adaptive RAG paper (arXiv:2508.13107) built *"a custom extractor [that] disentangled document references from questions using threshold-based similarity matching (0.3–0.55 depending on domain)"* — i.e. they routed on the document name in the query as an explicit pipeline stage.

Confirmed query template from the released data (pulled from PAKTON's result dumps):

- MAUD: `Consider the Acquisition Agreement between Parent "Cisco Systems, Inc." and Target "Acacia Communications, Inc."; Where is the Closing...`
- ContractNLI: `Consider the Mutual Non-Disclosure Agreement between Bosch and Automotive Service Solutions; Does the document require...`
- CUAD: `Consider the Co-Branding and Advertising Agreement between I-Escrow, Inc. and 2TheMart.com, Inc.; Is there a non-compete clause...`
- PrivacyQA: `Consider "23andMe"'s privacy policy; is my information shared with any third parties?`

The document description is **generated by GPT-4o-mini from the source document itself** (`create_title()` in `generate/utils.py`) and concatenated onto every query.

Adjacent literature: **MLEB** (arXiv:2510.19365, Oct 2025) criticizes LegalBench-RAG as narrow/contracts-only/US-centric and notes it collapses toward *"Chat with a Document"* rather than corpus-wide retrieval. **OBLIQ-Bench** (arXiv:2605.06235, MIT, May 2026) builds queries that omit names/dates and applies a **"hardening pass [that] removes remaining identifiers"** specifically to kill lexical shortcuts — the closest published analog of the de-biasing ablation. **Fröbe et al.** (SPIRE 2022, arXiv:2206.14759) is the quantified precedent: **69% of Robust04 queries have near-duplicates in MS MARCO/ORCAS**, and the leakage inflates scores enough to flip system rankings. **Entity Labels Are Not Entity Signals** (arXiv:2606.15998, June 2026) formalizes Conceptual vs **Observable** Entity Relevance; entity linkers "fire indiscriminately," and OER-aligned supervision improved pruning **up to 10×**.

**Nobody has published "strip party/document names from LegalBench-RAG queries and remeasure."** Open. (Beaver's F1 result, 2026-07-31, is exactly this measurement.)

---

## 7. Replicate runs / variance reporting — what to cite and copy

- **On Randomness in Agentic Evals** — arXiv:2602.07150 (Bjarnason, Silva, Monperrus), Feb 6 2026, rev Mar 25 2026. **Single-run pass@1 varies by 2.2–6.0 pp** depending on which run you pick, **σ > 1.5 pp even at temperature 0**. Blunt conclusion: *"reported improvements of 2–3 percentage points may reflect evaluation noise rather than genuine algorithmic progress."* Recommends (1) multi-run pass@1, (2) **statistical power analysis to choose n**, (3) pass@k / pass^k as optimistic/pessimistic envelopes. **Primary citation** — the 9–10% answered/declined flip rate is a much larger effect than what they call alarming.
- **Measuring all the Noises of LLM Evals** — arXiv:2512.21326 (Sida Wang), Dec 24 2025, rev Mar 29 2026. Decomposes **prediction noise** (regeneration) vs **data noise** (question sampling) via law of total variance; proposes the **all-pairs paired method**; key result: **paired prediction noise typically exceeds paired data noise**, and averaging to reduce prediction noise *significantly increases statistical power*. Theoretical justification for the paired 1σ ≈ 0.0065 design — and it says the right move is more replicates, not more items.
- **Hidden Measurement Error in LLM Pipelines** — arXiv:2604.11581 (Solomon Messing), Apr 13 / May 13 2026. **Naive standard errors are 40–60% smaller than TEE-corrected SEs** once you account for judge choice, temperature, and prompt phrasing. Conventional 95% CIs *lose* coverage as n grows. Recommends a small **pilot design study** to project which design change buys the most precision; reports halved MMLU estimation error at equal cost. Also: TEE-guided pipelines shrank the benchmark-gaming surface from 56 → 32 Elo points.
- Also worth citing: **The Coin Flip Judge? Reliability and Bias in LLM-as-a-Judge** (arXiv:2606.13685) — single pointwise score carries ±1.2 on a 10-pt scale; **ReasonBENCH: Benchmarking the (In)Stability of LLM Reasoning** (arXiv:2512.07795).
- Emerging community norm (2026): 3–10 replicates with mean ± σ; **BCa paired bootstrap, B=10,000**, on the primary metric; seed-to-seed variance on auxiliary slices; pinned decoding params + harness version (config drift alone moves identical model/benchmark pairs by 5+ points).

---

## 8. Holdout / contamination practice

- **SeedRG: Generating Leakage-Free Benchmarks for Robust RAG Evaluation** — arXiv:2605.08838, May 9 2026. **RAG-specific** contamination fix: extract reasoning graphs from existing QA/context pairs, do type-constrained entity replacement, filter on (a) reasoning-graph consistency and (b) knowledge-leakage checks. Directly targets "RAG tasks solvable without retrieval."
- **Benchmark Inflation: Revealing LLM Performance Gaps Using Retro-Holdouts** — arXiv:2410.09247. Build a statistically indistinguishable twin of your benchmark; found scores inflated **up to 16 pp** on the original vs. the twin across 20 LLMs. **Template for the holdout: construct a MAUD-analog twin, not just a random split.**
- **GSM1k** (arXiv:2405.00332) — hand-written contamination-free twin; gaps up to **8–13 pp**; Spearman **0.32** between verbatim-regurgitation propensity and the gap.
- **Platinum Benchmarks** (arXiv:2502.03461) — most "saturation" is label noise, not capability.
- **PTEB: Paraphrasing Text Embedding Benchmark** — arXiv:2510.06730v3, rev Feb 27 2026. **Generates paraphrases at evaluation time** rather than using a fixed query set — the exact "regenerate paraphrased queries to test template overfit" practice. Drops: **−1.7 to −5.1 pp** on STS, **−2.72 pp** average on non-STS incl. retrieval/reranking.
- **One Prompt Is Not Enough** — arXiv:2605.22544, May 2026, 6 models × 11 datasets × 15 prompts (990 evals). Median CV 2–6% but individual combos swing **30–45%**, and **every model could be pushed to #1 by adversarial prompt selection.**
- **Preregistering for the Next LLM** — arXiv:2606.27687, June 29 2026 — lock the analysis plan before a newer model exists; explicit temporal analog of reusable-holdout protection.
- Theory base: Dwork et al. **Reusable Holdout** (Science 2015 / arXiv:1506.02629); Blum & Hardt **The Ladder** (arXiv:1502.04585); Recht et al. ImageNetV2/CIFAR-10.1 — note the calibrating finding that **adaptive overfitting was "limited to non-existent"** on multiclass tasks (arXiv:2005.09619 explains why), so don't over-assume dev-bed iteration has destroyed the split; measure it.

---

# What this changes about the next tests

1. **Reframe the CRLF finding as a portability defect, not a benchmark error.** Publish it as: LF gold ⊕ CRLF bytes, masked by Python's `newline=None`. Ship a 10-line reproducer + the 84-probe test (LF 59/84 vs CRLF 31/84). File it as issue #5 on `zeroentropy-ai/legalbenchrag` and offer a one-line PR (`shutil.copy` → normalize-on-write, or ship a `.gitattributes`). It costs nothing and makes you the citable source.
2. **Add a CUAD regeneration guard.** `generate_cuad.py:189` has the identical `shutil.copy` pattern and is clean only by luck. Assert "no `\r` in any corpus file" as a startup gate on all four subsets, and re-run it whenever the corpus is re-downloaded.
3. **Report MAUD twice, always.** Publish both CRLF-naive and LF-normalized numbers side by side for a few iterations. It's the cheapest way to make the artifact legible and it lets others locate themselves against the 3× spread (paper/OpenContracts ~28% vs PAKTON/Ragie ~83%).
4. **Test the OpenContracts hypothesis.** Their MAUD-only depression (.20 at k=32 with ContractNLI at .90–.98) is the signature. Ask them directly, or reproduce their config and check whether normalizing recovers MAUD. If it does, you have an independent confirmed victim.
5. **Kill the "jargon" folklore with the density table.** MAUD is 31× larger docs at 13.4× lower gold density with fragmented gold (`max_bridge_gap_len=0` over `<omitted>` splits). Include the four-row table. A one-paragraph contribution that supersedes an unfalsified claim repeated in every downstream write-up.
6. **The name-leakage ablation is unoccupied and someone already showed it works.** Three arms: (a) full query, (b) title-stripped (drop everything before the `;`), (c) title-only-no-question. Cite issue #3 as prior empirical evidence and OBLIQ-Bench's hardening pass as the methodological precedent. Report Δrecall. (Beaver's F1 already ran arms (a)/(b): docR 1.00→0.7075.)
7. **Adopt TRUST-SCORE's failure taxonomy for the typed declines** — Inaccurate / Over-Responsive / Excessive Refusal / Over-Citation / Improper Citation. Free legibility, maps onto the existing decline types.
8. **The composer noise floor is publishable as-is.** 9–10% flip at fixed evidence is far above the 2.2–6.0 pp that arXiv:2602.07150 calls dangerous. Frame with Wang's prediction-vs-data noise decomposition (arXiv:2512.21326): the flip rate is *prediction* noise, so **averaging replicates is the correct fix and it buys real power**. Concretely: ≥5 composer replicates on the primary metric, BCa paired bootstrap B=10,000, and a power calculation stating the minimum detectable effect. Anything below ~2× the 0.0065 paired σ should be reported as null.
9. **Add three negative-control arms**, mirroring published metric names: gold-removed (→ **refusal rate**, **hallucination rate**, **gold leak rate**, per arXiv:2605.27123); distractor-only (RGB negative rejection, scored **both** exact-string and judged); and a risk–coverage curve with **AURC** over the decline threshold. Use CUAD's **Precision@80%Recall** framing rather than raw accuracy given the imbalance.
10. **Design the holdout as a retro-holdout twin, not a random split** (arXiv:2410.09247), plus paraphrase-at-eval-time regeneration (PTEB, arXiv:2510.06730) for the `Consider the <Agreement>...` template. Preregister the analysis plan (arXiv:2606.27687), freeze it, and evaluate once. Given how much dev-bed iteration has occurred, the retro-holdout twin is the only design that separates real progress from adaptive overfit.
11. **Expect coverage to be capped by the G-Cite design.** arXiv:2509.21557 predicts exactly this architecture trades coverage for precision, and recommends P-Cite for law. Run a P-Cite arm (draft freely, then attribute + verify + strip unsupported claims) as an ablation. If it wins on coverage at equal precision, that's a design change worth making — and LongCite is the existence proof the tradeoff isn't inviolable.
12. **Don't score with NLI.** ClaimRAG-LAW's RefChecker result — **4.4% F1 detecting contradictions in English legal text** — is the affirmative justification for verbatim char-span scoring over entailment judging. Cite it.

---

# Things you didn't ask about but should know

- **A second latent MAUD span defect, in the same generator.** `spans.append((sourcemap[index], sourcemap[index + len(matching_text)]))` — the end index is the original position of the **next non-whitespace character**, so every MAUD gold span silently absorbs the trailing whitespace run after the match. Harmless for recall, but it inflates the gold denominator and therefore *deflates* reported precision by a small, systematic amount. Worth measuring before publishing precision figures.
- **MAUD gold construction discards ~42% of candidates.** A commented-out line in `generate_maud.py` reads `# Success Rate: 58%` — spans that were ambiguous (the annotation string occurs more than once) or that used `<omitted>` unresolvably were **dropped**, not corrected. MAUD's surviving gold is therefore biased toward *lexically unique* passages. Direct implication: MAUD gold is selected for being findable by exact string match, which flatters BM25-family lexical retrieval. The BM25 arm may be reading high on MAUD for a reason that won't transfer to production.
- **Eight MAUD annotation columns were zeroed out for quality** (`column_to_queries[...] = None`, with comments like *"These annotations are low-quality for some reason"* and *"Not great / succinct"*). MAUD's query mix is a hand-curated subset, not the full ABA taxonomy. Anyone comparing to MAUD-the-original-dataset (arXiv:2301.00876, 92 questions) is comparing different things.
- **The mini-split is undocumented and someone asked for it a year ago.** Issue #2 (Sinha-Raunak, 2025-05-06) requests the exact LegalBenchRAG-mini question list; **never answered**. The de facto definition is `MAX_TESTS_PER_BENCHMARK = 194` + `SORT_BY_DOCUMENT = True` in `benchmark.py`, which OpenContracts reverse-engineered. If reporting mini numbers, state that recipe explicitly or the numbers are uncomparable to everyone else's.
- **PrivacyQA is only 7 documents** (176 KB total) in mini. Any PrivacyQA "retrieval" result at k=32+ is near-saturated by construction (OpenContracts hit **0.9999**). Don't let it into a macro-average — it will mask real movement elsewhere.
- **Isaacus is openly hostile to the LegalBench family**, calling the tasks *"low-value, relatively trivial text classification and sentiment analysis tasks requiring simple yes or no answers."* If publishing, pre-empt this: the char-span + grounded-quotation framing is precisely the answer to it, but say so explicitly.
- **Reranking hurt in two independent LegalBench-RAG studies** — the UCL Adaptive RAG paper found *"unranked results perform better than reranked ones for cosine similarity,"* and the original paper's best config was RCTS + **no reranker**. The LLM listwise rerank should be ablated against no-rerank on this benchmark specifically; the prior is against you.
- **The contextual chunk headers are already published as SAC.** arXiv:2510.06999 (Reuter, Lingenberg, Liepiņa, Lagioia, Lippi, Sartor, Passerini, Sayin — Oct 2025) prepends ~150-char document summaries to each chunk, on LegalBench-RAG, and reports ~50% DRM reduction. Two usable things: their **DRM** metric (proportion of top-k chunks not from the gold document) is a clean, cheap diagnostic that separates document-routing failure from span-localization failure — directly relevant given the name-leakage question. And their counterintuitive result: **generic summaries outperformed expert-guided, legally-targeted ones.** If the headers are legally sophisticated, test a dumb generic variant; you may be over-engineering.
- **Embedding-vendor ToS contamination risk.** Voyage AI, Jina, and Google default to opting users into data sharing/training. CUAD/MAUD/ContractNLI/PrivacyQA are old and public; commercial embedding models may already have them in-training. That's model-side contamination the holdout design cannot fix — only a fresh corpus can. Worth an explicit caveat in any vendor-embedding arm.
