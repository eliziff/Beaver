import { cachedContent } from "../contentCache";
import { guardedRemoteFetch } from "../remoteUrlSafety";
import { structureNative } from "../structureNative";

/**
 * Federal legislation A2AJ's consolidated statutes do not hold, from Justice Laws: an annual statute
 * of Canada ("SC 2017, c 4"), and the Constitution Acts (the Constitution Act, 1982 with the Charter
 * in its Part I, and the Constitution Act, 1867). Each is claimed by the citation engine's own key for
 * it, and comes as Justice Laws' official PDF, which the publisher PDF service fetches like any other
 * federal statute's (its `/PDF/…` path is already one it serves).
 */
const ORIGIN = "https://laws-lois.justice.gc.ca";
const HOSTS = ["laws-lois.justice.gc.ca"] as const;

/** The Constitution Acts, 1867 to 1982, as Justice Laws consolidates them in one PDF. */
const CONSTITUTION = { url: `${ORIGIN}/eng/Const/`, pdfUrl: `${ORIGIN}/PDF/Const_TRD.pdf` };
const CONSTITUTION_ACTS: Record<string, { title: string }> = {
  // "Part I of the Constitution Act, 1982, being Schedule B to the Canada Act 1982 (UK), 1982, c 11".
  "statute:ca:-:1982:11": { title: "Constitution Act, 1982" },
  // "Constitution Act, 1867, 30 & 31 Vict, c 3".
  "statute:-:-:30-31-vict:3": { title: "Constitution Act, 1867" },
};

/** What the engine reads a citation as: an annual statute of Canada's year and chapter, or a
 *  Constitution Act. Its key, not the citation's wording, decides. */
function claimed(text: string) {
  const key = structureNative().citationLookupKey(text).replace(/^\d+:/u, "");
  const constitution = CONSTITUTION_ACTS[key];
  if (constitution) return { kind: "constitution" as const, key, ...constitution };
  const [family, jurisdiction, series, year, chapter] = key.split(":");
  return family === "statute" && jurisdiction === "ca" && series === "sc" && /^\d{4}$/u.test(year ?? "") &&
    /^\d{1,3}$/u.test(chapter ?? "") ? { kind: "annual" as const, key, year, chapter } : null;
}

/** An annual statute's page names it: its <title> is the statute's short title, or its long title. */
async function annualTitle(year: string, chapter: string, signal?: AbortSignal) {
  const html = await cachedContent({ scope: "shared", kind: "legal-source-justice-laws-annual", key: `${year}_${chapter}`,
    version: 1, ttlMs: 30 * 24 * 60 * 60 * 1_000, produce: async () => {
      const response = await guardedRemoteFetch(`${ORIGIN}/eng/AnnualStatutes/${year}_${chapter}/`, { signal,
        headers: { Accept: "text/html" } }, { label: "Justice Laws annual statute", allowedHosts: HOSTS,
        defaultPortOnly: true, allowIpLiterals: false, timeoutMs: 15_000,
        response: { label: "Justice Laws annual statute page", maxBytes: 4 * 1024 * 1024, contentTypes: ["text/html"] } });
      return response.ok ? response.text() : "";
    } });
  signal?.throwIfAborted();
  const title = /<title>([^<]{1,300})<\/title>/iu.exec(html)?.[1]?.replace(/\s+/gu, " ").trim();
  return title && !/^(?:error|page not found)/iu.test(title) ? decodeEntities(title) : null;
}
const decodeEntities = (text: string) => text.replace(/&(amp|lt|gt|quot|#39|#x27|rsquo|lsquo);/giu, (_, name: string) =>
  ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", "#x27": "'", rsquo: "’", lsquo: "‘" })[name.toLowerCase()] ?? _);

/** The source of a federal statute A2AJ does not hold, or null for any other citation. An annual
 *  statute Justice Laws does not list (no page title) is not claimed. */
export async function justiceLawsSource(citation: string, signal?: AbortSignal) {
  const claim = claimed(citation);
  if (!claim) return null;
  // The title names the authority only where its citation gives no name of its own (the Charter keeps its name).
  // The brief's own citation stays the authority's, so the index prints the Act once.
  if (claim.kind === "constitution") return { id: claim.key, citation: citation.trim(), date: null, title: claim.title,
    url: CONSTITUTION.url, pdfUrl: CONSTITUTION.pdfUrl, text: "", titleIfUnnamed: true };
  const title = await annualTitle(claim.year, claim.chapter, signal);
  if (!title) return null;
  return { id: claim.key, citation: `SC ${claim.year}, c ${claim.chapter}`, date: null, title,
    url: `${ORIGIN}/eng/AnnualStatutes/${claim.year}_${claim.chapter}/`,
    pdfUrl: `${ORIGIN}/PDF/${claim.year}_${claim.chapter}.pdf`, text: "", titleIfUnnamed: true };
}

export const justiceLawsLegalSourceProvider = {
  id: "justice-laws",
  canResolve: ({ kind, text }: { kind: string; text: string }) => kind === "legislation" && !!claimed(text),
};
