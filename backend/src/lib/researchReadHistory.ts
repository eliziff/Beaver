import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { DocumentStore } from "./documentStore";
import { storedLegalEvidenceReceipt, type LegalEvidenceReceipt } from "./chat/legalEvidence";
import type { ResearchFile } from "./researchFile";
import { sha256 } from "./hash";

// Background observations use the research file's existing, versioned parts port.
// They never create source membership, highlights, or grounded findings.
export const RESEARCH_READS_PART = "reads.json";
export async function readResearchReads(documents: DocumentStore, scope: ApplicationScope,
  file: ResearchFile): Promise<Record<string, LegalEvidenceReceipt>> {
  const ref = file.state.reads;
  if (!ref) return {};
  const part = (await documents.readParts(scope, file.document.id, file.versionId, [RESEARCH_READS_PART]))?.[0];
  if (!part || part.sha256 !== ref.sha256 || sha256(part.bytes) !== ref.sha256)
    throw new ApplicationError(409, "Research read history is unavailable");
  let values: unknown;
  try { values = JSON.parse(part.bytes.toString("utf8")); } catch { /* Checked below. */ }
  if (!values || typeof values !== "object" || Array.isArray(values) ||
      Object.keys(values).length !== ref.count || Object.entries(values).some(([id, value]) =>
        storedLegalEvidenceReceipt(value)?.evidence_id !== id))
    throw new ApplicationError(409, "Research read history is invalid");
  return values as Record<string, LegalEvidenceReceipt>;
}
