/** Shared Court Record draft state; the app and the standalone client decode to this. */
import type { CoverFieldId } from "./court-record-profiles.mjs";
import type { FileSnapshot, WorkProductInput } from "./work-products.mjs";

export type CourtRecordPartyContact =
  Partial<Record<"name" | "address" | "phone" | "fax" | "email", string>>;

export type CaseParty = { id: string; name: string; contact?: CourtRecordPartyContact };

export type CasePartyGroup = { id: string; role: string; roleBelow?: string;
  parties: CaseParty[] };

/** Cover keys that carry plain text; the remaining keys carry party structure. */
export type CoverTextFieldId = CoverFieldId | "partyStyleId";

export type CoverValues = Partial<Record<CoverTextFieldId, string>> & {
  partyGroups?: CasePartyGroup[];
  filingPartyIds?: string[];
};

/** Cover values and exhibit evidence read out of one source PDF. */
export type SourceDocumentFields = {
  cover: Partial<Record<CoverFieldId, string>>;
  exhibitLabels: string[];
  exhibitMentions?: Record<string, string[]>;
  explicitExhibitLabel?: string;
  entryTitle?: string;
  entryDate?: string;
};

/** The sequential exhibit slots bound to one affidavit's bytes. */
export type SourceExhibits = { sourceSha256: string; labels: string[] };

export type CourtRecordDraftEntry = {
  id: string;
  kindId: string;
  title: string;
  date?: string;
  rule70CountedPages?: number;
  exhibitLabel?: string;
  sourceExhibits?: SourceExhibits;
  sourceFields?: SourceDocumentFields;
  descriptionOnly?: boolean;
  ocrAttemptedPages?: number[];
  nonTextPagesConfirmed?: boolean;
  lastSeen: FileSnapshot;
};

/** The durable, file-byte-free Court Record draft stored at the application boundary. */
export type CourtRecordDraft = {
  profileId: string;
  cover: CoverValues;
  entries: CourtRecordDraftEntry[];
  bindings: Record<string, WorkProductInput>;
};
