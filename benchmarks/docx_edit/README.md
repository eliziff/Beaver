# docx-edit-bench v1

How well does a model edit an **arbitrary span of a real document** when it is
given a tool surface and a semantic instruction? Not "can it write a clause" —
can it find the one place the change belongs, change only that, and leave the
four places that look identical alone.

The benchmark is surface-agnostic. It takes a **tool surface** as configuration
and measures a model against it, so the next surface anyone invents is
measurable without editing anything here. Its first consumer is an A/B of two
Beaver navigation shapes, but nothing in `src/` knows that.

## What is here

| Path | What it is |
| --- | --- |
| `tasks.jsonl` | The tasks, as data. One record per task. Add a task by adding a line. |
| `fixtures/prose/*.md` | Sources for the prose fixtures. |
| `src/fixtures.ts` | Deterministic fixture builders (prose + pathology). |
| `src/checks.ts` | The checker library: score a produced document against a task. |
| `src/tasks.ts` | Task loading and structural validation. |
| `src/selftest.ts` | Task validity and outcome validity, separately. |
| `src/surface.ts` | Tool surfaces as configuration. |
| `src/run.ts` | The runner: one model, one surface, one task, one replicate. |
| `src/report.ts` | Aggregation over receipts. |
| `surfaces.jsonl` | The surfaces. Add one by adding a line. |
| `manifest.jsonl` | Fixture and task fingerprints. Regenerate after any change. |

Run everything from the `backend/` workspace — that is where the `node_modules`
the fixture builders resolve through live. The single point of coupling to the
product is `backend/scripts/docx-edit-bench-bridge.ts`.

```powershell
cd backend
npx tsx ../benchmarks/docx_edit/src/cli.ts list
npx tsx ../benchmarks/docx_edit/src/cli.ts self-test
npx tsx ../benchmarks/docx_edit/src/cli.ts surface --id beaver-address
npx tsx ../benchmarks/docx_edit/src/cli.ts manifest --write
npx tsx ../benchmarks/docx_edit/src/run.ts --surface beaver-address `
  --task lease-cure-period --model codex:gpt-5.6-sol --rep 1 --out <receipts-dir>
npx tsx ../benchmarks/docx_edit/src/report.ts --out <receipts-dir>
```

Receipts are append-only and are **never committed**. Keep them outside the
repository.

## Fixtures

Eleven documents, built rather than committed, in two families.

**Prose** (rendered through the product's own markdown-to-DOCX path):

| id | Character |
| --- | --- |
| `sunrise-spa` | 25k chars, 17 articles, 7 schedules, 109 structural handles. Exceeds a default read window. |
| `northwind-credit` | Page-marked credit agreement, 13 pages, a table of contents that repeats heading wording. |
| `harbourfront-lease` | Short, PART-structured, heading capitalisation drift. |
| `indemnity-memo` | Unstructured memo restating another document's terms. |
| `pinewood-engagement-letter` | Unstructured letter: no numbering at all. |
| `discovery-transcript` | Page-marked, no numbered structure; an answer runs across a sheet break. |

**Pathology** (assembled with the DOCX packager, reusing the shapes in
`backend/src/lib/__tests__/fixtures/docx-pathologies`):

| id | Character |
| --- | --- |
| `crossbridge-bylaw` | Auto-numbered clauses — the numbers live in `numbering.xml` and appear nowhere in the text — plus a signing-limit table, a header and a footer. |
| `fairmount-supply-redline` | A real tracked insertion and deletion, a manual strike/colour redline that still reads as operative, two comments, change recording on. |
| `bilingual-notice` | Parallel English and French clauses plus a bilingual table of periods. |
| `ocr-arbitral-award` | OCR damage: mixed straight and curly quotes, en/em dash confusion, double spacing, a hyphen-split word, a stray non-breaking space. |
| `laurier-factum` | Footnotes and endnotes off the body plane, running heads. |

All fixtures are **locally generated**. Nothing in this set is a well-known
public document, so a model cannot have memorised the answer.

### Fixture identity

DOCX bytes are not reproducible across builds — the packager stamps times into
`core.xml`. A fixture's identity in `manifest.jsonl` is therefore
`text_sha256`, the hash of its **extracted body text**: the only plane the
checks and the tool surface both see. `bytes_sha256_sample` records one build
and is informational.

## Tasks

27 tasks. Every task carries, as data: a stable id, the semantic instruction
**verbatim as it is played to the model**, its fixtures, difficulty, categories,
a `why` field recording what it probes, the checks, a reference solution, and
at least one hand-written near miss.

Instructions are semantic. None of them names a tool, a parameter, a page
scheme, or an addressing form — what the model reaches for is the measurement,
so telling it what to reach for would destroy it.

### Difficulty

| Difficulty | Tasks |
| --- | --- |
| floor (labelled `floor_task`) | 3 |
| easy | 1 |
| medium | 5 |
| hard | 11 |
| devious | 7 |

**Floor tasks are labelled and must be excluded from any headline number.**
They exist to show the set is not uniformly hard and to catch a surface that
cannot do the simplest thing; averaging them into a score flatters everything.

### What the devious tasks probe

- `redline-struck-carveout` — struck text that reads as operative. The waiver
  is struck through in red as a *manual* redline, so it is still on the body
  text plane. The instruction's literal reading is satisfiable and satisfying
  it edits a sentence the parties already deleted.
- `redline-already-deleted` — the inverse. The obligation is inside a real
  tracked deletion, so it is absent from every read: searching finds nothing,
  and the obvious thing to reach for is the insertion that replaced it.
- `spa-delete-and-renumber` — downstream renumbering. Removing one clause
  forces four renumberings inside the article and five pointer updates, two of
  them in articles nowhere near it.
- `credit-heading-and-toc` — the same phrase in an article heading, a contents
  entry nine pages away, and the clause bodies. Only the first two may move.
- `bilingual-cure-period` — four sites across two equally authentic languages
  and a summary table, with an identical decoy period elsewhere.
- `transcript-page-boundary` — the instruction names the page the answer
  *begins* on; the wrong date is in the continuation on the next page, and the
  identical date three pages earlier is a different event.
- `bylaw-directors-notice` — near-identical notice clauses in a document whose
  clause numbers exist only in the numbering part.

Refusal tasks (`expected: refuse`) cover a target that does not exist
(`spa-nonexistent-section`), a genuinely ambiguous instruction
(`credit-ambiguous-margin`), the two redline cases above, and a target that is
off the addressable plane entirely (`factum-footnote-pinpoint`).

## Progressive tool disclosure

A surface may ship only part of its schema in the request and reveal the rest
when the model asks for a domain. The runner drives that loop, because the
provider adapter freezes its tool list when a call starts: a domain opened
mid-call cannot become callable inside that call, so the runner ends the call
at the disclosure and continues in a new one, replaying the exchange so far.
The replay's token cost is real and is counted. A surface that defers nothing
never restarts, so one code path serves both.

Two things keep the condition honest:

- a call to a tool the surface has not served is **refused by the runner**
  rather than executed. The handlers dispatch on name alone, so without this a
  model that guessed a deferred tool's name would silently get it;
- the first request's schema size is reported beside the mean across the run's
  requests, because the saving is only real if the model does not open
  everything on turn one.

Reported separately from ordinary failures: runs that opened a domain, the
batch at which the first disclosure fired, runs blocked on a hidden tool, and
domains opened but never used.

Two task fields make a disclosure result readable, and they are properties of
the task rather than of any arm:

- `resident_route_exists` — whether a route using only always-resident tools
  solves it. **True for all 27 tasks in v1**: every reference solution is a
  literal substitution, which a deterministic text-op tool executes directly.
  So v1 can show the cost of hiding a tool a model *wanted*; it cannot show
  the cost of hiding a tool a task *needs*. A future task that genuinely
  requires a deferred capability would set this false.
- `alternative_route_domains` — the domains a natural alternative route
  reaches for. `["drafting"]` on every edit task, because tracked-change
  revision is the obvious thing to reach for and it is commonly deferred.

## Scoring

Every check is programmatic and frozen before any model call. A task that
cannot be checked programmatically does not ship.

The score is **partial credit**, not a bare pass/fail:

```
sites_correct  targets satisfied
sites_missed   targets not satisfied
sites_wrong    guards broken — sites a correct edit never touches
foreign_line_removals / foreign_line_additions
answer_check, document_changed, unchanged_document_violations
```

`pass` requires every target satisfied, no guard broken, no collateral beyond
what the reference solution incurs, and — for refusal tasks — no change and an
answer that both matches the required pattern and avoids the forbidden one.

### Blocking the shortcuts

The obvious shortcut is a model that **regenerates the document from its own
reading**: it can satisfy any "X now says Y" assertion without ever locating
anything. Every task therefore has a negative half.

| Shortcut | Blocked? | How |
| --- | --- | --- |
| Rewrite the whole document | Yes | `foreign_line_removals`: original content lines the run destroyed beyond those the reference solution destroys. Budget 0 by default. |
| Sweep the change everywhere | Yes | Guards on the look-alike sites. Every edit task has at least one; the loader refuses a task without one. |
| Edit the source instead of the target | Yes | `unchanged_documents`. |
| Say it is done without doing it | Yes | `document_changed` for edit tasks; `answer_must_not_match` for refusal tasks. |
| Append the right sentence instead of fixing the wrong one | Yes | `foreign_line_additions`, budget 0, plus the "old text gone" targets. |
| Refuse for the wrong reason | **Partly** | A refusal task checks that nothing changed and that the answer names the reason. It cannot tell a correct refusal from an unmotivated one that happens to use the right word. Recorded as a known limitation. |
| Reorder rather than edit | **Partly** | Line-multiset comparison is order-insensitive, so a pure reordering that keeps every line reads as no damage. No task depends on order. |

### Known limitations

- `factum-footnote-pinpoint` measures a **surface blind spot** as much as model
  judgement: footnote text is not on the body plane, so the target is
  unreachable through these tools by construction. Its "correct" answer is a
  refusal. Read it as a property of the surface, not as a model score.
- Refusal tasks score an answer with a regular expression. That is
  deterministic but shallow.
- The checker scores the **accepted** projection of the document. A run that
  makes the right change as a tracked change and a run that makes it outright
  score the same.

## Validity, measured

`self-test` establishes the two things separately and reports both.

**Task validity — is the task solvable?** Every task carries a reference
solution as literal edits. Applying it must find every string it claims to find
and produce a document the checker passes.

**Outcome validity — can the checker fail?** Every wrong result must be
rejected, and the report records *which* check rejected it. Wrong results come
from three places: the hand-written near misses; two automatic probes (the
untouched document, and a partially regenerated document that satisfies the
positive half while destroying the tail); and one synthetic sensitivity probe
per guard, which damages exactly what that guard protects.

Current state, from `npx tsx ../benchmarks/docx_edit/src/cli.ts self-test`:

```
27 tasks: 27 with a verified reference solution, 27 rejecting every wrong result.
0 site checks never observed failing.
```

That is 27/27 solvability and 100% of site checks with demonstrated
sensitivity — every target has been seen to fail on the untouched document and
every guard has been seen to fail on a document that damages it.

## Statistical framing

At 27 tasks this is an **exploratory** instrument. It is built to separate
surfaces qualitatively and to show *where* they differ, not to certify a
percentage-point difference. Any comparison must report the within-arm
run-to-run floor (the spread across replicates of the same cell) beside the
between-arm difference, and must not call a difference that sits inside that
floor. Do not quote a headline number that includes the floor tasks.

## Reproducibility

Each receipt records the benchmark version, the task version, the fixture text
hashes through the manifest, the surface id and its environment, the **hash of
the tool schema actually served**, the repository HEAD, the model and reasoning
effort, and the full argument list of every tool call. A product change that
alters the served surface shows up as a different schema hash rather than as an
unexplained result.
