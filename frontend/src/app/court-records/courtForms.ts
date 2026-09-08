import { rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { courtPdfText as latin, courtPdfTextWidth, drawCourtPdfText, wrapCourtPdfText } from "./pdfText";
import { ap5BookTitle, ap5PartyGroups, ap5PartyLabel, captionPartyGroups, contactGroups, coverPartyGroups, filingPartyNames,
  groupNames, partyNames } from "./types";
import type { CourtProfile, CoverValues } from "./types";

type VolumeLabel = { number: number; count: number };
const FEDERAL_MARGIN = 99.21; // 3.5 cm, Federal Courts Rule 65(b)

export function drawCourtCover(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  profile: CourtProfile,
  cover: CoverValues,
  volume: VolumeLabel,
) {
  fill(page, profile.cover.colourHex);
  switch (profile.cover.template) {
    case "abca-ap5":
      drawAbcaAp5(page, regular, bold, profile, cover, volume);
      break;
    case "federal-record":
      drawFederalRecord(page, regular, bold, profile, cover, volume);
      break;
    default:
      drawGenericCover(page, regular, bold, profile, cover, volume);
  }
}

export function drawCourtExhibitCertificate(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  profile: CourtProfile,
  cover: CoverValues,
  label: string,
) {
  const { width, height } = page.getSize();
  const deponent = latin(cover.deponent || "____________________________");
  const date = latin(cover.swornDate || "____________________________");
  fill(page, "#FFFFFF");
  if (profile.jurisdiction === "ab") {
    drawAlbertaExhibitCertificate(page, regular, label, deponent, date);
    return;
  }
  centred(page, `EXHIBIT ${latin(label)}`, height - 118, bold, 12);

  const wording = `This is Exhibit “${label}” referred to in the affidavit of ${deponent}, sworn (or affirmed) before me on ${date}.`;
  const signature = "Signature and capacity of the person before whom the affidavit was sworn or affirmed";
  const reference = "Federal Courts Rule 80(3)";

  wrap(wording, regular, 12, width - (2 * FEDERAL_MARGIN)).forEach((text, index) =>
    drawCourtPdfText(page, text, { x: FEDERAL_MARGIN, y: height - 206 - index * 19,
      font: regular, size: 12 }));
  rule(page, 286, 276, width - FEDERAL_MARGIN, 276);
  signature.split("\n").flatMap((value) =>
    wrap(value, regular, 12, width - FEDERAL_MARGIN - 286))
    .forEach((text, index) => drawCourtPdfText(page, text, {
      x: 286, y: 255 - index * 15, font: regular, size: 12,
    }));
  drawCourtPdfText(page, reference, { x: FEDERAL_MARGIN, y: 75, font: regular, size: 12 });
}

export function drawFederalForm344(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  profile: CourtProfile,
  cover: CoverValues,
) {
  const { width } = page.getSize();
  fill(page, "#FFFFFF");
  const y = drawFederalHeading(page, regular, bold, profile, cover);
  centred(page, "Certificate of Completeness of Appeal Book", y - 8, bold, 12);
  const name = latin(cover.counselName || filingPartyNames(profile, cover) || "____________________________");
  const statement = `I, ${name}, solicitor for the appellant (or appellant), certify that the contents of the appeal book in this appeal are complete and legible.`;
  wrap(statement, regular, 12, width - (2 * FEDERAL_MARGIN)).forEach((text, index) =>
    drawCourtPdfText(page, text, { x: FEDERAL_MARGIN, y: y - 50 - index * 16,
      size: 12, font: regular }));
  drawCourtPdfText(page, "(Date)", { x: FEDERAL_MARGIN, y: y - 116,
    font: regular, size: 12 });
  rule(page, 352, y - 116, width - FEDERAL_MARGIN, y - 116);
  drawCourtPdfText(page, "(Signature of solicitor or appellant)", {
    x: 352, y: y - 134, font: regular, size: 12,
  });
  const contact = [
    cover.counselName,
    cover.counselAddress,
    cover.counselPhone && `Telephone: ${cover.counselPhone}`,
    cover.counselFax && `Fax: ${cover.counselFax}`,
  ].filter((value): value is string => !!value).map(latin);
  assertCoverSpace(y - 158 - contact.length * 16);
  contact.forEach((text, index) => drawCourtPdfText(page, text, {
    x: 352, y: y - 158 - index * 16, font: regular, size: 12,
  }));
}

function drawAbcaAp5(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  profile: CourtProfile,
  cover: CoverValues,
  volume: VolumeLabel,
) {
  const { width, height } = page.getSize();
  const groups = ap5PartyGroups(profile, cover);
  centred(page, "COURT OF APPEAL OF ALBERTA", height - 83.28, bold, 12);
  page.drawText("Form AP-5", { x: 468, y: height - 95.64, font: bold, size: 10 });
  drawCourtPdfText(page,
    profile.cover.ruleReference ? `[${latin(profile.cover.ruleReference)}]` : "[Rule 14.87]", {
    x: 468, y: height - 107.64, font: regular, size: 10,
  });
  page.drawRectangle({ x: 470.5, y: height - 226.7, width: 118.1, height: 107.3,
    borderWidth: 0.7, borderColor: rgb(0.35, 0.35, 0.35), color: rgb(1, 1, 1) });
  page.drawText("Registrar's Stamp", { x: 489.84, y: height - 132.72, font: regular, size: 10 });

  const rows: Array<[string, string | undefined]> = [
    ["COURT OF APPEAL FILE NUMBER:", cover.courtFileNumber],
    ["TRIAL COURT FILE NUMBER:", cover.lowerCourtFileNumber],
    ["REGISTRY OFFICE:", cover.registry],
    ...groups.flatMap((group): Array<[string, string | undefined]> => [
      [ap5PartyLabel(group), partyNames(group)],
      ["STATUS ON APPEAL:", group.role],
    ]),
    ["DOCUMENT:", profile.cover.title],
  ];
  const rowStep = groups.length > 2 ? 22 : 27.84;
  let y = height - 133.44;
  for (const [label, value] of rows) {
    page.drawText(label, { x: 77.4, y, font: regular, size: 12 });
    const valueFont = label === "DOCUMENT:" ? bold : regular;
    const lines = wrap(latin(value || ""), valueFont, 12, width - 305);
    lines.forEach((text, index) => drawCourtPdfText(page, text, {
      x: 289.8, y: y - (index * 13), font: valueFont, size: 12,
    }));
    y -= Math.max(rowStep, lines.length * 13 + 5);
  }
  const headingRule = y + (rowStep / 2);
  rule(page, 70.56, headingRule, width - 70.56, headingRule);

  const decision = [
    "Appeal from the Decision of",
    latin(cover.decisionMaker || "____________________________"),
    cover.decisionDate ? `Dated ${legalDate(cover.decisionDate)}` : "Dated ____________________________",
    cover.decisionFileDate ? `Filed ${legalDate(cover.decisionFileDate)}` : "Filed _____________________________",
  ];
  const decisionTop = headingRule - 26;
  decision.forEach((text, index) => centredAt(page, text, 321,
    decisionTop - index * 15.88, regular, 12));
  const decisionRule = decisionTop - 67;
  rule(page, 70.56, decisionRule, width - 70.56, decisionRule);
  const titleY = decisionRule - 25;
  const titleLines = [...wrap(latin(ap5BookTitle(profile, cover)).toUpperCase(),
    regular, 12, width - 141.12),
  ...(volume.count > 1 ? [`VOLUME ${volume.number} OF ${volume.count}`] : [])];
  titleLines.forEach((text, index) => centred(page, text, titleY - index * 15, regular, 12));
  const titleRule = titleY - titleLines.length * 15 - 3;
  rule(page, 70.56, titleRule, width - 70.56, titleRule);
  const contactTop = titleRule - 25;
  const contactBottom = drawAbcaContactColumns(page, regular, bold, profile, cover, contactTop);
  const contactRule = Math.min(contactTop - 87, contactBottom - 3);
  assertCoverSpace(contactRule);
  rule(page, 70.56, contactRule, width - 70.56, contactRule);
}

function drawFederalRecord(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  profile: CourtProfile,
  cover: CoverValues,
  volume: VolumeLabel,
) {
  const { width } = page.getSize();
  let y = drawFederalHeading(page, regular, bold, profile, cover);
  rule(page, FEDERAL_MARGIN, y, width - FEDERAL_MARGIN, y);
  y -= 39;
  wrap(latin(cover.recordTitle || profile.cover.title).toUpperCase(), bold, 12,
    width - (2 * FEDERAL_MARGIN)).forEach((text) => {
    centred(page, text, y, bold, 12);
    y -= 16;
  });
  const subtitles = [cover.recordSubtitle, cover.hearingDate && `Hearing date: ${cover.hearingDate}`]
    .filter(Boolean) as string[];
  subtitles.flatMap((value) => wrap(latin(value), bold, 12, width - (2 * FEDERAL_MARGIN)))
    .forEach((text) => {
      centred(page, text, y - 4, bold, 12);
      y -= 17;
    });
  if (volume.count > 1) {
    centred(page, `VOLUME ${volume.number} OF ${volume.count}`, y - 4, bold, 12);
    y -= 18;
  }
  rule(page, FEDERAL_MARGIN, y - 8, width - FEDERAL_MARGIN, y - 8);
  assertCoverSpace(drawFederalContactColumns(page, regular, bold, profile, cover, y - 40));
}

function drawFederalHeading(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  profile: CourtProfile,
  cover: CoverValues,
) {
  const { width, height } = page.getSize();
  right(page, `Court File No. ${latin(cover.courtFileNumber || "________________")}`,
    width - FEDERAL_MARGIN, height - 78, regular, 12);
  centred(page, profile.courtAbbreviation === "FCA" ? "FEDERAL COURT OF APPEAL" : "FEDERAL COURT",
    height - 118, bold, 12);
  page.drawText("BETWEEN:", { x: FEDERAL_MARGIN, y: height - 157, font: regular, size: 12 });
  const groups = captionPartyGroups(profile, cover);
  let y = height - 193;
  groups.forEach((group, index) => {
    const names = wrap(latin(partyNames(group) || "____________________________"), regular, 12,
      width - (2 * FEDERAL_MARGIN));
    names.forEach((name) => {
      centred(page, name, y, regular, 12);
      y -= 14;
    });
    const roleY = y - 20;
    right(page, latin(group.role), width - FEDERAL_MARGIN, roleY, regular, 12);
    if (index < groups.length - 1) {
      centred(page, "and", roleY - 26, regular, 12);
      y = roleY - 52;
    } else y = roleY - 32;
  });
  if ((cover.partyStyleId ?? profile.cover.partyStyles?.[0]?.id) === "application" &&
      cover.applicationUnder?.trim()) {
    for (const text of wrap(`APPLICATION UNDER ${latin(cover.applicationUnder)}`, regular, 12,
      width - (2 * FEDERAL_MARGIN))) {
      centred(page, text, y, regular, 12);
      y -= 15;
    }
    y -= 17;
  }
  return y;
}

function drawFederalContactColumns(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  profile: CourtProfile,
  cover: CoverValues,
  top: number,
) {
  const gap = 28;
  const columnWidth = (page.getWidth() - (2 * FEDERAL_MARGIN) - gap) / 2;
  const [filing, others] = contactGroups(profile, cover);
  const left = exactContactBlock(page, regular, bold, [
    [groupNames(filing), true], [filing?.role, false], [cover.counselName, false],
    [cover.counselAddress, false], [cover.counselPhone && `Tel: ${cover.counselPhone}`, false],
    [cover.counselFax && `Fax: ${cover.counselFax}`, false],
    [cover.counselEmail && `Email: ${cover.counselEmail}`, false],
  ], FEDERAL_MARGIN, top, columnWidth);
  const right = exactContactBlock(page, regular, bold, [
    [groupNames(...others), true], [others.map((group) => group.role).join(" / "), false], [cover.otherCounselName, false],
    [cover.otherCounselAddress, false], [cover.otherCounselPhone && `Tel: ${cover.otherCounselPhone}`, false],
    [cover.otherCounselFax && `Fax: ${cover.otherCounselFax}`, false],
    [cover.otherCounselEmail && `Email: ${cover.otherCounselEmail}`, false],
  ], FEDERAL_MARGIN + columnWidth + gap, top, columnWidth);
  return Math.min(left, right);
}

function drawAbcaContactColumns(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  profile: CourtProfile,
  cover: CoverValues,
  top: number,
) {
  const left = 77.4;
  const rightX = 329.16;
  const width = 212;
  const [filing, others] = contactGroups(profile, cover);
  const filingBottom = exactContactBlock(page, regular, bold, [
    [`Lawyer for ${groupNames(filing) || "________________"}`, false], [cover.counselName, false],
    [cover.counselAddress, false], [cover.counselPhone, false], [cover.counselFax, false],
    [cover.counselEmail, false],
  ], left, top, width, 13.8);
  const parties = others.flatMap((group) => group.parties).filter(({ name }) => name.trim());
  let otherBottom = top;
  for (const party of parties) {
    otherBottom = exactContactBlock(page, regular, bold, [
      [`Lawyer for ${party.name}`, false], [party.contact?.name, false],
      [party.contact?.address, false], [party.contact?.phone, false], [party.contact?.fax, false],
      [party.contact?.email, false],
    ], rightX, otherBottom - (otherBottom === top ? 0 : 5), width, 13.8);
  }
  if (!parties.length) otherBottom = exactContactBlock(page, regular, bold,
    [["Lawyer for ________________", false]], rightX, top, width, 13.8);
  return Math.min(filingBottom, otherBottom);
}

function exactContactBlock(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  values: Array<[string | undefined, boolean]>,
  x: number,
  top: number,
  width: number,
  lineHeight = 15,
) {
  let y = top;
  for (const [value, strong] of values) {
    if (!value) continue;
    const font = strong ? bold : regular;
    for (const text of wrap(latin(value), font, 12, width)) {
      drawCourtPdfText(page, text, { x, y, font, size: 12 });
      y -= lineHeight;
    }
  }
  return y;
}

function drawAlbertaExhibitCertificate(
  page: PDFPage,
  font: PDFFont,
  label: string,
  deponent: string,
  date: string,
) {
  const left = 126;
  const rightX = page.getWidth() - left;
  const top = page.getHeight() - 180;
  drawCourtPdfText(page, `This is Exhibit "${latin(label)}" referred to in the Affidavit of:`, {
    x: left, y: top, font, size: 12,
  });
  drawCourtPdfText(page, deponent, { x: left + 6, y: top - 31, font, size: 12 });
  rule(page, left, top - 35, rightX, top - 35);
  centredAt(page, "(name of person making the affidavit)", page.getWidth() / 2,
    top - 52, font, 10);
  page.drawRectangle({ x: left, y: top - 90, width: 10, height: 10, borderWidth: 0.8,
    borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) });
  page.drawText("Sworn", { x: left + 16, y: top - 89, font, size: 12 });
  page.drawText("/", { x: left + 66, y: top - 89, font, size: 12 });
  page.drawRectangle({ x: left + 82, y: top - 90, width: 10, height: 10, borderWidth: 0.8,
    borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) });
  page.drawText("Affirmed before me this", { x: left + 98, y: top - 89, font, size: 12 });
  drawCourtPdfText(page, date, { x: left + 6, y: top - 122, font, size: 12 });
  rule(page, left, top - 126, rightX, top - 126);
  rule(page, left, top - 184, rightX, top - 184);
  centredAt(page, "Commissioner for Oaths, Justice of the Peace,", page.getWidth() / 2,
    top - 201, font, 10);
  centredAt(page, "or Notary Public in and for Alberta", page.getWidth() / 2,
    top - 215, font, 10);
  rule(page, left, top - 254, rightX, top - 254);
  centredAt(page, "Print Name and Expiry Date", page.getWidth() / 2, top - 271, font, 10);
}

function drawGenericCover(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  profile: CourtProfile,
  cover: CoverValues,
  volume: VolumeLabel,
) {
  const { width, height } = page.getSize();
  centred(page, latin(cover.courtName || profile.court).toUpperCase(), height - 88, bold, 12);
  rule(page, 56, height - 112, width - 56, height - 112);
  let y = height - 170;
  coverPartyGroups(profile, cover).forEach((group, index) => {
    if (index) {
      centred(page, "and", y, regular, 11);
      y -= 18;
    }
    wrap(latin(partyNames(group) || "____________________________"), bold, 11, width - 112)
      .forEach((name) => {
        centred(page, name, y, bold, 11);
        y -= 14;
      });
    centred(page, latin(group.role), y, regular, 10);
    y -= 22;
  });
  const titleY = Math.min(height - 348, y - 24);
  assertCoverSpace(titleY - (volume.count > 1 ? 45 : 20), 170);
  centred(page, latin(cover.recordTitle || profile.cover.title).toUpperCase(), titleY, bold, 18);
  if (volume.count > 1) centred(page, `VOLUME ${volume.number} OF ${volume.count}`, titleY - 27, bold, 10);
  drawCourtPdfText(page, latin(cover.courtFileNumber || ""), {
    x: 64, y: 148, font: regular, size: 9,
  });
  drawCourtPdfText(page, latin(filingPartyNames(profile, cover)), {
    x: 64, y: 130, font: bold, size: 9,
  });
}

function assertCoverSpace(bottom: number, minimum = 71) {
  if (bottom < minimum) throw new Error(
    "The style of cause and filing details do not fit the prescribed one-page cover.",
  );
}

function fill(page: PDFPage, colour: string) {
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 0, y: 0, width, height, color: hex(colour) });
}

function centred(
  page: PDFPage,
  text: string,
  y: number,
  font: PDFFont,
  size: number,
  color: RGB = rgb(0.05, 0.05, 0.05),
) {
  centredAt(page, text, page.getWidth() / 2, y, font, size, color);
}

function centredAt(
  page: PDFPage,
  text: string,
  centre: number,
  y: number,
  font: PDFFont,
  size: number,
  color: RGB = rgb(0.05, 0.05, 0.05),
) {
  drawCourtPdfText(page, text, {
    x: centre - courtPdfTextWidth(text, font, size) / 2, y, font, size, color,
  });
}

function right(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
) {
  drawCourtPdfText(page, text, {
    x: x - courtPdfTextWidth(text, font, size), y, font, size,
  });
}

function rule(page: PDFPage, x1: number, y1: number, x2: number, y2: number) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
    thickness: 0.7, color: rgb(0.08, 0.08, 0.08) });
}


function legalDate(value: string) {
  const prose = value.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/u);
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!prose && !iso) return latin(value);
  const day = Number(prose?.[2] ?? iso?.[3]);
  const month = prose?.[1] ?? ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"][Number(iso?.[2]) - 1];
  const year = prose?.[3] ?? iso?.[1];
  const suffix = day % 10 === 1 && day !== 11 ? "st"
    : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `the ${day}${suffix} day of ${month}, ${year}`;
}

function hex(value: string): RGB {
  const normalized = value.replace("#", "");
  const number = Number.parseInt(normalized.length === 3
    ? normalized.split("").map((character) => character.repeat(2)).join("")
    : normalized, 16);
  return rgb(((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255);
}

const wrap = (text: string, font: PDFFont, size: number, maxWidth: number) =>
  wrapCourtPdfText(text, font, size, maxWidth, true);
