# Meta Muse Spark provider decision

Checked 26 July 2026.

## Verified contract

- The current public model is **Muse Spark 1.1**, not the April 2026 Muse
  Spark preview. Meta describes it as a multimodal reasoning model with a
  one-million-token context, tool calling, and a public-preview Meta Model API:
  <https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/>.
- Meta's developer landing page describes its API as OpenAI-compatible and
  advertises both direct Meta Model API access and OpenRouter:
  <https://developer.meta.com/ai/>.
- OpenRouter's model record gives the callable ID
  `meta/muse-spark-1.1` and confirms text, image, video, audio, and PDF input,
  streaming-compatible tool calls, structured output, and reasoning:
  <https://openrouter.ai/meta/muse-spark-1.1>.
- OpenRouter's live model catalog reports mandatory reasoning with default
  `medium` effort and supported efforts `xhigh`, `high`, `medium`, `low`, and
  `minimal`: <https://openrouter.ai/api/v1/models>.
- OpenRouter documents its OpenAI-compatible, stateless Responses API at
  `https://openrouter.ai/api/v1/responses`:
  <https://openrouter.ai/docs/api/reference/responses/overview>.

## Beaver route

Beaver exposes Muse Spark under a **Meta** model group and invokes it through
OpenRouter using the existing `OPENROUTER_API_KEY` setting. This is the
smallest available integration on this Canadian installation: this machine has
no direct Meta Model API credential, and it already has an OpenRouter
credential. OpenRouter's current model page labels this particular hosted
preview as available only to US users. That is a distribution policy, not an
inherent model capability.

The adapter reuses Beaver's Responses API implementation. OpenAI requests retain
their provider session continuation; OpenRouter requests replay completed
output items and tool results because OpenRouter's Responses API is stateless.
No secret is sent to the browser or written to logs.

Direct Meta Model API auth should be added only if Meta makes it available for
this deployment and a `MODEL_API_KEY` is supplied. It would be another endpoint
configuration, not another model/tool implementation.

## Live validation

The adapter reached OpenRouter through Beaver on 2026-07-26. The configured
`OPENROUTER_API_KEY` was rejected first with HTTP 401 `User not found`, so this
run did **not** test whether OpenRouter would enforce its displayed US-user
restriction for this account. Replace or reissue the OpenRouter key, then rerun
the harmless text, tool, and image checks before marking Muse Spark live.
