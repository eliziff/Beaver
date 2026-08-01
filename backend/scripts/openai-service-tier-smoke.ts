import "../src/lib/loadEnv";
import { streamOpenAI } from "../src/lib/llm/openai";

const model = process.argv[2]?.trim() || "gpt-5.4";
const requestedServiceTier = process.argv[3]?.trim() || "fast";
const expectedServiceTier =
  requestedServiceTier.toLowerCase() === "fast"
    ? "priority"
    : requestedServiceTier.toLowerCase();

async function main() {
  const result = await streamOpenAI({
    model,
    systemPrompt: "Reply with exactly OK.",
    messages: [{ role: "user", content: "Reply OK." }],
    reasoningEffort: "low",
    maxIterations: 1,
    serviceTier: requestedServiceTier,
  });

  const receipt = {
    model,
    requested_service_tier: requestedServiceTier,
    expected_service_tier: expectedServiceTier,
    reported_service_tier: result.serviceTier ?? null,
    input_tokens: result.usage?.inputTokens ?? null,
    output_tokens: result.usage?.outputTokens ?? null,
    response_ok: result.fullText.trim() === "OK",
  };
  console.log(JSON.stringify(receipt, null, 2));

  if (result.serviceTier !== expectedServiceTier) process.exitCode = 1;
}

void main();
