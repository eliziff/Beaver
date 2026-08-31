import type { SourceDocumentFields } from "./types";

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";

export function affidavitSourceFields(pages: string[]): SourceDocumentFields | undefined {
  const available = pages.filter((page) => page.trim());
  if (!available.length) return;
  const opening = available.slice(0, 3).join("\n").replace(/\r/gu, "");
  const ending = available.slice(-3).join("\n").replace(/\r/gu, "");
  const lines = (value: string) => value.split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim()).filter(Boolean);
  const openingLines = lines(opening), endingLines = lines(ending);
  const openingFlat = openingLines.join(" "), endingFlat = endingLines.join(" ");
  const labelled = (aliases: string[], source = openingLines) => {
    for (let index = 0; index < source.length; index += 1) {
      const divided = source[index].match(/^(.{2,35}?)(?:\s*[:|]\s*|\s+[–—-]\s+)(.+)$/u);
      if (divided && aliases.some((alias) => sameLabel(divided[1], alias))) return readable(divided[2]);
      if (aliases.some((alias) => sameLabel(source[index], alias)) && source[index + 1]) {
        return readable(source[index + 1]);
      }
    }
    return "";
  };
  const party = (roles: string[]) => openingLines.flatMap((line, index) =>
    roles.some((role) => line.trim().toLowerCase() === role) && index
      ? [readable(openingLines[index - 1])] : [])[0] || labelled(roles);
  const firstRole = ["applicant", "petitioner", "plaintiff", "appellant", "claimant"]
    .find((role) => party([role]));
  const first = firstRole ? party([firstRole]) : "";
  const second = party(["respondent", "defendant"]);
  const number = openingFlat.match(/\b(?:This\s+is\s+the\s+)?(\d{1,3})(?:st|nd|rd|th)?\s+Affidavit\b/iu)?.[1]
    || openingFlat.match(/\bAffidavit\s*(?:(?:No\.?|Number|#)\s*)?[:#-]?\s*(\d{1,3})(?:st|nd|rd|th)?\b/iu)?.[1]
    || labelled(["affidavit number", "affidavit no"]);
  let deponent = labelled(["deponent"]);
  deponent ||= openingLines.map((line) => line.match(
    /^(?:(?:This\s+is\s+the\s+)?\d+(?:st|nd|rd|th)?\s+Affidavit|Affidavit(?:\s*(?:(?:No\.?|Number|#)\s*)?[:#-]?\s*\d+(?:st|nd|rd|th)?)?)\s+of\s+(.+)$/iu,
  )?.[1]).find(Boolean) || "";
  deponent ||= openingFlat.match(/\b(?:\d+(?:st|nd|rd|th)?\s+)?Affidavit(?:\s*(?:(?:No\.?|Number|#)\s*)?[:#-]?\s*\d+)?\s+of\s+([\p{L}][\p{L} .'-]{1,119}?)(?=\s+(?:in\s+this\s+case|I\b|sworn\b|affirmed\b|the\s+deponent\b)|$)/iu)?.[1] || "";
  deponent ||= openingFlat.match(/\bI,\s*(.+?)(?=\s*,?\s+(?:of|residing)\b)/iu)?.[1] || "";
  const jurat = endingFlat.match(/\b(?:sworn|affirmed)(?:\s+or\s+affirmed)?(?:\s+before\s+me)?\s+at\s+(?:the\s+)?(?:City|Town|Village)?\s*(?:of\s+)?([\p{L}][\p{L} .,'-]{1,70}?)(?=\s+(?:in\s+the\s+Province|this|on)\b)/iu);
  const date = `${endingFlat} ${openingFlat}`.match(new RegExp(
    `\\b(?:this|on)\\s+(\\d{1,2})(?:st|nd|rd|th|e)?\\s+(?:day\\s+of\\s+)?(${MONTHS})\\s*,?\\s*(\\d{4})\\b`, "iu"));
  const court = [
    /\bCourt of King['’]s Bench of Alberta\b/iu,
    /\bCourt of Appeal of Alberta\b/iu,
    /\bFederal Court of Appeal\b/iu,
    /\bFederal Court(?: of Canada)?\b/iu,
  ].map((pattern) => openingFlat.match(pattern)?.[0]).find(Boolean) || "";
  const exhibits = exhibitLabels(available.join("\n"));
  const explicitExhibitLabel = available.join(" ").match(
    /\bThis is Exhibit\s*["“”'‘’]?\s*([A-Z]{1,2})\s*["“”'‘’]?\s+(?:referred to in|to) the Affidavit\b/iu,
  )?.[1].toUpperCase();
  const cover = compact({
    courtName: readable(court),
    courtFileNumber: openingFlat.match(/\bCourt\s+File\s+(?:No\.?|Number)\s*:?\s*([A-Z0-9][A-Z0-9./-]{1,30})\b/iu)?.[1]
      || labelled(["court file no", "court file number"]),
    registry: labelled(["court registry", "registry", "judicial centre"])
      || readable(openingLines.map((line) => line.match(/^([\p{L}][\p{L} .'-]{1,49})\s+(?:Registry|Judicial Centre)$/iu)?.[1]).find(Boolean) || ""),
    affidavitNumber: number,
    deponent: readable(deponent),
    swornDate: date ? `${readable(date[2])} ${Number(date[1])}, ${date[3]}` : labelled(["sworn date", "date sworn", "affirmed date"], endingLines),
    swornPlace: readable(jurat?.[1] || labelled(["sworn at", "affirmed at"], endingLines)),
    recordTitle: labelled(["record title", "document title"]),
    counselName: labelled(["counsel", "lawyer", "lawyer or filing person"]),
    counselAddress: labelled(["address for service", "counsel address", "lawyer address"]),
    counselPhone: labelled(["telephone", "phone", "counsel phone"]),
    counselFax: labelled(["fax", "counsel fax"]),
    counselEmail: labelled(["email", "counsel email"]),
  });
  const swornDate = cover.swornDate;
  const readableDeponent = cover.deponent;
  return {
    cover,
    ...(firstRole ? { partyStyleId: firstRole === "plaintiff" ? "action" : firstRole === "appellant" ? "appeal" : "application" } : {}),
    ...(first || second ? { parties: { ...(first ? { first } : {}), ...(second ? { second } : {}) } } : {}),
    exhibitLabels: exhibits,
    ...(explicitExhibitLabel ? { explicitExhibitLabel } : {}),
    ...(readableDeponent && swornDate ? { entryTitle: `Affidavit of ${readableDeponent}` } : {}),
    ...(swornDate ? { entryDate: swornDate } : {}),
  };
}

function exhibitLabels(text: string) {
  const labels: string[] = [];
  const flat = text.replace(/\s+/gu, " ");
  for (const match of flat.matchAll(/\bExhibit\s*["“”'‘’]?\s*([A-Z]{1,2})\s*["“”'‘’]?\b/giu)) {
    const start = Math.max(flat.lastIndexOf(".", match.index - 1), flat.lastIndexOf(";", match.index - 1)) + 1;
    const stop = flat.indexOf(".", match.index + match[0].length);
    const context = flat.slice(start, stop < 0 ? flat.length : stop + 1).trim();
    const label = match[1].toUpperCase();
    if (!/This is Exhibit\b.{0,100}\b(?:referred to in|to) the Affidavit/iu.test(context) && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

function sameLabel(left: string, right: string) {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  return clean(left) === clean(right);
}

function readable(value = "") {
  const clean = value.replace(/\s+/gu, " ").trim().replace(/^[,;:\s]+|[,;:\s]+$/gu, "");
  return clean && clean === clean.toUpperCase()
    ? clean.toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
      .replace(/['’]S\b/gu, "'s")
      .replace(/\b(?:Of|For|The|And)\b/gu, (word) => word.toLowerCase())
    : clean;
}

function compact<T extends Record<string, string | undefined>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item)) as Partial<T>;
}
