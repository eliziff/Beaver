export type AuthoritySourceLanguage = "en" | "fr" | "bilingual";
export type AttachedAuthoritySource = {
  bindingRole: string;
  filename: string;
  sourceSha256: string;
  sourceUrl: string | null;
  origin: "manual" | "original" | "reconstructed";
  language: AuthoritySourceLanguage;
};
export type AuthoritySourceDecision =
  | { kind: "unresolved" }
  | { kind: "resolved" }
  | { kind: "attached"; sources: AttachedAuthoritySource[] }
  | { kind: "pending-canlii"; authorityKey: string; pageUrl: string; pdfUrl: string };

export type AuthoritiesBoundPdf = {
  bindingRole: string;
  filename: string;
  sourceSha256: string;
};
export type AuthoritiesBookSupplement = AuthoritiesBoundPdf & { id: string };
export type AuthoritiesBookParts = {
  cover: AuthoritiesBoundPdf | null;
  index: AuthoritiesBoundPdf | null;
  supplements: AuthoritiesBookSupplement[];
};

type SourceDraft<Binding = unknown> = {
  import: { kind: "manual" } | { kind: "document"; bindingRole: string };
  bindings: Record<string, Binding>;
  authorities: Record<string, { source: AuthoritySourceDecision }>;
  bookParts: AuthoritiesBookParts;
};
type SourceAuthority = { source: AuthoritySourceDecision };

/** The obligations a caller enforces, named after the court profile requirements. */
export type AuthoritySourceRequirements = {
  completeBookSources?: boolean;
  bilingualEnactments?: boolean;
  unlinkedPdfTableSources?: boolean;
};
export type AuthoritySourceReason = "missing" | "incomplete-enactment" | "unlinked";
type RequirementDraft = {
  import: { kind: "manual" } | { kind: "document"; fileType: "pdf" | "docx" };
  outputMode: "table" | "book" | "both";
  insertIntoDocument: boolean;
};
type RequirementAuthority = {
  kind: string;
  citation: string;
  excluded?: boolean;
  source: AuthoritySourceDecision;
  sourceIdentity?: { externalUrl?: string | null } | null;
};

export function attachedAuthoritySources(source: AuthoritySourceDecision): AttachedAuthoritySource[];
export function federalEnactmentCitation(citation: string): boolean;
export function hasBilingualAuthoritySource(source: AuthoritySourceDecision): boolean;
export function authoritySourceUrl(authority: RequirementAuthority): string | null;
export function bilingualEnactmentRequired(authority: Pick<RequirementAuthority, "kind" | "citation">,
  requirements?: AuthoritySourceRequirements | null): boolean;
export function authorityBytesRequired(draft: RequirementDraft,
  requirements?: AuthoritySourceRequirements | null): boolean;
export function authorityPdfRequired(draft: RequirementDraft, authority: RequirementAuthority,
  requirements?: AuthoritySourceRequirements | null): boolean;
export function authoritySourceRequirement(draft: RequirementDraft, authority: RequirementAuthority,
  requirements?: AuthoritySourceRequirements | null, prepared?: boolean): AuthoritySourceReason | null;
export function authoritiesBookPdfs(draft: Pick<SourceDraft, "bookParts">): AuthoritiesBoundPdf[];
export function removeUnusedBinding(draft: SourceDraft, role: string | undefined): void;
export function replaceSource(draft: SourceDraft, authority: SourceAuthority,
  source: AuthoritySourceDecision): void;
export function attachAuthoritySource<Binding>(draft: SourceDraft<Binding> & {
  stage?: "citations" | "sources" | "highlights" | "build";
}, authority: SourceAuthority, source: AttachedAuthoritySource, binding: Binding): void;

export function authoritiesInputPlan<A extends SourceAuthority & { excluded: boolean }>(draft: {
  import: { kind: "manual" } | { kind: "document"; bindingRole: string; fileType: "pdf" | "docx" };
  authorities: Record<string, A>;
  bookParts: AuthoritiesBookParts;
  outputMode: "table" | "book" | "both";
  insertIntoDocument: boolean;
}, requirements?: AuthoritySourceRequirements | null): {
  authoritySources: Array<{ authority: A; source: AttachedAuthoritySource }>;
  bookPdfs: AuthoritiesBoundPdf[];
  bookRoles: Set<string>;
  byteRoles: Set<string>;
};
