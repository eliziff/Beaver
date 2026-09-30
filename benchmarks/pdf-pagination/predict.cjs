const fs = require('node:fs'), path = require('node:path');
process.env.MIKE_LOCAL_DATA_DIR = path.resolve('tmp/pdf-pagination/projections');
const { documentProjectionService: service } = require('../../backend/dist/lib/documentProjectionService');
const { reporterStartPages } = require('../../backend/dist/lib/pdfPagination');
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
  for (const row of rows) {
    const target = path.join(process.argv[3], row.sha256 + '.prediction.json');
    if (fs.existsSync(target)) continue;
    try {
      const start = performance.now();
      const source = { documentId: row.sha256, versionId: row.sha256, sourceSha256: row.sha256,
        fileType: 'pdf', readBytes: () => fs.readFileSync(row.path) };
      const citations = row.category === 'case' ? [row.title || ''] : [];
      const starts = reporterStartPages(citations);
      const bindings = await service.pdfPagination(source, citations);
      const anchor = bindings.find(entry => entry.observed && starts.includes(Number(entry.observed)));
      fs.writeFileSync(target, JSON.stringify({ bindings, starts, anchor: anchor?.pdfPage ?? null,
        elapsedMs: performance.now() - start }));
      console.log(JSON.stringify({ id: row.sha256.slice(0,12), pages: bindings.length, anchor: anchor?.pdfPage }));
    } catch (error) { fs.writeFileSync(target, JSON.stringify({ error: String(error) })); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
