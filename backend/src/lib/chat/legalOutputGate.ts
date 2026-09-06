const LEGAL_SOURCE_URL = /https?:\/\/(?:[^\s/]+\.)?(?:canlii\.org|bclaws\.gov\.bc\.ca|laws-lois\.justice\.gc\.ca|decisions?\.[^\s/]+\.ca|courtlistener\.com|govinfo\.gov|nationalarchives\.gov\.uk)\b/iu;

export function hasModelAuthoredLegalSourceUrl(text: string) {
  return LEGAL_SOURCE_URL.test(text);
}

export const GROUNDED_LEGAL_REPAIR_INSTRUCTION =
  "The draft contains an unsupported source link. Revise it with supporting evidence_ids and finish with submit_grounded_answer. Reuse available evidence; retrieve only missing passages.";

export const UNVERIFIED_LEGAL_ANSWER =
  "I could not produce a verified answer from the available legal sources.";
