export type GroundedClaim = { text: string; evidence_ids: string[] };
export type GroundedAnswer = {
  claims: GroundedClaim[];
  value?: string | number | boolean | string[] | null;
};
export type GroundedAnswerFlag = "green" | "grey" | "yellow" | "red";
export type GroundedResult = GroundedAnswer & { summary?: string; flag?: GroundedAnswerFlag;
  reasoning?: string; outcome?: "answered" | "not_found"; coverage?: "complete" | "partial" };

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
export function groundedSentenceCount(text: string, protectedSpans: Array<{ start: number; end: number }>) {
  return [...sentences.segment(text.replace(/^\s*#{1,6}[^\n]*/gmu, heading => " ".repeat(heading.length)))]
    .filter(({ segment, index }) => /[\p{L}\p{N}]/u.test(segment) && !protectedSpans.some(({ start, end }) => start < index && index < end)).length;
}
