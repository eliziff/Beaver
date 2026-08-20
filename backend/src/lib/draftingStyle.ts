import { jsonRecord as object } from "./value";

const DRAFTING_STYLE_VERSION = 1 as const;

const DRAFTING_DOCUMENT_TYPES = [
  "memo",
  "factum",
  "letter",
  "other",
] as const;
export type DraftingDocumentType = (typeof DRAFTING_DOCUMENT_TYPES)[number];

const CITATION_PLACEMENTS = [
  "footnotes",
  "inline",
  "after-paragraph",
  "none",
] as const;
export type CitationPlacement = (typeof CITATION_PLACEMENTS)[number];
export type HeadingNumbering = boolean | "auto";

export type DraftingDocumentStyle = {
  citationPlacement: CitationPlacement;
  citationHyperlinks: boolean;
  numberHeadings: HeadingNumbering;
};

export type DraftingStyleSettings = {
  version: typeof DRAFTING_STYLE_VERSION;
  documents: Record<DraftingDocumentType, DraftingDocumentStyle>;
  memoHeader: {
    to: string;
    from: string;
  };
};

export const DEFAULT_DRAFTING_STYLE: DraftingStyleSettings = {
  version: DRAFTING_STYLE_VERSION,
  documents: {
    memo: { citationPlacement: "footnotes", citationHyperlinks: true, numberHeadings: false },
    factum: { citationPlacement: "inline", citationHyperlinks: true, numberHeadings: true },
    letter: { citationPlacement: "footnotes", citationHyperlinks: true, numberHeadings: false },
    other: { citationPlacement: "inline", citationHyperlinks: true, numberHeadings: "auto" },
  },
  memoHeader: { to: "File", from: "AI Assistant" },
};

function oneLine(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized && normalized.length <= 200 ? normalized : fallback;
}

function citationPlacement(
  value: unknown,
  documentType: DraftingDocumentType,
  fallback: CitationPlacement,
) {
  const placement = CITATION_PLACEMENTS.includes(value as CitationPlacement)
    ? value as CitationPlacement
    : fallback;
  return placement === "after-paragraph" && documentType !== "factum"
    ? fallback
    : placement;
}

function headingNumbering(value: unknown, fallback: HeadingNumbering) {
  return value === true || value === false || value === "auto"
    ? value
    : fallback;
}

export function normalizeDraftingStyleSettings(
  value: unknown,
): DraftingStyleSettings {
  const root = object(value);
  const documents = object(root?.documents);
  const memoHeader = object(root?.memoHeader);
  return {
    version: DRAFTING_STYLE_VERSION,
    documents: Object.fromEntries(
      DRAFTING_DOCUMENT_TYPES.map((documentType) => {
        const raw = object(documents?.[documentType]);
        const fallback = DEFAULT_DRAFTING_STYLE.documents[documentType];
        return [
          documentType,
          {
            citationPlacement: citationPlacement(
              raw?.citationPlacement,
              documentType,
              fallback.citationPlacement,
            ),
            citationHyperlinks: typeof raw?.citationHyperlinks === "boolean"
              ? raw.citationHyperlinks
              : fallback.citationHyperlinks,
            numberHeadings: headingNumbering(
              raw?.numberHeadings,
              fallback.numberHeadings,
            ),
          },
        ];
      }),
    ) as DraftingStyleSettings["documents"],
    memoHeader: {
      to: oneLine(memoHeader?.to, DEFAULT_DRAFTING_STYLE.memoHeader.to),
      from: oneLine(memoHeader?.from, DEFAULT_DRAFTING_STYLE.memoHeader.from),
    },
  };
}

export type ResolvedDraftingOptions = {
  documentType: DraftingDocumentType;
  citationPlacement: CitationPlacement;
  citationHyperlinks: boolean;
  numberHeadings: HeadingNumbering;
  memoHeader?: {
    to: string;
    from: string;
    date?: string;
  };
};

export function resolveDraftingOptions(
  raw: Record<string, unknown>,
  settings: DraftingStyleSettings,
): ResolvedDraftingOptions {
  const documentType = raw.document_type === undefined
    ? "other"
    : DRAFTING_DOCUMENT_TYPES.includes(raw.document_type as DraftingDocumentType)
      ? raw.document_type as DraftingDocumentType
      : null;
  if (!documentType) throw new Error("DOCX document_type is invalid.");

  const saved = settings.documents[documentType];
  const explicitPlacement = raw.citation_style;
  if (
    explicitPlacement !== undefined &&
    !CITATION_PLACEMENTS.includes(explicitPlacement as CitationPlacement)
  ) {
    throw new Error("DOCX citation_style is invalid.");
  }
  const placement = explicitPlacement as CitationPlacement | undefined;
  if (placement === "after-paragraph" && documentType !== "factum") {
    throw new Error("after-paragraph citations are available only for factums.");
  }
  if (
    raw.number_headings !== undefined &&
    typeof raw.number_headings !== "boolean"
  ) {
    throw new Error("DOCX number_headings must be true or false.");
  }
  if (
    raw.citation_hyperlinks !== undefined &&
    typeof raw.citation_hyperlinks !== "boolean"
  ) {
    throw new Error("DOCX citation_hyperlinks must be true or false.");
  }

  let memoHeader: ResolvedDraftingOptions["memoHeader"];
  if (raw.memo_header !== undefined) {
    if (documentType !== "memo") {
      throw new Error("memo_header is available only for memos.");
    }
    const custom = object(raw.memo_header);
    if (
      !custom ||
      Object.keys(custom).some((key) => !["to", "from", "date"].includes(key))
    ) {
      throw new Error("DOCX memo_header is invalid.");
    }
    for (const key of ["to", "from", "date"] as const) {
      if (
        custom[key] !== undefined &&
        (typeof custom[key] !== "string" ||
          !custom[key].trim() ||
          custom[key].length > 200 ||
          /[\r\n]/u.test(custom[key]))
      ) {
        throw new Error(`DOCX memo_header.${key} is invalid.`);
      }
    }
    memoHeader = {
      to: oneLine(custom.to, settings.memoHeader.to),
      from: oneLine(custom.from, settings.memoHeader.from),
      ...(typeof custom.date === "string"
        ? { date: oneLine(custom.date, "") }
        : {}),
    };
  } else if (documentType === "memo") {
    memoHeader = { ...settings.memoHeader };
  }

  return {
    documentType,
    citationPlacement: placement ?? saved.citationPlacement,
    citationHyperlinks: typeof raw.citation_hyperlinks === "boolean"
      ? raw.citation_hyperlinks
      : saved.citationHyperlinks,
    numberHeadings:
      typeof raw.number_headings === "boolean"
        ? raw.number_headings
        : saved.numberHeadings,
    ...(memoHeader ? { memoHeader } : {}),
  };
}
