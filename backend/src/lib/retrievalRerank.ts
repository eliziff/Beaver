/**
 * Whole-pool listwise LLM reranking over lexical passage candidates
 * (Stage 16 W2). One flat-rate model call ranks the full pool — the
 * RankGPT-family pattern without sliding windows, viable because pools
 * are ≤48 short passages. The model returns candidate indices only;
 * passages themselves are never rewritten, so reranking cannot alter
 * evidence — it only reorders which verbatim slices are offered. Any
 * unparseable reply falls back to lexical order (typed, counted by the
 * caller via the `fallback` flag).
 */
import { completeText } from "./llm";
import type { PassageHit } from "./passageRetrieval";

const SYSTEM =
  "You rank retrieved legal passages by relevance to a question. Reply " +
  "with ONLY a JSON array of candidate numbers, best first, nothing else.";

export async function rerankPassages(args: {
  query: string;
  hits: PassageHit[];
  model: string;
  top: number;
  /** Chars of each passage shown to the ranker. Default 1600 (full
   * passage at the winning chunk size): measured R@4 0.562 -> 0.762
   * over preview 500 on 120 paired gold tests — ranking on 31% of the
   * evidence was the single largest post-pool loss. */
  preview?: number;
  /** Reasoning effort for the ranking call. Unset = provider default
   * (the config every pre-effort receipt file was recorded at). */
  effort?: string;
}): Promise<{ hits: PassageHit[]; fallback: boolean }> {
  const { query, hits, model, top } = args;
  if (hits.length <= top) return { hits: hits.slice(0, top), fallback: false };
  const preview = args.preview ?? 1600;
  const user = JSON.stringify({
    question: query,
    instruction: `Return the ${top} most relevant candidate numbers as a JSON array, most relevant first.`,
    candidates: hits.map((hit, index) => ({
      n: index,
      document: hit.citation,
      text: hit.text.slice(0, preview),
    })),
  });
  try {
    const reply = await completeText({
      model,
      systemPrompt: SYSTEM,
      user,
      ...(args.effort ? { reasoningEffort: args.effort } : {}),
    });
    const match = reply.match(/\[[\d,\s]+\]/u);
    if (!match) throw new Error("no JSON array in reranker reply");
    const order = (JSON.parse(match[0]) as unknown[])
      .map(Number)
      .filter(
        (index, position, all) =>
          Number.isInteger(index) &&
          index >= 0 &&
          index < hits.length &&
          all.indexOf(index) === position,
      );
    if (!order.length) throw new Error("reranker returned no valid indices");
    const chosen = order.slice(0, top).map((index, rank) => ({
      ...hits[index],
      rank,
    }));
    // Underfilled ranking (model returned < top): pad in lexical order.
    for (const hit of hits) {
      if (chosen.length >= top) break;
      if (!chosen.some((c) => c.start === hit.start && c.docId === hit.docId))
        chosen.push({ ...hit, rank: chosen.length });
    }
    return { hits: chosen, fallback: false };
  } catch {
    return { hits: hits.slice(0, top), fallback: true };
  }
}
