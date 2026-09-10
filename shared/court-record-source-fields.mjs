import { extractExhibitMentions } from "./court-record-exhibits.mjs";

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const ROLES = ["Applicant", "Petitioner", "Plaintiff", "Appellant", "Claimant",
  "Respondent", "Defendant", "Intervener"];
const NAME_WORDS = 6;
const NAME_WORD = /^(?:[\p{Lu}][\p{L}'’-]{1,29}\.?|[\p{Lu}]\.)$/u;
const NAME_STOP = /^(?:a|an|and|am|are|as|at|be|been|being|by|city|county|declare|declared|do|for|from|had|has|have|hereby|in|is|make|makes|municipality|my|oath|of|on|or|province|region|resides|residing|said|say|says|solemnly|state|swear|swore|sworn|affirm|affirms|affirmed|territory|that|the|these|this|those|to|town|village|was|were|who|with)\.?$/iu;

function sourceDocumentFields(pages) {
  const available = pages.filter((page) => page.trim());
  if (!available.length) return;
  const lines = (value) => value.replace(/\r/gu, "").split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim()).filter(Boolean);
  const coverLines = lines(available[0]);
  const openingLines = lines(available.slice(0, 3).join("\n"));
  const endingLines = lines(available.slice(-3).join("\n"));
  const openingFlat = openingLines.join(" "), endingFlat = endingLines.join(" ");
  const labelled = (aliases, source = openingLines, exact = false) => {
    for (let index = 0; index < source.length; index += 1) {
      const divided = source[index].match(/^(.{2,45}?)(?:\s*[:|]\s*|\s+[\u2013\u2014-]\s+)(.+)$/u);
      if (divided && aliases.some((alias) => sameLabel(divided[1], alias))) {
        return exact ? cleanText(divided[2]) : readable(divided[2]);
      }
      if (aliases.some((alias) => sameLabel(source[index], alias)) && source[index + 1] &&
        !fieldOrSectionLabel(source[index + 1])) {
        return exact ? cleanText(source[index + 1]) : readable(source[index + 1]);
      }
    }
    return "";
  };

  const recordIndex = coverLines.findIndex((line) => /^MOTION RECORD$/iu.test(line));
  const recordSubtitle = [];
  if (recordIndex >= 0) {
    for (const line of coverLines.slice(recordIndex + 1)) {
      if (fieldOrSectionLabel(line) || ROLES.some((role) => sameRole(line, role)) ||
        [...recordSubtitle, line].join(" ").length > 240) break;
      recordSubtitle.push(line);
    }
  }
  const recordHeading = recordIndex < 0 ? "" : [coverLines[recordIndex],
    recordSubtitle.join(" ")].filter(Boolean).join(" — ");
  const number = openingFlat.match(/\b(?:This\s+is\s+the\s+)?(\d{1,3})(?:st|nd|rd|th)?\s+Affidavit\b/iu)?.[1]
    || openingFlat.match(/\bAffidavit\s*(?:(?:No\.?|Number|#)\s*)?[:#-]?\s*(\d{1,3})(?:st|nd|rd|th)?\b/iu)?.[1]
    || labelled(["affidavit number", "affidavit no"]);
  // A deponent is a person's name, so every reading is trimmed to the name it starts with.
  // Scanned affidavits arrive as one flat line per page, where an unbounded read of
  // "Affidavit of ..." or "I, ... of" swallows the whole opening recital.
  let deponent = personName(labelled(["deponent"]));
  deponent ||= firstName(openingFlat, /\bI\s*,?\s+(.{2,120}?)\s*,?\s+(?:of|residing)\b/giu);
  deponent ||= firstName(openingFlat, /\b(?:\d{1,3}(?:st|nd|rd|th)?\s+)?Affidavit(?:\s*(?:No\.?|Number|#)?\s*[:#-]?\s*\d{1,3}(?:st|nd|rd|th)?)?\s+of\s+(.+)/giu);
  const jurat = endingFlat.match(/\b(?:sworn|affirmed)(?:\s+or\s+affirmed)?(?:\s+before\s+me)?\s+at\s+(?:the\s+)?(?:City|Town|Village)?\s*(?:of\s+)?([\p{L}][\p{L} .,'-]{1,70}?)(?=\s+(?:in\s+the\s+Province|this|on)\b)(?:\s+in\s+the\s+Province\s+of\s+([\p{L}][\p{L} .'-]{1,40}?)(?=\s*,?\s+(?:this|on)\b))?/iu);
  const date = `${endingFlat} ${openingFlat}`.match(new RegExp(
    `\\b(?:this|on)\\s+(\\d{1,2})(?:st|nd|rd|th|e)?\\s+(?:day\\s+of\\s+)?(${MONTHS})\\s*,?\\s*(\\d{4})\\b`, "iu"));
  const court = [
    /\bCourt of King['\u2019]s Bench of Alberta\b/iu,
    /\bCourt of Appeal of Alberta\b/iu,
    /\bFederal Court of Appeal\b/iu,
    /\bFederal Court(?: of Canada)?\b/iu,
  ].map((pattern) => openingFlat.match(pattern)?.[0]).find(Boolean) || "";
  const allText = available.join("\n.\n"), exhibitMentions = extractExhibitMentions(allText);
  const exhibits = Object.keys(exhibitMentions);
  const explicitExhibitLabel = allText.replace(/\s+/gu, " ").match(
    /\bThis is Exhibit\s*["\u201c\u201d'\u2018\u2019]?\s*([A-Z]{1,2})\s*["\u201c\u201d'\u2018\u2019]?\s+(?:referred to in|to) the Affidavit\b/iu,
  )?.[1].toUpperCase();
  const officialDate = (verb) => {
    const match = openingFlat.match(new RegExp(
      `\\b${verb}\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+day\\s+of\\s+(${MONTHS})\\s*,?\\s*(\\d{2})\\s*(\\d{2})\\b`, "iu"));
    return match && `${readable(match[2])} ${Number(match[1])}, ${match[3]}${match[4]}`;
  };
  const cover = compact({
    courtName: readable(court),
    courtFileNumber: openingFlat.match(/\bNo\.\s*([A-Z0-9]+-[A-Z0-9./-]{1,30})\b/iu)?.[1]
      || openingFlat.match(/\b(?:Court of Appeal )?File\s+(?:No\.?|Number)\s*:?\s*([A-Z0-9][A-Z0-9./-]{1,30})\b/iu)?.[1]
      || labelled(["court of appeal file number", "court file no", "court file number"]),
    lowerCourtFileNumber: labelled(["trial court file number", "lower court file number"],
      openingLines, true),
    registry: labelled(["registry office", "court registry", "registry", "judicial centre"])
      || readable(openingLines.map((line) => line.match(/^([\p{L}][\p{L} .'-]{1,49})\s+(?:Registry|Judicial Centre)$/iu)?.[1]).find(Boolean) || ""),
    decisionMaker: labelled(["appeal from the decision of", "decision maker appealed from", "decision maker",
      "judge appealed from"], openingLines, true),
    decisionDate: labelled(["decision date", "date of decision", "date of judgment"],
      openingLines, true) || officialDate("Dated"),
    decisionFileDate: labelled(["decision filing date", "date decision filed",
      "date judgment filed"], openingLines, true) || officialDate("Filed"),
    affidavitNumber: number,
    deponent,
    swornDate: date ? `${readable(date[2])} ${Number(date[1])}, ${date[3]}`
      : labelled(["sworn date", "date sworn", "affirmed date"], endingLines),
    swornPlace: placeName([jurat?.[1], jurat?.[2]].map(readable).filter(Boolean).join(", ")
      || labelled(["sworn at", "affirmed at"], endingLines)),
    recordTitle: labelled(["record title", "document title"]),
    counselName: labelled(["counsel", "lawyer", "lawyer or filing person"]),
    counselAddress: labelled(["address for service", "counsel address", "lawyer address"]),
    counselPhone: labelled(["telephone", "phone", "counsel phone"]),
    counselFax: labelled(["fax", "counsel fax"]),
    counselEmail: labelled(["email", "counsel email"]),
    applicationUnder: readable(openingLines.map((line) =>
      line.match(/^APPLICATION UNDER\s+(.+)$/iu)?.[1]).find(Boolean) ||
      labelled(["application under"], openingLines, true)),
  });
  const swornDate = cover.swornDate, readableDeponent = cover.deponent;
  const dateText = `${openingFlat} ${endingFlat}`;
  const dated = !recordHeading && (dateText.match(new RegExp(
    `\\b(?:dated|filed|issued|made)\\b.{0,100}?\\b(\\d{1,2})(?:st|nd|rd|th|e)?\\s+(?:day\\s+of\\s+)?(${MONTHS})\\s*,?\\s*(\\d{4})\\b`, "iu"))
    || dateText.match(new RegExp(
      `\\b(?:date|dated|filed|issued|made)\\s*:?\\s*(${MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})\\b`, "iu")));
  const entryDate = swornDate || cover.decisionDate || cover.decisionFileDate || (dated &&
    (/^\d/u.test(dated[1])
      ? `${readable(dated[2])} ${Number(dated[1])}, ${dated[3]}`
      : `${readable(dated[1])} ${Number(dated[2])}, ${dated[3]}`));
  return {
    cover,
    exhibitLabels: exhibits,
    ...(exhibits.length && { exhibitMentions }),
    ...(explicitExhibitLabel && { explicitExhibitLabel }),
    ...(readableDeponent && swornDate
      ? { entryTitle: `Affidavit of ${readableDeponent}` }
      : (recordHeading || cover.recordTitle) && { entryTitle: recordHeading || cover.recordTitle }),
    ...(entryDate && { entryDate }),
  };
}


const sameLabel = (left, right) => left.toLowerCase().replace(/[^a-z0-9]+/gu, "") ===
  right.toLowerCase().replace(/[^a-z0-9]+/gu, "");
function sameRole(left, right) {
  const clean = (value) => value.toLowerCase().replace(/[^a-z]+/gu, "").replace(/s$/u, "");
  return clean(left) === clean(right);
}
const fieldOrSectionLabel = (value) => /^(?:affidavit (?:number|no)|deponent|court (?:of appeal )?file (?:number|no)|trial court file number|lower court file number|registry(?: office)?|judicial centre|appeal from the decision of|decision (?:maker(?: appealed from)?|date|filing date)|date (?:of decision|of judgment|decision filed|judgment filed|sworn)|judge appealed from|sworn at|affirmed (?:at|date)|record title|document(?: title)?|counsel|lawyer(?: or filing person| for .+)?|address(?: for service)?|(?:counsel |lawyer )?address|telephone|phone|counsel phone|fax|counsel fax|email|counsel email|name|status on appeal|hearing date\b.*|application under\b.*|registrar['\u2019]?s stamp)\s*:?$/iu.test(cleanText(value));
const firstName = (text, pattern) => [...text.matchAll(pattern)]
  .map(([, candidate]) => personName(candidate)).find(Boolean) || "";
// The person's name `value` opens with: capitalised words only, closed by the comma, period
// or label colon that ends a name. Anything longer, or anything that runs into the words of
// a recital, is not a name and is reported as nothing rather than as text.
function personName(value) {
  const name = [];
  for (const raw of cleanText(value).split(" ")) {
    if (!raw || /[^\p{L}'’.,;-]/u.test(raw)) break;
    const word = /^[\p{Lu}]\.$/u.test(raw) ? raw : raw.replace(/[.,;]+$/u, "");
    if (!NAME_WORD.test(word) || NAME_STOP.test(word)) break;
    name.push(word);
    if (word !== raw || name.length > NAME_WORDS) break;
  }
  return name.length <= NAME_WORDS ? name.join(" ") : "";
}
// A jurat place is a municipality, not a sentence.
const placeName = (value) => {
  const text = cleanText(value);
  return !/\d/u.test(text) && text.length <= 60 && text.split(" ").length <= 8 ? text : "";
};
const cleanText = (value = "") => value.replace(/\s+/gu, " ").trim()
  .replace(/^[,;:\s]+|[,;:\s]+$/gu, "");
const readable = cleanText;
const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item));

export { sourceDocumentFields };
