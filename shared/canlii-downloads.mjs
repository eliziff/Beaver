// Filename recognition only. Each app decides which cases it may attach or add.
export const CANLII_PDF_NAME = /^(\d{4})([a-z]{2,10})(\d{1,5})(?: ?\(\d+\))?\.pdf$/iu;
export const canliiDownloadKey = citation => String(citation || '')
  .replace(/\s*\([^)]*\)\s*$/u, '').normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
  .toLowerCase().replace(/[^a-z0-9]/gu, '');

/** Newest top-level download per filename citation; browser duplicate suffixes are ignored. */
export function canliiDownloads(files) {
  const best = new Map();
  for (const file of files) {
    const match = CANLII_PDF_NAME.exec(file.name);
    if (!match || (file.webkitRelativePath || '').split('/').length > 2) continue;
    const citation = `${match[1]} ${match[2].toUpperCase()} ${match[3]}`;
    if (!best.has(citation) || file.lastModified > best.get(citation).lastModified) best.set(citation, file);
  }
  return [...best].map(([citation, file]) => ({ citation, file }));
}

/** Match only the supplied candidates; an ambiguous alias never picks an arbitrary record. */
export function matchCanliiDownloads(files, candidates) {
  const wanted = new Map(), best = new Map();
  for (const { record, citations } of candidates) for (const citation of citations) {
    const key = canliiDownloadKey(citation);
    if (!key) continue;
    const previous = wanted.get(key);
    wanted.set(key, previous === undefined || previous === record ? record : null);
  }
  for (const { citation, file } of canliiDownloads(files)) {
    const record = wanted.get(canliiDownloadKey(citation));
    if (record && (!best.has(record) || file.lastModified > best.get(record).lastModified)) best.set(record, file);
  }
  return [...best].map(([record, file]) => ({ record, file }));
}
