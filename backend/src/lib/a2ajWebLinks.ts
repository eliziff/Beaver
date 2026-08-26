import type { A2AJCompiledDocument } from "./legalSources/a2aj";
import type { NativeTextFragmentPlan } from "./structureNative";

/**
 * A2AJ Law Web's full-document reader renders the same flattened A2AJ text
 * used by the native planner. The browser receives only a normal document URL
 * and native text-fragment directives; Chrome remains solely the verifier.
 */
export function buildA2AJWebPinpointUrl(
  source: Pick<A2AJCompiledDocument, "citation" | "docType">,
  plan: NativeTextFragmentPlan,
) {
  if (!source.citation || !plan.sourceSafeComplete || !plan.directives.length) return null;
  const url = new URL("https://law.a2aj.ca/document");
  url.searchParams.set("citation", source.citation);
  url.searchParams.set("doc_type", source.docType ?? "cases");
  return `${url.href}#:~:${plan.directives.join("&")}`;
}
