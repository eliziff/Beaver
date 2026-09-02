import type {
  CourtProfile,
  CoverDefinition,
  CoverField,
  CoverFieldId,
  CoverValues,
  DocumentKind,
  PartyStyle,
  TechnicalRequirements,
} from "./types";
import { filingParty } from "./types";
import profileContractJson from "../../../../shared/court-record-profiles.json";

const MB = 1024 * 1024;
type CourtIdentity = Pick<CourtProfile,
  "jurisdiction" | "courtId" | "court" | "courtAbbreviation" | "language">;
const GENERAL: CourtIdentity = {
  jurisdiction: "general", courtId: "general", court: "Court",
  courtAbbreviation: "No preset", language: "en",
};
const ABKB: CourtIdentity = {
  jurisdiction: "ab", courtId: "ab-kb", court: "Court of King’s Bench of Alberta",
  courtAbbreviation: "ABKB", language: "en",
};
const ABCA: CourtIdentity = {
  jurisdiction: "ab", courtId: "ab-ca", court: "Court of Appeal of Alberta",
  courtAbbreviation: "ABCA", language: "en",
};
const FC: CourtIdentity = {
  jurisdiction: "ca", courtId: "fc", court: "Federal Court",
  courtAbbreviation: "FC", language: "en",
};
const FCA: CourtIdentity = {
  jurisdiction: "ca", courtId: "fca", court: "Federal Court of Appeal",
  courtAbbreviation: "FCA", language: "en",
};
const DUAL_FEDERAL: CourtIdentity = {
  ...FC, courtId: "fc-fca", court: "Federal Court or Federal Court of Appeal",
  courtAbbreviation: "FC/FCA",
};
const document = (documentFamily: string, documentLabel: string, variant = "standard") => ({
  documentFamily, documentLabel, variant,
});
type KindPresentation = Pick<DocumentKind, "id" | "description">;
type ProfilePresentation = Omit<CourtProfile, "label" | "documentKinds"> & {
  documentKinds: KindPresentation[];
};
type ProfileContract = { id: string; label: string; coverFields: CoverFieldId[];
  partyStyleIds?: string[]; filingGroupId?: string; effectiveFrom?: string;
  oneOf?: Array<{ slots: string[]; label: string }>;
  slots: Array<Omit<DocumentKind, "description">> };
const PROFILE_CONTRACT = profileContractJson as unknown as {
  partyStyles: PartyStyle[]; profiles: ProfileContract[];
};
const PROFILE_CONTRACTS = PROFILE_CONTRACT.profiles;
const PARTY_STYLE_BY_ID = new Map(PROFILE_CONTRACT.partyStyles.map((item) => [item.id, item]));

const field = (
  id: CoverFieldId,
  label: string,
  required = false,
  placeholder?: string,
  multiline = false,
): CoverField => ({ id, label, required, placeholder, multiline });

const kind = (
  id: string,
  description: string,
): KindPresentation => ({ id, description });

const baseCoverFields: CoverField[] = [
  field("courtFileNumber", "Court file number", true, "T-123-26"),
  field("registry", "Registry", true, "Calgary"),
  field("counselName", "Lawyer or filing person", true),
  field("counselAddress", "Address for service", true, undefined, true),
  field("counselPhone", "Telephone", true),
  field("counselFax", "Fax"),
  field("counselEmail", "Email", true),
  field("otherCounselName", "Other party’s lawyer or filing person"),
  field("otherCounselAddress", "Other party’s address for service", false, undefined, true),
  field("otherCounselPhone", "Other party’s telephone"),
  field("otherCounselFax", "Other party’s fax"),
  field("otherCounselEmail", "Other party’s email"),
];

const federalCoverFields = baseCoverFields.filter((item) => item.id !== "registry");
const federalApplicationUnder: CoverField = {
  ...field("applicationUnder", "Application under", true, "Federal Courts Act, section 18.1"),
  partyStyleId: "application",
};
const federalMotionFields = [
  ...federalCoverFields,
  field("hearingDate", "Hearing date"),
  field("recordSubtitle", "Motion description", true),
  federalApplicationUnder,
];

const appealFields: CoverField[] = [
  field("courtFileNumber", "Appeal file number", true),
  field("lowerCourtFileNumber", "Trial court file number"),
  field("registry", "Registry", true),
  field("decisionMaker", "Decision maker appealed from"),
  field("decisionDate", "Decision date"),
  field("decisionFileDate", "Decision filing date"),
  field("counselName", "Lawyer or filing person", true),
  field("counselAddress", "Address for service", true, undefined, true),
  field("counselPhone", "Telephone", true),
  field("counselFax", "Fax"),
  field("counselEmail", "Email", true),
  field("otherCounselName", "Other party’s lawyer or filing person"),
  field("otherCounselAddress", "Other party’s address for service", false, undefined, true),
  field("otherCounselPhone", "Other party’s telephone"),
  field("otherCounselFax", "Other party’s fax"),
  field("otherCounselEmail", "Other party’s email"),
];

const electronicRecord: TechnicalRequirements = {
  pdfOnly: true,
  searchable: true,
  noSecurity: true,
  continuousPageNumbers: true,
  pageNumberPosition: "top-centre",
  pageOne: "cover",
  pdfPageLabelsMatch: true,
  bookmarks: "tabs-and-documents",
  bookmarksPanelOpen: true,
  hyperlinkedIndex: true,
};

const federalElectronic: TechnicalRequirements = {
  ...electronicRecord,
  bookmarks: "documents",
  pageNumberPosition: "bottom-right",
  pageNumberInset: 99.21,
  pageNumberOffset: 54,
  indexStyle: "federal",
  indexTitle: "TABLE OF CONTENTS",
  indexDocumentLabel: "DOCUMENT",
  indexRowsPerPage: 14,
  indexDate: "none",
  pageNumberSize: 12,
  maxOutputBytes: 100 * MB,
  maxOutputPages: 500,
  volumeInstructions: "Use the smallest number of clearly labelled volumes; keep continuous pagination and a complete table of contents in every volume.",
};

const abcaElectronic: TechnicalRequirements = {
  ...electronicRecord,
  pageNumberPosition: "top-right",
  pageNumberInset: 72,
  pageNumberOffset: 31.79,
  pageNumberSize: 20,
  indexStyle: "abca",
  indexTitle: "Table of Contents",
  indexRowsPerPage: 14,
  maxOutputBytes: 100 * MB,
  volumeInstructions: "If the PDF cannot be reduced below 100 MB, file it in the smallest practical number of separately labelled parts with continuous pagination.",
};

const whiteCover = (
  title: string,
  fields: CoverField[] = baseCoverFields,
  extra: Partial<CoverDefinition> = {},
): CoverDefinition => ({
  generated: true,
  title,
  colourName: "white",
  colourHex: "#FFFFFF",
  fields,
  ...extra,
});

const affidavitKinds = [
  kind("affidavit", "The sworn or affirmed affidavit."),
  kind("exhibit", "A document identified as an exhibit in the affidavit."),
];

const affidavitFields: CoverField[] = [
  field("courtFileNumber", "Court file number", true),
  field("registry", "Registry"),
  field("affidavitNumber", "Affidavit number"),
  field("deponent", "Deponent", true),
  field("swornDate", "Date sworn or affirmed", true),
  field("swornPlace", "Place sworn or affirmed"),
];
const generalAffidavitFields = affidavitFields.map((item) => ({
  ...item, required: item.id === "courtFileNumber",
}));

const genericRecordFields: CoverField[] = [
  field("courtName", "Court", true),
  field("courtFileNumber", "Court file number", true),
  field("registry", "Registry"),
  field("recordTitle", "Record title", true),
];

const abkbSeparateTechnical: TechnicalRequirements = {
  ...electronicRecord,
  continuousPageNumbers: false,
  pdfPageLabelsMatch: false,
  pageOne: "first-content",
  bookmarks: "documents",
  hyperlinkedIndex: false,
  maxOutputBytes: 100 * MB,
  separateSourceFiles: true,
};

const abkbFilingSet = ({
  id,
  shortLabel,
  document: documentIdentity,
  variant,
  division,
  role,
  documentKinds,
  sourceIds = ["ab-kb-digital-guidelines", "ab-kb-cpn1"],
  effectiveFrom = "2024-07-02",
  minimumDocuments,
}: {
  id: string;
  shortLabel: string;
  document: [family: string, label: string];
  variant: string;
  division?: string;
  role?: string;
  documentKinds: KindPresentation[];
  sourceIds?: string[];
  effectiveFrom?: string;
  minimumDocuments?: number;
}): ProfilePresentation => ({
  id,
  ...ABKB,
  ...document(...documentIdentity, variant),
  division,
  shortLabel,
  family: "filing-set",
  outputMode: "separate-files",
  role,
  effective: { from: effectiveFrom },
  cover: {
    generated: false,
    title: "File details",
    colourName: "source",
    colourHex: "#FFFFFF",
    fields: [],
  },
  documentKinds,
  technical: abkbSeparateTechnical,
  minimumDocuments,
  sourceIds,
  filenamePattern: "{kind}.pdf",
});

const chambersApplicantKinds = [
  kind("application", "The application to be heard."),
  kind("affidavit", "Each item relied on, with every affidavit and its exhibits kept in one bookmarked PDF."),
  kind("brief", "A short and concise brief where required or permitted."),
  kind("authorities", "Only authorities expected to be used, supplied separately from the application, evidence and brief."),
  kind("proposed-order", "The proposed order required by the applicable digital filing route."),
  kind("proof-service", "Proof of service where required."),
];
const chambersRespondentKinds = [
  kind("responding-affidavit", "Each responding item relied on, with affidavit exhibits kept in the same bookmarked PDF."),
  kind("responding-pleading", "A responding pleading relied on for the application."),
  kind("brief", "A short and concise responding brief where required or permitted."),
  kind("authorities", "Only authorities expected to be used, supplied separately."),
  kind("proposed-order", "An alternate proposed form of order, where useful."),
  kind("proof-service", "Proof of service where required."),
];
const deskApplicationKinds = [
  kind("application-form", "The Application Form used to place the request before the Court."),
  kind("application", "The application or other usual commencement material."),
  kind("supporting-material", "Every supporting item the Court should consider."),
  kind("consent", "Executed consent or other evidence of consent for a consent application."),
  kind("proposed-order", "The proposed form of order in the format required by the filing channel."),
];
const profiles: ProfilePresentation[] = [
  {
    id: "general-affidavit-exhibits",
    ...GENERAL,
    ...document("affidavit-with-exhibits", "Affidavit with exhibits"),
    shortLabel: "Affidavit + exhibits",
    family: "affidavit",
    outputMode: "affidavit-with-exhibits",
    effective: { from: "1970-01-01" },
    cover: { generated: false, title: "Case details", colourName: "source", colourHex: "#FFFFFF", fields: [field("courtName", "Court"), ...generalAffidavitFields] },
    documentKinds: affidavitKinds,
    technical: { ...electronicRecord, pageOne: "first-content", bookmarks: "exhibits", maxOutputBytes: 100 * MB },
    sourceIds: [],
    filenamePattern: "Affidavit-{courtFileNumber}.pdf",
  },
  {
    id: "general-court-record",
    ...GENERAL,
    ...document("court-record", "Court record"),
    shortLabel: "Court record",
    family: "hearing-record",
    outputMode: "combined-record",
    effective: { from: "1970-01-01" },
    cover: whiteCover("COURT RECORD", genericRecordFields),
    documentKinds: [kind("document", "Documents in record order.")],
    technical: { ...electronicRecord, maxOutputBytes: 100 * MB },
    sourceIds: [],
    filenamePattern: "Court-Record-{courtFileNumber}.pdf",
  },
  {
    id: "ab-kb-affidavit-exhibits",
    ...ABKB,
    ...document("affidavit-with-exhibits", "Affidavit with exhibits"),
    shortLabel: "Affidavit + exhibits",
    family: "affidavit",
    outputMode: "affidavit-with-exhibits",
    exhibitCertificate: true,
    effective: { from: "2010-11-01" },
    cover: { generated: false, title: "Affidavit details", colourName: "source", colourHex: "#FFFFFF", fields: affidavitFields },
    documentKinds: affidavitKinds,
    technical: {
      ...electronicRecord,
      pageOne: "first-content",
      bookmarks: "exhibits",
      maxOutputBytes: 100 * MB,
    },
    sourceIds: ["ab-rules-part-13-14", "ab-kb-form-49", "ab-affidavit-exhibit-example", "ab-kb-digital-guidelines"],
    filenamePattern: "Affidavit-{filingParty}-{courtFileNumber}.pdf",
  },
  {
    id: "fc-affidavit-exhibits",
    ...DUAL_FEDERAL,
    ...document("affidavit-with-exhibits", "Affidavit with exhibits"),
    shortLabel: "Affidavit + exhibits",
    family: "affidavit",
    outputMode: "affidavit-with-exhibits",
    exhibitCertificate: true,
    effective: { from: "1998-02-05" },
    cover: { generated: false, title: "Affidavit details", colourName: "source", colourHex: "#FFFFFF", fields: affidavitFields },
    documentKinds: affidavitKinds,
    technical: { ...federalElectronic, pageOne: "first-content", bookmarks: "exhibits" },
    sourceIds: ["fc-rules", "fc-practice-guidelines-2025", "fc-efiling"],
    filenamePattern: "Affidavit-{filingParty}-{courtFileNumber}.pdf",
  },
  abkbFilingSet({
    id: "ab-kb-chambers-justice-applicant-set",
    shortLabel: "Justice chambers — applicant",
    document: ["civil-chambers-filing-set", "Civil chambers filing set"],
    variant: "justice-applicant",
    division: "justice",
    role: "Applicant",
    sourceIds: ["ab-kb-digital-guidelines", "ab-kb-cpn1"],
    documentKinds: chambersApplicantKinds,
  }),
  abkbFilingSet({
    id: "ab-kb-chambers-justice-respondent-set",
    shortLabel: "Justice chambers — respondent",
    document: ["civil-chambers-filing-set", "Civil chambers filing set"],
    variant: "justice-respondent",
    division: "justice",
    role: "Respondent",
    sourceIds: ["ab-kb-digital-guidelines", "ab-kb-cpn1"],
    minimumDocuments: 1,
    documentKinds: chambersRespondentKinds,
  }),
  abkbFilingSet({
    id: "ab-kb-chambers-applications-judge-applicant-set",
    shortLabel: "Applications Judge chambers — applicant",
    document: ["civil-chambers-filing-set", "Civil chambers filing set"],
    variant: "applications-judge-applicant-digital-order",
    division: "applications-judge",
    role: "Applicant",
    effectiveFrom: "2026-09-15",
    sourceIds: ["ab-kb-digital-guidelines", "ab-kb-cpn1", "ab-kb-fds-2026",
      "ab-kb-digital-orders-2026"],
    documentKinds: chambersApplicantKinds,
  }),
  abkbFilingSet({
    id: "ab-kb-chambers-applications-judge-respondent-set",
    shortLabel: "Applications Judge chambers — respondent",
    document: ["civil-chambers-filing-set", "Civil chambers filing set"],
    variant: "applications-judge-respondent-digital-order",
    division: "applications-judge",
    role: "Respondent",
    effectiveFrom: "2026-09-15",
    sourceIds: ["ab-kb-digital-guidelines", "ab-kb-cpn1", "ab-kb-fds-2026",
      "ab-kb-digital-orders-2026"],
    minimumDocuments: 1,
    documentKinds: chambersRespondentKinds,
  }),
  abkbFilingSet({
    id: "ab-kb-desk-justice-application-set",
    shortLabel: "Justice desk application",
    document: ["desk-application", "Desk application"],
    variant: "justice",
    division: "justice",
    role: "Applicant",
    documentKinds: deskApplicationKinds,
  }),
  abkbFilingSet({
    id: "ab-kb-desk-applications-judge-application-set",
    shortLabel: "Applications Judge desk application",
    document: ["desk-application", "Desk application"],
    variant: "applications-judge-digital-order",
    division: "applications-judge",
    role: "Applicant",
    effectiveFrom: "2026-09-15",
    sourceIds: ["ab-kb-digital-guidelines", "ab-kb-cpn1",
      "ab-kb-digital-orders-2026"],
    documentKinds: deskApplicationKinds,
  }),
  abkbFilingSet({
    id: "ab-kb-special-application-applicant-set",
    shortLabel: "Special — applicant",
    document: ["special-application-filing-set", "Special Application filing set"],
    variant: "applicant",
    role: "Applicant",
    sourceIds: ["ab-kb-digital-guidelines", "ab-kb-cpn1", "ab-kb-civil-special-chambers"],
    documentKinds: [
      kind("application", "The application to be heard."),
      kind("evidence", "The completed evidentiary record identified in the booking request."),
      kind("pleading", "The originating pleading and every pleading relied on."),
      kind("brief", "A short, concise summary of relevant facts and the main points of law."),
      kind("authorities", "Only authorities expected to be referred to; a headnote or extract may suffice and relied-on portions are marked."),
      kind("oral-hearing-order", "The filed order granting leave for oral evidence under Rule 6.11(1)(g)."),
      kind("proposed-order", "The applicant’s proposed form of order."),
    ],
  }),
  abkbFilingSet({
    id: "ab-kb-special-application-respondent-set",
    shortLabel: "Special — respondent",
    document: ["special-application-filing-set", "Special Application filing set"],
    variant: "respondent",
    role: "Respondent",
    sourceIds: ["ab-kb-digital-guidelines", "ab-kb-cpn1", "ab-kb-civil-special-chambers"],
    documentKinds: [
      kind("evidence", "Every responding evidentiary item permitted for the Special Application."),
      kind("responding-pleading", "Every responding pleading relied on."),
      kind("brief", "A short, concise response on the relevant facts and main points of law."),
      kind("authorities", "Only authorities expected to be referred to; relied-on portions are marked."),
      kind("proposed-order", "An alternate proposed form of order, where useful."),
    ],
  }),
  abkbFilingSet({
    id: "ab-kb-review-appeal-applicant-set",
    shortLabel: "Review/appeal — applicant",
    document: ["review-appeal-filing-set", "Judicial review or civil appeal set"],
    variant: "applicant",
    role: "Applicant",
    documentKinds: [
      kind("commencement", "The applicable commencement document."),
      kind("record-proceedings", "The tribunal or lower-court record required by the governing enactment or procedural order."),
      kind("affidavit", "Any affidavit permitted by the law governing the review or appeal."),
      kind("brief", "A short, concise brief with pinpoint references to the record under review."),
      kind("authorities", "The supporting authorities or proper extracts."),
      kind("proposed-order", "The proposed form of order."),
    ],
  }),
  abkbFilingSet({
    id: "ab-kb-review-appeal-respondent-set",
    shortLabel: "Review/appeal — respondent",
    document: ["review-appeal-filing-set", "Judicial review or civil appeal set"],
    variant: "respondent",
    role: "Respondent",
    documentKinds: [
      kind("affidavit", "Any responding affidavit permitted by the governing law."),
      kind("brief", "A short, concise brief with pinpoint references to the record under review."),
      kind("authorities", "The supporting authorities or proper extracts."),
      kind("proposed-order", "An alternate proposed form of order, where useful."),
    ],
  }),
  abkbFilingSet({
    id: "ab-kb-commercial-applicant-set",
    shortLabel: "Commercial — applicant",
    document: ["commercial-list-filing-set", "Commercial List filing set"],
    variant: "applicant",
    role: "Applicant",
    documentKinds: [
      kind("booking-letter", "The request identifying the matter, urgency, length, reading time and agreed filing timetable where required."),
      kind("application", "The application to be heard on the Commercial List."),
      kind("evidence", "Every current or previously filed item the applicant intends to rely on."),
      kind("brief", "The applicant’s brief, limited to 35 pages unless directed otherwise."),
      kind("authorities", "Authorities supplied for the hearing with functional open-source links where practical."),
      kind("proposed-order", "The proposed form of order."),
    ],
    sourceIds: ["ab-kb-digital-guidelines", "ab-kb-commercial-pn1"],
  }),
  abkbFilingSet({
    id: "ab-kb-commercial-respondent-set",
    shortLabel: "Commercial — respondent",
    document: ["commercial-list-filing-set", "Commercial List filing set"],
    variant: "respondent",
    role: "Respondent",
    documentKinds: [
      kind("evidence", "Every current or previously filed item the respondent intends to rely on."),
      kind("brief", "The respondent’s brief, limited to 35 pages unless directed otherwise."),
      kind("authorities", "Authorities supplied for the hearing with functional open-source links where practical."),
      kind("proposed-order", "An alternate proposed form of order, where useful."),
    ],
    sourceIds: ["ab-kb-digital-guidelines", "ab-kb-commercial-pn1"],
  }),
  {
    id: "ab-kb-commercial-compendium",
    ...ABKB,
    ...document("commercial-list-compendium", "Commercial List hearing compendium"),
    shortLabel: "Commercial compendium",
    family: "hearing-record",
    outputMode: "combined-record",
    effective: { from: "2024-07-02" },
    cover: whiteCover("COMMERCIAL HEARING COMPENDIUM", [baseCoverFields[0]]),
    documentKinds: [
      kind("document-extract", "A fair extract from an essential document."),
      kind("transcript-extract", "A fair extract from a transcript."),
      kind("prior-order", "A previous order essential to the hearing."),
      kind("authority-extract", "An essential authority extract, with the relied-on portion marked."),
      kind("nonessential", "The compendium should contain only essential material."),
    ],
    technical: { ...electronicRecord, maxOutputBytes: 100 * MB },
    minimumDocuments: 1,
    sourceIds: ["ab-kb-digital-guidelines", "ab-kb-commercial-pn1"],
    filenamePattern: "Commercial-Compendium-{filingParty}-{courtFileNumber}.pdf",
  },
  {
    id: "ab-ca-appeal-record",
    ...ABCA,
    ...document("appeal-record", "Appeal record"),
    shortLabel: "Appeal record",
    family: "appeal",
    outputMode: "combined-record",
    role: "Appellant",
    effective: { from: "2010-11-01" },
    cover: {
      generated: true,
      title: "APPEAL RECORD",
      template: "abca-ap5",
      form: "Form AP-5",
      ruleReference: "Rule 14.87",
      colourName: "red",
      colourHex: "#FF0000",
      fields: appealFields,
    },
    documentKinds: [
      kind("part-1-pleading", "Relevant pleadings in chronological order: the last pre-trial version, any amendment made at trial, and the application if the decision arose from one."),
      kind("part-2-reasons", "Written or transcribed reasons for the decision under appeal and any prior decision that led to it."),
      kind("part-2-order", "The formal judgment, order or decision appealed from."),
      kind("part-2-access-order", "Any order restricting access to the court record."),
      kind("part-2-prior-order", "A prior order relevant to the decision under appeal."),
      kind("part-2-permission", "The order granting permission to appeal, if required."),
      kind("part-2-notice", "The filed notice of appeal and any notice of cross appeal."),
      kind("part-2-service", "Proof of service only where an enactment requires it in the appeal record."),
      kind("part-3-transcript", "A transcript required for the appeal, with its prescribed table of contents."),
      kind("part-3-no-oral-record", "A table-of-contents notation that no oral record can be transcribed."),
      kind("evidence", "Evidence, affidavits and exhibits do not belong in the appeal record; use Extracts of Key Evidence."),
      kind("argument", "Argument, trial briefs and legal authorities are prohibited from the appeal record."),
    ],
    technical: abcaElectronic,
    sourceIds: ["ab-rules-part-13-14", "ab-ca-electronic-format", "ab-ca-filing-hub",
      "ab-ca-appeal-requirements", "ab-ca-appeal-transcripts",
      "ab-ca-consolidated-directions", "ab-ca-sample-record"],
    filenamePattern: "Appeal-Record-{filingParty}-{courtFileNumber}.pdf",
  },
  ...([
    ["appellant", "Appellant", "yellow", "#F4DD76"],
    ["respondent", "Respondent", "pink", "#FFAABF"],
    ["intervener", "Intervener", "blue", "#9FC5DC"],
  ] as const).map(([roleId, role, colourName, colourHex]): ProfilePresentation => ({
    id: `ab-ca-extracts-${roleId}`,
    ...ABCA,
    ...document("extracts-of-key-evidence", "Extracts of key evidence", roleId),
    shortLabel: `${role} extracts`,
    family: "extracts",
    outputMode: "combined-record",
    role,
    effective: { from: "2010-11-01" },
    cover: {
      generated: true,
      title: "EXTRACTS OF KEY EVIDENCE",
      template: "abca-ap5",
      form: "Form AP-5",
      ruleReference: "Rule 14.87",
      colourName,
      colourHex,
      fields: appealFields,
    },
    documentKinds: [
      kind("transcript-extract", "Only testimony or oral material likely to be needed to resolve the appeal."),
      kind("exhibit-extract", "Only the relevant portion of an exhibit already in the official record."),
      kind("record-extract", "Only another item already in the record and likely to be needed."),
      kind("new-evidence", "New evidence cannot be placed in Extracts without leave through the proper procedure."),
      kind("argument", "Argument, briefs and legal authorities are excluded from Extracts."),
    ],
    technical: abcaElectronic,
    minimumDocuments: 1,
    sourceIds: ["ab-rules-part-13-14", "ab-ca-electronic-format", "ab-ca-filing-hub", "ab-ca-sample-extracts"],
    filenamePattern: `Extracts-${role}-{courtFileNumber}.pdf`,
  })),
  {
    id: "ab-ca-condensed-book",
    ...ABCA,
    ...document("condensed-book", "Condensed book"),
    shortLabel: "Condensed book",
    family: "extracts",
    outputMode: "combined-record",
    effective: { from: "2021-02-01" },
    cover: { generated: true, title: "CONDENSED BOOK", template: "abca-ap5", form: "Form AP-5", colourName: "beige", colourHex: "#F5F5DC", fields: appealFields },
    documentKinds: [
      kind("filed-extract", "A concise excerpt from an item already filed in the appeal."),
      kind("new-material", "A condensed book cannot be used to introduce new material or an oral-argument outline."),
    ],
    technical: abcaElectronic,
    sourceIds: ["ab-rules-part-13-14", "ab-ca-electronic-format", "ab-ca-filing-hub", "ab-ca-consolidated-directions", "ab-ca-condensed-books-overview"],
    filenamePattern: "Condensed-Book-{filingParty}-{courtFileNumber}.pdf",
  },
  {
    id: "fc-motion-record-moving",
    ...DUAL_FEDERAL,
    ...document("motion-record", "Motion record", "moving"),
    shortLabel: "Motion record — moving",
    family: "motion",
    outputMode: "combined-record",
    role: "Moving party",
    effective: { from: "2025-12-21" },
    cover: whiteCover("MOTION RECORD", federalMotionFields, { template: "federal-record", ruleReference: "Rule 364" }),
    documentKinds: [
      kind("notice-motion", "The filed notice of motion."),
      kind("moving-evidence", "Every affidavit and other material served by the moving party for use on the motion."),
      kind("transcript-extract", "Only portions of cross-examinations or other oral evidence relied on."),
      kind("written-representations", "Written representations, or a memorandum where Rule 366 applies."),
      kind("other-filed-material", "Other filed material necessary for the motion’s disposition."),
      kind("proof-service", "Proof of service attached for electronic filing and separately bookmarked."),
    ],
    technical: { ...federalElectronic, indexTitle: "INDEX", indexDocumentLabel: "PLEADING" },
    sourceIds: ["fc-rules", "fc-practice-guidelines-2025", "fc-efiling", "fc-sample-motion-record"],
    filenamePattern: "Motion-Record-{filingParty}-{courtFileNumber}.pdf",
  },
  {
    id: "fc-motion-record-responding",
    ...DUAL_FEDERAL,
    ...document("motion-record", "Motion record", "responding"),
    shortLabel: "Motion record — responding",
    family: "motion",
    outputMode: "combined-record",
    role: "Responding party",
    effective: { from: "2025-12-21" },
    cover: whiteCover("MOTION RECORD", federalMotionFields, { template: "federal-record", ruleReference: "Rule 365" }),
    documentKinds: [
      kind("responding-evidence", "Affidavits and other material not already in the moving record."),
      kind("transcript-extract", "Only relied-on portions not already in the moving record."),
      kind("written-representations", "The responding party’s written representations, or memorandum where Rule 366 applies."),
      kind("other-filed-material", "Other necessary material not already in the moving record."),
      kind("proof-service", "Proof of service attached for electronic filing and separately bookmarked."),
      kind("duplicate", "Do not reproduce material that is already in the moving party’s record."),
    ],
    technical: { ...federalElectronic, indexTitle: "INDEX", indexDocumentLabel: "PLEADING" },
    sourceIds: ["fc-rules", "fc-practice-guidelines-2025", "fc-efiling", "fc-sample-motion-record"],
    filenamePattern: "Responding-Motion-Record-{filingParty}-{courtFileNumber}.pdf",
  },
  {
    id: "fc-application-record-applicant",
    ...DUAL_FEDERAL,
    ...document("application-record", "Application record", "applicant"),
    shortLabel: "Application record — applicant",
    family: "application",
    outputMode: "combined-record",
    role: "Applicant",
    effective: { from: "2025-12-21" },
    cover: whiteCover("APPLICANT’S RECORD", [...federalCoverFields, federalApplicationUnder], { template: "federal-record", ruleReference: "Rule 309" }),
    documentKinds: [
      kind("notice-application", "The filed notice of application."),
      kind("decision", "The order in respect of which the application is made, and reasons, if any."),
      kind("supporting-affidavit", "Every supporting affidavit, including its exhibits."),
      kind("applicant-cross-exam", "Transcripts of cross-examinations conducted by the applicant."),
      kind("tribunal-material", "Material transmitted by a tribunal under Rule 318 that will be used."),
      kind("oral-evidence", "Only transcript portions relied on and not already included."),
      kind("physical-exhibit", "A description of any physical exhibit that cannot be reproduced."),
      kind("memorandum", "The applicant’s memorandum of fact and law."),
      kind("proof-service", "Proof of service attached for electronic filing and separately bookmarked."),
    ],
    technical: { ...federalElectronic, indexDate: "required" },
    sourceIds: ["fc-rules", "fc-practice-guidelines-2025", "fc-efiling"],
    filenamePattern: "Applicant-Record-{filingParty}-{courtFileNumber}.pdf",
  },
  {
    id: "fc-application-record-respondent",
    ...DUAL_FEDERAL,
    ...document("application-record", "Application record", "respondent"),
    shortLabel: "Application record — respondent",
    family: "application",
    outputMode: "combined-record",
    role: "Respondent",
    effective: { from: "2025-12-21" },
    cover: whiteCover("RESPONDENT’S RECORD", [...federalCoverFields, federalApplicationUnder], { template: "federal-record", ruleReference: "Rule 310" }),
    documentKinds: [
      kind("supporting-affidavit", "Every respondent affidavit, including exhibits."),
      kind("respondent-cross-exam", "Transcripts of cross-examinations conducted by the respondent."),
      kind("tribunal-material", "Relied-on tribunal material not already in the applicant’s record."),
      kind("oral-evidence", "Only relied-on transcript portions not already included."),
      kind("physical-exhibit", "A description of any physical exhibit that cannot be reproduced."),
      kind("memorandum", "The respondent’s memorandum of fact and law."),
      kind("proof-service", "Proof of service attached for electronic filing and separately bookmarked."),
      kind("duplicate", "Do not duplicate material already in the applicant’s record."),
    ],
    technical: { ...federalElectronic, indexDate: "required" },
    sourceIds: ["fc-rules", "fc-practice-guidelines-2025", "fc-efiling"],
    filenamePattern: "Respondent-Record-{filingParty}-{courtFileNumber}.pdf",
  },
  {
    id: "fca-appeal-book",
    ...FCA,
    ...document("appeal-book", "Appeal book"),
    shortLabel: "Appeal book",
    family: "appeal",
    outputMode: "combined-record",
    role: "Appellant",
    effective: { from: "2025-12-21" },
    cover: { generated: true, title: "APPEAL BOOK", template: "federal-record", form: "General heading and Form 344 certificate", ruleReference: "Rules 343–344", colourName: "grey", colourHex: "#BEC2C6", fields: federalCoverFields },
    documentKinds: [
      kind("notice", "The notice of appeal and any notice of cross appeal."),
      kind("order-reasons", "The signed and entered order appealed from and all reasons, including dissenting reasons."),
      kind("originating-pleading", "The originating document and other pleadings or first-instance documents that define the issues."),
      kind("agreed-material", "Documents, exhibits and transcripts agreed or ordered for inclusion."),
      kind("conduct-order", "Any order made about the conduct of the appeal."),
      kind("other-relevant", "Any other document relevant to the appeal."),
      kind("contents-agreement", "The agreement or order settling appeal-book contents."),
      kind("form-344", "The builder generates the prescribed certificate after the appeal-book contents."),
    ],
    technical: { ...federalElectronic, maxOutputPages: undefined, volumeInstructions: undefined },
    sourceIds: ["fc-rules", "fca-consolidated-direction-2026", "fca-efiling-guide", "fca-example-appeal-book-agreement"],
    filenamePattern: "Appeal-Book-{filingParty}-{courtFileNumber}.pdf",
  },
  {
    id: "fca-condensed-book",
    ...FCA,
    ...document("condensed-book", "Condensed book"),
    shortLabel: "Condensed book",
    family: "extracts",
    outputMode: "combined-record",
    effective: { from: "2021-06-17" },
    cover: whiteCover("CONDENSED BOOK", federalCoverFields, { template: "federal-record", ruleReference: "Rule 348.1" }),
    documentKinds: [
      kind("appeal-book-extract", "An extract from the filed appeal book that will be used in oral argument."),
      kind("authority-extract", "An extract from the filed book of statutes, regulations and authorities that will be used in oral argument."),
      kind("new-material", "Rule 348.1 limits the condensed book to extracts from the two filed books."),
    ],
    technical: { ...federalElectronic, maxOutputPages: undefined, volumeInstructions: undefined },
    minimumDocuments: 1,
    sourceIds: ["fc-rules", "fca-consolidated-direction-2026", "fca-efiling-guide"],
    filenamePattern: "Condensed-Book-{filingParty}-{courtFileNumber}.pdf",
  },
];

const fcaElectronic: TechnicalRequirements = {
  ...federalElectronic,
  maxOutputPages: undefined,
  volumeInstructions: undefined,
};

const federalSeparate: TechnicalRequirements = {
  ...federalElectronic, continuousPageNumbers: false, pdfPageLabelsMatch: false,
  hyperlinkedIndex: false, separateSourceFiles: true,
};
const fcaSeparate: TechnicalRequirements = {
  ...federalSeparate, maxOutputPages: undefined, volumeInstructions: undefined,
};

const additionalFederalProfiles: ProfilePresentation[] = [
  {
    id: "fc-motion-reply", ...FC,
    ...document("motion-record", "Motion record", "reply"),
    shortLabel: "Motion reply — moving party", family: "motion",
    outputMode: "separate-files", role: "Moving party",
    effective: { from: "2025-12-21" },
    cover: { generated: false, title: "File details", colourName: "source", colourHex: "#FFFFFF", fields: [] },
    documentKinds: [kind("written-reply", "The moving party’s written representations in reply under Rule 369(3).")],
    technical: federalSeparate,
    sourceIds: ["fc-rules", "fc-practice-guidelines-2025", "fc-efiling"],
    filenamePattern: "{kind}.pdf",
  },
  {
    id: "fca-motion-reply", ...FCA,
    ...document("motion-record", "Motion record", "reply"),
    shortLabel: "Motion reply — moving party", family: "motion",
    outputMode: "separate-files", role: "Moving party",
    effective: { from: "2025-12-21" },
    cover: { generated: false, title: "File details", colourName: "source", colourHex: "#FFFFFF", fields: [] },
    documentKinds: [kind("written-reply", "The moving party’s written representations in reply under Rule 369.2(3).")],
    technical: fcaSeparate,
    sourceIds: ["fc-rules", "fca-consolidated-direction-2026", "fca-efiling-guide", "fca-example-written-representations"],
    filenamePattern: "{kind}.pdf",
  },
  {
    id: "fc-trial-record",
    ...FC,
    ...document("trial-record", "Trial record"),
    shortLabel: "Trial record",
    family: "hearing-record",
    outputMode: "combined-record",
    role: "Plaintiff or party directed by the Court",
    effective: { from: "1998-02-05" },
    cover: whiteCover("TRIAL RECORD", federalCoverFields, {
      template: "federal-record",
      ruleReference: "Rules 268–269",
    }),
    documentKinds: [
      kind("pleading", "Every filed pleading in the action."),
      kind("particulars", "Any filed particulars supplied in the action."),
      kind("trial-order-direction", "Every order and direction respecting the trial."),
      kind("necessary-filed-document", "Another filed document necessary for the conduct of the trial."),
      kind("unfiled-material", "Rule 269 permits other documents only if they are filed and necessary for the conduct of the trial."),
    ],
    technical: federalElectronic,
    sourceIds: ["fc-rules", "fc-practice-guidelines-2025", "fc-efiling", "fc-action-guide"],
    filenamePattern: "Trial-Record-{filingParty}-{courtFileNumber}.pdf",
  },
  {
    id: "fca-leave-motion-record",
    ...FCA,
    ...document("leave-motion-record", "Motion for leave to appeal record", "moving"),
    shortLabel: "Leave motion record",
    family: "motion",
    outputMode: "combined-record",
    role: "Moving party",
    effective: { from: "2025-12-21" },
    cover: whiteCover("MOTION RECORD", [...federalCoverFields, field("recordSubtitle", "Motion description", true), federalApplicationUnder], { template: "federal-record", ruleReference: "Rules 352–353" }),
    documentKinds: [
      kind("order-reasons", "The order for which leave is sought and every reason, including dissenting reasons."),
      kind("notice-motion", "The notice bringing the motion for leave to appeal."),
      kind("pleadings-material", "The pleadings and any other material necessary for the leave motion."),
      kind("supporting-affidavit", "Facts relied on that do not appear on the Court file."),
      kind("memorandum", "The moving party’s memorandum of fact and law."),
      kind("proof-service", "Proof of service attached at the end of the electronic record and separately bookmarked."),
    ],
    technical: { ...fcaElectronic, indexTitle: "INDEX", indexDocumentLabel: "PLEADING" },
    sourceIds: ["fc-rules", "fca-consolidated-direction-2026", "fca-efiling-guide", "fca-leave-guide"],
    filenamePattern: "FCA-Leave-Motion-Record-{filingParty}-{courtFileNumber}.pdf",
  },
  {
    id: "fca-leave-response-set",
    ...FCA,
    ...document("leave-motion-record", "Motion for leave to appeal record", "responding"),
    shortLabel: "Leave response set",
    family: "filing-set",
    outputMode: "separate-files",
    role: "Respondent",
    effective: { from: "2025-12-21" },
    cover: { generated: false, title: "File details", colourName: "source", colourHex: "#FFFFFF", fields: [] },
    documentKinds: [
      kind("memorandum", "The respondent’s memorandum responding to the leave motion."),
      kind("supporting-affidavit", "Any supporting affidavit served with the memorandum."),
      kind("proof-service", "Proof of service attached to the applicable electronic document and bookmarked."),
    ],
    technical: fcaSeparate,
    sourceIds: ["fc-rules", "fca-consolidated-direction-2026", "fca-efiling-guide", "fca-leave-guide"],
    filenamePattern: "{kind}.pdf",
  },
  {
    id: "fca-leave-reply", ...FCA,
    ...document("leave-motion-record", "Motion for leave to appeal record", "reply"),
    shortLabel: "Leave motion — reply", family: "filing-set",
    outputMode: "separate-files", role: "Moving party",
    effective: { from: "2025-12-21" },
    cover: { generated: false, title: "File details", colourName: "source", colourHex: "#FFFFFF", fields: [] },
    documentKinds: [kind("written-reply", "The moving party’s reply to the respondent’s memorandum under Rule 355.")],
    technical: fcaSeparate,
    sourceIds: ["fc-rules", "fca-consolidated-direction-2026", "fca-efiling-guide", "fca-leave-guide"],
    filenamePattern: "{kind}.pdf",
  },
  {
    id: "fca-informal-motion-letter",
    ...FCA,
    ...document("informal-motion-letter", "Informal motion letter"),
    shortLabel: "Informal motion",
    family: "filing-set",
    outputMode: "separate-files",
    role: "Requesting party",
    effective: { from: "2026-07-09" },
    cover: { generated: false, title: "File details", colourName: "source", colourHex: "#FFFFFF", fields: [] },
    documentKinds: [
      kind("letter-with-service", "One PDF confirming consent or no opposition, relevant facts, submissions, exact relief, and proof of service appended and bookmarked."),
    ],
    technical: fcaSeparate,
    sourceIds: ["fca-consolidated-direction-2026", "fca-efiling-guide"],
    filenamePattern: "{kind}.pdf",
  },
  {
    id: "fca-compendium",
    ...FCA,
    ...document("compendium", "Compendium"),
    shortLabel: "Compendium",
    family: "hearing-record",
    outputMode: "combined-record",
    effective: { from: "2026-07-09" },
    cover: whiteCover("COMPENDIUM", federalCoverFields, { template: "federal-record", ruleReference: "Consolidated Practice Direction, paras 59–64" }),
    documentKinds: [
      kind("memorandum-material", "A document or fair extract referred to in the memorandum of fact and law."),
      kind("new-evidence", "A compendium cannot augment the evidentiary record."),
      kind("new-argument", "A compendium cannot augment the party’s filed argument."),
    ],
    technical: fcaElectronic,
    sourceIds: ["fca-consolidated-direction-2026", "fca-efiling-guide"],
    filenamePattern: "FCA-Compendium-{filingParty}-{courtFileNumber}.pdf",
  },
];

const expandedProfiles = profiles.flatMap((profile): ProfilePresentation[] => {
  if (profile.courtId !== DUAL_FEDERAL.courtId) return [profile];
  const federalCourt: ProfilePresentation = {
    ...profile,
    ...FC,
  };
  const appealCourt: ProfilePresentation = {
    ...profile,
    id: profile.id.replace(/^fc-/u, "fca-"),
    ...FCA,
    cover: profile.cover,
    documentKinds: profile.family === "motion" ? [...profile.documentKinds.map((item) =>
      item.id === "written-representations"
        ? { ...item, description: "Written representations under Rule 369.2." } : item),
      kind("oral-hearing-request", "The separate request and reasons attached at the end of the motion record under Rule 369.2(2).")] : profile.documentKinds,
    technical: {
      ...profile.technical,
      ...(profile.family === "motion" && { indexDocumentLabel: undefined }),
      maxOutputPages: undefined,
      volumeInstructions: undefined,
    },
    sourceIds: [...new Set([...profile.sourceIds.filter((id) =>
      !["fc-efiling", "fc-practice-guidelines-2025", "fc-sample-motion-record"].includes(id)),
    "fca-consolidated-direction-2026", "fca-efiling-guide",
    ...(profile.family === "motion" ? ["fca-example-written-representations"] : [])])],
    filenamePattern: profile.filenamePattern.replace(/^(?=[A-Z])/u, "FCA-"),
  };
  return [federalCourt, appealCourt];
});

const manualDocument = kind("other-document", "Another document selected by the filing lawyer.");

const presentations = [...expandedProfiles, ...additionalFederalProfiles].map((profile) => ({
  ...profile, documentKinds: [...profile.documentKinds, manualDocument],
}));
const contracts = new Map(PROFILE_CONTRACTS.map((profile) => [profile.id, profile]));

const required = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new Error(message);
  return value;
};

export const COURT_PROFILES = presentations.map((profile): CourtProfile => {
  const contract = required(contracts.get(profile.id),
    `Missing Court Record contract for ${profile.id}`);
  const fields = new Map(profile.cover.fields.map((field) => [field.id, field]));
  const kinds = new Map(profile.documentKinds.map((kind) => [kind.id, kind]));
  const partyStyles = contract.partyStyleIds?.map((id) => required(PARTY_STYLE_BY_ID.get(id),
    `Missing Court Record party style ${id}`));
  return {
    ...profile,
    label: contract.label,
    cover: { ...profile.cover, fields: contract.coverFields.map((id) => required(
      fields.get(id), `Missing ${profile.id} cover presentation for ${id}`)),
    ...(partyStyles && { partyStyles }),
    ...(contract.filingGroupId && { filingGroupId: contract.filingGroupId }) },
    ...(contract.oneOf && { oneOf: contract.oneOf }),
    documentKinds: contract.slots.map((slot) => ({ ...slot, description: required(
      kinds.get(slot.id)?.description,
      `Missing ${profile.id} slot presentation for ${slot.id}`) })),
  };
});

if (COURT_PROFILES.length !== PROFILE_CONTRACTS.length) {
  throw new Error("Court Record profile presentations and contracts do not match");
}

export const COURT_PROFILE_BY_ID = new Map(
  COURT_PROFILES.map((profile) => [profile.id, profile]),
);

export function effectiveCourtProfiles(date = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Edmonton",
}).format(new Date())) {
  return COURT_PROFILES.filter(({ effective }) => effective.from <= date &&
    (!effective.to || date <= effective.to));
}

const ABCA_FACTUM_COVERS: Record<string, [string, string]> = {
  Appellant: ["beige", "#F5F5DC"], Respondent: ["green", "#A9D18E"],
  Intervener: ["blue", "#9FC5DC"],
};
export function courtProfileForCover(profile: CourtProfile, cover: CoverValues) {
  if (profile.id !== "ab-ca-condensed-book") return profile;
  const colour = ABCA_FACTUM_COVERS[filingParty(profile, cover)?.group.role ?? "Appellant"];
  return { ...profile, cover: { ...profile.cover,
    colourName: colour[0], colourHex: colour[1] } };
}
