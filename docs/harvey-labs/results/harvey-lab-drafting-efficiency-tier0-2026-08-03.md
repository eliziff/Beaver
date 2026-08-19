# Harvey LAB drafting-efficiency Tier 0 — token-slice report

Generated 2026-08-03T19:53:21.682Z by `npx tsx backend/scripts/drafting-efficiency-tier0.ts` (filter: `grounded-cache v1/v2/v3`). Report: `docs\harvey-lab-drafting-efficiency-tier0-2026-08-03.md`

Zero model calls. Every number below is read from a real run artifact:
- per-round provider usage and byte receipts: `context-manifest.jsonl`
- aggregates and ingestion surface: `metrics.json`
- tool-call trace (names, host phase): `raw-sse.txt`, falling back to `beaver-receipts.json`

Runs enumerated: 81; sliceable (drafting boundary resolved): 44; with metrics.json: 43.
## 1. Drafting-phase definition (auditable)

**Boundary.** A round (one provider request / tool-loop iteration in the manifest's `rounds[]`) is a **drafting round** if its tool-call batch contains an authoring call — a tool whose name matches `/docx/i` (in these arms: `generate_docx`), or a call the host traced with phase `drafting`/`continuous`. The **first** such round is the drafting boundary; **all rounds from that round through the end of the run are drafting**, and rounds before it are research. Rounds at or after the boundary with no tool calls (final answer-composition iterations) are still drafting.

**Why the phase field alone is insufficient here.** `metrics.json` distinguishes `research_tool_calls` vs `drafting_tool_calls` from the host `phase` stamped on each tool result (chat.ts: `phase: continuousEvidenceEnabled ? "continuous" : draftingPhase ? "drafting" : "research"`). In all three grounded-cache arms `MIKE_CONTEXT_HANDOFF=0` and `MIKE_CONTINUOUS_EVIDENCE=0`, so `draftingPhase` never flips and **all 312 traced tool calls across the whole batch have phase `"research"`** — including the `generate_docx` calls that actually author the deliverable. A phase-based slice would report drafting = 0 for every run. The authoring-call boundary is the only discriminator present in the artifacts.

**Why include everything from the boundary onward (not just the authoring round).** In these single-invocation trajectories the manifest round's `inputTokens` already contains the accumulated context of that request. The drafting round re-reads the entire research evidence (e.g. the upstream `fetch_documents` 1 MB result) as input while composing the deliverable; that re-read is precisely the drafting-efficiency cost this benchmark wants to expose. A Tier 1 refinement can subtract the replayed research bytes using the `gross_replay_ratio` / `unique_source_exposure` machinery, but Tier 0 keeps the boundary simple and byte-exact.

**Attribution mechanics.** Rounds are matched to tool calls cumulatively by each round's `toolCallCount` against the chronological `tool_call_start` stream (raw-sse.txt). Where the two disagree the run is flagged `MISALIGNED` and the numbers should be treated as approximate.
## 2. Run-directory gaps

| run | kind | gaps |
|---|---|---|
| 2026-08-03-grounded-cache-v1--antitrust-competition--prepare-antitrust-risk-assessment--grounded_structure_v1 | error_no_usage | manifest status error; no per-round provider usage |
| 2026-08-03-grounded-cache-v1--antitrust-competition--prepare-antitrust-risk-assessment--mike_structure_paths_v1 | error_no_usage | manifest status error; no per-round provider usage |
| 2026-08-03-grounded-cache-v1--antitrust-competition--prepare-antitrust-risk-assessment--upstream_terminal_v1 | error_no_usage | manifest status error; no per-round provider usage |
| 2026-08-03-grounded-cache-v1--banking-finance--extract-credit-agreement-covenants--grounded_structure_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--banking-finance--extract-credit-agreement-covenants--mike_structure_paths_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--banking-finance--extract-credit-agreement-covenants--upstream_terminal_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--corporate-ma--draft-acquisition-due-diligence--grounded_structure_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--corporate-ma--draft-acquisition-due-diligence--mike_structure_paths_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--corporate-ma--draft-acquisition-due-diligence--upstream_terminal_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--diligence--cybersecurity-tuck-in--grounded_structure_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--diligence--cybersecurity-tuck-in--mike_structure_paths_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--diligence--cybersecurity-tuck-in--upstream_terminal_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--healthcare-life-sciences--analyze-counterparty-markup-of-clinical-trial-agreement--grounded_structure_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--healthcare-life-sciences--analyze-counterparty-markup-of-clinical-trial-agreement--mike_structure_paths_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--healthcare-life-sciences--analyze-counterparty-markup-of-clinical-trial-agreement--upstream_terminal_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--tax--draft-transfer-pricing-documentation--grounded_structure_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--tax--draft-transfer-pricing-documentation--mike_structure_paths_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--tax--draft-transfer-pricing-documentation--upstream_terminal_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--trusts-estates-private-client--extract-client-intake-facts--scenario-01--grounded_structure_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--trusts-estates-private-client--extract-client-intake-facts--scenario-01--mike_structure_paths_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--trusts-estates-private-client--extract-client-intake-facts--scenario-01--upstream_terminal_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--white-collar-defense-investigations--analyze-counterparty-markup-of-deferred-prosecution-agreement--grounded_structure_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--white-collar-defense-investigations--analyze-counterparty-markup-of-deferred-prosecution-agreement--mike_structure_paths_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v1--white-collar-defense-investigations--analyze-counterparty-markup-of-deferred-prosecution-agreement--upstream_terminal_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--antitrust-competition--prepare-antitrust-risk-assessment--grounded_structure_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--antitrust-competition--prepare-antitrust-risk-assessment--mike_structure_paths_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--antitrust-competition--prepare-antitrust-risk-assessment--upstream_terminal_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--corporate-ma--draft-acquisition-due-diligence--grounded_structure_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--corporate-ma--draft-acquisition-due-diligence--mike_structure_paths_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--corporate-ma--draft-acquisition-due-diligence--upstream_terminal_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--diligence--cybersecurity-tuck-in--grounded_structure_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--diligence--cybersecurity-tuck-in--mike_structure_paths_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--diligence--cybersecurity-tuck-in--upstream_terminal_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--tax--draft-transfer-pricing-documentation--grounded_structure_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--tax--draft-transfer-pricing-documentation--mike_structure_paths_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v2--tax--draft-transfer-pricing-documentation--upstream_terminal_v1 | no_artifacts | no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only) |
| 2026-08-03-grounded-cache-v3--capital-markets--draft-indenture-for-senior-secured-notes-offering--upstream_terminal_v1 | sliceable_no_metrics | metrics.json missing (aggregates unavailable) |
| 2026-08-03-grounded-cache-v3--tax--draft-transfer-pricing-documentation--grounded_structure_v1 | error_no_usage | manifest status error; no per-round provider usage |

## 3. Drafting-phase token slice, by task and arm

Each table groups one task's runs (same task + model `codex:gpt-5.6-luna`) across the three arms and the v1/v3 batches. `drafting cache-adj in` is the cache-adjusted input-equivalent (uncached input + 0.1×cached-read + 1.25×cache-write, mirroring lab-beaver-arm.ts) for drafting rounds only. `drafting req bytes` is the sum of the drafting rounds' `inputBytes` receipts — the byte size of the provider request(s) that composed the deliverable, which typically re-carries the whole research evidence.

### antitrust-competition/analyze-antitrust-hsr-strategy

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | 78,830 | 14,318 | 78,830.0 | 94.7% | 4,450 | 83,280 | 83,280.0 | 332,864 | r2 · 1 aut | aligned |
| v1 | mike_structure_paths_v1 | 78,340 | 14,717 | 76,957.6 | 97.6% | 1,875 | 80,215 | 78,832.6 | 330,325 | r1 · 1 aut | aligned |
| v1 | upstream_terminal_v1 | 77,884 | 11,884 | 77,884.0 | 98.3% | 1,384 | 79,268 | 79,268.0 | 332,078 | r1 · 1 aut | aligned |
| v3 | grounded_structure_v1 | 78,442 | 10,594 | 77,059.6 | 99.2% | 2,012 | 80,454 | 77,689.2 | 330,098 | r1 · 1 aut | aligned |
| v3 | mike_structure_paths_v1 | 78,329 | 16,892 | 76,946.6 | 99.4% | 1,875 | 80,204 | 77,439.2 | 330,255 | r1 · 1 aut | aligned |
| v3 | upstream_terminal_v1 | 78,081 | 15,953 | 78,081.0 | 96.2% | 3,088 | 81,169 | 81,169.0 | 332,523 | r2 · 1 aut | aligned |

### antitrust-competition/prepare-antitrust-risk-assessment

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | error_no_usage |
| v1 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | error_no_usage |
| v1 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | error_no_usage |
| v2 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v2 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v2 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v3 | grounded_structure_v1 | 186,646 | 22,459 | 76,514.8 | 21.4% | 286,525 | 473,171 | 357,510.2 | 871,501 | r4 · 4 aut | aligned |
| v3 | mike_structure_paths_v1 | 171,861 | 18,817 | 170,478.6 | 99.6% | 2,011 | 173,872 | 171,107.2 | 859,159 | r1 · 4 aut | aligned |
| v3 | upstream_terminal_v1 | 171,375 | 17,747 | 171,375.0 | 99.1% | 1,520 | 172,895 | 172,895.0 | 859,184 | r1 · 4 aut | aligned |

### banking-finance/extract-credit-agreement-covenants

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v3 | grounded_structure_v1 | 41,938 | 20,229 | 40,555.6 | 98.7% | 1,913 | 43,851 | 41,086.2 | 177,006 | r1 · 1 aut | aligned |
| v3 | mike_structure_paths_v1 | 41,788 | 18,961 | 40,405.6 | 99.0% | 1,776 | 43,564 | 40,799.2 | 176,899 | r1 · 1 aut | aligned |
| v3 | upstream_terminal_v1 | 41,285 | 16,869 | 41,285.0 | 97.0% | 1,285 | 42,570 | 42,570.0 | 176,809 | r1 · 1 aut | aligned |

### capital-markets/compare-closing-documents-against-closing-checklist

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | 29,700 | 8,820 | 29,700.0 | 93.8% | 1,977 | 31,677 | 31,677.0 | 124,126 | r1 · 1 aut | aligned |
| v1 | mike_structure_paths_v1 | 29,215 | 8,054 | 29,215.0 | 94.1% | 1,840 | 31,055 | 31,055.0 | 122,677 | r1 · 1 aut | aligned |
| v1 | upstream_terminal_v1 | 28,944 | 6,503 | 28,944.0 | 90.6% | 2,996 | 31,940 | 31,940.0 | 124,891 | r2 · 1 aut | aligned |
| v3 | grounded_structure_v1 | 29,665 | 10,611 | 28,282.6 | 94.7% | 4,339 | 34,004 | 29,856.8 | 125,071 | r2 · 1 aut | aligned |
| v3 | mike_structure_paths_v1 | 29,171 | 8,557 | 27,788.6 | 93.8% | 1,840 | 31,011 | 29,628.6 | 122,334 | r1 · 1 aut | aligned |
| v3 | upstream_terminal_v1 | 28,913 | 11,761 | 28,913.0 | 95.5% | 1,349 | 30,262 | 30,262.0 | 123,443 | r1 · 1 aut | aligned |

### capital-markets/draft-indenture-for-senior-secured-notes-offering

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | 215,886 | 24,586 | 214,503.6 | 99.0% | 4,892 | 220,778 | 216,630.8 | 1,016,533 | r2 · 2 aut | aligned |
| v1 | mike_structure_paths_v1 | 215,245 | 28,681 | 213,862.6 | 99.1% | 1,947 | 217,192 | 215,809.6 | 1,013,643 | r1 · 2 aut | aligned |
| v1 | upstream_terminal_v1 | 214,459 | 20,942 | 214,459.0 | 99.3% | 1,456 | 215,915 | 215,915.0 | 1,011,619 | r1 · 2 aut | aligned |
| v3 | grounded_structure_v1 | 215,192 | 17,701 | 213,809.6 | 99.7% | 2,084 | 217,276 | 214,511.2 | 1,012,151 | r1 · 2 aut | aligned |
| v3 | mike_structure_paths_v1 | 142,591 | 22,730 | 141,208.6 | 98.7% | 4,607 | 147,198 | 143,050.8 | 678,427 | r2 · 2 aut | aligned |
| v3 | upstream_terminal_v1 | 214,405 | 11,283 | 214,405.0 | 99.3% | 1,456 | 215,861 | 215,861.0 | 1,011,210 | r1 · 1 aut | aligned |

### corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | 187,882 | 13,131 | 186,499.6 | 50.5% | 186,828 | 374,710 | 369,180.4 | 812,777 | r4 · 1 aut | aligned |
| v1 | mike_structure_paths_v1 | 190,003 | 16,684 | 188,620.6 | 99.7% | 2,035 | 192,038 | 189,273.2 | 944,419 | r1 · 1 aut | aligned |
| v1 | upstream_terminal_v1 | 189,624 | 14,216 | 189,624.0 | 99.2% | 1,544 | 191,168 | 191,168.0 | 948,512 | r1 · 1 aut | aligned |
| v3 | grounded_structure_v1 | 220,759 | 13,552 | 219,376.6 | 88.5% | 31,141 | 251,900 | 247,752.8 | 1,076,928 | r2 · 1 aut | aligned |
| v3 | mike_structure_paths_v1 | 172,212 | 12,390 | 170,829.6 | 20.5% | 708,034 | 880,246 | 832,783.6 | 827,716 | r7 · 1 aut | aligned |
| v3 | upstream_terminal_v1 | 189,988 | 6,171 | 189,988.0 | 98.1% | 3,642 | 193,630 | 193,630.0 | 947,551 | r2 · 1 aut | aligned |

### corporate-ma/draft-acquisition-due-diligence

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v2 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v2 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v2 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v3 | grounded_structure_v1 | 203,078 | 23,318 | 201,695.6 | 92.9% | 18,212 | 221,290 | 217,142.8 | 950,482 | r2 · 1 aut | aligned |
| v3 | mike_structure_paths_v1 | 202,687 | 19,708 | 201,304.6 | 99.6% | 2,263 | 204,950 | 202,185.2 | 947,316 | r1 · 1 aut | aligned |
| v3 | upstream_terminal_v1 | 202,111 | 14,733 | 202,111.0 | 99.8% | 1,772 | 203,883 | 202,500.6 | 946,665 | r1 · 1 aut | aligned |

### diligence/cybersecurity-tuck-in

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v2 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v2 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v2 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |

### healthcare-life-sciences/analyze-counterparty-markup-of-clinical-trial-agreement

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v3 | grounded_structure_v1 | 47,901 | 15,853 | 46,518.6 | 98.8% | 1,946 | 49,847 | 47,082.2 | 224,115 | r1 · 1 aut | aligned |
| v3 | mike_structure_paths_v1 | 47,777 | 20,223 | 46,394.6 | 99.1% | 1,809 | 49,586 | 46,821.2 | 224,872 | r1 · 1 aut | aligned |
| v3 | upstream_terminal_v1 | 47,434 | 16,969 | 47,434.0 | 94.3% | 2,858 | 50,292 | 50,292.0 | 226,042 | r2 · 1 aut | aligned |

### tax/draft-transfer-pricing-documentation

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v2 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v2 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v2 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v3 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | error_no_usage |
| v3 | mike_structure_paths_v1 | 285,427 | 15,416 | 284,044.6 | 30.1% | 666,739 | 952,166 | 943,871.6 | 1,208,294 | r6 · 1 aut | aligned |
| v3 | upstream_terminal_v1 | 266,301 | 14,361 | 266,301.0 | 98.8% | 4,487 | 270,788 | 269,405.6 | 1,216,945 | r2 · 1 aut | aligned |

### trusts-estates-private-client/extract-client-intake-facts/scenario-01

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v3 | grounded_structure_v1 | 10,909 | 7,308 | 9,526.6 | 94.7% | 1,915 | 12,824 | 10,059.2 | 42,439 | r1 · 1 aut | aligned |
| v3 | mike_structure_paths_v1 | 10,781 | 6,598 | 9,398.6 | 84.1% | 1,778 | 12,559 | 11,176.6 | 42,487 | r1 · 1 aut | aligned |
| v3 | upstream_terminal_v1 | 10,304 | 5,991 | 10,304.0 | 88.9% | 1,287 | 11,591 | 11,591.0 | 42,585 | r1 · 1 aut | aligned |

### white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement

| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | mike_structure_paths_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v1 | upstream_terminal_v1 | — | — | — | — | — | — | — | — | — | no_artifacts |
| v3 | grounded_structure_v1 | 56,269 | 14,927 | 54,886.6 | 99.0% | 1,961 | 58,230 | 55,465.2 | 282,261 | r1 · 1 aut | aligned |
| v3 | mike_structure_paths_v1 | 65,022 | 18,966 | 63,639.6 | 98.1% | 4,030 | 69,052 | 64,904.8 | 327,320 | r2 · 1 aut | aligned |
| v3 | upstream_terminal_v1 | 64,307 | 15,820 | 64,307.0 | 98.0% | 1,333 | 65,640 | 65,640.0 | 325,326 | r1 · 1 aut | aligned |

## 4. Aggregate across arms

| arm | runs | mean drafting cache-adj in | median drafting cache-adj in | mean drafting share (cache-adj) | mean drafting out | mean research in | mean total in |
|---|---|---|---|---|---|---|---|
| grounded_structure_v1 | 14 | 105,554.2 | 76,787.2 | 0.8754 | 15,529 | 39,300 | 153,807 |
| mike_structure_paths_v1 | 15 | 116,073.0 | 76,957.6 | 0.8749 | 16,493 | 93,631 | 210,994 |
| upstream_terminal_v1 | 15 | 121,694.3 | 78,081.0 | 0.9683 | 13,414 | 2,097 | 123,791 |

Interpretation of the arm ranking is deferred to the reader; the point of Tier 0 is that the slice now exists and is reproducible from the artifacts.
## 5. Ingestion-representation surface (recoverable-now part of axis 2)

These fields are already computed per run in `metrics.json` and are the only recoverable-now evidence for the docx-as-markdown vs whole-document axis. `whole_read_max_chars` is `null`/unset for all three arms (`MIKE_WHOLE_READ_MAX_CHARS=""` in the arm environment), so the whole-document side of the axis is observable only through the exposure ratios below:

- `unique_source_exposure_ratio` = unique source spans exposed / total source text chars — 1.0 means the model saw essentially the whole corpus.
- `gross_replay_ratio` = gross exposed span chars / unique exposed span chars — >1.0 means source text was re-read/replayed across calls.
- `documents_read` = distinct source documents whose evidence reached the model.
- `tool_result_chars` vs `source_text_chars` shows how much result payload entered context.

| batch | arm | docs read / ingested | source chars | tool result chars | unique-source exposure ratio | gross replay ratio | duplicate reads | duplicate exposures | tool result cap | whole-read cap | structure-path evidence chars | structure-path replay ratio |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 | grounded_structure_v1 | 9/9 | 318,203 | 325,772 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v1 | mike_structure_paths_v1 | 9/9 | 318,203 | 324,598 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v1 | upstream_terminal_v1 | 9/9 | 318,203 | 324,171 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v1 | grounded_structure_v1 | 8/8 | 113,734 | 120,509 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v1 | mike_structure_paths_v1 | 8/8 | 113,734 | 119,444 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v1 | upstream_terminal_v1 | 8/8 | 113,734 | 120,110 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v1 | grounded_structure_v1 | 14/14 | 991,237 | 1,003,329 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v1 | mike_structure_paths_v1 | 14/14 | 991,237 | 1,001,547 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v1 | upstream_terminal_v1 | 14/14 | 991,237 | 1,001,547 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v1 | grounded_structure_v1 | 18/19 | 921,161 | 786,638 | 0.4329 | 1.1167 | 0 | 0 | 64,000 | unset | 0 | — |
| v1 | mike_structure_paths_v1 | 19/19 | 921,161 | 933,700 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v1 | upstream_terminal_v1 | 19/19 | 921,161 | 932,805 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | grounded_structure_v1 | 9/9 | 318,203 | 324,598 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | mike_structure_paths_v1 | 9/9 | 318,203 | 324,598 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | upstream_terminal_v1 | 9/9 | 318,203 | 325,324 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | grounded_structure_v1 | 12/12 | 836,218 | 850,099 | 0.6771 | 1.2473 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | mike_structure_paths_v1 | 12/12 | 836,218 | 847,600 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | upstream_terminal_v1 | 12/12 | 836,218 | 847,600 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | grounded_structure_v1 | 3/3 | 170,373 | 172,954 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | mike_structure_paths_v1 | 3/3 | 170,373 | 172,954 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | upstream_terminal_v1 | 3/3 | 170,373 | 172,954 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | grounded_structure_v1 | 8/8 | 113,734 | 120,509 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | mike_structure_paths_v1 | 8/8 | 113,734 | 119,485 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | upstream_terminal_v1 | 8/8 | 113,734 | 120,110 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | grounded_structure_v1 | 14/14 | 991,237 | 1,001,547 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | mike_structure_paths_v1 | 11/14 | 991,237 | 667,724 | 0.6633 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | grounded_structure_v1 | 19/19 | 921,161 | 1,059,798 | 1.0000 | 1.0973 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | mike_structure_paths_v1 | 18/19 | 921,161 | 761,190 | 0.2767 | 2.4565 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | upstream_terminal_v1 | 19/19 | 921,161 | 935,225 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | grounded_structure_v1 | 31/31 | 911,426 | 931,819 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | mike_structure_paths_v1 | 31/31 | 911,426 | 931,883 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | upstream_terminal_v1 | 31/31 | 911,426 | 931,883 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | grounded_structure_v1 | 5/5 | 216,135 | 220,054 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | mike_structure_paths_v1 | 5/5 | 216,135 | 219,827 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | upstream_terminal_v1 | 5/5 | 216,135 | 220,448 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | mike_structure_paths_v1 | 22/25 | 1,166,898 | 1,133,558 | 0.4921 | 1.5634 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | upstream_terminal_v1 | 25/25 | 1,166,898 | 1,187,313 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | grounded_structure_v1 | 3/3 | 37,605 | 40,158 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | mike_structure_paths_v1 | 3/3 | 37,605 | 40,158 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | upstream_terminal_v1 | 3/3 | 37,605 | 40,158 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | grounded_structure_v1 | 5/6 | 315,213 | 277,267 | 0.8673 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | mike_structure_paths_v1 | 6/6 | 315,213 | 320,537 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |
| v3 | upstream_terminal_v1 | 6/6 | 315,213 | 319,744 | 1.0000 | 1.0000 | 0 | 0 | 64,000 | unset | 0 | — |

## 6. Caveats

- Drafting share is sensitive to the boundary definition; a run that calls `generate_docx` in its first round reports drafting share 100% by construction.
- `drafting cache-adj in` includes the research evidence re-sent in the drafting request. This is intentional for Tier 0 (drafting-context cost), not a double count of the research request itself.
- v1 and v3 contain duplicate runs of four tasks (antitrust analyze, compare-closing, draft-indenture, analyze-change-of-control); they are kept as separate rows rather than averaged so batch-level drift stays visible.
- The v2 batch is entirely empty (run-state.json only) and is reported as a gap.