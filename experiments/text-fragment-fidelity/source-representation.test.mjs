import assert from "node:assert/strict";
import { pdfOnlyLink } from "./source-representation.mjs";

assert.equal(
  pdfOnlyLink('<div id="decisia-decision-pdf-only" class="decisia-document-warning"><a href="/nsc/nssc/en/42/1/document.do">PDF</a></div>', "https://decisia.lexum.com/nsc/nssc/en/item/42/index.do"),
  "https://decisia.lexum.com/nsc/nssc/en/42/1/document.do",
);
assert.equal(pdfOnlyLink('<div><a href="/wrong.pdf">PDF</a></div>', "https://example.test/item"), null);
