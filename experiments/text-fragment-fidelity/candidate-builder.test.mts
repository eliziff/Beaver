// Standalone checks for the candidate builder's fragment strategies, over
// fixtures mirroring the captured publisher markup. Run: npx tsx <this file>.
// Production stays untouched; this imports the experiment copy.
import { buildLegalSourcePinpointUrl } from "./builder-candidate.ts";

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
