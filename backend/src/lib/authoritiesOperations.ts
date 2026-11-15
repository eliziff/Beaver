/** Authorities' operations: every app's (authoritiesSourceOperations.ts), with the book of authorities' own: a source read
 *  as the book reads it, an excerpt's pages, a source's highlights, the book's front, a book
 *  part attached, and the book built. Its sources' step typesets a PDF from a provider's text where there is no original. */
import { docxToPdf, wordToPdfAvailable } from "./convert";
import { AUTHORITIES_BOOK_SLOTS } from "mike/shared/authorities-sources.mjs";
import { reject } from "./applicationError";
import { excerptPageCounts } from "./authoritiesBuild";
import { structureNative } from "./structureNative";
import { authorityStatuteText, bookSourceServices, gatherAuthoritySources, resolveAuthoritiesSources,
  type PreparedAuthoritySource } from "./authoritiesBookSources";
import { authoritiesSourceText, createAuthoritiesPreparation } from "./authoritiesPreparation";
import { attachBookFile, authoritiesBookFrontPdf, authorityAnnotations, buildAuthoritiesDraft } from "./authoritiesBookCore";
import { sha256 } from "./hash";
import { decodeAuthoritiesUserAction } from "./authoritiesActionContract";
import { createAuthoritiesSourceOperations, draft, fileResult, givenSource, inRuns, json, keptByPage, requiredSource,
  sourceBytes, standaloneSource, value, type OperationContext, type OperationsOptions } from "./authoritiesSourceOperations";
import { text } from "./authoritiesActionContract";
import type { AuthoritiesDraft } from "./authoritiesDomain";
import type { AuthoritiesOperationInput, AuthoritiesRuntimeResult } from "mike/shared/runtime/authoritiesRuntime.mjs";

const MAX_BUILD_INPUT_BYTES = 512 * 1024 * 1024;

/** A draft and the PDFs its sources' step fetched or typeset for the book, for the page to keep. */
const draftResult = (data: AuthoritiesDraft, attachments: PreparedAuthoritySource[]): AuthoritiesRuntimeResult => ({ data, attachments });

export function assertAuthoritiesBuildUploadSize(
  files: ReadonlyArray<{ size: number }>,
) {
  if (files.reduce((total, file) => total + file.size, 0) > MAX_BUILD_INPUT_BYTES)
    reject(413, "Authorities build files are too large together. Maximum total is 512 MB.");
}

export function createAuthoritiesOperations(options: OperationsOptions = {}) {
  const { citedCases = "resolve" } = options, services = { ...bookSourceServices, ...options.services };
  const shared = createAuthoritiesSourceOperations(options);
  return { ...shared, ...inRuns({
    // Every app's lookups, and then each authority's PDF fetched or, where there is no original, typeset from its
    // provider's text for the book, kept by the page and attached with its page count and printed page numbers.
    "sources": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
      const progress = context.progress;
    const current = draft(input?.draft);
    const onlyAuthorityId = input?.authorityId === undefined
      ? undefined : text(input.authorityId, 200);
    const gathered = await gatherAuthoritySources(current, { progress, signal: context.signal,
      resolve: (state) => resolveAuthoritiesSources(state, { ...services, render: (source) => structureNative().renderSourcePdf(source) }, context.signal,
        onlyAuthorityId, progress, input?.keptOnly === true, citedCases),
      keep: async (attachments) => attachments.map(({ filename, bytes, sourceSha256 }) =>
        keptByPage(filename, bytes, sourceSha256, `stored:${sourceSha256}`)) });
    return draftResult(gathered.draft, gathered.attachments);
    },
    "source-read": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
      const progress = context.progress;
    const state = draft(json(input?.draft, "draft"));
    const role = String(input?.role), bytes = sourceBytes(requiredSource(input));
    const { source } = givenSource(state, role, bytes);
    await createAuthoritiesPreparation(state).prepareText(role, { bytes, sourceSha256: source.sourceSha256,
      signal: context.signal, ...(progress ? { progress: (done: number, total: number) => progress(`${done}/${total}`) } : {}) });
    return value({});
    },
    // The source is read as a build reads it, so a source read ahead or built is not read again; the page has no
    // recognition queue of its own, so reading it recognizes what the draft's scan setting asks for.
    "annotations": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const state = draft(json(input?.draft, "draft")), bytes = sourceBytes(requiredSource(input));
    const { authority, source } = givenSource(state, String(input?.bindingRole), bytes);
    return value(await authorityAnnotations(state, { authorityId: authority.id, bindingRole: source.bindingRole, bytes,
      recognize: true, signal: context.signal }));
    },
    "book-front": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const actions = Array.isArray(input?.actions) && input.actions.length <= 3 ? input.actions as unknown[]
      : reject(400, "actions are invalid");
    // The pages each excerpted authority keeps, as "excerpt-pages" counted them in the runtime that reads sources.
    const counted = input?.excerptPages === undefined ? {} : typeof input.excerptPages === "string"
      ? json(input.excerptPages, "excerptPages") : input.excerptPages;
    const excerptPages = counted && typeof counted === "object" && Object.values(counted).every((pages) =>
      Number.isSafeInteger(pages) && (pages as number) > 0) ? counted as Record<string, number> : reject(400, "excerptPages is invalid");
    return fileResult(null, [{ role: "output", mimeType: "application/pdf",
      bytes: await authoritiesBookFrontPdf(draft(input?.draft), actions.map(decodeAuthoritiesUserAction),
        String(input?.title ?? ""), excerptPages) }]);
    },
    // An excerpt's pages for the index preview, one PDF at a time: the PDF given is read as a build reads
    // it (a build then finds it read), and its authority's pages counted once all its PDFs are read.
    "excerpt-pages": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const state = draft(json(input?.draft, "draft"));
    const role = String(input?.role), bytes = sourceBytes(requiredSource(input));
    const { authority, source } = givenSource(state, role, bytes);
    const read = authoritiesSourceText(state);
    const own = await read(role, { bytes, sourceSha256: source.sourceSha256, signal: context.signal });
    const counts = await excerptPageCounts(state, async (item) => item.bindingRole === role ? own : read(item.bindingRole,
      { sourceSha256: item.sourceSha256, signal: context.signal } as Parameters<typeof read>[1]).catch(() => null), authority.id);
    return value({ authorityId: authority.id, pages: counts[authority.id] ?? null });
    },
    // A book part (cover, index, brief, supplement) is the book's; an authority's PDF is attached as every app attaches it.
    "pdf": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    if (input?.authority_id !== undefined) return shared.pdf(input, context);
    const current = draft(json(input?.draft, "draft"));
    const { filename, fileType, bytes, modified } = await standaloneSource(input);
    if (!filename.trim() || filename.length > 500 || /[\u0000-\u001f\u007f]/u.test(filename) ||
        fileType !== "pdf" || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") reject(400, "Add a valid PDF");
    const keep = async () => ({ binding: { kind: "local-file" as const, handleId: "standalone",
      lastSeen: { name: filename, size: bytes.length, modified, sha256: sha256(bytes) } } });
    const slot = AUTHORITIES_BOOK_SLOTS.find(value => value === input?.slot)
      ?? reject(400, "Book-part slot is invalid");
    const supplementId = input?.supplement_id;
    if (supplementId !== undefined && (typeof supplementId !== "string" || !supplementId.trim() ||
        supplementId.length > 500)) reject(400, "Book-part ID is invalid");
    return value(await attachBookFile(current, { slot, supplementId: supplementId as string | undefined,
      filename, bytes, keep }));
    },
    "build": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
      const progress = context.progress;
    let raw: unknown, roles: unknown;
    try { raw = json(input?.draft, "draft"); roles = json(input?.roles, "roles"); }
    catch { reject(400, "draft and roles must be JSON"); }
    const state = draft(raw);
    const files = Array.isArray(input.files) ? input.files : [];
    assertAuthoritiesBuildUploadSize(files.map(file => ({ size: file.bytes.length })));
    if (!Array.isArray(roles) || roles.length !== files.length ||
        !roles.every((role) => typeof role === "string" && role.length <= 300))
      reject(400, "Authorities build inputs are invalid");
    const roleNames = roles as string[];
    if (new Set(roleNames).size !== roleNames.length) reject(400, "Duplicate source roles are invalid");
    const id = String(input?.id ?? ""), revision = Number(input?.revision);
    const title = String(input?.title ?? "").trim();
    if (!id || !title || title.length > 300 || !Number.isSafeInteger(revision) || revision < 1)
      reject(400, "Authorities build identity is invalid");
    const buildFiles = files.map((file, index) => {
      const role = roleNames[index], bytes = sourceBytes(file), binding = state.bindings[role];
      const expectedHash = binding?.kind === "local-file" ? binding.lastSeen.sha256
        : binding?.kind === "document" && binding.version !== "latest" ? binding.version.sha256 : null;
      const sourceSha256 = expectedHash && sha256(bytes) === expectedHash ? expectedHash
        : reject(409, "An attached PDF changed. Add the current file before continuing.");
      return { role, filename: file.filename, bytes, sourceSha256 };
    });
    const { built } = await buildAuthoritiesDraft(state, { title, workProduct: { id, revision }, files: buildFiles,
      signal: context.signal, progress,
      statuteText: (authority, signal) => authorityStatuteText(state, authority, services, signal),
      ...(wordToPdfAvailable() ? { finalPdfSource: async (bytes: Uint8Array) => docxToPdf(Buffer.from(bytes)) } : {}) });
    const artifacts = Object.values(built.artifacts).filter((artifact) => artifact !== undefined);
    return fileResult({ receipt: built.receipt }, artifacts);
    },
  }) };
}
