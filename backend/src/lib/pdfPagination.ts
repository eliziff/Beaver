import * as pdf from "pdf-lib";
import { structureNative } from "./structureNative";
import { reporterMarginLabels as sharedReporterMarginLabels,
  type PdfMarginPage } from "mike/shared/pdf-page-binding.mjs";
export { resolvePdfPagination, printedPageIndices, resolvePrintedPages } from
  "mike/shared/pdf-page-binding.mjs";
export type { PdfPageBinding } from "mike/shared/pdf-page-binding.mjs";

export function reporterStartPages(citations: readonly string[]) {
  return [...new Set(citations.flatMap(citation => structureNative().providerCitationsInText(citation)
    .filter(item => item.family === "reporter" && /^\d+$/u.test(item.page ?? ""))
    .map(item => Number(item.page))).filter(page => Number.isSafeInteger(page) && page > 0))];
}

export function reporterMarginLabels(labels: readonly (string | null)[], starts: readonly number[],
  pages: readonly PdfMarginPage[]) {
  return sharedReporterMarginLabels(labels, starts, pages, (value, candidate) =>
    structureNative().providerCitationsInText(value).some(cite => cite.page === candidate));
}
/** Read the existing PDF number tree without fabricating default physical labels. */
export function embeddedPageLabels(document: pdf.PDFDocument): (string | null)[] {
  const labels: (string | null)[] = Array(document.getPageCount()).fill(null);
  if (!document.catalog.has(pdf.PDFName.of("PageLabels"))) return labels;
  const rules: Array<{ index: number; prefix: string; style: string; start: number }> = [];
  const visited = new Set<pdf.PDFDict>();
  const visit = (node: pdf.PDFDict) => {
    if (visited.has(node)) return;
    visited.add(node);
    const nums = node.lookupMaybe(pdf.PDFName.of("Nums"), pdf.PDFArray);
    if (nums) for (let i = 0; i + 1 < nums.size(); i += 2) {
      const index = nums.lookup(i, pdf.PDFNumber).asNumber();
      const spec = nums.lookup(i + 1, pdf.PDFDict);
      rules.push({ index, prefix: spec.lookupMaybe(pdf.PDFName.of("P"), pdf.PDFString, pdf.PDFHexString)?.decodeText() ?? "",
        style: spec.lookupMaybe(pdf.PDFName.of("S"), pdf.PDFName)?.asString().slice(1) ?? "",
        start: spec.lookupMaybe(pdf.PDFName.of("St"), pdf.PDFNumber)?.asNumber() ?? 1 });
    }
    const kids = node.lookupMaybe(pdf.PDFName.of("Kids"), pdf.PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) visit(kids.lookup(i, pdf.PDFDict));
  };
  visit(document.catalog.lookup(pdf.PDFName.of("PageLabels"), pdf.PDFDict));
  rules.sort((a, b) => a.index - b.index);
  const roman = (number: number) => {
    let result = "";
    for (const [value, text] of [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],
      [50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]] as const)
      while (number >= value) { result += text; number -= value; }
    return result;
  };
  for (let r = 0; r < rules.length; r++) {
    const rule = rules[r];
    for (let i = Math.max(0, rule.index); i < Math.min(labels.length, rules[r + 1]?.index ?? labels.length); i++) {
      const n = rule.start + i - rule.index;
      if (!Number.isSafeInteger(n) || n < 1 || n > 100_000) continue;
      let value = rule.style === "D" ? String(n) : rule.style === "R" || rule.style === "r" ? roman(n)
        : rule.style === "A" || rule.style === "a" ? String.fromCharCode(65 + (n - 1) % 26).repeat(Math.ceil(n / 26))
        : rule.style === "" ? "" : null;
      if (value === null) continue;
      if (rule.style === "r" || rule.style === "a") value = value.toLowerCase();
      labels[i] = rule.prefix + value || null;
    }
  }
  return labels;
}
