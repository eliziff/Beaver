import type { AuthoritiesDraft } from "../../../../shared/authorities-contract.d.ts";
export type {
  AuthoritiesUserAction as AuthoritiesAction, AuthorityKind, AuthoritiesOutputMode, AuthoritiesSourceMode, AuthoritiesProfileId,
  AuthoritiesBookRole, AuthoritiesBuildSettings, AuthoritiesCover, AuthorityIdentity,
  AuthorityTextSpan, AuthorityOccurrence, AuthoritiesDiscrepancyAction, AuthoritiesDraft,
  AuthoritiesDiscrepancy, AuthoritiesBuildReceipt, AuthoritiesOutputRole, AuthoritiesOutputFile,
  AuthoritiesProfile,
} from "../../../../shared/authorities-contract.d.ts";

export type { AuthoritySourceLanguage, AttachedAuthoritySource, AuthoritiesBoundPdf,
  AuthoritiesBookSupplement } from "../../../../shared/authorities-sources.mjs";
import type { WorkProduct } from "@/app/lib/workProducts";

export type AuthoritiesProduct = WorkProduct<AuthoritiesDraft>;
