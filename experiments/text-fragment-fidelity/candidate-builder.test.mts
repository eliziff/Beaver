// Standalone checks for the candidate builder's fragment strategies, over
// fixtures mirroring the captured publisher markup. Run: npx tsx <this file>.
// Production stays untouched; this imports the experiment copy.
import {
  buildLegalSourcePinpointUrl,
  buildLineCorePinpointUrl,
  buildMaximalPinpointUrl,
  maximalCoreQuotes,
} from "./builder-candidate.ts";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
function fragmentsOf(result) {
  if (!result) return [];
  const raw = result.split(":~:text=")[1] ?? "";
  if (!raw) return [];
  return raw.split("&text=").map((piece) => {
    const trimmed = piece.replace(/%(?![0-9A-Fa-f]{2})/gu, "");
    try { return decodeURIComponent(trimmed); } catch { return trimmed; }
  });
}
function build(blockText, quote, documentText) {
  return buildLegalSourcePinpointUrl(
    { url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/18909/index.do", anchor: "par1", blockText, documentText },
    [quote],
  );
}

// T1 — seam-split range with leading pinpoint dropped (BCCA 480 shape).
{
  const block =
    "[14] Charter of Rights and Freedoms: s. 1 The Canadian Charter of Rights and Freedoms guarantees the rights and freedoms set out in it subject only to such reasonable limits prescribed by law as can be demonstrably justified in a free and democratic society.";
  const quote = "of Rights and Freedoms: s. 1 The Canadian Charter";
  const frags = fragmentsOf(build(block, quote, block));
  check(
    "seam-split drops leading pinpoint (T1)",
    frags.some((f) => f.includes("Freedoms:,") && f.includes(",The Canadian Charter")),
    frags.join(" | "),
  );
}

// T2 — seam-split range (BCCA 79 shape, no pinpoint).
{
  const block =
    "[63] The respondents cross appeal on the ground that: The Chambers judge erred in law when he concluded that the aspect of the ARP regime that imposes prohibitions should be struck down.";
  const quote = "respondents cross appeal on the ground that: The Chambers";
  const frags = fragmentsOf(build(block, quote, block));
  check(
    "seam-split range (T2)",
    frags.some((f) => f.includes("ground that:,") && f.includes(",The Chambers")),
    frags.join(" | "),
  );
}

// T3 — detached punctuation variant (CITT "60. (1)").
{
  const block =
    "The Act stipulates as follows: 60.(1) A person to whom notice of a determination is given may apply in writing within thirty days after the day on which the notice is given.";
  const quote = "stipulates as follows: 60.(1) A person to whom notice";
  const frags = fragmentsOf(build(block, quote, block));
  check(
    "detached punctuation variant (T3)",
    frags.some((f) => f.includes("60. (1)")),
    frags.join(" | "),
  );
}

// T4 — curly quote fold + bracket respelling (YKCA shape).
{
  const block =
    'The Court further noted at para. 33 that "[t]he interests of justice take account not only of the applicant\u2019s interests but also of the need to preserve public confidence in the administration of justice.';
  const quote = 'Court further noted at para. 33 that "[t]he interests';
  const frags = fragmentsOf(build(block, quote, block));
  check(
    "curly/bracket respellings present (T4)",
    frags.some((f) => f.includes("\u201C[t]he") || f.includes("that t he interests")),
    frags.join(" | "),
  );
}

// T5 — graded NBSP variants for abbreviation pinpoints (Decisia).
{
  const block =
    "This appeal centres on the appropriate framework for determining applications to retroactively decrease child support arrears under s. 17 of the Divorce Act and related provisions.";
  const quote = "under s. 17 of the Divorce Act";
  const frags = fragmentsOf(build(block, quote, block));
  check(
    "NBSP grades for s. 17 (T5)",
    frags.some((f) => f.includes("s.\u00A017")),
    frags.join(" | "),
  );
}

// T6 — range boundary crossing a paragraph seam: the end boundary's
// seam-adjacent continuation ("Nothing") is dropped so a sibling directive ends
// inside one paragraph (pinpoint-drop). Both raw and seam-split pairs ship.
{
  const block =
    "The applicant submits that the chambers judge erred in law when he concluded that the regime that imposes prohibitions should be struck down because it violates the constitutional guarantee of freedom of expression. Nothing";
  const quote = block;
  const frags = fragmentsOf(build(block, quote, block));
  check(
    "seam-split range boundary drops seam tail (T6)",
    frags.some(
      (f) =>
        f.includes("freedom of expression.") &&
        !f.includes("freedom of expression. Nothing"),
    ),
    frags.join(" | "),
  );
}

// T7 — exact target crossing a seam whose continuation is one word ("here:
// The"): the head-only single run ships alongside the crossing run.
{
  const block =
    "MacKay then states and I quote him here: The tribunal lacked the jurisdiction to entertain the claim.";
  const quote = "MacKay then states and I quote him here: The";
  const frags = fragmentsOf(build(block, quote, block));
  check(
    "seam-head fallback when tail too short (T7)",
    frags.includes("MacKay then states and I quote him here:"),
    frags.join(" | "),
  );
}

// T8 — apostrophe respelling: an in-word apostrophe is a RIGHT single quote
// (U+2019), not the LEFT mark (U+2018).
{
  const block =
    "The court considers the applicant's privacy, liberty and dignity in this inquiry.";
  const quote = "court considers the applicant's privacy, liberty";
  const frags = fragmentsOf(build(block, quote, block));
  check(
    "apostrophe respells to U+2019 (T8)",
    frags.some((f) => f.includes("applicant\u2019s")) &&
      !frags.some((f) => f.includes("applicant\u2018s")),
    frags.join(" | "),
  );
}

// T9 — markdown emphasis: A2AJ carries `*...*` markers, publishers render
// without them. Both spellings ship so either page matches.
{
  const block =
    "In this Act: *acknowledgement* means an acknowledgement under section 7 (1) (b)";
  const quote = "*acknowledgement* means an acknowledgement";
  const frags = fragmentsOf(build(block, quote, block));
  check(
    "markdown stripped sibling (T9)",
    frags.includes("acknowledgement means an acknowledgement") &&
      frags.includes("acknowledgement* means an acknowledgement"),
    frags.join(" | "),
  );
}

// T10 — an opening quote is not a useful range seam. Start inside the quoted
// term and close after it instead of painting unrelated text before the quote.
{
  const block =
    "In this Regulation “ generally accepted accounting principles ” means the standards used here. Later generally accepted accounting principles apply.";
  const quote = "Regulation “ generally accepted accounting principles ” means the";
  const result = buildLineCorePinpointUrl(
    { url: "https://example.test/rules.pdf", blockText: block, documentText: block },
    [quote],
  );
  const frags = fragmentsOf(result);
  check(
    "line core skips opening-quote seam (T10)",
    frags.includes("generally accepted accounting principles,means the") &&
      !frags.some((fragment) => fragment.includes("In this-,")),
    frags.join(" | "),
  );
}

// T11 — when the range is ambiguous, use its closing boundary as context for
// the painted core instead of adding unrelated text before the opening quote.
{
  const block =
    "In this Regulation “ class A society ”, in relation to a year means a society. A class A society has duties in relation to its records.";
  const quote = "Regulation “ class A society ”, in relation to";
  const result = buildLineCorePinpointUrl(
    { url: "https://example.test/rules.pdf", blockText: block, documentText: block },
    [quote],
  );
  const frags = fragmentsOf(result);
  check(
    "line core uses the closing boundary as context (T11)",
    frags.includes("class A society,-in relation to") &&
      !frags.some((fragment) => fragment.includes("In this-,")),
    frags.join(" | "),
  );
}

// T12 — a PDF column-order break at an opening quote produces two directives
// whose painted targets together retain every requested word.
{
  const block =
    "In this Regulation “ class A society ”, in relation to a year means a society. A class A society has duties.";
  const quote = "Regulation “ class A society ”, in relation to";
  const result = buildMaximalPinpointUrl(
    { url: "https://example.test/rules.pdf", blockText: block, documentText: block },
    [quote],
  );
  const frags = fragmentsOf(result);
  check(
    "maximal builder retains both sides of an opening-quote break (T12)",
    frags.length === 2 &&
      frags.some((fragment) => fragment === "Regulation" || fragment.endsWith("-,Regulation")) &&
      frags.includes("“class A society”, in relation to"),
    frags.join(" | "),
  );
}

// T13 — PDF seam handling is derived from A2AJ text, never a publisher name.
{
  const block = "alpha beta gamma delta\nepsilon zeta eta theta";
  const quote = "alpha beta gamma delta epsilon zeta eta theta";
  const left = fragmentsOf(buildMaximalPinpointUrl(
    { url: "https://one.example/a.pdf", blockText: block, documentText: block }, [quote]));
  const right = fragmentsOf(buildMaximalPinpointUrl(
    { url: "https://two.example/b.pdf", blockText: block, documentText: block }, [quote]));
  check(
    "maximal PDF seams are content-derived (T13)",
    left.join("|") === right.join("|") &&
      left.join("|") === "alpha beta gamma delta|epsilon zeta eta theta",
    `${left.join(" | ")} / ${right.join(" | ")}`,
  );
}

// HTML core ranges may omit a structural paragraph label at the edge.
{
  const block = "[21] Pursuant to the Act, the provision is restrictive.";
  const quote = "[21] Pursuant to the Act";
  const frags = fragmentsOf(buildMaximalPinpointUrl(
    { url: "https://example.test/reasons", blockText: block, documentText: block }, [quote]));
  check(
    "maximal HTML range trims structural edge labels (T14)",
    frags.join("|") === "Pursuant to,the Act" &&
      maximalCoreQuotes({ blockText: block }, [quote]).join("|") === "Pursuant to the Act",
    frags.join(" | "),
  );
}

// Both range endpoints must identify the intended passage independently. A
// unique start/end pairing is insufficient because Chrome can join an earlier
// repeated start to the intended end and paint unrelated intervening text.
{
  const document =
    "a spouse lives here. supporter or helper. [38] a spouse at the intended passage and supporter or guardian.";
  const block = "[38] a spouse at the intended passage and supporter or guardian.";
  const quote = "[38] a spouse at the intended passage and supporter or";
  const frags = fragmentsOf(buildMaximalPinpointUrl(
    { url: "https://example.test/reasons", blockText: block, documentText: document }, [quote]));
  check(
    "maximal HTML range anchors both endpoints independently (T15)",
    frags.join("|") === "a spouse at the,passage and supporter or",
    frags.join(" | "),
  );
}

// Multiple nearby passages remain separate directives, each with the same
// independent endpoint guarantee.
{
  const block = "[4] alpha beta gamma delta epsilon. [5] zeta eta theta iota kappa.";
  const quotes = ["[4] alpha beta gamma delta", "[5] zeta eta theta iota"];
  const frags = fragmentsOf(buildMaximalPinpointUrl(
    { url: "https://example.test/reasons", blockText: block, documentText: block }, quotes));
  check(
    "maximal HTML builder keeps multiple directives (T16)",
    frags.length === 2 &&
      frags.includes("alpha beta,gamma delta") &&
      frags.includes("zeta eta,theta iota"),
    frags.join(" | "),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
