/**
 * docx-edit-bench fixture builders.
 *
 * Two families, both built rather than committed as binaries, so a fixture
 * tracks whatever markup the current packager emits:
 *
 *  - PROSE fixtures render a plain-prose markdown source through the
 *    product's own renderMarkdownDocx. They vary in length, structure and
 *    pagination, and they are the clean end of the range.
 *  - PATHOLOGY fixtures are assembled with the `docx` packager directly,
 *    reusing the shapes in backend/src/lib/__tests__/fixtures/docx-pathologies.
 *    They carry the features synthetic corpora almost never have:
 *    auto-numbering that lives in numbering.xml and not in the text, tables,
 *    footnotes and endnotes, headers and footers, tracked changes and
 *    comments already in the file, parallel English and French, and the
 *    quote/dash/spacing/hyphenation damage an OCR pass leaves behind.
 *
 * IDENTITY. DOCX bytes are not reproducible across runs (the packager stamps
 * times into core.xml), so a fixture's identity in the manifest is the
 * sha256 of its EXTRACTED BODY TEXT — the only plane the checks and the tool
 * surface both see. `bytes_sha256` is recorded for a single build and is
 * informational.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document,
  Footer,
  FootnoteReferenceRun,
  Header,
  InsertedTextRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  extractDocxBodyText,
  renderMarkdownDocx,
} from "../../../backend/scripts/docx-edit-bench-bridge";
import type { FixtureId } from "./types";

const PROSE_DIR = path.join(__dirname, "..", "fixtures", "prose");
const REAL_DIR = path.join(__dirname, "..", "fixtures", "real");

/**
 * Provenance for a fixture cut from a real document — recorded so a result is
 * reproducible and so anyone can see where every line came from. It is a
 * REPRODUCIBILITY record, not a legal one: scope and permissions are settled
 * outside this benchmark and no fixture is gated on a judgement made here.
 */
export type FixtureProvenance = {
  /** Where the document came from: a resolvable URL, or a local corpus id. */
  source: string;
  /** Citation or identifier the source is addressed by. */
  citation: string;
  /** What was done to it: excerpted, truncated, renamed, nothing. */
  modifications: string;
  /**
   * Contamination risk. A landmark document a model may have memorised is a
   * worse fixture than an obscure one, and tasks must turn on THIS
   * document's specifics either way.
   */
  obscurity: "obscure" | "moderate" | "well-known";
  retrieved: string;
};

export type FixtureSpec = {
  id: FixtureId;
  /** Filename the model sees in the library. */
  filename: string;
  family: "prose" | "pathology" | "real";
  /** One line on what makes this document worth having. */
  character: string;
  /** Jurisdiction, for breadth reporting. */
  jurisdiction?: string;
  /** Required on the `real` family, absent on generated fixtures. */
  provenance?: FixtureProvenance;
  build: () => Promise<Buffer>;
};

const REVISION = { author: "Counsel", date: "2026-01-01T00:00:00Z" };

function prose(id: FixtureId, title: string, character: string): FixtureSpec {
  return {
    id,
    filename: `${title}.docx`,
    family: "prose",
    character,
    build: async () => {
      const source = readFileSync(path.join(PROSE_DIR, `${id}.md`), "utf8");
      const rendered = await renderMarkdownDocx(title, source);
      if ("error" in rendered) throw new Error(`${id}: ${rendered.error}`);
      return rendered.bytes;
    },
  };
}

/**
 * A fixture cut from a real document.
 *
 * Real legal text is not markdown: it has ALL-CAPS headings, "1." and "(a)"
 * at the start of lines, and hard-wrapped paragraphs. Running it through the
 * markdown renderer silently eats list markers and renumbers clauses, so the
 * `real` family packs each source line as one paragraph, verbatim. That is
 * also closer to what a scanned or exported document actually looks like.
 */
function realDocument(
  id: FixtureId,
  title: string,
  file: string,
  character: string,
  jurisdiction: string,
  provenance: FixtureProvenance,
): FixtureSpec {
  return {
    id,
    filename: `${title}.docx`,
    family: "real",
    character,
    jurisdiction,
    provenance,
    build: async () => {
      const source = readFileSync(path.join(REAL_DIR, file), "utf8");
      return Packer.toBuffer(
        new Document({
          sections: [
            {
              children: source
                .split(/\r?\n/u)
                .map((line) => new Paragraph({ children: [new TextRun(line)] })),
            },
          ],
        }),
      );
    },
  };
}

const BYLAW_NUMBERING = {
  config: [
    {
      reference: "bylaw",
      levels: [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.START,
        },
        {
          level: 1,
          format: LevelFormat.LOWER_LETTER,
          text: "(%2)",
          alignment: AlignmentType.START,
        },
      ],
    },
  ],
};

const numbered = (level: number, text: string) =>
  new Paragraph({
    numbering: { reference: "bylaw", level },
    children: [new TextRun(text)],
  });

const plain = (text: string) => new Paragraph({ children: [new TextRun(text)] });

const cell = (text: string) =>
  new TableCell({ children: [new Paragraph(text)] });

/**
 * Auto-numbering, a table and running heads. The clause numbers exist only
 * in numbering.xml: the text plane every read and every edit works on has
 * no "5.2" in it anywhere, so an instruction that names a clause number has
 * nothing to match and the model must work from wording and order.
 */
const crossbridgeBylaw: FixtureSpec = {
  id: "crossbridge-bylaw",
  filename: "Crossbridge Co-operative By-Law No. 4.docx",
  family: "pathology",
  character:
    "auto-numbered clauses (numbers live in numbering.xml), signing-limit table, header and footer",
  build: () =>
    Packer.toBuffer(
      new Document({
        numbering: BYLAW_NUMBERING,
        sections: [
          {
            headers: {
              default: new Header({
                children: [
                  new Paragraph("CROSSBRIDGE CO-OPERATIVE — BY-LAW NO. 4"),
                ],
              }),
            },
            footers: {
              default: new Footer({
                children: [new Paragraph("Adopted 3 March 2026")],
              }),
            },
            children: [
              plain("BY-LAW NO. 4 — GOVERNANCE OF THE CO-OPERATIVE"),
              plain("PART ONE — MEMBERS"),
              numbered(0, "Membership. A person becomes a member on approval of the application by the board and payment of the membership share price."),
              numbered(0, "Notice of members' meetings. Written notice of a meeting of members shall be given to each member not less than 5 days before the meeting."),
              numbered(1, "The notice shall state the date, time and place of the meeting and the general nature of the business to be transacted."),
              numbered(1, "Accidental omission to give notice to a member does not invalidate the proceedings at the meeting."),
              numbered(0, "Quorum of members. A quorum at a meeting of members is a majority of the members entitled to vote."),
              plain("PART TWO — DIRECTORS"),
              numbered(0, "Number of directors. The board consists of not fewer than five and not more than nine directors elected at the annual meeting."),
              numbered(0, "Notice of directors' meetings. Written notice of a meeting of the board shall be given to each director not less than 5 days before the meeting."),
              numbered(1, "A director may waive notice of a meeting of the board, and attendance at the meeting is a waiver unless the director attends to object to the transaction of business."),
              numbered(0, "Quorum of directors. A quorum at a meeting of the board is a majority of the directors then in office."),
              numbered(0, "Vacancies. The board may fill a vacancy among the directors, and a director so appointed holds office for the remainder of the term of the director replaced."),
              plain("PART THREE — OFFICERS AND SIGNING AUTHORITY"),
              numbered(0, "Appointment of officers. The board shall appoint a president, a secretary and a treasurer, and may appoint such other officers as it considers necessary."),
              numbered(0, "Signing authority. An officer may bind the co-operative up to the limit set out in the schedule of signing limits below, and any commitment above that limit requires a resolution of the board."),
              numbered(0, "Banking. The treasurer shall arrange the banking of the co-operative and shall report to the board at each regular meeting on the financial position of the co-operative."),
              plain("SCHEDULE OF SIGNING LIMITS"),
              new Table({
                width: { size: 9000, type: WidthType.DXA },
                rows: [
                  new TableRow({
                    children: [cell("Officer"), cell("Signing limit"), cell("Second signature required above")],
                  }),
                  new TableRow({
                    children: [cell("President"), cell("$25,000"), cell("$30,000")],
                  }),
                  new TableRow({
                    children: [cell("Secretary"), cell("$10,000"), cell("$15,000")],
                  }),
                  new TableRow({
                    children: [cell("Treasurer"), cell("$25,000"), cell("$30,000")],
                  }),
                  new TableRow({
                    children: [cell("General manager"), cell("$40,000"), cell("$45,000")],
                  }),
                ],
              }),
              plain("PART FOUR — AMENDMENT"),
              numbered(0, "Amendment of this by-law. This by-law may be amended by a resolution of the board confirmed by a majority of the members voting at a meeting of members called for that purpose."),
            ],
          },
        ],
      }),
    ),
};

/**
 * A file that has already been marked up. It carries three separate things
 * an editor must tell apart:
 *
 *  - a REAL tracked deletion, whose text is absent from the accepted text
 *    plane the read tools show, so an instruction to remove it has already
 *    been carried out and there is nothing left to delete;
 *  - a MANUAL redline — strike-through and red colour standing in for
 *    tracked changes — whose text IS present in the accepted plane and
 *    therefore reads as operative when it is not;
 *  - comments, which are not body text at all.
 */
const fairmountSupplyRedline: FixtureSpec = {
  id: "fairmount-supply-redline",
  filename: "Fairmount Supply Agreement (marked up).docx",
  family: "pathology",
  character:
    "real tracked insertion and deletion, manual strike/colour redline that reads as operative, two comments",
  build: () =>
    Packer.toBuffer(
      new Document({
        features: { trackRevisions: true },
        comments: {
          children: [
            {
              id: 0,
              author: "Counsel",
              date: new Date("2026-01-04T00:00:00Z"),
              children: [new Paragraph("Confirm the escalation cap with procurement.")],
            },
            {
              id: 1,
              author: "Counsel",
              date: new Date("2026-01-04T00:00:00Z"),
              children: [new Paragraph("Struck on the last call — do not reinstate.")],
            },
          ],
        },
        sections: [
          {
            children: [
              plain("FAIRMOUNT SUPPLY AGREEMENT between FAIRMOUNT INDUSTRIAL LTD. (the \"Supplier\") and CEDAR RIDGE AGGREGATES INC. (the \"Buyer\")."),
              plain("ARTICLE 1 — SUPPLY AND ORDERING"),
              plain("1.1 Supply. The Supplier shall supply the products listed in Schedule 1 in the quantities ordered by the Buyer from time to time."),
              plain("1.2 Purchase orders. The Buyer shall order by written purchase order, and the Supplier shall acknowledge each order within two business days after receiving it."),
              plain("ARTICLE 2 — PRICE AND ESCALATION"),
              plain("2.1 Price. The price of each product is the price set out in Schedule 1, exclusive of taxes and delivery charges."),
              new Paragraph({
                children: [
                  new TextRun("2.2 Escalation. The Supplier may increase the price of a product once in each contract year by not more than "),
                  new CommentRangeStart(0),
                  new TextRun("3% of the price then in effect"),
                  new CommentRangeEnd(0),
                  new TextRun({ children: [new CommentReference(0)] }),
                  new TextRun(", on sixty days' written notice to the Buyer."),
                ],
              }),
              plain("2.3 Invoicing. The Supplier shall invoice on delivery and the Buyer shall pay each invoice within 30 days after receiving it."),
              plain("ARTICLE 3 — DELIVERY"),
              new Paragraph({
                children: [
                  new TextRun("3.1 Delivery terms. The Supplier shall deliver DDP the Buyer's yard "),
                  new DeletedTextRun({
                    text: "and shall bear the cost of expedited freight where an order is late through the Supplier's fault",
                    id: 501,
                    ...REVISION,
                  }),
                  new InsertedTextRun({
                    text: "in accordance with the delivery schedule agreed for each order",
                    id: 502,
                    ...REVISION,
                  }),
                  new TextRun("."),
                ],
              }),
              plain("3.2 Late delivery. If the Supplier fails to deliver by the agreed date, the Buyer may cancel the order without liability and source the products elsewhere."),
              plain("ARTICLE 4 — QUALITY"),
              plain("4.1 Specification. Each product shall conform to the specification in Schedule 2 and to any sample approved by the Buyer in writing."),
              plain("4.2 Rejection. The Buyer may reject a non-conforming delivery within ten business days after delivery, and the Supplier shall replace it at its own cost."),
              plain("ARTICLE 5 — LIABILITY"),
              new Paragraph({
                children: [
                  new TextRun("5.1 Limit of liability. The aggregate liability of the Supplier under this Agreement in any contract year is limited to the amounts paid by the Buyer in that year. "),
                  new CommentRangeStart(1),
                  new TextRun({
                    text: "The Supplier shall have no liability for consequential damages, including loss of profit, loss of production and loss of contract.",
                    strike: true,
                    color: "FF0000",
                  }),
                  new CommentRangeEnd(1),
                  new TextRun({ children: [new CommentReference(1)] }),
                ],
              }),
              plain("5.2 Insurance. The Supplier shall maintain commercial general liability insurance of not less than $5,000,000 per occurrence and shall name the Buyer as an additional insured."),
              plain("ARTICLE 6 — TERM AND TERMINATION"),
              plain("6.1 Term. This Agreement runs for three years from 1 April 2026 and renews automatically for successive one year terms unless either party gives ninety days' notice."),
              plain("6.2 Termination for cause. Either party may terminate on written notice if the other party commits a material breach and fails to remedy it within 30 days after notice of the breach."),
            ],
          },
        ],
      }),
    ),
};

/**
 * Equally authentic English and French. A value stated in one version and
 * not the other is drift, so an edit that touches only the English half is
 * wrong even though the English half now reads correctly.
 */
const bilingualNotice: FixtureSpec = {
  id: "bilingual-notice",
  filename: "Bilingual Default Notice Schedule.docx",
  family: "pathology",
  character: "parallel EN/FR clauses plus a bilingual table of periods",
  build: () =>
    Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              plain("SCHEDULE 6 — NOTICE AND CURE / ANNEXE 6 — AVIS ET CORRECTION"),
              plain("This Schedule is drawn up in English and in French and both versions are equally authentic. La presente annexe est redigee en anglais et en francais et les deux versions font egalement foi."),
              plain("PART A — PAYMENT / PARTIE A — PAIEMENT"),
              plain("A.1 Payment terms. The Purchaser shall pay each invoice within 30 days after receiving it."),
              plain("A.1 Modalites de paiement. L'acheteur paie chaque facture dans les 30 jours suivant sa reception."),
              plain("A.2 Interest on late payment. Interest accrues on an overdue invoice at 1.5% per month from the due date."),
              plain("A.2 Interets sur paiement en retard. Les interets courent sur une facture en souffrance au taux de 1,5 % par mois a compter de l'echeance."),
              plain("PART B — DEFAULT / PARTIE B — DEFAUT"),
              plain("B.1 Notice of default. A party alleging a default shall give the other party written notice describing the default in reasonable detail."),
              plain("B.1 Avis de defaut. La partie qui allegue un defaut donne a l'autre partie un avis ecrit decrivant le defaut de facon suffisamment detaillee."),
              plain("B.2 Cure period. The party in default has 30 days after receiving the notice to remedy the default."),
              plain("B.2 Delai de correction. La partie en defaut dispose de 30 jours suivant la reception de l'avis pour remedier au defaut."),
              plain("B.3 Termination. If the default is not remedied within the cure period, the party that gave the notice may terminate this Agreement on further written notice."),
              plain("B.3 Resiliation. Si le defaut n'est pas corrige dans le delai de correction, la partie qui a donne l'avis peut resilier la presente convention sur nouvel avis ecrit."),
              plain("PART C — SUMMARY OF PERIODS / PARTIE C — SOMMAIRE DES DELAIS"),
              new Table({
                width: { size: 9000, type: WidthType.DXA },
                rows: [
                  new TableRow({
                    children: [cell("Period / Delai"), cell("English"), cell("Francais")],
                  }),
                  new TableRow({
                    children: [cell("Payment / Paiement"), cell("30 days"), cell("30 jours")],
                  }),
                  new TableRow({
                    children: [cell("Cure / Correction"), cell("30 days"), cell("30 jours")],
                  }),
                  new TableRow({
                    children: [cell("Renewal notice / Avis de renouvellement"), cell("90 days"), cell("90 jours")],
                  }),
                ],
              }),
            ],
          },
        ],
      }),
    ),
};

const CURLY_OPEN = "“";
const CURLY_CLOSE = "”";
const EN_DASH = "–";
const EM_DASH = "—";
const NBSP = " ";

/**
 * An OCR'd award. Straight and curly quotes are mixed inside one sentence,
 * en and em dashes stand for each other, sentence spacing is inconsistent,
 * a word is split across a line break the scanner kept, and a non-breaking
 * space sits where a normal one belongs. Any find/replace written from a
 * clean reading of the text misses at least one of these.
 */
const ocrArbitralAward: FixtureSpec = {
  id: "ocr-arbitral-award",
  filename: "Meridian Arbitral Award (scanned).docx",
  family: "pathology",
  character:
    "OCR damage: mixed straight/curly quotes, en/em dash confusion, double spacing, a hyphen-split word, a stray non-breaking space",
  build: () =>
    Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              plain("IN THE MATTER OF AN ARBITRATION between MERIDIAN CAPITAL PARTNERS LP and SUNRISE HOLDINGS INC."),
              plain("AWARD"),
              plain(`Paragraph 1. The Tribunal was constituted under the arbitra- tion clause in Article XII of the share purchase agreement dated 3 March 2026 (the ${CURLY_OPEN}Agreement").`),
              plain(`Paragraph 2. The Claimant seeks damages for breach of the representations in Article III. The Respondent denies breach and says the claim is out of time.  The parties agreed that Ontario law governs.`),
              plain(`Paragraph 3. The hearing was held on 12${NBSP}September 2026 in Toronto ${EN_DASH} by agreement of the parties ${EM_DASH} and closed on the same day.`),
              plain(`Paragraph 4. The Claimant's expert valued the shortfall in working capital at CAD 1,420,000. The Respondent's expert put the figure at CAD 980,000.`),
              plain(`Paragraph 5. The Tribunal prefers the Claimant's expert. The working capital statement was prepared on the basis described in Schedule F and the Respondent's objection was not particularised.`),
              plain(`Paragraph 6. The Tribunal finds that the "target working capital" figure of $4,100,000 was agreed and that the Respondent has not displaced it.`),
              plain(`Paragraph 7. On limitation, the Tribunal finds that the claim was notified within the period in Section 8.03 and is not out of time.`),
              plain(`Paragraph 8. Costs follow the event. The Respondent shall pay the Claimant's costs of the arbitration, to be assessed if not agreed.`),
              plain("DISPOSITION"),
              plain(`Paragraph 9. The Tribunal awards the Claimant the sum of CAD 1,240,000, together with interest at 4% per annum from 30 April 2026 to the date of payment.`),
              plain(`Paragraph 10. The Respondent shall pay the Claimant's costs of the arbitration in the amount of CAD 145,000.`),
              plain(`Paragraph 11. This Award is final and binding on the parties, subject only to the rights of appeal and set aside conferred by the Arbitration Act, 1991 (Ontario).`),
              plain("Seat of arbitration: Toronto, Ontario. Date of Award: 30 October 2026."),
            ],
          },
        ],
      }),
    ),
};

/**
 * A factum with footnotes, endnotes, hyperlinks and running heads. Its
 * point in this set is a NEGATIVE one that the benchmark records rather
 * than hides: footnote text is not on the body text plane, so it is neither
 * readable nor editable through the surface under test.
 */
const laurierFactum: FixtureSpec = {
  id: "laurier-factum",
  filename: "Laurier Factum (Part III).docx",
  family: "pathology",
  character:
    "footnotes and endnotes off the body plane, running heads, body paragraphs whose wording repeats across headings and argument",
  build: () =>
    Packer.toBuffer(
      new Document({
        footnotes: {
          1: { children: [new Paragraph("Dunsmuir v New Brunswick, 2008 SCC 9 at para 74.")] },
          2: { children: [new Paragraph("Vavilov v Canada (Citizenship and Immigration), 2019 SCC 65 at para 23.")] },
          3: { children: [new Paragraph("Applicant's Record, Tab 4, p 112.")] },
        },
        sections: [
          {
            headers: {
              default: new Header({
                children: [new Paragraph("Court File No. A-114-26 — Applicant's Factum")],
              }),
            },
            footers: {
              default: new Footer({ children: [new Paragraph("Part III — Argument")] }),
            },
            children: [
              plain("PART III — STATEMENT OF ARGUMENT"),
              plain("A. THE STANDARD OF REVIEW IS REASONABLENESS"),
              new Paragraph({
                children: [
                  new TextRun("21. The standard of review is reasonableness. The presumption of reasonableness review applies to the interpretation by an administrative decision maker of its home statute."),
                  new FootnoteReferenceRun(1),
                ],
              }),
              new Paragraph({
                children: [
                  new TextRun("22. The presumption is rebutted only where the legislature has indicated otherwise or where the rule of law requires correctness review."),
                  new FootnoteReferenceRun(2),
                ],
              }),
              plain("23. The Respondent does not argue that either exception applies on these facts, and the standard of review is therefore reasonableness."),
              plain("B. THE DECISION IS UNREASONABLE"),
              new Paragraph({
                children: [
                  new TextRun("24. The decision is unreasonable because the decision maker did not grapple with the central submission the Applicant made about the transitional provision."),
                  new FootnoteReferenceRun(3),
                ],
              }),
              plain("25. A decision that fails to account for a central submission is not justified, transparent or intelligible, and the reviewing court should not supply reasons the decision maker did not give."),
              plain("26. The Applicant therefore asks that the decision be set aside and the matter remitted for redetermination by a differently constituted panel."),
              plain("C. RELIEF SOUGHT"),
              plain("27. The Applicant seeks an order setting aside the decision, an order remitting the matter for redetermination, and costs of this application."),
            ],
          },
        ],
      }),
    ),
};

export const FIXTURES: FixtureSpec[] = [
  prose(
    "sunrise-spa",
    "Sunrise Share Purchase Agreement",
    "long structured agreement, 17 articles and 7 schedules, no pagination; exceeds a default read window",
  ),
  prose(
    "northwind-credit",
    "Northwind Credit Agreement",
    "page-marked credit agreement with a table of contents whose entries repeat heading wording",
  ),
  prose(
    "harbourfront-lease",
    "Harbourfront Commercial Lease",
    "short PART-structured lease with heading capitalisation drift",
  ),
  prose(
    "indemnity-memo",
    "Indemnity Position Memo",
    "short unstructured memo that restates another document's terms",
  ),
  prose(
    "pinewood-engagement-letter",
    "Pinewood Engagement Letter",
    "unstructured letter: no numbering of any kind, repeated figures",
  ),
  prose(
    "discovery-transcript",
    "Okafor Discovery Transcript",
    "page-marked transcript with no numbered structure; an answer runs across a sheet break",
  ),
  crossbridgeBylaw,
  fairmountSupplyRedline,
  bilingualNotice,
  ocrArbitralAward,
  laurierFactum,
];

export function fixtureSpec(id: FixtureId): FixtureSpec {
  const found = FIXTURES.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown fixture: ${id}`);
  return found;
}

const bytesCache = new Map<FixtureId, Buffer>();
const textCache = new Map<FixtureId, string>();

export async function fixtureBytes(id: FixtureId): Promise<Buffer> {
  const cached = bytesCache.get(id);
  if (cached) return cached;
  const bytes = await fixtureSpec(id).build();
  bytesCache.set(id, bytes);
  return bytes;
}

/** The only plane the checks and the tool surface both see. */
export async function fixtureText(id: FixtureId): Promise<string> {
  const cached = textCache.get(id);
  if (cached !== undefined) return cached;
  const text = await extractDocxBodyText(await fixtureBytes(id));
  textCache.set(id, text);
  return text;
}
