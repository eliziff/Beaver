// Focused static contract for the canonical no-oracle fragment planner.
// Run: npx tsx experiments/text-fragment-fidelity/candidate-builder.test.mts
import { buildMaximalPinpointPlan, sourceUrl } from "./builder-candidate.ts";

let passed = 0;
let failed = 0;
const planned: ReturnType<typeof buildMaximalPinpointPlan>[] = [];

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
    return;
  }
  failed += 1;
  console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
}

function fragmentsOf(target: string | null) {
  const raw = target?.split(":~:text=")[1] ?? "";
  if (!raw) return [];
  return raw.split("&text=").map((piece) => decodeURIComponent(
    piece.replace(/%(?![0-9A-Fa-f]{2})/gu, ""),
  ));
}

function termsOf(target: string | null) {
  const raw = target?.split(":~:text=")[1] ?? "";
  if (!raw) return [];
  return raw.split("&text=").flatMap((directive) => directive.split(",").map((term) =>
    decodeURIComponent(term.replace(/^-|-$/gu, ""))));
}

function rangeDirectiveCount(target: string | null) {
  const raw = target?.split(":~:text=")[1] ?? "";
  if (!raw) return 0;
  return raw.split("&text=").filter((directive) => {
    const terms = directive.split(",");
    if (terms[0]?.endsWith("-")) terms.shift();
    if (terms.at(-1)?.startsWith("-")) terms.pop();
    return terms.length === 2;
  }).length;
}

function wordCount(text: string) {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu)].length;
}

function plan(
  url: string,
  blockText: string,
  quotes: string[],
  documentText = blockText,
) {
  const result = buildMaximalPinpointPlan({ url, blockText, documentText }, quotes);
  planned.push(result);
  return result;
}

// Repeated endpoint terms are valid when Chromium's first resolved range is
// the requested interval. Independent endpoint uniqueness is not required.
{
  const document =
    "unique pre alpha beta gamma delta. alpha other gamma delta.";
  const result = plan(
    "https://example.test/reasons",
    "unique pre alpha beta gamma delta.",
    ["alpha beta gamma delta"],
    document,
  );
  const fragments = fragmentsOf(result.target);
  check(
    "HTML accepts the exact first-resolved passage",
    result.sourceSafeComplete &&
      result.paintQuotes.join("|") === "alpha beta gamma delta" &&
      result.paintedWords === 4 &&
      result.sourceWordIntervals.length === 1,
    JSON.stringify({ fragments, result }),
  );
}

// A source block boundary is a real uncertainty boundary. Exact directives
// cover both sides; no range may bridge publisher-inserted text.
{
  const document = "lead alpha beta\ngamma delta trail";
  const result = plan(
    "https://example.test/reasons",
    document,
    ["alpha beta gamma delta"],
  );
  const fragments = fragmentsOf(result.target);
  check(
    "HTML exact-cover splits at a block seam",
    result.sourceSafeComplete &&
      result.paintQuotes.join("|") === "alpha beta|gamma delta" &&
      result.sourceWordIntervals.length === 2 &&
      rangeDirectiveCount(result.target) === 0,
    JSON.stringify({ fragments, result }),
  );
}

// Requested endpoints grow before external context is considered. This keeps
// punctuation/typography outside the quote from becoming load-bearing.
{
  const document =
    "alpha wrong gamma delta. unique alpha beta gamma delta.";
  const result = plan(
    "https://example.test/reasons",
    "unique alpha beta gamma delta.",
    ["alpha beta gamma delta"],
    document,
  );
  const fragments = fragmentsOf(result.target);
  check(
    "HTML expands an in-quote endpoint before external context",
    result.sourceSafeComplete &&
      result.paintedWords === 4 &&
      !fragments.some((fragment) => fragment.startsWith("unique-,")),
    JSON.stringify({ fragments, result }),
  );
}

// When context cannot disambiguate a line-start occurrence, the endpoint grows
// minimally; the requested prose is never dropped to make a short URL pass.
{
  const document = [
    "begin x finish",
    "begin y finish",
    "begin target prose finish",
  ].join("\n");
  const result = plan(
    "https://example.test/reasons",
    "begin target prose finish",
    ["begin target prose finish"],
    document,
  );
  const fragments = fragmentsOf(result.target);
  check(
    "HTML grows an endpoint instead of omitting words",
    result.sourceSafeComplete &&
      result.paintQuotes.join("|") === "begin target prose finish" &&
      result.paintedWords === 4,
    JSON.stringify({ fragments, result }),
  );
}

// PDF source lines are also structural uncertainty boundaries. Exact-cover
// keeps every word without assuming that a range may cross a page seam.
{
  const document = "alpha beta\ngamma delta";
  const result = plan(
    "https://example.test/reasons.pdf",
    document,
    ["alpha beta gamma delta"],
  );
  const fragments = fragmentsOf(result.target);
  check(
    "PDF exact-cover preserves both source lines",
    result.sourceSafeComplete &&
      result.paintQuotes.join("|") === "alpha beta|gamma delta" &&
      result.sourceWordIntervals.length === 2 &&
      rangeDirectiveCount(result.target) === 0 &&
      result.paintedWords === 4,
    JSON.stringify({ fragments, result }),
  );
}

// A context parameter may occupy the adjacent source line; it remains its own
// uninterrupted term and disambiguates the requested occurrence.
{
  const document = [
    "old",
    "alpha beta gamma",
    "unique",
    "alpha beta gamma",
  ].join("\n");
  const result = plan(
    "https://example.test/reasons.pdf",
    "unique alpha beta gamma",
    ["alpha beta gamma"],
    document,
  );
  check(
    "adjacent-line context disambiguates without entering the paint",
    result.sourceSafeComplete &&
      result.paintQuotes.join("|") === "alpha beta gamma" &&
      termsOf(result.target).includes("unique") &&
      result.paintedWords === 3,
    JSON.stringify(result),
  );
}

// Established line-start list/provision furniture is optional; ordinary words
// on both sides remain explicit source intervals.
{
  const document = "(a) alpha beta\n(3) gamma delta";
  const result = plan(
    "https://example.test/reasons.pdf",
    document,
    [document],
  );
  const fragments = fragmentsOf(result.target);
  check(
    "PDF trims only classified line furniture",
    result.sourceSafeComplete &&
      result.paintQuotes.join("|") === "alpha beta|gamma delta" &&
      result.paintedWords === 4,
    JSON.stringify({ fragments, result }),
  );
}

// An identical signed-at/date/judge prefix immediately before CITATION is
// classified as duplicate court metadata. Ordinary duplicated prose is never
// granted this exception.
{
  const signature = "at Ottawa Canada this 26th day of September 2011 Real Favreau Favreau J";
  const document = [
    signature,
    "OLD RECORD",
    "examined Signed",
    signature,
    "CITATION 2011 TCC 418",
    "COURT FILE Wayne Bowden Apostle",
  ].join("\n");
  const quote = `${signature} CITATION 2011 TCC 418 COURT FILE Wayne Bowden Apostle`;
  const result = plan(
    "https://example.test/reasons.pdf",
    `examined Signed ${quote}`,
    [quote],
    document,
  );
  check(
    "only duplicate signature metadata may be omitted",
    result.sourceSafeComplete &&
      result.paintQuotes.join(" ").startsWith("2011 TCC 418") &&
      !result.paintQuotes.join(" ").includes("Ottawa") &&
      result.paintedWords === 8,
    JSON.stringify(result),
  );

  const prose = "at issue this 26th day of September 2011 evidence remains J";
  const rejected = plan(
    "https://example.test/reasons.pdf",
    `marker pad ${prose} CITATION end`,
    [prose],
    [
      `old pad ${prose}`,
      `marker pad ${prose}`,
    ].join("\n"),
  );
  check(
    "metadata exception requires the complete lexical shape and CITATION boundary",
    !rejected.sourceSafeComplete,
    JSON.stringify(rejected),
  );
}

// Directive spelling may strip Markdown, but coverage remains the canonical
// source-word interval rather than a comparison against the rewritten string.
{
  const document = "*alpha* beta gamma delta";
  const result = plan(
    "https://example.test/reasons",
    document,
    [document],
  );
  const interval = result.sourceWordIntervals[0];
  check(
    "source coverage is independent of directive spelling",
    result.sourceSafeComplete &&
      result.paintQuotes.join("|") === "alpha beta gamma delta" &&
      result.paintedWords === 4 &&
      interval?.lastWord - interval?.firstWord + 1 === 4,
    JSON.stringify(result),
  );
}

// Multiple requested passages remain separate combined-URL directives and
// preserve their quote identity in the interval proof.
{
  const document =
    "alpha beta gamma. nearby delta epsilon zeta.";
  const result = plan(
    "https://example.test/reasons",
    document,
    ["alpha beta gamma", "delta epsilon zeta"],
  );
  check(
    "multiple quotes retain separate canonical intervals",
    result.sourceSafeComplete &&
      fragmentsOf(result.target).length === 2 &&
      result.sourceWordIntervals.map(({ quoteIndex }) => quoteIndex).join("|") === "0|1" &&
      result.paintedWords === 6,
    JSON.stringify(result),
  );
}

// The only whole-quote omissions are established edge furniture/artifacts.
{
  const document = "[21] Pursuant to the Act [99-135]";
  const result = plan(
    "https://example.test/reasons",
    document,
    [document],
  );
  check(
    "classified edge furniture does not dilute prose coverage",
    result.sourceSafeComplete &&
      result.paintQuotes.join("|") === "Pursuant to the Act" &&
      result.paintedWords === 4,
    JSON.stringify(result),
  );
}

// A singleton uses source-line context and still proves its exact global word
// occurrence rather than relying on word rarity.
{
  const document = "alpha beta\nalpha gamma";
  const result = plan(
    "https://example.test/reasons",
    "alpha gamma",
    ["alpha"],
    document,
  );
  const fragments = fragmentsOf(result.target);
  check(
    "singleton directive resolves the exact repeated word",
    result.sourceSafeComplete &&
      result.sourceWordIntervals[0]?.firstWord === 2 &&
      result.paintedWords === 1,
    JSON.stringify({ fragments, result }),
  );
}

// A duplicated requested passage prefers its adjacent source paragraph label
// over longer generic prose context; context never enters the paint.
{
  const quote = "interpretation Ocean seeks to place on section 12 of";
  const earlier = `The ${quote} the Regulation in relation to the assignment of leases.`;
  const intended = `[39] The ${quote} the Regulation in relation to the agreement between Tokyu and Ocean.`;
  const result = plan(
    "https://example.test/reasons",
    intended,
    [quote],
    `${earlier}\n${intended}`,
  );
  check(
    "adjacent label disambiguates the p39 duplicate",
    result.sourceSafeComplete &&
      result.paintedWords === wordCount(quote) &&
      termsOf(result.target).includes("[39] The"),
    JSON.stringify(result),
  );
}

// Exact raw same-line punctuation is admissible. First-compatible replay,
// rather than an inferred period seam, proves the intended title/name span.
{
  const quote = "setting out s. 19(6) [now s. 20(6)], Mr. Justice";
  const earlier = `${quote} Smith rejected that view.`;
  const intended = `${quote} Hall accepted it.`;
  const result = plan(
    "https://example.test/reasons",
    intended,
    [quote],
    `${earlier}\n${intended}`,
  );
  check(
    "expanded context retains Justice across exact same-line punctuation",
    result.sourceSafeComplete &&
      result.paintedWords === wordCount(quote),
    JSON.stringify(result),
  );
}

// Parenthetical provision clusters stay attached to their atom. Exact raw
// same-line terms may include following prose when replay proves the interval.
{
  const quote = "of subsection 141(1) of the Health of Animals Regulations";
  const earlier = "application of subsection 141(1) of the Plant Regulations is disputed.";
  const intended = `The violation ${quote} is established.`;
  const result = plan(
    "https://example.test/reasons",
    intended,
    [quote],
    `${earlier}\n${intended}`,
  );
  check(
    "provision atom and following prose retain full substantive union",
    result.sourceSafeComplete && result.paintedWords === wordCount(quote),
    JSON.stringify(result),
  );
}

// Opening/closing quotation marks stay in the quoted atom. Context grows away
// from the quote when the quoted phrase itself is duplicated.
{
  const quote = 'addition to the brief definitions of "dangerous sexual offenders"';
  const earlier = `${quote} listed elsewhere.`;
  const intended = `${quote} apply here.`;
  const result = plan(
    "https://example.test/reasons",
    intended,
    [quote],
    `${earlier}\n${intended}`,
  );
  check(
    "quoted duplicate retains every requested word",
    result.sourceSafeComplete && result.paintedWords === wordCount(quote),
    JSON.stringify(result),
  );
}

// The replay rejects a tempting range whose first start would join to an end
// in an earlier passage. The overlap cover still paints the intended union.
{
  const earlier = "lead alpha. wrong omega tail.";
  const intended = "unique alpha. beta omega finish.";
  const quote = "alpha. beta omega";
  const result = plan(
    "https://example.test/reasons",
    intended,
    [quote],
    `${earlier}\n${intended}`,
  );
  check(
    "wrong earlier range is rejected, not accepted by endpoint rarity",
    result.sourceSafeComplete && result.paintedWords === wordCount(quote) &&
      !fragmentsOf(result.target).some((fragment) => fragment === "alpha.,omega"),
    JSON.stringify(result),
  );
}

// Same-line punctuation and structural labels are not guessed seams. Newlines
// and Markdown openings remain the only hard parameter boundaries.
{
  const document = "The applicant. He answered.\n*Section* 650(1) Subject to subsection (2), relief follows.";
  const quotes = ["applicant. He answered", "Section 650(1) Subject to subsection"];
  const result = plan("https://example.test/reasons", document, quotes);
  const terms = termsOf(result.target);
  check(
    "same-line punctuation does not force omission while source block seams stay hard",
    result.sourceSafeComplete && result.paintedWords ===
      quotes.reduce((sum, quote) => sum + wordCount(quote), 0) &&
      !terms.some((term) => /answered\. Section|\*Section/u.test(term)),
    JSON.stringify({ terms, result }),
  );
}

// Publisher chrome can introduce an earlier generic word. An exact longer raw
// term is safe when its first-compatible replay still resolves the target.
{
  const document = "Courts publish notices. The lower courts. They have power to decide.";
  const quote = "courts. They have power";
  const result = plan(
    "https://example.test/reasons",
    "The lower courts. They have power to decide.",
    [quote],
    document,
  );
  check(
    "generic publisher-chrome word cannot create a stray range",
    result.sourceSafeComplete && result.paintedWords === wordCount(quote) &&
      result.sourceWordIntervals[0]?.firstWord === 5,
    JSON.stringify(result),
  );
}

// Chromium word boundaries end before adjacent punctuation. The earlier
// `date")` occurrence therefore matches the bare exact phrase and forces the
// intended paragraph to carry context; replay must not skip it as a different
// punctuation atom.
{
  const quote = "equalization date";
  const earlier = 'The equalization date") appears in the quoted definition.';
  const intended = "[73] The equalization date determines the valuation.";
  const result = plan(
    "https://coadecisions.ontariocourts.ca/item/1/index.do",
    intended,
    [quote],
    `${earlier}\n${intended}`,
  );
  check(
    "ONCA punctuation boundary counts the earlier compatible phrase",
    result.sourceSafeComplete && result.paintedWords === 2 &&
      result.sourceWordIntervals[0]?.firstWord === 10 &&
      termsOf(result.target).some((term) => term.includes("[73]")) &&
      rangeDirectiveCount(result.target) === 0,
    JSON.stringify(result),
  );
}

// A source-proven paragraph label may disambiguate a duplicate as preferred
// non-painted context. The substantive target remains the only paint interval.
{
  const quote = "complainant alleged that Parks Canada had improperly withheld information";
  const earlier = `Summary\nThe ${quote} under section 23.`;
  const intended = `[1]The ${quote} under section 23.`;
  const result = plan(
    "https://example.test/reasons",
    intended,
    [quote],
    `${earlier}\n${intended}`,
  );
  check(
    "SCT body label is preferred context, never painted prose",
    result.sourceSafeComplete && result.paintedWords === wordCount(quote) &&
      termsOf(result.target).includes("[1]The") &&
      result.paintQuotes.every((paint) => !paint.includes("[1]")),
    JSON.stringify(result),
  );
}

// Justice Laws flattens each definition into A2AJ prose but preserves record
// boundaries in the full document. The live definition list may insert a
// standalone <dt> copy before the <dd> body, so no range may bridge records.
// English terms and French aliases remain substantive exact-cover pieces.
{
  const quote = "The following definitions apply in these Regulations. Act means the Retail Payment Activities Act. (Loi) senior";
  const block = "The following definitions apply in these Regulations. **Act** means the Retail Payment Activities Act. (**Loi**) **senior officer**, in respect of an entity, means its chief executive officer.";
  const document = [
    "The following definitions apply in these Regulations.",
    "**Act** means the Retail Payment Activities Act. (**Loi**)",
    "**senior officer**, in respect of an entity, means its chief executive officer.",
  ].join("\n\n");
  const result = plan(
    "https://laws-lois.justice.gc.ca/eng/XML/SOR-2023-229.xml",
    block,
    [quote],
    document,
  );
  check(
    "Justice definition reorder uses exact record cover without omissions",
    result.sourceSafeComplete && result.paintedWords === wordCount(quote) &&
      result.sourceWordIntervals.length === 3 &&
      result.paintQuotes.some((piece) => piece.includes("Loi")) &&
      result.paintQuotes.at(-1) === "senior" &&
      termsOf(result.target).some((term) => term.startsWith("officer")) &&
      rangeDirectiveCount(result.target) === 0,
    JSON.stringify(result),
  );
}

// A line marker attached without whitespace to substantive text is one atom;
// peeling `(a)` must never make `information` impossible to target.
{
  const quote = "Records: (a)information relating to prices";
  const document = `Protected ${quote}`.replace(": ", ":\n");
  const result = plan(
    "https://example.test/reasons",
    document,
    [quote],
    document,
  );
  check(
    "tight label atom retains its attached substantive word",
    result.sourceSafeComplete && result.paintedWords === wordCount(quote) &&
      termsOf(result.target).some((term) => term.startsWith("(a)information")),
    JSON.stringify(result),
  );
}

// Edge-furniture predicates are deliberately exact. Ordinary conjunctions,
// citations, and bilingual words remain substantive and must all be painted.
{
  const quotes = [
    "AND CONSIDERING the ordinary evidence",
    "by EC550/23; the ordinary evidence remains",
    "plan mineur vérificateur remain substantive words",
  ];
  const document = quotes.join(". ");
  const result = plan("https://example.test/reasons", document, quotes);
  check(
    "ordinary edge-like prose is never classified as furniture",
    result.sourceSafeComplete && result.paintedWords ===
      quotes.reduce((sum, quote) => sum + wordCount(quote), 0) &&
      result.paintQuotes.join(" ").includes("AND CONSIDERING") &&
      result.paintQuotes.join(" ").includes("EC550/23") &&
      result.paintQuotes.join(" ").includes("vérificateur"),
    JSON.stringify(result),
  );
}

// Historical p51 regression: the requested 79-word passage must not use the
// external `to “. . .` seam as prefix and must retain every substantive word.
{
  const block = "[51] Although paragraph 125(1)(r) of the Code refers to “. . . guards, guard-rails, barricades and fences”, it is really subsection 2.6(1) of the Regulations that provides the details of the purportedly contravened obligation. Section 2.6(2) states that a “grating, screen, covering or walkway” must be designed, constructed and maintained to support certain loads. However, it is section 2.6(1), mentioned above, that specifies the conditions in which section 2.6(2) applies, that is to say, the places or situations where such guards are required.";
  const quote = "guards, guard-rails, barricades and fences”, it is really subsection 2.6(1) of the Regulations that provides the details of the purportedly contravened obligation. Section 2.6(2) states that a “grating, screen, covering or walkway” must be designed, constructed and maintained to support certain loads. However, it is section 2.6(1), mentioned above, that specifies the conditions in which section 2.6(2) applies, that is to say, the places or situations where such guards are";
  const result = plan(
    "https://example.test/reasons",
    block,
    [quote],
    `Earlier guards were discussed elsewhere.\n${block}`,
  );
  check(
    "p51 retains all 79 source words without the unsafe external seam",
    wordCount(quote) === 79 && result.sourceSafeComplete &&
      result.paintedWords === 79 &&
      !termsOf(result.target).some((term) => /to “?\.\s*\.\s*\./u.test(term)),
    JSON.stringify(result),
  );
}

// PDF front matter can repeat a definition term while the bilingual body is
// split into source lines. Exact-cover paints both English and French lines;
// the table-of-contents occurrence is context only and no line-crossing range
// can absorb it.
{
  const quote = "business contact information means identifying information renseignements commerciaux vérificateur";
  const document = [
    "business contact information",
    "TABLE OF CONTENTS",
    "business contact information means identifying information",
    "renseignements commerciaux vérificateur",
  ].join("\n");
  const result = plan(
    "https://example.test/statute.pdf",
    document,
    [quote],
    document,
  );
  check(
    "PDF bilingual body survives front-matter duplication",
    result.sourceSafeComplete && result.paintedWords === wordCount(quote) &&
      result.paintQuotes.join("|") ===
        "business contact information means identifying information|renseignements commerciaux vérificateur" &&
      !result.paintQuotes.join(" ").includes("TABLE OF CONTENTS") &&
      rangeDirectiveCount(result.target) === 0,
    JSON.stringify(result),
  );
}

// When a quote ends at the first word of the next
// bilingual definition: the alias/definition boundary is a seam, never a
// license to discard that requested word.
for (const nextTerm of ["standard", "attractant"]) {
  const quote = `operative text; \u00ab alias fran\u00e7ais \u00bb \u201c ${nextTerm}`;
  const document = [
    `${nextTerm} appears in front matter`,
    `${quote} terms means the source-contextual definition`,
  ].join("\n");
  const result = plan(
    "https://example.test/statute.pdf",
    quote,
    [quote],
    document,
  );
  check(
    `next bilingual definition word ${nextTerm} remains required`,
    result.sourceSafeComplete && result.paintedWords === wordCount(quote) &&
      result.paintQuotes.some((paint) => paint === nextTerm) &&
      rangeDirectiveCount(result.target) === 0,
    JSON.stringify(result),
  );
}

// PDF publisher chrome cannot inject prose into the cached text layer. A
// full-document-unique word isolated by a source newline is safe as its own
// exact directive and remains substantive rather than being dropped.
{
  const quote = "other person prescribed as an auditor; « vérificateur »";
  const document = `(c) any other person prescribed as an auditor;\n« vérificateur »\n“business contact information” means contact details.`;
  const result = plan(
    "https://example.test/statute.pdf",
    quote,
    [quote],
    document,
  );
  check(
    "unique PDF singleton retains the seventh substantive word",
    wordCount(quote) === 7 && result.sourceSafeComplete &&
      result.paintedWords === 7 &&
      result.paintQuotes.some((paint) => paint === "vérificateur"),
    JSON.stringify(result),
  );
}

// A2AJ exposes BCLaws' machine `/xml` route, but text fragments must target
// the human document route and its `sectionN` anchor spelling.
{
  const resolved = sourceUrl(
    "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/96001_01/xml",
    "sec12",
  );
  const nested = sourceUrl(
    "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/96001_01/xml",
    "sec249.1(2)(a)(ii)",
  );
  check(
    "BCLaws XML source maps section and nested subsection to human routes",
    resolved ===
      "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/96001_01#section12" &&
      nested ===
      "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/96001_01#section249.1",
    JSON.stringify({ resolved, nested }),
  );
}

// BCLaws definition lists may inject list labels between the flattened Oxford
// role items. Each source-proved island remains an exact target and their union
// retains the complete requested passage.
{
  const quote = "the appeal; *registrar* means a person appointed under section 10 (1) as the registrar, the associate registrar, or a deputy registrar; *respondent*";
  const result = plan(
    "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/21006/xml",
    quote,
    [quote],
  );
  const paints = result.paintQuotes.join("|");
  check(
    "LEGISLATION-BC_SBC_2021_c_6 splits the Oxford role series",
    result.sourceSafeComplete && result.paintedWords === wordCount(quote) &&
      result.sourceWordIntervals.length > 1 &&
      !paints.includes("section 10 (1) as") &&
      !paints.includes("as the registrar") &&
      !paints.includes("registrar, the associate registrar") &&
      !paints.includes("or a deputy registrar") &&
      rangeDirectiveCount(result.target) === 0,
    JSON.stringify(result),
  );
}

// BCLaws can insert a publisher annotation immediately after a legal locator.
// The source grammar, not the provider name, makes that endpoint a hard exact-
// target seam while the resulting pieces still cover every requested word.
for (const [name, url, quote, locator, continuation] of [
  [
    "REGULATIONS-BC_BC_Reg_209_2025 section 1",
    "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/209_2025/xml",
    "14; *highway* has the same meaning as in section 1 of the Transportation Act; *Indigenous peoples* has the same meaning as in",
    "section 1",
    "of the Transportation Act",
  ],
  [
    "REGULATIONS-BC_BC_Reg_59_2021 section 118",
    "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/59_2021/xml",
    "Columbia, but otherwise within the area described in section 118 of the Act, defined in accordance with the law of the jurisdiction",
    "section 118",
    "of the Act",
  ],
  [
    "REGULATIONS-BC_BC_Reg_120_2022 section 38",
    "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/120_2022/xml",
    "or any directives of the registrar issued under section 38 of the Act; *hearing date* means the date set for a hearing;",
    "section 38",
    "of the Act",
  ],
  [
    "REGULATIONS-BC_BC_Reg_281_2021 section 33 (6)",
    "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/281_2021/xml",
    "assent voting advertising attributed to each sponsor under section 33 (6) of the Act is non-election assent voting advertising of each of",
    "section 33 (6)",
    "of the Act",
  ],
] as const) {
  const result = plan(url, quote, [quote]);
  const paintedLocator = locator.replace(/\)$/u, "");
  check(
    `${name} is an exact-cover seam`,
    result.sourceSafeComplete && result.paintedWords === wordCount(quote) &&
      result.sourceWordIntervals.length > 1 &&
      !result.paintQuotes.some((paint) =>
        paint.includes(paintedLocator) && paint.includes(continuation)) &&
      result.paintQuotes.some((paint) => paint.endsWith(paintedLocator)) &&
      result.paintQuotes.some((paint) => paint.startsWith(continuation)) &&
      rangeDirectiveCount(result.target) === 0,
    JSON.stringify(result),
  );
}

check(
  "maximal planner never emits a start,end range",
  planned.every((result) => rangeDirectiveCount(result.target) === 0),
  JSON.stringify(planned.filter((result) => rangeDirectiveCount(result.target))),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
