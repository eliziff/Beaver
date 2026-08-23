export function seedDocumentKey(seed) {
  const label = typeof seed === "string" ? seed : seed.label;
  const dataset = typeof seed === "string" ? label.split("_", 1)[0] : seed.dataset;
  const rest = dataset && label.startsWith(`${dataset}_`) ? label.slice(dataset.length + 1) : label;
  return rest.match(/^(.*?)_(?:p\d+|sec[^_]*)_/u)?.[1];
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}`) {
  console.assert(seedDocumentKey("BCCA_2008_BCCA_283_p85_short-exact") === "2008_BCCA_283");
  console.assert(seedDocumentKey({ dataset: "LEGISLATION-AB", label: "LEGISLATION-AB_RSA_2000_c_M-26_sec1(1)_short-exact" }) === "RSA_2000_c_M-26");
}
