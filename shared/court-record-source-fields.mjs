import { extractExhibitMentions } from "./court-record-exhibits.mjs";

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const ROLES = ["Applicant", "Petitioner", "Plaintiff", "Appellant", "Claimant",
  "Respondent", "Defendant", "Intervener"];

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
  const partyNames = (role) => {
    const matches = (line) => role === "Intervener"
      ? /^interven(?:er|or)s?\s*:?$/iu.test(line) : sameRole(line, role);
    const boundary = (line) => {
      const text = line.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      return ROLES.some((candidate) => sameRole(text, candidate)) ||
        /^(?:and|between|court\s+file|court\s+of|federal\s+court|registry|judicial\s+centre|application\s+under|motion\s+record|affidavit|status\s+on\s+appeal|document)\b/iu.test(text);
    };
    for (let index = 0; index < openingLines.length; index += 1) {
      const divided = openingLines[index].match(/^(.{2,35}?)(?:\s*[:|]\s*|\s+[\u2013\u2014-]\s+)(.+)$/u);
      if (divided && matches(divided[1])) return divided[2].split(/\s*;\s*/u)
        .map(cleanParty).filter(Boolean);
      if (!matches(openingLines[index])) continue;
      if (/^STATUS ON APPEAL\s*:?$/iu.test(openingLines[index - 1] ?? "")) continue;
      const collect = (step) => {
        const names = [];
        for (let cursor = index + step; cursor >= 0 && cursor < openingLines.length &&
          Math.abs(cursor - index) <= 8; cursor += step) {
          const line = openingLines[cursor];
          if (boundary(line)) break;
          if (step < 0) names.unshift(cleanParty(line)); else names.push(cleanParty(line));
        }
        return names.filter(Boolean);
      };
      const before = collect(-1), after = collect(1);
      return /[:|]\s*$/u.test(openingLines[index]) ? after : before.length ? before : after;
    }
    return [];
  };

  const ap5Groups = extractAp5Groups(openingLines);
  const genericGroups = ROLES.flatMap((role) => {
    const parties = partyNames(role);
    return parties.length ? [{ role, parties }] : [];
  }).filter((group) => !ap5Groups.some((item) => sameRole(item.role, group.role)));
  const partyGroups = mergeSourceGroups(ap5Groups, genericGroups);
  const partyStyleId = sourcePartyStyle(partyGroups, !!ap5Groups.length);
  const recordIndex = coverLines.findIndex((line) => /^MOTION RECORD$/iu.test(line));
  const recordSubtitle = [];
  if (recordIndex >= 0) {
    for (const line of coverLines.slice(recordIndex + 1)) {
      if (fieldOrSectionLabel(line) || ROLES.some((role) => sameRole(line, role)) ||
        partyGroups.some((group) => group.parties.some((party) => sameParty(line, party))) ||
        [...recordSubtitle, line].join(" ").length > 240) break;
      recordSubtitle.push(line);
    }
  }
  const recordHeading = recordIndex < 0 ? "" : [coverLines[recordIndex],
    recordSubtitle.join(" ")].filter(Boolean).join(" — ");
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
    deponent: readable(deponent),
    swornDate: date ? `${readable(date[2])} ${Number(date[1])}, ${date[3]}`
      : labelled(["sworn date", "date sworn", "affirmed date"], endingLines),
    swornPlace: readable(jurat?.[1] || labelled(["sworn at", "affirmed at"], endingLines)),
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
  const heading = recordHeading || cover.recordTitle || openingLines.find((line) => line.length <= 160 &&
    /^(?:(?:applicant|respondent|appellant|moving party|responding party)['\u2019s]*\s+)?(?:notice(?:\s+of\s+(?:application|motion|appeal))?|application|originating application|statement of (?:claim|defence)|memorandum(?:\s+of\s+fact\s+and\s+law)?|written representations|factum|brief|order(?:\s+and\s+reasons)?|reasons(?:\s+for\s+(?:judgment|order))?|judgment(?:\s+and\s+reasons)?|decision|transcript(?:\s+of\s+.+)?|certificate(?:\s+of\s+.+)?|affidavit(?:\s+of\s+.+)?)$/iu.test(line));
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
    ...(partyStyleId && { partyStyleId }),
    ...(partyGroups.length && { partyGroups }),
    exhibitLabels: exhibits,
    ...(exhibits.length && { exhibitMentions }),
    ...(explicitExhibitLabel && { explicitExhibitLabel }),
    ...(readableDeponent && swornDate
      ? { entryTitle: `Affidavit of ${readableDeponent}` }
      : heading && { entryTitle: readable(heading) }),
    ...(entryDate && { entryDate }),
  };
}

function extractAp5Groups(lines) {
  const groups = [];
  for (let index = 0; index < lines.length; index += 1) {
    const divided = lines[index].match(/^(.{2,35}?)(?:\s*[:|]\s*)(.*)$/u);
    const label = divided?.[1] ?? lines[index];
    const combined = /(?:plaintiff\s*\/\s*applicant|defendant\s*\/\s*respondent)/iu.test(label);
    const roleBelow = combined ? undefined : /plaintiff/iu.test(label) ? "Plaintiff"
      : /defendant/iu.test(label) ? "Defendant"
        : /applicant/iu.test(label) ? "Applicant"
          : /interven(?:er|or)/iu.test(label) ? "Intervener" : undefined;
    if (!combined && !/interven(?:er|or)/iu.test(label)) continue;
    const parties = divided?.[2] ? [cleanParty(divided[2])] : [];
    let status = roleBelow === "Intervener" ? "Intervener" : "";
    for (let cursor = index + 1; cursor < lines.length && cursor - index <= 8; cursor += 1) {
      const statusLine = lines[cursor].match(/^STATUS ON APPEAL\s*:?\s*(.*)$/iu);
      if (statusLine) {
        status = statusLine[1] || cleanText(lines[cursor + 1] ?? "");
        break;
      }
      if (/^(?:PLAINTIFF\s*\/\s*APPLICANT|DEFENDANT\s*\/\s*RESPONDENT|INTERVEN(?:ER|OR)|DOCUMENT|DECISION\b)/iu.test(lines[cursor])) break;
      parties.push(cleanParty(lines[cursor]));
    }
    const role = canonicalRole(status), names = parties.filter(Boolean);
    if (role && names.length) groups.push({ role, ...(roleBelow && { roleBelow }), parties: names });
  }
  return groups;
}

function mergeSourceGroups(...sets) {
  const groups = [];
  for (const group of sets.flat()) {
    const existing = groups.find((item) => sameRole(item.role, group.role) &&
      sameRole(item.roleBelow ?? "", group.roleBelow ?? ""));
    if (!existing) groups.push({ ...group, parties: [...group.parties] });
    else for (const party of group.parties) {
      if (!existing.parties.some((name) => sameParty(name, party))) existing.parties.push(party);
    }
  }
  return groups;
}

function sourcePartyStyle(groups, ap5 = false) {
  const roles = new Set(groups.map((group) => canonicalRole(group.role)));
  const appellant = groups.find((group) => canonicalRole(group.role) === "Appellant");
  if (appellant?.roleBelow) {
    const underlying = canonicalRole(appellant.roleBelow);
    if (underlying === "Plaintiff") return "action-plaintiff";
    if (underlying === "Defendant") return "action-defendant";
    if (underlying === "Applicant") return "application-applicant";
    if (underlying === "Respondent") return "application-respondent";
  }
  if (ap5) return;
  if (roles.has("Plaintiff") && roles.has("Defendant")) return "action";
  if ((roles.has("Applicant") || roles.has("Petitioner")) && roles.has("Respondent")) {
    return "application";
  }
  if (roles.has("Appellant") && roles.has("Respondent")) return "appeal";
}

const canonicalRole = (value) => ROLES.find((role) => sameRole(value, role));
const sameParty = (left, right) => cleanText(left).toLocaleLowerCase() ===
  cleanText(right).toLocaleLowerCase();
const sameLabel = (left, right) => left.toLowerCase().replace(/[^a-z0-9]+/gu, "") ===
  right.toLowerCase().replace(/[^a-z0-9]+/gu, "");
function sameRole(left, right) {
  const clean = (value) => value.toLowerCase().replace(/[^a-z]+/gu, "").replace(/s$/u, "");
  return clean(left) === clean(right);
}
const fieldOrSectionLabel = (value) => /^(?:affidavit (?:number|no)|deponent|court (?:of appeal )?file (?:number|no)|trial court file number|lower court file number|registry(?: office)?|judicial centre|appeal from the decision of|decision (?:maker(?: appealed from)?|date|filing date)|date (?:of decision|of judgment|decision filed|judgment filed|sworn)|judge appealed from|sworn at|affirmed (?:at|date)|record title|document(?: title)?|counsel|lawyer(?: or filing person| for .+)?|address(?: for service)?|(?:counsel |lawyer )?address|telephone|phone|counsel phone|fax|counsel fax|email|counsel email|name|status on appeal|hearing date\b.*|application under\b.*|registrar['\u2019]?s stamp)\s*:?$/iu.test(cleanText(value));
const cleanText = (value = "") => value.replace(/\s+/gu, " ").trim()
  .replace(/^[,;:\s]+|[,;:\s]+$/gu, "");
const cleanParty = (value = "") => cleanText(value);
const readable = cleanText;
const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item));

export { sourceDocumentFields };
