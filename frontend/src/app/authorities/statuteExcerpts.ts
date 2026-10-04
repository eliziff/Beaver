import { useEffect, useMemo, useState } from "react";
import { attachedAuthoritySources, statuteExcerpt } from "../../../../shared/authorities-sources.mjs";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";
import { oneAtATime } from "../../../../shared/one-at-a-time.mjs";
import { getPdfJs, openPdfDocument, PDF_DOCUMENT_OPTIONS } from "@/app/lib/pdfJs";
import type { AuthoritiesHost } from "./host";
import type { SourceOcrPanel } from "./sourceOcr";
import type { AuthoritiesProduct } from "./types";

/** What a statute's excerpt holds of one of its PDFs: its length, the pages kept (null where no cited
 *  provision is placed) and the provisions placed ("section\u000012(2)"). */
export type StatuteExcerptSummary = { pageCount: number; pages: number | null; placed: string[] };
/** A statute row's book copy: whether it can be chosen, excerpt or whole (unknown until the
 *  statute's length is) and the line that says what goes in. */
export type StatuteCopy = { choosable: boolean; excerpt?: boolean; line: string };

type Provision = { kind: string; label: string };
type Read = { kind: "count" | "summary"; key: string; role: string };
const ABBREVIATIONS: Record<string, [string, string]> = { section: ["s", "ss"], subsection: ["s", "ss"],
  paragraph: ["para", "paras"], page: ["p", "pp"], rule: ["r", "rr"], article: ["art", "arts"],
  schedule: ["Sch", "Schs"], clause: ["cl", "cls"], footnote: ["n", "nn"] };
const keyOf = ({ kind, label }: Provision) => `${kind}\0${label}`;
const pages = (count: number) => `${count} page${count === 1 ? "" : "s"}`;

/** What the brief cites of an authority, in its order, each once and as written. */
function cited({ units, occurrences, authorities }: AuthoritiesProduct["state"], id: string) {
  const found = new Map<string, Provision>();
  const add = (kind: string, value: string) => {
    const item = { kind, label: value.trim() };
    if (item.label && !found.has(keyOf(item))) found.set(keyOf(item), item);
  };
  for (const unit of units) for (const occurrenceId of unit.occurrenceIds) {
    const occurrence = occurrences[occurrenceId];
    if (occurrence?.authorityId === id) occurrence.pinpoints.forEach(({ kind, text }) => add(kind, text));
  }
  authorities[id]?.locators.forEach(({ kind, label }) => add(kind, label));
  return [...found.values()];
}
/** "ss 33.1, 34(2), 718": each kind under its abbreviation, in the order first cited. */
const written = (items: Provision[]) => [...new Set(items.map(({ kind }) => kind))].map((kind) => {
  const labels = items.filter((item) => item.kind === kind).map(({ label }) => label);
  const [one, many] = ABBREVIATIONS[kind] ?? [kind, kind];
  return `${labels.length > 1 ? many : one} ${labels.join(", ")}`;
}).join(", ");

/** What of the statute goes in the book, said as a sentence. */
function line(excerpt: boolean | undefined, provisions: Provision[], pageCount?: number,
  summaries?: StatuteExcerptSummary[]) {
  const counted = (count?: number) => count ? ` (${pages(count)})` : "";
  const whole = (why = "") => `${why}Includes the whole statute${counted(pageCount)}.`;
  if (excerpt === undefined) return "";
  if (!excerpt) return whole();
  if (!provisions.length) return whole("No section is cited. ");
  const excerpted = (items: Provision[], count?: number) => `Includes ${written(items)}${counted(count)}.`;
  if (!summaries) return excerpted(provisions);
  const placed = new Set(summaries.flatMap(({ placed }) => placed));
  const found = provisions.filter((item) => placed.has(keyOf(item)));
  const missing = provisions.filter((item) => !placed.has(keyOf(item)));
  const kept = summaries.reduce((sum, { pages: count }) => sum + (count ?? 1), 0);
  if (!missing.length) return excerpted(found, kept);
  // What the PDF does not place goes in rebuilt from the statute's text.
  const rebuilt = `${written(missing)}, rebuilt from the A2AJ text`;
  return `Includes ${found.length ? `${written(found)}${counted(kept)} and ` : ""}${rebuilt}.`;
}

async function pageCount(file: Blob) {
  const task = openPdfDocument(await getPdfJs(), { data: new Uint8Array(await file.arrayBuffer()) }, PDF_DOCUMENT_OPTIONS);
  try { return (await task.promise).numPages; } finally { await task.destroy(); }
}

/** Lengths and excerpts read for one draft, kept while it is open. A read that fails is not asked again. */
type Store = { draftId: string; stop: AbortController; read: Map<string, number | StatuteExcerptSummary | null>;
  asked: Set<string> };
const stores = new WeakMap<AuthoritiesHost, Store>();
const queue = oneAtATime();
function storeFor(host: AuthoritiesHost, draftId: string) {
  const held = stores.get(host);
  if (held?.draftId === draftId) return held;
  held?.stop.abort();
  const store: Store = { draftId, stop: new AbortController(), read: new Map(), asked: new Set() };
  stores.set(host, store);
  return store;
}

/**
 * The book copy of each statute the book reproduces, by authority: as chosen in `shown`, else by
 * its length, recorded when its PDF was attached or read here the first time it is wanted. The
 * excerpt's pages come from the reading a build of the saved `product` makes, read one PDF at a time
 * while `active`; a scan still being recognized waits for its text.
 */
export function useStatuteCopies(host: AuthoritiesHost, product: AuthoritiesProduct | undefined,
  shown: AuthoritiesProduct | undefined, tracked: SourceOcrPanel["tracked"], active: boolean) {
  const [version, setVersion] = useState(0);
  const { rows, wanted } = useMemo(() => {
    const rows = new Map<string, StatuteCopy>(), wanted: Read[] = [];
    const state = shown?.state, held = product && stores.get(host);
    const read = held?.draftId === product?.id ? held?.read : undefined;
    if (!product || !state || state.import.kind !== "document" || state.outputMode === "table" && !state.settings.finalPdf)
      return { rows, wanted };
    for (const id of state.authorityOrder) {
      const authority = state.authorities[id];
      if (authority?.kind !== "legislation") continue;
      const sources = attachedAuthoritySources(authority.source);
      if (!sources.length || authority.excluded) { rows.set(id, { choosable: false, line: "" }); continue; }
      const counts = sources.map(({ bindingRole, sourceSha256, pageCount }) => {
        const key = `count\0${sourceSha256}`, value = pageCount ?? read?.get(key);
        if (value === undefined && host.readSource) wanted.push({ kind: "count", key, role: bindingRole });
        return typeof value === "number" ? value : undefined;
      });
      const excerpt = statuteExcerpt(authority, counts), provisions = cited(state, id);
      const summaries = sources.map(({ bindingRole, sourceSha256 }) => {
        // All a summary depends on: what is cited, the pages marked and how scans are read.
        const marked = product.state.authorities[id]?.annotations?.[bindingRole]?.marks
          .flatMap(({ fragments }) => fragments.map(({ pageNumber }) => pageNumber)) ?? [];
        const key = canonicalJson(["excerpt", bindingRole, sourceSha256, authority.citation, provisions, marked,
          product.state.settings.scannedPdfPolicy]);
        const value = read?.get(key);
        if (excerpt && provisions.length && value === undefined && host.statuteExcerpt &&
            !["running", "paused"].includes(tracked[bindingRole]?.state ?? "")) wanted.push({ kind: "summary", key, role: bindingRole });
        return value && typeof value === "object" ? value : undefined;
      });
      rows.set(id, { choosable: true, excerpt, line: line(excerpt, provisions,
        counts.includes(undefined) ? undefined : counts.reduce<number>((sum, count) => sum + count!, 0),
        summaries.includes(undefined) ? undefined : summaries as StatuteExcerptSummary[]) });
    }
    return { rows, wanted };
  // What has been read is kept outside React; `version` moves on as each read lands.
  }, [host, product, shown, tracked, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const reads = wanted.map(({ key }) => key).join("\n");
  useEffect(() => {
    if (!active || !product || !reads) return;
    const store = storeFor(host, product.id), { signal } = store.stop;
    for (const { kind, key, role } of wanted) {
      if (store.asked.has(key)) continue;
      store.asked.add(key);
      void queue(async () => store.read.set(key, kind === "count"
        ? await pageCount(await host.readSource!(product, role, signal))
        : await host.statuteExcerpt!(product, role, signal)), signal)
        .catch(() => { if (!signal.aborted) store.read.set(key, null); })
        .finally(() => { if (!signal.aborted) setVersion((value) => value + 1); });
    }
  }, [host, product?.id, reads, active]); // eslint-disable-line react-hooks/exhaustive-deps
  return rows;
}
