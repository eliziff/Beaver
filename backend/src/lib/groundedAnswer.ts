export type GroundedClaim = { text: string; evidence_ids: string[] };
export type GroundedAnswer = {
  claims: GroundedClaim[];
  value?: string | number | boolean | string[] | null;
};
export type GroundedAnswerFlag = "green" | "grey" | "yellow" | "red";
