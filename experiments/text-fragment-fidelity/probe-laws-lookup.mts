if (!process.env.LEGAL_SOURCE_PROVIDER_MODULE) throw new Error("Set LEGAL_SOURCE_PROVIDER_MODULE to the provider module under test");
const { a2ajLegalSourceProvider } = await import(process.env.LEGAL_SOURCE_PROVIDER_MODULE);
const hits = await a2ajLegalSourceProvider.search({
  text: "child support", kinds: ["legislation"], language: "en", perProviderLimit: 5,
  collection: "LEGISLATION-BC",
});
console.log("hits:", JSON.stringify((hits ?? []).map((h) => ({ c: h.citation, d: h.collection, u: (h.url ?? "").slice(0, 60) }))));
const first = (hits ?? [])[0];
if (first) {
  const lookup = await a2ajLegalSourceProvider.lookup({
    citation: first.citation, docType: "laws", language: "en", kind: "section", locator: "1",
  });
  console.log("lookup:", JSON.stringify({ status: lookup?.status, url: lookup?.url, keys: lookup ? Object.keys(lookup) : null }));
  const src = lookup?.status === "found" ? a2ajLegalSourceProvider.source(lookup) : null;
  console.log("blocks:", (src?.blocks ?? []).slice(0, 6).map((b) => ({ k: b.kind, l: b.label, t: src.text.slice(b.start, b.end).replace(/\s+/gu, " ").slice(0, 70) })));
}
