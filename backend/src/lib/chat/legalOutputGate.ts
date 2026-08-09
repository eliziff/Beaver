const LEGAL_SOURCE_URL = /https?:\/\/(?:[^\s/]+\.)?(?:canlii\.org|bclaws\.gov\.bc\.ca|laws-lois\.justice\.gc\.ca|decisions?\.[^\s/]+\.ca|courtlistener\.com|govinfo\.gov|nationalarchives\.gov\.uk)\b/iu;

export function hasModelAuthoredLegalSourceUrl(text: string) {
  return LEGAL_SOURCE_URL.test(text);
}

export const GROUNDED_LEGAL_REPAIR_INSTRUCTION =
  "The draft used a model-authored legal-source URL without a verified evidence receipt. Discard it. Retrieve responsive case law, legislation, or journal passages with the supplied source tools, then call submit_grounded_answer using their evidence_ids. Do not write or repeat any URL; the host constructs inline citation pills.";

export const UNVERIFIED_LEGAL_ANSWER =
  "I could not produce a verified answer from the available legal sources.";
