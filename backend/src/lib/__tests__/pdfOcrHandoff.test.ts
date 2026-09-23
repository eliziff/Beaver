import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { sha256 } from '../hash';
import type { NativePdfTextPage } from '../structureNative';

it('retains disjoint OCR passes through the worker, SQLite reopen and authorized text-layer route', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-handoff-'));
  vi.stubEnv('AUTH_MODE', 'local'); vi.stubEnv('MIKE_LOCAL_DATA_DIR', root);
  const scope = { userId: '00000000-0000-0000-0000-000000000001' };
  const artifacts = new Map<string, { sha256: string; pages: NativePdfTextPage[] }>();
  const prepare = vi.fn(async (bytes: Buffer, input: { pages?: number[]; ocr?: unknown }) => {
    const pages = input.ocr ? input.pages ?? [1, 2, 3] : [];
    const key = sha256(JSON.stringify([sha256(bytes), pages]));
    artifacts.set(key, { sha256: sha256(bytes), pages: pages.map(pageNumber => ({ pageNumber,
      width: 400, height: 500, lines: [{ id: `${pageNumber}-1`, rect: [40, 60, 240, 75],
        words: [{ text: `Recognized page ${pageNumber}`, rect: [40, 60, 240, 75] }] }] })) });
    return { sha256: sha256(bytes), cacheKey: key, parserVersion: 'test', status: pages.length === 3 ? 'ready' : 'degraded',
      pageCount: 3, projectionPageCount: input.pages?.length ?? 3,
      pagesNeedingOcr: [0, 1, 2].filter(page => !pages.includes(page + 1)), ocrRoutedPages: pages.map(page => page - 1) };
  });
  const restore = vi.fn(async (input: { cache_key: string; expected_source_sha256: string }) => {
    const artifact = artifacts.get(input.cache_key);
    return artifact?.sha256 === input.expected_source_sha256 ? artifact : null;
  });
  vi.doMock('../structureNative', () => ({ structureNative: () => ({ preparePdfDocument: prepare,
    restorePdfDocument: restore,
    pdfRecognizedText: (artifact: { pages: NativePdfTextPage[] }, pages?: number[]) =>
      artifact.pages.filter(page => !pages || pages.includes(page.pageNumber)),
  }) }));
  const [{ createDocumentApplication }, { documentRepository }, { filesystemDocumentObjects },
    queue, { pdfJobHandlers }, db, { createDocumentsRouter }] = await Promise.all([
    import('../documentApplication'), import('../relationalDocumentRepository'), import('../filesystemObjectStorage'),
    import('../jobQueue'), import('../pdfJobs'), import('../relationalDatabase'), import('../../routes/documentRoutes'),
  ]);
  const documents = createDocumentApplication(documentRepository, filesystemDocumentObjects());
  const worker = queue.startJobWorker(pdfJobHandlers(documents));
  try {
    const file = await documents.create(scope, { filename: 'scan.pdf', fileType: 'pdf',
      bytes: Buffer.from('%PDF-1.7\nthree page scan'), pdfOcrProvider: null });
    const original = await vi.waitFor(async () => {
      const source = await documents.projectionSource(scope, file.id, file.current_version_id);
      expect(source?.pdfProfile).toBeDefined(); return source!.pdfProfile!;
    });
    const { enqueuePdfReprocess } = await import('../pdfJobs');
    for (const page of [2, 1]) {
      const job = await enqueuePdfReprocess({ userId: scope.userId, documentId: file.id,
        versionId: file.current_version_id, sourceSha256: file.source_sha256,
        ocrProvider: 'tesseract', layout: false, pages: [page] });
      await vi.waitFor(async () => expect((await queue.getJob(job.id, scope.userId))?.status).toBe('succeeded'));
    }
    const source = (await documents.projectionSource(scope, file.id, file.current_version_id))!;
    expect(source.pdfProfile).toMatchObject(original);
    expect(Object.keys(source.pdfProfile!.textLayerPages ?? {})).toEqual(['1', '2']);
    // A lower-priority whole-document native pass must not erase the completed OCR slices.
    await documents.recordPdfPreparation(scope, file.id, { versionId: file.current_version_id,
      sourceSha256: file.source_sha256, pageCount: 3, pdfProfile: original });
    await worker.stop(); await db.closeRelationalDatabase();
    const reader = createDocumentApplication(documentRepository, filesystemDocumentObjects());
    const resolve = reader.projectionSource;
    reader.projectionSource = async (...args) => {
      const result = await resolve(...args);
      return result && { ...result, readBytes: () => { throw Error('Text-layer GET reread the PDF'); } };
    };
    const api = express(); api.use(createDocumentsRouter({} as never, reader));
    const readsBefore = prepare.mock.calls.length;
    const read = () => request(api).get(`/${file.id}/pdf-text-layer?version_id=${file.current_version_id}`);
    const url = `/${file.id}/pdf-text-layer?version_id=${file.current_version_id}`;
    restore.mockClear();
    const selected = await Promise.all([request(api).get(`${url}&pages=2`).expect(200),
      request(api).get(`${url}&pages=2`).expect(200)]);
    expect(selected.map(response => response.body.pages.map((page: NativePdfTextPage) => page.pageNumber))).toEqual([[2], [2]]);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls[0][0].cache_key).toBe(source.pdfProfile!.textLayerPages!['2']);
    await request(api).get(`${url}&pages=0`).expect(400);
    await request(api).get(`${url}&pages=2&source_sha256=${'0'.repeat(64)}`).expect(409);
    const response = await read().expect(200);
    expect(response.body.pages.map((page: NativePdfTextPage) => page.pageNumber)).toEqual([1, 2]);
    expect(response.body.pages[1].lines[0].words[0].text).toBe('Recognized page 2');
    expect(prepare).toHaveBeenCalledTimes(readsBefore);
    // Missing cached recognition is an error, not permission to launch OCR in a reader.
    await documents.recordPdfPreparation(scope, file.id, { versionId: file.current_version_id,
      sourceSha256: file.source_sha256, pageCount: 3, textOnly: true,
      pdfProfile: { ...original, textLayerPages: { '2': 'f'.repeat(64) } } });
    await request(api).get(`${url}&pages=1`).expect(200); // An unrelated missing slice cannot block this page.
    await read().expect(409);
    expect(prepare).toHaveBeenCalledTimes(readsBefore);
    await request(api).get(`/missing/pdf-text-layer`).expect(404);
  } finally {
    await worker.stop(); await db.closeRelationalDatabase();
    vi.doUnmock('../structureNative'); vi.unstubAllEnvs(); vi.resetModules();
    await rm(root, { recursive: true, force: true });
  }
});
