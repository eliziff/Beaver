import type { WorkProduct, WorkProductInput } from "@/app/lib/workProducts";

export type AuthorityKind = "case" | "legislation" | "commentary" | "other";
export type AuthoritiesOutputMode = "table" | "book" | "both";
type AuthoritySourceIdentity = {
  provider: string;
  stableSourceId: string;
  sourceSha256: string;
  version: string | null;
  externalUrl: string | null;
};

type AuthoritySource =
  | { kind: "unresolved" }
  | { kind: "resolved" }
  | { kind: "attached"; bindingRole: string; filename: string;
      sourceSha256: string; sourceUrl: string | null }
  | { kind: "pending-canlii"; authorityKey: string; pageUrl: string; pdfUrl: string };

export type AuthorityIdentity = {
  id: string;
  key: string;
  kind: AuthorityKind;
  citation: string;
  name: string | null;
  displayName: string | null;
  evidenceIds: string[];
  locators: Array<{ kind: string; label: string }>;
  sourceIdentity: AuthoritySourceIdentity | null;
  excluded: boolean;
  source: AuthoritySource;
};

export type AuthorityOccurrence = {
  id: string;
  unitId: string;
  start: number;
  end: number;
  text: string;
  kind: AuthorityKind | "reference";
  citation: string;
  authorityId: string | null;
  reference: { kind: "supra" | "ibid"; targetAuthorityId: string } | null;
  pinpoints: Array<{ kind: "paragraph" | "section" | "page"; text: string }>;
  evidenceIds: string[];
  sourceTextSha256: string;
  localOrdinal: number;
  reviewed: boolean;
};

export type AuthoritiesDraft = {
  schemaVersion: "beaver.authorities-draft.v1";
  import: { kind: "manual" } | { kind: "document"; bindingRole: "source";
    filename: string; fileType: "docx" | "pdf"; snapshot: {
      documentId: string; versionId: string; sha256: string;
    } | null };
  bindings: Record<string, WorkProductInput>;
  outputMode: AuthoritiesOutputMode;
  insertIntoDocument: boolean;
  units: Array<{ id: string; kind: "body" | "footnote"; ordinal: number;
    footnoteId: number | null; footnoteRefs: Array<[number, number]>;
    pageNumbers: number[]; text: string; occurrenceIds: string[] }>;
  occurrences: Record<string, AuthorityOccurrence>;
  authorities: Record<string, AuthorityIdentity>;
  authorityOrder: string[];
};

export type AuthoritiesProduct = WorkProduct<AuthoritiesDraft>;

export type AuthoritiesAction =
  | { type: "add-authority"; kind: AuthorityKind; citation: string; name?: string | null }
  | { type: "remove-authority"; authorityId: string }
  | { type: "exclude-authority"; authorityId: string; excluded: boolean }
  | { type: "rename-authority"; authorityId: string; displayName: string | null }
  | { type: "reorder-authorities"; authorityIds: string[] }
  | { type: "split-occurrence"; occurrenceId: string; cursor: number }
  | { type: "merge-occurrence"; occurrenceId: string }
  | { type: "relink-occurrence"; occurrenceId: string; authorityId: string | null }
  | { type: "set-reference"; occurrenceId: string;
      reference: { kind: "supra" | "ibid"; targetAuthorityId: string } | null }
  | { type: "begin-canlii-handoff"; authorityId: string }
  | { type: "set-output-mode"; outputMode: AuthoritiesOutputMode }
  | { type: "set-document-output"; enabled: boolean };

export type AuthoritiesBuildReceipt = {
  schemaVersion: "beaver.authorities-build.v1";
  builtAt: string;
  outputs: Partial<Record<"table" | "book" | "annotated-document", {
    filename: string; mimeType: string; sha256: string; pageCount: number | null;
  }>>;
};
