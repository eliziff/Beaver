import assert from "node:assert/strict";
import {
  cachedDerivedPdfEvidence,
  decisiaPdfEvidence,
} from "./source-representation.mjs";
import { sourceUrl } from "./builder-candidate.ts";

assert.deepEqual(
  decisiaPdfEvidence('<div id="decisia-decision-pdf-only" class="decisia-document-warning"><a href="/nsc/nssc/en/42/1/document.do">PDF</a></div>', "https://decisia.lexum.com/nsc/nssc/en/item/42/index.do"),
  { url: "https://decisia.lexum.com/nsc/nssc/en/42/1/document.do", pdfOnly: true },
);
assert.deepEqual(
  decisiaPdfEvidence('<li class="documents"><a href="/nsc/nssc/en/43/1/document.do">PDF</a></li>', "https://decisia.lexum.com/nsc/nssc/en/item/43/index.do"),
  { url: "https://decisia.lexum.com/nsc/nssc/en/43/1/document.do", pdfOnly: false },
);
assert.deepEqual(
  decisiaPdfEvidence(
    '<li class="documents"><a href="/nsc/nssc/en/44/1/document.do">PDF</a></li><div id="decisia-decision-pdf-only"><a href="/nsc/nssc/en/44/2/document.do">Only PDF</a></div>',
    "https://decisia.lexum.com/nsc/nssc/en/item/44/index.do",
  ),
  { url: "https://decisia.lexum.com/nsc/nssc/en/44/2/document.do", pdfOnly: true },
);
assert.equal(decisiaPdfEvidence('<li class="documents"></li>', "https://decisia.lexum.com/nsc/nssc/en/item/42/index.do"), null);
assert.equal(decisiaPdfEvidence('<article><a href="/nsc/nssc/en/42/1/document.do">citation</a></article>', "https://decisia.lexum.com/nsc/nssc/en/item/42/index.do"), null);
assert.equal(decisiaPdfEvidence('<div><a href="/wrong.pdf">PDF</a></div>', "https://example.test/item"), null);
assert.deepEqual(
  cachedDerivedPdfEvidence("https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/530291/index.do?iframe=true&site_preference=mobile"),
  {
    url: "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/530291/1/document.do",
    pdfOnly: false,
  },
);
assert.deepEqual(
  cachedDerivedPdfEvidence("https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/item/463717/index.do"),
  {
    url: "https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/463717/1/document.do",
    pdfOnly: true,
  },
);
assert.deepEqual(
  cachedDerivedPdfEvidence("https://decisia.lexum.com/nsc/nssc/en/item/459053/index.do?iframe=true&site_preference=mobile"),
  {
    url: "https://decisia.lexum.com/nsc/nssc/en/459053/1/document.do",
    pdfOnly: true,
  },
);
assert.equal(
  cachedDerivedPdfEvidence("https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/40083/index.do?iframe=true&site_preference=mobile"),
  null,
);
assert.equal(
  sourceUrl(
    "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/281_2021/xml",
    "sec1(1)",
  ),
  "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/281_2021#section1",
);
