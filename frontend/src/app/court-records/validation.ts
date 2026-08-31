import { indexPageCount } from "./layout";
import { acceptedSourceFormats, sourceFormat } from "./formats";
import { formatBytes } from "@/app/lib/utils";
import { coverPartyGroups, exhibitIndex, filingParty, partyNames } from "./types";
import type {
  ComplianceFinding,
  ComplianceReport,
  CourtProfile,
  CourtRecordReceipt,
  CoverValues,
  RecordEntry,
} from "./types";

const generatedPages = (profile: CourtProfile, entries: RecordEntry[]) => {
  if (profile.outputMode === "separate-files") return 0;
  if (profile.outputMode === "affidavit-with-exhibits") {
    return profile.exhibitCertificate
      ? entries.filter((entry) => entry.kindId === "exhibit").length
      : 0;
  }
  const kinds = new Map(profile.documentKinds.map((kind) => [kind.id, kind]));
  const indexItems = [
    ...entries.map((entry) => ({ group: kinds.get(entry.kindId)?.group })),
    ...profile.documentKinds.filter((kind) => kind.generated).map((kind) => ({ group: kind.group })),
  ];
  const generatedContentPages = profile.documentKinds.filter((kind) => kind.generated).length;
  return (profile.cover.generated ? 1 : 0) +
    indexPageCount(indexItems, profile.technical.indexRowsPerPage) +
    generatedContentPages;
};

const finding = (
  id: string,
  level: ComplianceFinding["level"],
  title: string,
  detail: string,
  extra: Partial<ComplianceFinding> = {},
): ComplianceFinding => ({ id, level, title, detail, ...extra });

export function sortedEntries(profile: CourtProfile, entries: RecordEntry[]) {
  const order = new Map(profile.documentKinds.map((item) => [item.id, item.order]));
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) =>
      (order.get(left.entry.kindId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.entry.kindId) ?? Number.MAX_SAFE_INTEGER) ||
      (profile.family === "affidavit" && left.entry.kindId === "exhibit" &&
        right.entry.kindId === "exhibit"
        ? (exhibitIndex(left.entry.exhibitLabel) + 1 || Number.MAX_SAFE_INTEGER) -
          (exhibitIndex(right.entry.exhibitLabel) + 1 || Number.MAX_SAFE_INTEGER) : 0) ||
      left.index - right.index)
    .map(({ entry }) => entry);
}

export function staleBuildSource(receipt: CourtRecordReceipt, entries: RecordEntry[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return receipt.sources.find((source) => {
    const entry = byId.get(source.entryId);
    if (!entry || entry.inputStatus === "missing" || entry.inputStatus === "changed") return true;
    if ((entry.origin?.kind ?? "device") !== source.origin.kind) return true;
    if (entry.origin?.kind === "library") {
      return entry.origin.documentId !== source.origin.documentId ||
        entry.origin.versionId !== source.origin.versionId ||
        entry.origin.sourceSha256 !== source.origin.sourceSha256;
    }
    return entry.file.name !== source.filename || entry.file.size !== source.byteCount;
  });
}

export function validateCourtRecord({
  profile,
  entries,
  cover,
}: {
  profile: CourtProfile;
  entries: RecordEntry[];
  cover: CoverValues;
}): ComplianceReport {
  const blockers: ComplianceFinding[] = [];
  const review: ComplianceFinding[] = [];
  const passes: ComplianceFinding[] = [];
  const kinds = new Map(profile.documentKinds.map((item) => [item.id, item]));

  const styleId = cover.partyStyleId ?? profile.cover.partyStyles?.[0]?.id;
  for (const coverField of profile.cover.fields.filter((item) => item.required &&
    (!item.partyStyleId || item.partyStyleId === styleId))) {
    if (!cover[coverField.id]?.trim()) {
      blockers.push(finding(
        `cover-${coverField.id}`,
        "blocker",
        `${coverField.label} is required`,
        profile.cover.generated
          ? "Complete this field so the generated cover can identify the proceeding and filing party."
          : "Complete this field so generated certificates and output labels are accurate.",
        { fieldId: coverField.id },
      ));
    }
  }

  if (profile.cover.partyStyles?.length) {
    const groups = coverPartyGroups(profile, cover);
    const style = profile.cover.partyStyles.find((item) => item.id === cover.partyStyleId) ??
      profile.cover.partyStyles[0];
    const requiredGroups = new Set(style.groups.filter((group) => !group.optional ||
      group.id === profile.cover.filingGroupId)
      .map((group) => group.id));
    for (const group of groups.filter((item) => requiredGroups.has(item.id))) {
      if (!partyNames(group)) {
        blockers.push(finding(
          `party-${group.id}`,
          "blocker",
          `${group.role} is required`,
          `Enter at least one ${group.role.toLowerCase()} name.`,
          { fieldId: "partyGroups" },
        ));
      }
    }
    if (!filingParty(profile, cover)) {
      blockers.push(finding(
        "filing-party",
        "blocker",
        "Filing party is required",
        "Enter the party names, then choose who is filing this record.",
        { fieldId: "filingPartyId" },
      ));
    }
  }

  for (const requiredKind of profile.documentKinds.filter((item) => item.requirement === "required")) {
    if (!requiredKind.generated && !entries.some((entry) => entry.kindId === requiredKind.id)) {
      blockers.push(finding(
        `missing-${requiredKind.id}`,
        "blocker",
        `${requiredKind.label} is missing`,
        `Add ${requiredKind.label.toLowerCase()}.`,
      ));
    }
  }

  const usable = entries.filter((entry) => kinds.get(entry.kindId)?.requirement !== "forbidden");
  if (profile.minimumDocuments && usable.length < profile.minimumDocuments) {
    blockers.push(finding(
      "minimum-documents",
      "blocker",
      "Add at least one permitted document",
      "This record cannot be empty.",
    ));
  }

  for (const entry of entries) {
    const documentKind = kinds.get(entry.kindId);
    if (!documentKind) {
      blockers.push(finding(
        `unknown-${entry.id}`,
        "blocker",
        "Choose a document type",
        `${entry.file.name} is not assigned to a document type in this preset.`,
        { entryId: entry.id },
      ));
      continue;
    }
    if (entry.inputStatus === "missing") {
      const nested = entry.binding?.kind === "work-product-output";
      blockers.push(finding(
        `missing-file-${entry.id}`,
        "blocker",
        nested ? "Rebuild the source draft" : "Relink the source file",
        nested
          ? `${entry.file.name} comes from a draft whose current output is unavailable. Rebuild that draft, then refresh this record.`
          : `${entry.file.name} is no longer available to this draft.`,
        { entryId: entry.id },
      ));
      continue;
    }
    if (entry.inputStatus === "changed") {
      review.push(finding(
        `changed-file-${entry.id}`,
        "review",
        "Source file changed",
        `${entry.file.name} has changed since it was last used in this draft.`,
        { entryId: entry.id },
      ));
    }
    if (documentKind.requirement === "forbidden") {
      blockers.push(finding(
        `forbidden-${entry.id}`,
        "blocker",
        `${documentKind.label} is not permitted`,
        `Remove ${entry.file.name} to continue.`,
        { entryId: entry.id },
      ));
    }
    if (entry.descriptionOnly) {
      if (!documentKind.descriptionOnly || !entry.title.trim()) {
        blockers.push(finding(
          `description-${entry.id}`,
          "blocker",
          "Enter a description",
          "Describe the physical exhibit that cannot be reproduced.",
          { entryId: entry.id },
        ));
      }
      continue;
    }
    if (profile.family === "affidavit" && entry.kindId === "exhibit" &&
        !entry.exhibitLabel?.trim()) {
      blockers.push(finding(
        `exhibit-slot-${entry.id}`,
        "blocker",
        "Assign the exhibit file",
        `Choose the exhibit label for ${entry.file.name}.`,
        { entryId: entry.id },
      ));
    }
    if (profile.technical.indexDate === "required" && !entry.date?.trim()) {
      blockers.push(finding(
        `date-${entry.id}`,
        "blocker",
        "Document date is required",
        `Enter the date for ${entry.title || entry.file.name}.`,
        { entryId: entry.id },
      ));
    }
    const format = sourceFormat(entry.file);
    const accepted = acceptedSourceFormats(documentKind);
    if (!format || !accepted.includes(format)) {
      const expected = accepted.length === 2 ? "a PDF or Word (.docx) file" :
        accepted[0] === "docx" ? "a Word (.docx) file" : "a PDF";
      blockers.push(finding(
        `format-${entry.id}`,
        "blocker",
        `Use ${expected}`,
        `${documentKind.label} accepts ${expected}.`,
        { entryId: entry.id },
      ));
    }
    const preparedPdf = format === "pdf" || !!entry.pdfRendition;
    if (profile.outputMode !== "separate-files" && !preparedPdf) {
      blockers.push(finding(
        `rendition-${entry.id}`,
        "blocker",
        "Word conversion is incomplete",
        `${entry.file.name} could not be prepared as a PDF. Try adding it again.`,
        { entryId: entry.id },
      ));
    }
    if (preparedPdf && entry.encrypted === true) {
      blockers.push(finding(
        `security-${entry.id}`,
        "blocker",
        "Remove PDF security",
        `${entry.file.name} is password-protected or restricts access.`,
        { entryId: entry.id },
      ));
    }
    if (preparedPdf && profile.technical.searchable && entry.searchable === false) {
      blockers.push(finding(
        `searchability-${entry.id}`,
        "blocker",
        "OCR is required",
        `${entry.file.name} has no searchable text layer. OCR it before building the filing copy.`,
        { entryId: entry.id },
      ));
    } else if (preparedPdf && profile.technical.searchable && (entry.textlessPageCount ?? 0) > 0) {
      review.push(finding(
        `textless-pages-${entry.id}`,
        "review",
        "Some pages have no searchable text",
        `${entry.file.name} has ${entry.textlessPageCount} page${entry.textlessPageCount === 1 ? "" : "s"} without a detected text layer. Confirm those pages are photographs or other non-text material, or OCR them.`,
        { entryId: entry.id },
      ));
    }
    if (preparedPdf && documentKind.maximumPages && entry.pageCount !== null && entry.pageCount > documentKind.maximumPages) {
      blockers.push(finding(
        `kind-pages-${entry.id}`,
        "blocker",
        `${documentKind.label} exceeds ${documentKind.maximumPages} pages`,
        `${entry.file.name} has ${entry.pageCount} pages.`,
        { entryId: entry.id },
      ));
    }
    if (entry.inspectionError) {
      review.push(finding(
        `inspection-${entry.id}`,
        "review",
        "Document inspection was incomplete",
        `${entry.file.name}: ${entry.inspectionError}`,
        { entryId: entry.id },
      ));
    }
  }

  const paginatedEntries = entries.filter((entry) => !entry.descriptionOnly &&
    (sourceFormat(entry.file) === "pdf" || !!entry.pdfRendition));
  const knownPageCount = paginatedEntries.every((entry) => entry.pageCount !== null);
  const pageCount = knownPageCount
    ? paginatedEntries.reduce((sum, entry) => sum + (entry.pageCount ?? 0), 0) + generatedPages(profile, entries)
    : null;
  const inputBytes = entries.reduce((sum, entry) => sum + (entry.descriptionOnly
    ? 0 : entry.lastSeen?.size ??
      (profile.outputMode === "separate-files" ? entry.file : entry.pdfRendition ?? entry.file).size), 0);
  const limit = profile.technical.maxOutputBytes;
  if (limit) {
    if (profile.outputMode === "separate-files") {
      for (const entry of entries.filter((item) => item.file.size > limit)) {
        blockers.push(finding(
          `size-${entry.id}`,
          "blocker",
          "File exceeds the court limit",
          `${entry.file.name} is ${formatBytes(entry.file.size)}; each file must be no larger than ${formatBytes(limit)}.`,
          { entryId: entry.id },
        ));
      }
    } else if (inputBytes > limit && profile.technical.volumeInstructions) {
      review.push(finding(
        "output-size-split",
        "review",
        "The builder will create filing-sized volumes",
        `The sources total ${formatBytes(inputBytes)} before assembly. The builder will split them under the ${formatBytes(limit)} limit and continue pagination across volumes.`,
      ));
    } else if (inputBytes > limit) {
      blockers.push(finding(
        "output-size",
        "blocker",
        "Record exceeds the court file-size limit",
        `The source files total ${formatBytes(inputBytes)} before assembly; the limit is ${formatBytes(limit)}.`,
      ));
    } else if (inputBytes > limit * 0.9) {
      review.push(finding(
        "output-size-near",
        "review",
        "Record is close to the file-size limit",
        `The source files total ${formatBytes(inputBytes)} before assembly; the finished PDF must stay below ${formatBytes(limit)}.`,
      ));
    }
  }
  if (profile.technical.maxOutputPages && pageCount !== null && pageCount > profile.technical.maxOutputPages) {
    const canSplit = !!profile.technical.volumeInstructions;
    (canSplit ? review : blockers).push(finding(
      "output-pages",
      canSplit ? "review" : "blocker",
      canSplit ? "The builder will split this record into volumes" : "Record exceeds the page limit",
      `The estimated output is ${pageCount} pages; each volume permits ${profile.technical.maxOutputPages}.`,
    ));
  }

  if (entries.length && !blockers.some((item) => item.id.startsWith("missing-"))) {
    passes.push(finding("required-documents", "pass", "Required documents present", "Every unconditionally required document type has been added."));
  }
  if (entries.length && !blockers.some((item) => item.id.startsWith("format-") || item.id.startsWith("security-") || item.id.startsWith("searchability-"))) {
    passes.push(finding("source-technical", "pass", "Source checks passed", "The inspected PDFs meet this preset's searchability and security requirements; permitted Word files remain editable."));
  }

  return {
    ready: blockers.length === 0,
    blockers,
    review,
    passes,
    pageCount,
    inputBytes,
  };
}

export function outputFilename(profile: CourtProfile, cover: CoverValues) {
  const replacements: Record<string, string> = {
    courtFileNumber: cover.courtFileNumber ?? "file",
    filingParty: filingParty(profile, cover)?.party.name ?? "party",
    kind: "Document",
  };
  return profile.filenamePattern.replace(/\{([^}]+)\}/gu, (_match, key: string) =>
    sanitizeFilename(replacements[key] ?? key));
}

function sanitizeFilename(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "") || "untitled";
}
