# Harvey Labs study catalog

Status: **experimental evidence, not Beaver product backlog**.

This folder is the single home for Beaver's Harvey Labs protocols, amendments,
harness designs, results, and decisions. The runnable benchmark remains under
`benchmarks/harvey-labs/`; generated runs, caches, scratch classifiers, and
model output stay there and are not documentation.

## Current harness documentation

- [Tutorial](design/tutorial.md)
- [Harness architecture and security model](design/harness-architecture.md)
- [Evaluation method](design/evaluation-method.md)

Run commands from `benchmarks/harvey-labs`. Provider calls may be metered and
are never authorized merely by being documented here.

## Protocol-to-evidence manifest

“Not retained” is an explicit reproducibility limit, not pending work. A
registration without a result or current runner remains an unpromoted
historical experiment.

| Study family | Protocols and amendments | Status | Runner version | Result | Decision | Reproduction |
|---|---|---|---|---|---|---|
| Coding context | [harvey-lab-coding-context-five-way](protocols/harvey-lab-coding-context-five-way-preregistration-2026-08-02.json) | registered; no product promotion | Historical backend harness; exact launcher not retained. | No consolidated result. | No decision promoted. | Not reproducible from the current checkout. |
| Coding Markdown | [harvey-lab-coding-markdown-final-v1](protocols/harvey-lab-coding-markdown-final-v1-preregistration-2026-08-08.json)<br>[harvey-lab-coding-markdown-final-v2](protocols/harvey-lab-coding-markdown-final-v2-preregistration-2026-08-08.json)<br>[harvey-lab-coding-markdown-final-v4](protocols/harvey-lab-coding-markdown-final-v4-preregistration-2026-08-08.json) | v1 rejected at preflight; v2/v4 remain unpromoted | `benchmarks/harvey-labs/scripts/run_coding_markdown_final_v1.py` | [v1 preflight forensics](results/harvey-lab-coding-markdown-final-v1-preflight-forensics-2026-08-08.json) | v1 rejected; no recorded v2/v4 promotion. | `python benchmarks/harvey-labs/scripts/run_coding_markdown_final_v1.py --help` |
| Grounded cache | [harvey-lab-grounded-cache-eleven-task-v3](protocols/harvey-lab-grounded-cache-eleven-task-v3-addendum-2026-08-03.json)<br>[harvey-lab-grounded-cache-eleven-task-v3-markdown-swap](protocols/harvey-lab-grounded-cache-eleven-task-v3-markdown-swap-addendum-2026-08-03.json)<br>[harvey-lab-grounded-cache-twelve-task](protocols/harvey-lab-grounded-cache-twelve-task-preregistration-2026-08-03.json)<br>[harvey-lab-grounded-cache-twelve-task-v2](protocols/harvey-lab-grounded-cache-twelve-task-v2-addendum-2026-08-03.json) | registered; unpromoted | Historical backend LAB runner; not retained. | No consolidated result. | No decision promoted. | Not reproducible from the current checkout. |
| Lean batch | [harvey-lab-lean-batch-compaction](protocols/harvey-lab-lean-batch-compaction-preregistration-2026-08-03.json)<br>[harvey-lab-lean-batch-four-way](protocols/harvey-lab-lean-batch-four-way-preregistration-2026-08-03.json) | registered; unpromoted | Historical backend LAB runner; not retained. | No consolidated result. | No decision promoted. | Not reproducible from the current checkout. |
| Mike Grep | [harvey-lab-mike-grep-four-way](protocols/harvey-lab-mike-grep-four-way-preregistration-2026-08-03.json) | completed experiment | `benchmarks/harvey-labs/scripts/run_mike_grep_four_way.ps1` | [four-way result](results/harvey-lab-mike-grep-four-way-results-2026-08-03.md) | A minimal one-shot frontier was retained; larger compiler stacks were not. | `powershell -File benchmarks/harvey-labs/scripts/run_mike_grep_four_way.ps1 -DryRun` |
| Minimal architecture | [harvey-lab-minimal-architecture-nine-task](protocols/harvey-lab-minimal-architecture-nine-task-preregistration-2026-08-03.json) | registered; result not consolidated | `benchmarks/harvey-labs/scripts/run_minimal_architecture_nine_task.ps1` | No consolidated result. | No product promotion. | `powershell -File benchmarks/harvey-labs/scripts/run_minimal_architecture_nine_task.ps1 -Wave 1 -DryRun` |
| Mike one-shot, review, and workbench arms | [harvey-lab-mike-adaptive-review](protocols/harvey-lab-mike-adaptive-review-preregistration-2026-08-03.json)<br>[harvey-lab-mike-control-xhigh-banking-replacement](protocols/harvey-lab-mike-control-xhigh-banking-replacement-preregistration-2026-08-03.json)<br>[harvey-lab-mike-control-xhigh](protocols/harvey-lab-mike-control-xhigh-preregistration-2026-08-03.json)<br>[harvey-lab-mike-final-check](protocols/harvey-lab-mike-final-check-preregistration-2026-08-03.json)<br>[harvey-lab-mike-fresh-scout](protocols/harvey-lab-mike-fresh-scout-preregistration-2026-08-03.json)<br>[harvey-lab-mike-large-context-plan](protocols/harvey-lab-mike-large-context-plan-preregistration-2026-08-03.json)<br>[harvey-lab-mike-linked-grounding](protocols/harvey-lab-mike-linked-grounding-preregistration-2026-08-03.json)<br>[harvey-lab-mike-monotonic-review](protocols/harvey-lab-mike-monotonic-review-preregistration-2026-08-03.json)<br>[harvey-lab-mike-native-sol-max](protocols/harvey-lab-mike-native-sol-max-preregistration-2026-08-03.json)<br>[harvey-lab-mike-one-shot-conflict-first-indenture-v1.1](protocols/harvey-lab-mike-one-shot-conflict-first-indenture-v1.1-preregistration-2026-08-03.json)<br>[harvey-lab-mike-one-shot-conflict-first](protocols/harvey-lab-mike-one-shot-conflict-first-preregistration-2026-08-03.json)<br>[harvey-lab-mike-one-shot-fact-index-v1.1](protocols/harvey-lab-mike-one-shot-fact-index-v1.1-preregistration-2026-08-03.json)<br>[harvey-lab-mike-one-shot-native-grounding](protocols/harvey-lab-mike-one-shot-native-grounding-preregistration-2026-08-03.json)<br>[harvey-lab-mike-one-shot](protocols/harvey-lab-mike-one-shot-preregistration-2026-08-03.json)<br>[harvey-lab-mike-one-shot-quote-first](protocols/harvey-lab-mike-one-shot-quote-first-preregistration-2026-08-03.json)<br>[harvey-lab-mike-quote-first-replicate](protocols/harvey-lab-mike-quote-first-replicate-preregistration-2026-08-03.json)<br>[harvey-lab-mike-workbench](protocols/harvey-lab-mike-workbench-preregistration-2026-08-03.json) | completed or superseded experiments; not roadmap | Protocol-embedded run matrices; general launcher not retained. | [one-shot context](results/harvey-lab-mike-one-shot-context-results-2026-08-03.md) and [workbench rejection](results/harvey-lab-mike-workbench-results-2026-08-03.json) | Workbench rejected; exact one-shot evidence handoff informed the current retrieval decision. | No single replay command is retained. |
| Tool surface and varied baselines | [harvey-lab-tool-surface](protocols/harvey-lab-tool-surface-amendment-2026-08-01.json)<br>[harvey-lab-tool-surface](protocols/harvey-lab-tool-surface-preregistration-2026-08-01.json)<br>[harvey-lab-varied-baselines](protocols/harvey-lab-varied-baselines-preregistration-2026-08-01.json) | completed exploratory protocols | Historical harness runner; not retained. | [tool/context audit](results/harvey-tool-context-audit-2026-08-01.md) | No protocol is current product backlog. | No single replay command is retained. |
| Hybrid retrieval | [hybrid-retrieval-h4-h5](protocols/hybrid-retrieval-h4-h5-preregistration-2026-08-01.json)<br>[hybrid-retrieval-h6-compiler](protocols/hybrid-retrieval-h6-compiler-preregistration-2026-08-01.json)<br>[hybrid-retrieval-h7-sla](protocols/hybrid-retrieval-h7-sla-preregistration-2026-08-01.json)<br>[hybrid-retrieval-h8-working-set-first](protocols/hybrid-retrieval-h8-working-set-first-preregistration-2026-08-01.json)<br>[hybrid-retrieval-h9-accretive-union](protocols/hybrid-retrieval-h9-accretive-union-preregistration-2026-08-01.json)<br>[hybrid-retrieval-h9-natural-stop](protocols/hybrid-retrieval-h9-natural-stop-amendment-2026-08-01.json)<br>[hybrid-retrieval-model-coverage](protocols/hybrid-retrieval-model-coverage-preregistration-2026-08-02.json)<br>[hybrid-retrieval-v13-live](protocols/hybrid-retrieval-v13-live-registration-2026-08-02.json)<br>[hybrid-retrieval-v14-live](protocols/hybrid-retrieval-v14-live-registration-2026-08-02.json)<br>[hybrid-retrieval-v15-live](protocols/hybrid-retrieval-v15-live-registration-2026-08-02.json)<br>[hybrid-retrieval-whole-read-budget](protocols/hybrid-retrieval-whole-read-budget-preregistration-2026-08-02.json) | completed/superseded experiments | Protocol-embedded run matrices; runner not retained. | [v13 adversarial audit](results/hybrid-retrieval-v13-adversarial-audit-2026-08-02.md) | [retrieval decision](../decisions/retrieval.md) | No single replay command is retained. |
| Paged retrieval checkpoints | [retrieval-checkpoint-paged-comparators](protocols/retrieval-checkpoint-paged-comparators-registration-2026-08-02.json)<br>[retrieval-checkpoint-paged-live](protocols/retrieval-checkpoint-paged-live-registration-2026-08-02.json)<br>[retrieval-checkpoint-paged-live-registration-v10-2026-08-02.json](protocols/retrieval-checkpoint-paged-live-registration-v10-2026-08-02.json)<br>[retrieval-checkpoint-paged-live-registration-v11-2026-08-02.json](protocols/retrieval-checkpoint-paged-live-registration-v11-2026-08-02.json)<br>[retrieval-checkpoint-paged-live-registration-v2-2026-08-02.json](protocols/retrieval-checkpoint-paged-live-registration-v2-2026-08-02.json)<br>[retrieval-checkpoint-paged-live-registration-v3-2026-08-02.json](protocols/retrieval-checkpoint-paged-live-registration-v3-2026-08-02.json)<br>[retrieval-checkpoint-paged-live-registration-v4-2026-08-02.json](protocols/retrieval-checkpoint-paged-live-registration-v4-2026-08-02.json)<br>[retrieval-checkpoint-paged-live-registration-v5-2026-08-02.json](protocols/retrieval-checkpoint-paged-live-registration-v5-2026-08-02.json)<br>[retrieval-checkpoint-paged-live-registration-v6-2026-08-02.json](protocols/retrieval-checkpoint-paged-live-registration-v6-2026-08-02.json)<br>[retrieval-checkpoint-paged-live-registration-v7-2026-08-02.json](protocols/retrieval-checkpoint-paged-live-registration-v7-2026-08-02.json)<br>[retrieval-checkpoint-paged-live-registration-v7-retry-2026-08-02.json](protocols/retrieval-checkpoint-paged-live-registration-v7-retry-2026-08-02.json)<br>[retrieval-checkpoint-paged-live-registration-v8-2026-08-02.json](protocols/retrieval-checkpoint-paged-live-registration-v8-2026-08-02.json)<br>[retrieval-checkpoint-paged-live-registration-v9-2026-08-02.json](protocols/retrieval-checkpoint-paged-live-registration-v9-2026-08-02.json) | successive registrations; superseded by later versions | Historical checkpoint runner; not retained. | No standalone consolidated result. | [retrieval decision](../decisions/retrieval.md) | No single replay command is retained. |
| Context refresh and varied pinpoint | [retrieval-context-refresh-full-live](protocols/retrieval-context-refresh-full-live-registration-2026-08-02.json)<br>[retrieval-varied-pinpoint-design-2026-08-01.json](protocols/retrieval-varied-pinpoint-design-2026-08-01.json)<br>[retrieval-varied-pinpoint-implementation-2026-08-01.json](protocols/retrieval-varied-pinpoint-implementation-2026-08-01.json) | registered/frozen experiments; unpromoted | Historical retrieval runner; not retained. | No standalone consolidated result. | [retrieval decision](../decisions/retrieval.md) | No single replay command is retained. |

## Design records

- [docx benchmark design](design/docx-benchmark-design.md)
- [evaluation method](design/evaluation-method.md)
- [harness architecture](design/harness-architecture.md)
- [harvey lab deterministic operationalization 2026 08 03](design/harvey-lab-deterministic-operationalization-2026-08-03.md)
- [harvey lab harness features plan 2026 08 03](design/harvey-lab-harness-features-plan-2026-08-03.md)
- [harvey lab replay runner design 2026 08 03](design/harvey-lab-replay-runner-design-2026-08-03.md)
- [harvey lab wings study design 2026 08 05](design/harvey-lab-wings-study-design-2026-08-05.md)
- [lab composition checkpoint design 2026 08 08](design/lab-composition-checkpoint-design-2026-08-08.md)
- [lab treatment v2 design 2026 08 06](design/lab-treatment-v2-design-2026-08-06.md)
- [legal skills ledger 2026 08 03](design/legal-skills-ledger-2026-08-03.json)
- [legal skills ledger 2026 08 03](design/legal-skills-ledger-2026-08-03.md)
- [retrieval finalist context handoff experiment 2026 08 01](design/retrieval-finalist-context-handoff-experiment-2026-08-01.md)
- [tutorial](design/tutorial.md)

## Results and forensic audits

- [docx capability conformance 2026 08 03](results/docx-capability-conformance-2026-08-03.md)
- [docx degraded pdf pilot 2026 07 27](results/docx-degraded-pdf-pilot-2026-07-27.md)
- [docx live model benchmark 2026 07 27](results/docx-live-model-benchmark-2026-07-27.md)
- [docx pipeline landscape audit 2026 08 03](results/docx-pipeline-landscape-audit-2026-08-03.md)
- [harvey lab adversarial audit 2026 08 03](results/harvey-lab-adversarial-audit-2026-08-03.md)
- [harvey lab coding markdown final v1 preflight forensics 2026 08 08](results/harvey-lab-coding-markdown-final-v1-preflight-forensics-2026-08-08.json)
- [harvey lab deterministic stress test 2026 08 03](results/harvey-lab-deterministic-stress-test-2026-08-03.md)
- [harvey lab drafting efficiency tier0 2026 08 03](results/harvey-lab-drafting-efficiency-tier0-2026-08-03.md)
- [harvey lab mike grep four way results 2026 08 03](results/harvey-lab-mike-grep-four-way-results-2026-08-03.md)
- [harvey lab mike one shot context results 2026 08 03](results/harvey-lab-mike-one-shot-context-results-2026-08-03.md)
- [harvey lab mike workbench results 2026 08 03](results/harvey-lab-mike-workbench-results-2026-08-03.json)
- [harvey lab phase c criteria forensics 2026 08 05](results/harvey-lab-phase-c-criteria-forensics-2026-08-05.md)
- [harvey lab run mining signals 2026 08 05](results/harvey-lab-run-mining-signals-2026-08-05.md)
- [harvey lab stage0 replay validation 2026 08 05](results/harvey-lab-stage0-replay-validation-2026-08-05.md)
- [harvey lab toy math date tools 2026 08 05](results/harvey-lab-toy-math-date-tools-2026-08-05.md)
- [harvey tool context audit 2026 08 01](results/harvey-tool-context-audit-2026-08-01.md)
- [hybrid retrieval v13 adversarial audit 2026 08 02](results/hybrid-retrieval-v13-adversarial-audit-2026-08-02.md)
- [lab showdown control vs treatment 2026 08 05](results/lab-showdown-control-vs-treatment-2026-08-05.md)
- [legal grounding adversarial fairness audit 2026 08 02](results/legal-grounding-adversarial-fairness-audit-2026-08-02.md)
- [legal grounding experiments 2026 07 30](results/legal-grounding-experiments-2026-07-30.md)
- [metric gold contract audit](results/metric-gold-contract-audit.md)
- [stage19 literature recheck 2026 07 31](results/stage19-literature-recheck-2026-07-31.md)
- [upstream native arm audit 2026 08 05](results/upstream-native-arm-audit-2026-08-05.md)

## Decisions

- [gold ground truth vetting](decisions/gold-ground-truth-vetting.md)
- [legal grounding framing signal synthesis 2026 08 02](decisions/legal-grounding-framing-signal-synthesis-2026-08-02.md)
- [legal text determinism plan](decisions/legal-text-determinism-plan.md)

The durable conclusions are narrow:

- treat task all-pass and criterion pass rate separately;
- keep source/evidence handoff exact and inspectable;
- do not promote retrieval/compiler/context machinery without same-task
  evidence against the simple control;
- deterministic legal operations need a real caller and an adversarial
  contract, not merely a favorable toy probe; and
- gold, judge, parser, and metric defects invalidate a study before model
  comparisons can support a product decision.

## Superseded but reproducibility-relevant records

- [handoff retrieval tools benchmark 2026 07 31](archive/handoff-retrieval-tools-benchmark-2026-07-31.md)
- [harvey lab deterministic wings inventory 2026 08 05](archive/harvey-lab-deterministic-wings-inventory-2026-08-05.md)
- [harvey lab index arm ideas ledger 2026 08 05](archive/harvey-lab-index-arm-ideas-ledger-2026-08-05.md)
- [legal grounding research plan 2026 07 30](archive/legal-grounding-research-plan-2026-07-30.md)
- [legal grounding restart plan 2026 07 31](archive/legal-grounding-restart-plan-2026-07-31.md)
- [retrieval experiment open items 2026 08 01](archive/retrieval-experiment-open-items-2026-08-01.md)
- [upstream mike native surface spec 2266446b](archive/upstream-mike-native-surface-spec-2266446b.md)

These files explain old instruments or run shapes. They are not active designs.
New studies should add one protocol, one runner, one result, and one decision
entry here; do not create a new root-level dated document.
