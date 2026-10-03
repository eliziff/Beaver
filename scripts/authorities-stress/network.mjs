// Every request the page makes beyond itself, answered here: nothing reaches a live service.
// A2AJ answers from a stub knowledge base (invented records, or placeholder text for public
// citations) or from a recorded HAR; the publisher PDF service answers with PDFs the case supplies
// or the HAR recorded. Anything else is refused and recorded, and a case fails on it.
import { readFile } from "node:fs/promises";

export const SERVICE = "https://quiet-wildflower-ab0d.authorities-lite.workers.dev/";
const json = (body, status = 200) => ({ status, contentType: "application/json",
  headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

/** A recorded HAR as answers by URL: the last answer recorded for each. */
export async function loadHar(file) {
  const har = JSON.parse(await readFile(file, "utf8")), answers = new Map();
  for (const { request, response } of har.log.entries) {
    const { text = "", encoding, mimeType = "" } = response.content;
    answers.set(request.url, { status: response.status, contentType: mimeType || "application/octet-stream",
      body: encoding === "base64" ? Buffer.from(text, "base64") : Buffer.from(text) });
  }
  return answers;
}

/** The record A2AJ serves for a decision: its name, citations and numbered paragraphs. */
export function caseRecord({ citation, alternate = null, name, date = "2031-03-04", text, paragraphs = 40, url = null, dataset = "TEST" }) {
  const body = text ?? [name, citation, "", ...Array.from({ length: paragraphs }, (_, index) =>
    `[${index + 1}] ${paragraphProse(name, index)}`)].join("\n\n");
  return { dataset, citation_en: citation, citation2_en: alternate, name_en: name, document_date_en: date,
    ...(url ? { url_en: url } : {}), unofficial_text_en: body, upstream_license: "Synthetic test record" };
}
/** The record A2AJ serves for an enactment: markdown with headings and numbered sections. */
export function lawRecord({ citation, name, sections }) {
  const text = [`# ${name}`, "", `*${citation}*`, "", ...sections.flatMap(([number, heading, body]) =>
    [heading ? `**${heading}**` : "", "", `**${number}** ${body}`, ""])].join("\n");
  return { dataset: "TEST-LAWS", citation_en: citation, citation2_en: null, name_en: name,
    document_date_en: "2031-01-01T00:00:00", unofficial_text_en: text, upstream_license: "Synthetic test record" };
}
export const WORDS = ["notice", "licence", "board", "season", "hearing", "reply", "record", "basin", "delay", "reasons",
  "permit", "schedule", "members", "weather", "harbour", "minister", "fairness", "evidence", "appeal", "remedy"];
/** Placeholder reasons, varied by paragraph so a passage can be found by its words. */
export const paragraphProse = (name, index) => `The court considered the ${WORDS[index % WORDS.length]} and the ` +
  `${WORDS[(index * 7 + 3) % WORDS.length]} raised in ${name.split(" v ")[0]}, weighing the ${WORDS[(index * 3 + 5) % WORDS.length]} ` +
  `against the ${WORDS[(index * 11 + 1) % WORDS.length]} before reaching the conclusion set out in paragraph ${index + 1}.`;

/**
 * Routes a browser context. `a2aj` is a Map of citation → record (cases and laws alike);
 * `har` a Map from loadHar, preferred where it holds the URL; `pdfs` a Map of publisher URL →
 * PDF bytes for the publisher service; `slow` delays each A2AJ answer by that many ms.
 * Returns the log of what was asked and how it was answered.
 */
export async function routeNetwork(context, { a2aj = new Map(), har = null, pdfs = new Map(), slow = 0, service = null } = {}) {
  const log = [];
  await context.route(/^https?:\/\//u, async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (["127.0.0.1", "localhost"].includes(url.hostname)) return route.continue();
    const entry = { method: request.method(), url: url.href, answer: "refused" };
    log.push(entry);
    if (url.hostname === "api.a2aj.ca") {
      if (slow) await new Promise((resolve) => setTimeout(resolve, slow));
      const recorded = har?.get(url.href);
      if (recorded) { entry.answer = "har"; return route.fulfill({ status: recorded.status, contentType: recorded.contentType,
        headers: { "access-control-allow-origin": "*" }, body: recorded.body }); }
      entry.answer = "stub";
      const citation = url.searchParams.get("citation");
      const hit = url.pathname === "/fetch" && citation && a2aj.get(citation);
      return route.fulfill(json({ results: hit ? [hit] : [] }));
    }
    if (url.href.startsWith(SERVICE)) {
      const source = url.searchParams.get("source") ?? "";
      if (service) { entry.answer = "service"; return route.fulfill(await service(request, source)); }
      const recorded = har?.get(url.href), bytes = pdfs.get(source);
      if (recorded) { entry.answer = "har"; return route.fulfill({ status: recorded.status, contentType: recorded.contentType,
        headers: { "access-control-allow-origin": "*" }, body: recorded.body }); }
      if (bytes) { entry.answer = "pdf"; return route.fulfill({ status: 200, contentType: "application/pdf",
        headers: { "access-control-allow-origin": "*" }, body: bytes }); }
      entry.answer = "not found";
      return route.fulfill(json({ error: "No PDF was found for this source.", code: "not_found" }, 404));
    }
    return route.abort("blockedbyclient");
  });
  return log;
}
/** What left the page unanswered: anything refused. */
export const refused = (log) => log.filter(({ answer }) => answer === "refused").map(({ method, url }) => `${method} ${url}`);
