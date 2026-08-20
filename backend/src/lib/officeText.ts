import { assertBoundedZip, loadZip, readZipEntry, zipReadBudget } from "./zip";
import { decodeXmlText as decodeXml } from "./text";

function extractTagText(xml: string, tagName: string) {
  const parts: string[] = [];
  const re = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) parts.push(decodeXml(match[1]));
  return parts;
}

export async function extractPresentationText(buffer: Buffer) {
  const zip = await loadZip(buffer);
  assertBoundedZip(zip, "Presentation", {
    maxEntries: 10_000, maxExpandedBytes: 256 * 1024 * 1024,
    selected: { test: /^ppt\/slides\/slide\d+\.xml$/iu, maxEntryBytes: 8 * 1024 * 1024,
      maxBytes: 64 * 1024 * 1024, name: "slide XML" },
  });
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => left.localeCompare(
      right, undefined, { numeric: true, sensitivity: "base" }));

  const slides: string[] = [];
  const budget = zipReadBudget(64 * 1024 * 1024);
  for (let index = 0; index < slidePaths.length; index++) {
    const entry = zip.file(slidePaths[index]);
    const xml = entry ? (await readZipEntry(entry, 8 * 1024 * 1024, budget,
      "Presentation slide XML")).toString("utf8") : null;
    if (!xml) continue;
    const text = extractTagText(xml, "a:t")
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n");
    if (text) slides.push(`## Slide ${index + 1}\n\n${text}`);
  }
  return slides.join("\n\n").trim();
}
