# Legal session compaction benchmark — Track B

This isolated scaffold asks a narrow question: after a 64-turn legal session is
compacted, can the same model recover the final authoritative state exactly?

It uses two synthetic, redistributable fixtures and 21 deterministic assertions
covering:

- active versus superseded instructions;
- authoritative document/version/hash;
- exact quote, limiting qualifier, pinpoint, and URL;
- accepted/rejected multi-turn edits;
- completed versus partial tool receipts, including exit status, truncation,
  cursor, result count, and durable artifact hash; and
- an early deadline that is later changed.

No embedding score or model judge is used. A changed apostrophe, missing
qualifier, stale edit, or guessed receipt fails the corresponding assertion.

## Local check

```powershell
python experiments/context_compaction_track_b/benchmark.py selftest
python experiments/context_compaction_track_b/benchmark.py inspect
python -m unittest discover -s experiments/context_compaction_track_b -p "test_*.py"
```

## Saved Codex authentication

This compares full history, an exact structured capsule plus an eight-turn tail,
and an intentionally lossy prose summary plus the same tail:

```powershell
python experiments/context_compaction_track_b/benchmark.py run-codex `
  --model gpt-5.6-terra `
  --effort low
```

The runner invokes `codex exec --ephemeral --ignore-user-config` in a temporary,
read-only directory and requests schema-constrained JSON. It does not persist a
Codex session.

## Native OpenAI compaction

When `OPENAI_API_KEY` is set:

```powershell
python experiments/context_compaction_track_b/benchmark.py run-openai `
  --model gpt-5.6 `
  --effort low `
  --arms full_history,structured_capsule,prose_summary,native_openai_compact
```

For `native_openai_compact`, the runner sends the full window to
`POST /v1/responses/compact`, keeps the returned output opaque, appends the new
user message, and passes the canonical window unchanged to
`POST /v1/responses`. It stores only the compacted window's hash, item types,
size, and usage—not the opaque compacted state itself.

## Controlled ablations

The following arms remove one group from the exact capsule while leaving the
tail and every other group unchanged:

```text
no_instruction_state
no_pinpoint_state
no_edit_state
no_tool_receipt_state
```

Example:

```powershell
python experiments/context_compaction_track_b/benchmark.py run-openai `
  --fixtures ca_paragraph_revision `
  --arms structured_capsule,no_pinpoint_state,no_tool_receipt_state
```

Run files are written to `results/` with the model, effort, fixture and input
hashes, exact per-field scores, usage, and elapsed time.

To grow context while holding the legal state and turn count fixed, add
`--noise-repeats N`. Each additional packet is explicitly marked as an
unverified, non-authoritative distractor. For example:

```powershell
python experiments/context_compaction_track_b/benchmark.py inspect `
  --fixtures ca_paragraph_revision `
  --noise-repeats 8

python experiments/context_compaction_track_b/benchmark.py run-openai `
  --fixtures ca_paragraph_revision `
  --noise-repeats 8 `
  --arms full_history,native_openai_compact
```

## Interpretation limits

The two fixtures are a smoke test, not a publishable estimate. The structured
capsule is an oracle state projection, so it tests whether the representation is
sufficient downstream; it does not measure the quality of a capsule generator.
The prose arm is a controlled information-loss baseline. A serious run should
add at least 30 licensed legal fixtures, three repetitions per arm, and the
paired non-inferiority analysis described in the Track B report.
