import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canliiDownloads, matchCanliiDownloads } from './canlii-downloads.mjs';
test('downloads keep unknown citations discoverable but matches never create candidates', () => {
  const old = { name: '1991canlii104.pdf', lastModified: 1 };
  const latest = { name: '1991canlii104 (1).pdf', lastModified: 2 };
  const other = { name: '2024scc1.pdf', lastModified: 3 };
  const nested = { name: '2024scc2.pdf', lastModified: 4, webkitRelativePath: 'Downloads/subfolder/2024scc2.pdf' };
  const record = { id: 'swain' };
  assert.deepEqual(canliiDownloads([old, latest, other, nested]), [
    { citation: '1991 CANLII 104', file: latest }, { citation: '2024 SCC 1', file: other },
  ]);
  assert.deepEqual(matchCanliiDownloads([old, latest, other], [
    { record, citations: ['1991 CanLII 104 (SCC)'] },
  ]), [{ record, file: latest }]);
  assert.deepEqual(matchCanliiDownloads([latest], [
    { record, citations: ['1991 CanLII 104 (SCC)'] },
    { record: { id: 'ambiguous' }, citations: ['1991 CanLII 104'] },
  ]), []);
});
