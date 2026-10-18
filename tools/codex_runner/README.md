# Codex runner components

Shared execution for the repository's Python Codex CLI callers. Existing task
entry points own inputs, prompts, schemas, validation and output artifacts.
This package has no task registry or separate command-line runner.
Callers add the repository's `tools` directory to their Python path and import
`codex_runner`; this avoids colliding with OLJ's existing `tools` package.

| Module | Responsibility |
| --- | --- |
| `transport` | Process execution, timeout/cancellation cleanup and streamed or captured output. `invoke` supplies the existing isolated, structured CLI invocation. |
| `calls` | Content-addressed accepted responses, bounded attempts, task validation, usage and retained receipts. |
| `artifacts` | Atomic JSON/files, compressed JSON reads and stable hashes. |

`execute` accepts the caller's exact command and final prompt. It adds no prose,
changes no model settings and inherits the caller's environment and working
directory unless supplied explicitly. Callers with different CLI contracts keep
their existing arguments. Timeout and interruption terminate the process tree.

`call` accepts a prompt, schema, ordered images, output directory, execution
options and a validation callback. `CallPolicy` supplies instructions/config,
retry wording, error handling and whether to validate the JSON schema locally.
The validator also runs on cached responses. A policy may stop immediately on a
provider failure or retry it; the executor does not choose that task behavior.

Cache identity includes the prompt, schema value, instructions/config, ordered
image hashes, model and effort. Attempts retain exact compressed prompts, raw
responses, compressed events/errors, hashes, usage and elapsed time. Output
locations belong to the calling task and must use its durable private store.
`usage_totals` reads that task's `calls/<unit>/<key>/receipt.json` tree.

The structure gold's lines, notes and hierarchy passes share the call
lifecycle, each with its own prompt and validation and its receipts under the
source run's `calls/` directory. Pagination and compaction callers share
the process transport while retaining their benchmark-specific retry/result
contracts. The provider-neutral structure composer keeps its existing bounded
module-negotiation loop; do not wrap it in another retry loop.

The subscription Responses adapter used by Harvey LAB and the decision-roster
caller is a separate existing transport. OLJ's article pipeline remains its own
consumer and supplies useful reference implementations; its article-specific
prompt decoration and scheduling are not dependencies of this package.

The CLI contract is documented in OpenAI's
[non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
Prompt/schema/default preservation is checked against existing saved requests
and accepted responses. Private verification receipts belong with the gold
investigation, not in this package.
