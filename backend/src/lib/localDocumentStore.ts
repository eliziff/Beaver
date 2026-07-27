import crypto from "node:crypto";
import path from "node:path";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { docxToPdf } from "./convert";
import {
  ALLOWED_DOCUMENT_TYPES,
  shouldConvertToPdf,
} from "./documentTypes";
import { mikeLocalDataHome } from "./legalDataPath";
import { isImageDocumentType, validateImageBytes } from "./llm/images";
import {
  queueLocalPdfParse,
  removeLocalPdfParseArtifacts,
} from "./localPdfIngestion";

export type LocalLibraryKind = "file" | "template";

export type LocalLegalSourcePointer = {
  id: string;
  userId: string;
  provider: "a2aj" | "journal";
  docType: "cases" | "laws" | "articles";
  citation: string;
  language: "en" | "fr";
  dataset: string | null;
  sourceId?: string | null;
};

type LocalVersion = {
  id: string;
  versionNumber: number;
  source: "upload" | "user_upload";
  createdAt: string;
  filename: string;
  fileType: string;
  sizeBytes: number;
  pageCount: number | null;
  storagePath: string;
  pdfStoragePath: string | null;
  sourceSha256?: string;
};

type LocalDocument = {
  id: string;
  userId: string;
  kind: LocalLibraryKind;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
  currentVersionId: string;
  versions: LocalVersion[];
};

type LocalFolder = {
  id: string;
  userId: string;
  kind: LocalLibraryKind;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
};

type LocalStore = {
  version: 1;
  documents: LocalDocument[];
  folders: LocalFolder[];
  legalSources: LocalLegalSourcePointer[];
};

const dataRoot = mikeLocalDataHome();
const indexPath = path.join(dataRoot, "library.json");
let mutationTail: Promise<unknown> = Promise.resolve();

function emptyStore(): LocalStore {
  return { version: 1, documents: [], folders: [], legalSources: [] };
}

async function readStore(): Promise<LocalStore> {
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as Partial<LocalStore>;
    return {
      version: 1,
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      legalSources: Array.isArray(parsed.legalSources)
        ? parsed.legalSources
        : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(store: LocalStore) {
  await mkdir(dataRoot, { recursive: true });
  const temporaryPath = `${indexPath}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), "utf8");
  await rename(temporaryPath, indexPath);
}

function mutateStore<T>(operation: (store: LocalStore) => Promise<T> | T): Promise<T> {
  const result = mutationTail.then(async () => {
    const store = await readStore();
    const value = await operation(store);
    await writeStore(store);
    return value;
  });
  mutationTail = result.catch(() => undefined);
  return result;
}

async function currentStore() {
  await mutationTail;
  return readStore();
}

function suffixFor(filename: string) {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

function activeVersion(document: LocalDocument) {
  const version =
    document.versions.find((version) => version.id === document.currentVersionId) ??
    document.versions[document.versions.length - 1];
  if (!version) throw new Error("Local document has no versions");
  return version;
}

function absoluteDataPath(relativePath: string) {
  const resolved = path.resolve(dataRoot, relativePath);
  if (resolved !== dataRoot && !resolved.startsWith(`${dataRoot}${path.sep}`)) {
    throw new Error("Invalid local document path");
  }
  return resolved;
}

async function writeVersionFiles(
  documentId: string,
  versionId: string,
  filename: string,
  bytes: Buffer,
) {
  const suffix = suffixFor(filename);
  if (!ALLOWED_DOCUMENT_TYPES.has(suffix)) {
    throw new Error(`Unsupported file type: ${suffix || "unknown"}`);
  }
  if (isImageDocumentType(suffix)) validateImageBytes(filename, bytes);

  const sourceSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const relativeDirectory = path.join("files", documentId);
  const relativeSource = path.join(
    relativeDirectory,
    `${versionId}-${sourceSha256.slice(0, 16)}.${suffix}`,
  );
  await mkdir(absoluteDataPath(relativeDirectory), { recursive: true });
  await writeFile(absoluteDataPath(relativeSource), bytes);

  let relativePdf: string | null = suffix === "pdf" ? relativeSource : null;
  if (shouldConvertToPdf(suffix)) {
    try {
      const pdf = await docxToPdf(bytes);
      const pdfHash = crypto.createHash("sha256").update(pdf).digest("hex");
      relativePdf = path.join(
        relativeDirectory,
        `${versionId}-${pdfHash.slice(0, 16)}.pdf`,
      );
      await writeFile(absoluteDataPath(relativePdf), pdf);
    } catch (error) {
      console.warn("[local-library] Office to PDF conversion unavailable", {
        filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { suffix, relativeSource, relativePdf, sourceSha256 };
}

async function queueVersionPdf(
  documentId: string,
  version: LocalVersion,
  response: Record<string, unknown>,
) {
  if (version.fileType !== "pdf") return response;
  const pdfParse = await queueLocalPdfParse({
    documentId,
    versionId: version.id,
    sourcePath: absoluteDataPath(version.storagePath),
    sourceSha256: version.sourceSha256,
  });
  return { ...response, pdf_parse: pdfParse };
}

export function localDocumentResponse(document: LocalDocument) {
  const version = activeVersion(document);
  return {
    id: document.id,
    user_id: document.userId,
    project_id: null,
    library_kind: document.kind,
    library_folder_id: document.folderId,
    folder_id: document.folderId,
    filename: version.filename,
    file_type: version.fileType,
    storage_path: version.storagePath,
    pdf_storage_path: version.pdfStoragePath,
    size_bytes: version.sizeBytes,
    page_count: version.pageCount,
    source_sha256: version.sourceSha256,
    status: "ready",
    current_version_id: document.currentVersionId,
    active_version_number: version.versionNumber,
    latest_version_number: Math.max(...document.versions.map((item) => item.versionNumber)),
    created_at: document.createdAt,
    updated_at: document.updatedAt,
  };
}

function localFolderResponse(folder: LocalFolder) {
  return {
    id: folder.id,
    user_id: folder.userId,
    library_kind: folder.kind,
    name: folder.name,
    parent_folder_id: folder.parentFolderId,
    created_at: folder.createdAt,
    updated_at: folder.updatedAt,
  };
}

export function localVersionResponse(version: LocalVersion) {
  return {
    id: version.id,
    version_number: version.versionNumber,
    source: version.source,
    created_at: version.createdAt,
    filename: version.filename,
    file_type: version.fileType,
    size_bytes: version.sizeBytes,
    page_count: version.pageCount,
    source_sha256: version.sourceSha256,
    deleted_at: null,
    deleted_by: null,
  };
}

export async function listLocalLibrary(userId: string, kind: LocalLibraryKind) {
  const store = await currentStore();
  return {
    documents: store.documents
      .filter((document) => document.userId === userId && document.kind === kind)
      .map(localDocumentResponse),
    folders: store.folders
      .filter((folder) => folder.userId === userId && folder.kind === kind)
      .map(localFolderResponse),
  };
}

export async function createLocalDocument(params: {
  userId: string;
  kind: LocalLibraryKind;
  filename: string;
  bytes: Buffer;
}) {
  const saved = await mutateStore(async (store) => {
    const now = new Date().toISOString();
    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const files = await writeVersionFiles(
      documentId,
      versionId,
      params.filename,
      params.bytes,
    );
    const version: LocalVersion = {
      id: versionId,
      versionNumber: 1,
      source: "upload",
      createdAt: now,
      filename: params.filename.slice(0, 200),
      fileType: files.suffix,
      sizeBytes: params.bytes.byteLength,
      pageCount: null,
      storagePath: files.relativeSource,
      pdfStoragePath: files.relativePdf,
      sourceSha256: files.sourceSha256,
    };
    const document: LocalDocument = {
      id: documentId,
      userId: params.userId,
      kind: params.kind,
      folderId: null,
      createdAt: now,
      updatedAt: now,
      currentVersionId: versionId,
      versions: [version],
    };
    store.documents.push(document);
    return { document, version };
  });
  return queueVersionPdf(
    saved.document.id,
    saved.version,
    localDocumentResponse(saved.document),
  );
}

export async function getLocalDocument(userId: string, documentId: string) {
  const store = await currentStore();
  return (
    store.documents.find(
      (document) => document.id === documentId && document.userId === userId,
    ) ?? null
  );
}

export async function getLocalVersionFile(
  userId: string,
  documentId: string,
  versionId?: string | null,
  preferPdf = false,
) {
  const document = await getLocalDocument(userId, documentId);
  if (!document) return null;
  const version = versionId
    ? document.versions.find((item) => item.id === versionId)
    : activeVersion(document);
  if (!version) return null;
  const relativePath = preferPdf && version.pdfStoragePath
    ? version.pdfStoragePath
    : version.storagePath;
  return {
    document: localDocumentResponse(document),
    version: localVersionResponse(version),
    path: absoluteDataPath(relativePath),
    fileType:
      preferPdf && version.pdfStoragePath ? "pdf" : version.fileType,
  };
}

export async function getLocalVersionFiles(
  userId: string,
  documentIds: Iterable<string>,
) {
  const wanted = new Set(documentIds);
  const store = await currentStore();
  return new Map(
    store.documents
      .filter(
        (document) =>
          document.userId === userId && wanted.has(document.id),
      )
      .map((document) => {
        const version = activeVersion(document);
        return [
          document.id,
          {
            path: absoluteDataPath(version.storagePath),
            fileType: version.fileType,
            filename: version.filename,
          },
        ] as const;
      }),
  );
}

export async function listLocalVersions(userId: string, documentId: string) {
  const document = await getLocalDocument(userId, documentId);
  if (!document) return null;
  return {
    current_version_id: document.currentVersionId,
    versions: document.versions.map(localVersionResponse),
  };
}

export async function addLocalVersion(params: {
  userId: string;
  documentId: string;
  filename: string;
  bytes: Buffer;
}) {
  const saved = await mutateStore(async (store) => {
    const document = store.documents.find(
      (item) => item.id === params.documentId && item.userId === params.userId,
    );
    if (!document) return null;
    const versionId = crypto.randomUUID();
    const files = await writeVersionFiles(
      document.id,
      versionId,
      params.filename,
      params.bytes,
    );
    const version: LocalVersion = {
      id: versionId,
      versionNumber:
        Math.max(...document.versions.map((item) => item.versionNumber)) + 1,
      source: "user_upload",
      createdAt: new Date().toISOString(),
      filename: params.filename.slice(0, 200),
      fileType: files.suffix,
      sizeBytes: params.bytes.byteLength,
      pageCount: null,
      storagePath: files.relativeSource,
      pdfStoragePath: files.relativePdf,
      sourceSha256: files.sourceSha256,
    };
    document.versions.push(version);
    document.currentVersionId = version.id;
    document.updatedAt = version.createdAt;
    return { document, version };
  });
  if (!saved) return null;
  return queueVersionPdf(
    saved.document.id,
    saved.version,
    localVersionResponse(saved.version),
  );
}

export async function renameLocalVersion(
  userId: string,
  documentId: string,
  versionId: string,
  filename: string,
) {
  return mutateStore((store) => {
    const document = store.documents.find(
      (item) => item.id === documentId && item.userId === userId,
    );
    const version = document?.versions.find((item) => item.id === versionId);
    if (!document || !version) return null;
    version.filename = filename.slice(0, 200);
    document.updatedAt = new Date().toISOString();
    return localVersionResponse(version);
  });
}

export async function replaceLocalVersion(params: {
  userId: string;
  documentId: string;
  versionId: string;
  filename: string;
  bytes: Buffer;
}) {
  const saved = await mutateStore(async (store) => {
    const document = store.documents.find(
      (item) => item.id === params.documentId && item.userId === params.userId,
    );
    const version = document?.versions.find((item) => item.id === params.versionId);
    if (!document || !version) return null;
    const nextSuffix = suffixFor(params.filename);
    if (nextSuffix !== version.fileType) return null;
    const previousPaths = new Set(
      [version.storagePath, version.pdfStoragePath].filter(
        (item): item is string => !!item,
      ),
    );
    const files = await writeVersionFiles(
      document.id,
      version.id,
      params.filename,
      params.bytes,
    );
    version.filename = params.filename.slice(0, 200);
    version.sizeBytes = params.bytes.byteLength;
    version.createdAt = new Date().toISOString();
    version.storagePath = files.relativeSource;
    version.pdfStoragePath = files.relativePdf;
    version.sourceSha256 = files.sourceSha256;
    document.updatedAt = version.createdAt;
    const nextPaths = new Set(
      [version.storagePath, version.pdfStoragePath].filter(
        (item): item is string => !!item,
      ),
    );
    await Promise.all(
      [...previousPaths]
        .filter((item) => !nextPaths.has(item))
        .flatMap((item) => {
          const absolute = absoluteDataPath(item);
          return [
            rm(absolute, { force: true }),
            removeLocalPdfParseArtifacts(absolute),
          ];
        }),
    );
    return { document, version };
  });
  if (!saved) return null;
  return queueVersionPdf(
    saved.document.id,
    saved.version,
    localVersionResponse(saved.version),
  );
}

export async function deleteLocalVersion(
  userId: string,
  documentId: string,
  versionId: string,
) {
  return mutateStore(async (store) => {
    const document = store.documents.find(
      (item) => item.id === documentId && item.userId === userId,
    );
    if (!document) return { status: "missing" as const };
    if (document.versions.length <= 1) return { status: "only" as const };
    const index = document.versions.findIndex((item) => item.id === versionId);
    if (index < 0) return { status: "missing" as const };
    const [removed] = document.versions.splice(index, 1);
    if (document.currentVersionId === versionId) {
      document.currentVersionId = document.versions
        .slice()
        .sort((a, b) => b.versionNumber - a.versionNumber)[0].id;
    }
    document.updatedAt = new Date().toISOString();
    await Promise.all(
      [...new Set([removed.storagePath, removed.pdfStoragePath])]
        .filter((item): item is string => !!item)
        .flatMap((item) => {
          const absolute = absoluteDataPath(item);
          return [
            rm(absolute, { force: true }),
            removeLocalPdfParseArtifacts(absolute),
          ];
        }),
    );
    return {
      status: "deleted" as const,
      currentVersionId: document.currentVersionId,
    };
  });
}

export async function renameLocalDocument(
  userId: string,
  kind: LocalLibraryKind,
  documentId: string,
  filename: string,
) {
  return mutateStore((store) => {
    const document = store.documents.find(
      (item) =>
        item.id === documentId && item.userId === userId && item.kind === kind,
    );
    if (!document) return null;
    activeVersion(document).filename = filename.slice(0, 200);
    document.updatedAt = new Date().toISOString();
    return localDocumentResponse(document);
  });
}

export async function moveLocalDocument(
  userId: string,
  kind: LocalLibraryKind,
  documentId: string,
  folderId: string | null,
) {
  return mutateStore((store) => {
    const document = store.documents.find(
      (item) =>
        item.id === documentId && item.userId === userId && item.kind === kind,
    );
    const folder = folderId
      ? store.folders.find(
          (item) =>
            item.id === folderId && item.userId === userId && item.kind === kind,
        )
      : null;
    if (!document || (folderId && !folder)) return null;
    document.folderId = folderId;
    document.updatedAt = new Date().toISOString();
    return localDocumentResponse(document);
  });
}

export async function deleteLocalDocument(userId: string, documentId: string) {
  return mutateStore(async (store) => {
    const index = store.documents.findIndex(
      (document) => document.id === documentId && document.userId === userId,
    );
    if (index < 0) return false;
    store.documents.splice(index, 1);
    if (/^[a-f0-9-]{36}$/i.test(documentId)) {
      await rm(absoluteDataPath(path.join("files", documentId)), {
        recursive: true,
        force: true,
      });
    }
    return true;
  });
}

export async function createLocalFolder(
  userId: string,
  kind: LocalLibraryKind,
  name: string,
  parentFolderId: string | null,
) {
  return mutateStore((store) => {
    if (
      parentFolderId &&
      !store.folders.some(
        (folder) =>
          folder.id === parentFolderId &&
          folder.userId === userId &&
          folder.kind === kind,
      )
    ) {
      return null;
    }
    const now = new Date().toISOString();
    const folder: LocalFolder = {
      id: crypto.randomUUID(),
      userId,
      kind,
      name: name.slice(0, 200),
      parentFolderId,
      createdAt: now,
      updatedAt: now,
    };
    store.folders.push(folder);
    return localFolderResponse(folder);
  });
}

export async function updateLocalFolder(params: {
  userId: string;
  kind: LocalLibraryKind;
  folderId: string;
  name?: string;
  parentFolderId?: string | null;
}) {
  return mutateStore((store) => {
    const folder = store.folders.find(
      (item) =>
        item.id === params.folderId &&
        item.userId === params.userId &&
        item.kind === params.kind,
    );
    if (!folder) return null;
    if (params.parentFolderId !== undefined) {
      let cursor = params.parentFolderId;
      while (cursor) {
        if (cursor === folder.id) return null;
        const parent = store.folders.find(
          (item) =>
            item.id === cursor &&
            item.userId === params.userId &&
            item.kind === params.kind,
        );
        if (!parent) return null;
        cursor = parent.parentFolderId;
      }
      folder.parentFolderId = params.parentFolderId;
    }
    if (params.name) folder.name = params.name.slice(0, 200);
    folder.updatedAt = new Date().toISOString();
    return localFolderResponse(folder);
  });
}

export async function deleteLocalFolder(
  userId: string,
  kind: LocalLibraryKind,
  folderId: string,
) {
  return mutateStore(async (store) => {
    if (
      !store.folders.some(
        (folder) =>
          folder.id === folderId && folder.userId === userId && folder.kind === kind,
      )
    ) {
      return false;
    }
    const folderIds = new Set([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of store.folders) {
        if (
          folder.userId === userId &&
          folder.kind === kind &&
          folder.parentFolderId &&
          folderIds.has(folder.parentFolderId) &&
          !folderIds.has(folder.id)
        ) {
          folderIds.add(folder.id);
          changed = true;
        }
      }
    }
    const documentIds = store.documents
      .filter(
        (document) =>
          document.userId === userId &&
          document.kind === kind &&
          !!document.folderId &&
          folderIds.has(document.folderId),
      )
      .map((document) => document.id);
    store.documents = store.documents.filter(
      (document) => !documentIds.includes(document.id),
    );
    store.folders = store.folders.filter((folder) => !folderIds.has(folder.id));
    await Promise.all(
      documentIds
        .filter((id) => /^[a-f0-9-]{36}$/i.test(id))
        .map((id) =>
          rm(absoluteDataPath(path.join("files", id)), {
            recursive: true,
            force: true,
          }),
        ),
    );
    return true;
  });
}

function legalSourceResponse(pointer: LocalLegalSourcePointer) {
  return {
    id: pointer.id,
    provider: pointer.provider,
    doc_type: pointer.docType,
    citation: pointer.citation,
    language: pointer.language,
    dataset: pointer.dataset,
    source_id: pointer.sourceId ?? null,
  };
}

function legalSourceId(pointer: {
  provider: "a2aj" | "journal";
  docType: "cases" | "laws" | "articles";
  citation: string;
  language: "en" | "fr";
  dataset?: string | null;
  sourceId?: string | null;
}) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        pointer.provider,
        pointer.docType,
        pointer.language,
        pointer.dataset?.trim().toLowerCase() ?? "",
        pointer.sourceId?.trim().toLowerCase() ?? "",
        pointer.citation.trim().toLowerCase(),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

export async function listLocalLegalSources(userId: string) {
  const store = await currentStore();
  return store.legalSources
    .filter((pointer) => pointer.userId === userId)
    .map(legalSourceResponse);
}

export async function getLocalLegalSource(userId: string, id: string) {
  const store = await currentStore();
  return (
    store.legalSources.find(
      (pointer) => pointer.userId === userId && pointer.id === id,
    ) ?? null
  );
}

export async function saveLocalLegalSource(params: {
  userId: string;
  provider: "a2aj" | "journal";
  docType: "cases" | "laws" | "articles";
  citation: string;
  language: "en" | "fr";
  dataset?: string | null;
  sourceId?: string | null;
}) {
  return mutateStore((store) => {
    const sourceId = params.sourceId?.trim();
    const pointer: LocalLegalSourcePointer = {
      id: legalSourceId(params),
      userId: params.userId,
      provider: params.provider,
      docType: params.docType,
      citation: params.citation.trim(),
      language: params.language,
      dataset: params.dataset?.trim() || null,
      ...(sourceId ? { sourceId } : {}),
    };
    const existing = store.legalSources.find(
      (item) => item.userId === params.userId && item.id === pointer.id,
    );
    if (existing) return legalSourceResponse(existing);
    store.legalSources.push(pointer);
    return legalSourceResponse(pointer);
  });
}

export async function deleteLocalLegalSource(userId: string, id: string) {
  return mutateStore((store) => {
    const index = store.legalSources.findIndex(
      (pointer) => pointer.userId === userId && pointer.id === id,
    );
    if (index < 0) return false;
    store.legalSources.splice(index, 1);
    return true;
  });
}
