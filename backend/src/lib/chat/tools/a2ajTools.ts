import { MAX_READ_PATTERNS, readPatterns } from "../resourceTools";
import { a2ajLegalSourceProvider } from "../../legalSources/a2aj";
import { parseResourceReference } from "mike/shared/runtime/resourceReferences.mjs";
import { collapseProvisionLabels } from "../../provisionLabels";
import { isEvidenceId, type LegalEvidenceReceipt } from "../legalEvidence";
import { trimmedText } from "../../value";

export type A2AJReferenceDirection = "none" | "inbound" | "outbound" | "both";

function activityText(value: unknown, maximum: number) {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return !text ? undefined : text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1).trimEnd()}…`;
}
const SOURCE_LABELS: Record<string, string> = {
  a2aj: "A2AJ", courtlistener: "CourtListener", "courtlistener-opinion": "CourtListener",
  journal: "the journal corpus", hansard: "Hansard", tna: "The National Archives",
  "govuk-et": "GOV.UK", govinfo: "GovInfo", pdf: "the source PDF",
};

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

function activityLocatorLabel(label: string, kind?: string) {
  const value = label
    .replace(/^\[\s*[a-z]+(?:\s+|=)([^\]]+)\s*\]$/iu, "$1")
    .replace(/^[a-z]+=/iu, "").trim()
    // A receipt's section label is "sec" and the label the source prints: "sec11(1)", "secSchedule 1".
    .replace(/^sec(?=\p{Lu})/u, "");
  const prefix = kind === "paragraph" ? /^(?:paragraphs?|paras?|par)\.?\s*/iu
    : kind === "section" ? /^(?:sections?|secs?|ss?|s)(?![a-z])\.?\s*/iu
      : kind === "page" ? /^(?:pages?|pp?)\.?[\s._=-]*/iu
        : kind === "footnote" ? /^(?:footnotes?|notes?|nn?|fn)\.?[\s._=-]*/iu
          : null;
  return prefix
    ? value.replace(prefix, "")
      .replace(new RegExp(`([–—-])${prefix.source.slice(1)}`, "giu"), "$1")
    : value;
}

function activityLocatorNoun(kind: string, plural: boolean) {
  if (kind === "paragraph") return plural ? "paras" : "para";
  if (kind === "section") return plural ? "ss" : "s";
  return plural ? `${kind}s` : kind;
}

/** A place named as the reader would: "s 11(1)", "paras 4–6", but "Schedule 1", which names its own kind. */
function locatorPhrase(kind: string, scope: string, plural: boolean) {
  return /^\p{Lu}\p{Ll}{2,}/u.test(scope) ? scope : `${activityLocatorNoun(kind, plural)} ${scope}`;
}

/** A structural handle ("sec96", "par12", "page3") as the place it names. */
function handlePhrase(handle: string) {
  const match = /^(?:(sec)(?=[\d\p{Lu}])|(par|page)(?=\d))/u.exec(handle), kind = match?.[1] ?? match?.[2];
  const named = kind === "sec" ? "section" : kind === "par" ? "paragraph" : kind;
  return named ? locatorPhrase(named, activityLocatorLabel(handle, named), false) : `section ${handle}`;
}

/** Source identity and requested operations are stable before metadata arrives. */
export function assistantReadActivity(args: Record<string, unknown>) {
  const resource = trimmedText(args.file_path), reference = parseResourceReference(resource);
  if (resource.length > 8_192 || reference?.kind !== "source" && reference?.kind !== "document") return undefined;
  const queries = readPatterns(args).slice(0, MAX_READ_PATTERNS).map(query => query.slice(0, 256));
  if (queries.length) return { resource, queries };
  const kind = trimmedText(args.locator_kind), first = activityLocatorLabel(trimmedText(args.locator), kind),
    last = activityLocatorLabel(trimmedText(args.end_locator), kind);
  const section = activityText(args.section, 100);
  const range = first ? locatorPhrase(kind, `${first}${last && last !== first ? `–${last}` : ""}`, !!last && last !== first)
    : args.page ? `page ${args.page}` : section ? handlePhrase(section)
    : args.offset ? `from line ${args.offset}` : args.start_char != null ? `from character ${args.start_char}` : "";
  return { resource, ...(range && { ranges: [range] }) };
}

export function assistantToolActivityLabel(
  name: string,
  args: Record<string, unknown>,
  sourceName?: string,
): string | null | undefined {
  sourceName = trimmedText(sourceName) || undefined;
  if (name === "load_tools") {
    const names = Array.isArray(args.names)
      ? args.names.filter((value): value is string => typeof value === "string").slice(0, 3)
      : [];
    return names.length ? `Loading ${names.join(", ")}` : "Loading requested tools";
  }
  if (name === "Glob") return null;
  if (name === "Grep") {
    const query = activityText(args.pattern, 80);
    const path = trimmedText(args.path);
    const resource = parseResourceReference(path);
    const scope = sourceName ?? (resource?.kind === "source"
      ? SOURCE_LABELS[resource.provider] ?? "the selected source"
      : resource ? `the selected ${resource.kind}`
      : UUID.test(path) ? "the selected document"
      : path ? `${activityText(path, 80)} in your Library` : "all documents in your Library");
    return query ? `Searching ${scope} for “${query}”` : `Searching ${scope}`;
  }
  if (name === "Read") {
    const file = trimmedText(args.file_path);
    // A bare number is an index the model mistook for a file, not a document:
    // "Reading lines 1-5 of 11" names nothing the reader can recognise.
    if (!file || file.startsWith(".mike/") || /^\d+$/u.test(file)) return null;
    // A reader's ID ends in the slot the Agents panel names it by ("Agent 2").
    const agent = (value: unknown) => {
      const slot = typeof value === "string" ? /:(\d+)$/u.exec(value)?.[1] : undefined;
      return slot ? `Agent ${slot}` : undefined;
    };
    const later = Number.isInteger(args.offset) && Number(args.offset) > 1 ? ` from item ${args.offset}` : "";
    if (file === "readers") {
      const reader = agent(args.section);
      return reader ? `Reading ${reader}’s findings` : `Listing reading agents${later}`;
    }
    const query = activityText(args.pattern, 80);
    if (file === "findings") return query ? `Searching saved findings for “${query}”` : `Reading saved findings${later}`;
    const inventory = file === "evidence" ? "saved evidence" : file === "queries"
      ? "previous searches" : file === "selection" ? "the research selection" : null;
    if (inventory) {
      const owner = file === "queries" ? agent(args.section) : undefined;
      return query ? `Searching ${inventory}${owner ? ` of ${owner}` : ""} for “${query}”`
        : `Listing ${inventory}${owner ? ` of ${owner}` : ""}${later}`;
    }
    if (/^e_/u.test(file)) return "Reusing saved evidence";
    if (/^q_/u.test(file)) return "Reading a saved search";
    const resource = parseResourceReference(file);
    let title = sourceName;
    if (resource?.kind === "source") {
      if (!title && resource.provider === "a2aj") {
        try {
          const [citation] = JSON.parse(resource.sourceId) as unknown[];
          if (typeof citation === "string" && citation.trim()) title = citation;
        } catch {}
      }
      title ??= SOURCE_LABELS[resource.provider] ?? resource.provider;
    } else if (resource || UUID.test(file)) {
      title ??= `the selected ${resource?.kind ?? "document"}`;
    } else if (/^[eq]_[A-Za-z0-9_-]+$/u.test(file) || isEvidenceId(file)) {
      title ??= file.startsWith("q_") ? "the saved search" : "the saved evidence";
    } else {
      title ??= activityText(file.replace(/^.*[\\/]/u, ""), 80);
    }
    const pattern = activityText(args.pattern, 80);
    if (pattern) return `Searching ${title} for “${pattern}”`;
    const kind = activityText(args.locator_kind, 24);
    const locator = activityText(args.locator, 80);
    const end = activityText(args.end_locator, 80);
    if (kind && locator) {
      const first = activityLocatorLabel(locator, kind);
      const last = end ? activityLocatorLabel(end, kind) : undefined;
      const range = last && last !== first ? `${first}–${last}` : first;
      const scope = collapseProvisionLabels([range], kind) ?? [range];
      const plural = scope.length > 1 || /[–—-]/u.test(scope[0]) &&
        !(kind === "section" && /[–—-]\(/u.test(scope[0]));
      return `Reading ${locatorPhrase(kind, scope.join(", "), plural)} of ${title}`;
    }
    const page = Number.isInteger(args.page) && Number(args.page) > 0
      ? Number(args.page) : 0;
    if (page) return `Reading page ${page} of ${title}`;
    const section = activityText(args.section, 100);
    if (section) return `Reading ${handlePhrase(section)} of ${title}`;
    const handle = activityText(args.handle, 80);
    if (handle) return `Reading a saved passage of ${title}`;
    const offset = Number.isInteger(args.offset) && Number(args.offset) > 0
      ? Number(args.offset) : 0;
    const limit = Number.isInteger(args.limit) && Number(args.limit) > 0
      ? Number(args.limit) : 0;
    if (offset || limit) {
      const start = offset || 1;
      return `Reading lines ${start}–${start + (limit || 2000) - 1} of ${title}`;
    }
    const startChar = Number.isInteger(args.start_char) && Number(args.start_char) >= 0
      ? Number(args.start_char) : null;
    if (startChar !== null) return `Reading from character ${startChar} of ${title}`;
    if (resource?.kind === "source") {
      return resource.provider === "a2aj" || sourceName
        ? `Reading ${title} from ${SOURCE_LABELS[resource.provider] ?? resource.provider}`
        : `Reading a source from ${SOURCE_LABELS[resource.provider] ?? resource.provider}`;
    }
    return sourceName || (resource && resource.kind !== "document") || /^[eq]_[A-Za-z0-9_-]+$/u.test(file)
      ? `Reading ${title}` : `Reading ${title} from your Library`;
  }
  if (name === "search_sources") {
    const query = activityText(args.query, 160);
    const kinds = Array.isArray(args.source_types)
      ? args.source_types.filter((value): value is string => typeof value === "string")
      : [];
    const rawJurisdiction = activityText(args.jurisdiction, 40);
    const jurisdiction = rawJurisdiction &&
        /^(?:ca|canada|canadian)$/iu.test(rawJurisdiction)
      ? "Canadian"
      : rawJurisdiction && /^(?:us|usa|united states)$/iu.test(rawJurisdiction)
        ? "US"
        : rawJurisdiction;
    const collection = activityText(args.collection, 40)?.toUpperCase();
    const suffix = collection?.match(/-([A-Z]{2,3})$/u)?.[1];
    const province = suffix === "YK" ? "YT" : suffix;
    // A court's collection is named by its code (NSPC): two courts of one province must not read as one search.
    const place = province && province in a2ajLegalSourceProvider.jurisdictions
      ? a2ajLegalSourceProvider.jurisdictions[province as keyof typeof a2ajLegalSourceProvider.jurisdictions]
      : collection ?? jurisdiction;
    // Searches split by date read alike unless the label names the range.
    const day = (value: unknown) => /^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? "")) ? String(value) : undefined;
    const from = day(args.date_from), to = day(args.date_to);
    const span = from && to
      ? from.endsWith("-01-01") && to.endsWith("-12-31")
        ? from.slice(0, 4) === to.slice(0, 4) ? ` in ${from.slice(0, 4)}` : ` from ${from.slice(0, 4)} to ${to.slice(0, 4)}`
        : ` from ${from} to ${to}`
      : from ? ` from ${from}` : to ? ` up to ${to}` : "";
    const labels: Record<string, string> = {
      case: "cases",
      legislation: "legislation",
      journal: "journal articles",
      hansard: "Hansard",
    };
    const scope = [place, kinds.map((kind) => labels[kind] ?? kind).join(" and ")]
      .filter(Boolean).join(" ") || "legal sources";
    return query ? `Searching ${scope} for “${query}”${span}` : `Searching ${scope}${span}`;
  }
  if (name === "Edit") return "Editing the selected document";
  if (name === "Write") return `Creating ${activityText(args.filename, 80) ?? "a document"}`;
  if (name === "note_up") return `Noting up ${activityText(args.citation, 80) ?? "a decision"}`;
  if (name === "edit_docx_advanced") return "Applying tracked document edits";
  if (name === "compare_versions") return "Comparing document versions";
  if (name === "submit_grounded_answer") return "Verifying cited findings";
  return undefined;
}

export function assistantReadEvidenceActivityLabel(
  evidence: readonly LegalEvidenceReceipt[],
  sourceName?: string,
  args: Record<string, unknown> = {},
) {
  const verb = /^e_/u.test(trimmedText(args.file_path)) ? "Reusing" : "Reading";
  const read = evidence.filter(({ scope, span_text }) => scope === "passage" && span_text);
  // "document" is the receipt's no-locator fallback, not a place in the document:
  // naming it reads as a structure the read never used ("document through s 4(2)(b)").
  const passages = read.filter(({ locator }) => locator.kind !== "document");
  const first = passages[0];
  const last = passages.at(-1);
  const title = sourceName ?? read[0]?.name ?? read[0]?.citation;
  if (!first || !last) return title ? `${verb} ${title}` : null;
  const pattern = activityText(args.pattern, 80);
  if (pattern) return `Searching ${title} for “${pattern}”`;
  const labels = [...new Set(passages.map(({ locator }) =>
    activityLocatorLabel(locator.label, locator.kind)))];
  const firstLabel = activityText(labels[0], 80);
  const lastLabel = activityText(labels.at(-1), 80);
  if (!firstLabel || !lastLabel) return `${verb} ${title}`;
  if (first.locator.kind !== last.locator.kind) {
    return `${verb} ${locatorPhrase(first.locator.kind, firstLabel, false)} through ${locatorPhrase(last.locator.kind, lastLabel, false)} of ${title}`;
  }
  const groups = collapseProvisionLabels(labels, first.locator.kind);
  const requested = first.locator.kind === "section" && args.locator_kind === "section" &&
    typeof args.locator === "string" && !args.end_locator
    ? collapseProvisionLabels([args.locator], "section")?.[0] : undefined;
  // Describe the requested section without changing its separately addressable receipts.
  const scope = requested && labels.every(label => label === requested || label.startsWith(`${requested}(`))
    ? [requested] : groups ?? labels;
  const plural = scope.length > 1 || /[–—-]/u.test(scope[0]) &&
    !(first.locator.kind === "section" && /[–—-]\(/u.test(scope[0]));
  return `${verb} ${locatorPhrase(first.locator.kind, scope.join(", "), plural)} of ${title}`;
}
