import { readFile } from "node:fs/promises";
import { downloadFile } from "../storage";
import { getLocalVersionFiles } from "../localDocumentStore";
import {
  isImageDocumentType,
  MAX_CHAT_IMAGES,
  toLlmImage,
} from "../llm/images";
import type { LlmImage } from "../llm/types";
import type { ChatMessage, DocIndex, DocStore } from "./types";

function referencedImageIds(
  messages: ChatMessage[],
  fileTypeForId: (documentId: string) => string | undefined,
) {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const file of message.files ?? []) {
      if (
        file.document_id &&
        isImageDocumentType(fileTypeForId(file.document_id))
      ) {
        ids.add(file.document_id);
      }
    }
  }
  if (ids.size > MAX_CHAT_IMAGES) {
    throw new Error(`Attach no more than ${MAX_CHAT_IMAGES} images per chat.`);
  }
  return ids;
}

export async function loadStoredChatImages(
  messages: ChatMessage[],
  docIndex: DocIndex,
  docStore: DocStore,
): Promise<Map<string, LlmImage>> {
  const slugByDocumentId = new Map(
    Object.entries(docIndex).map(([slug, info]) => [info.document_id, slug]),
  );
  const sourceForId = (documentId: string) => {
    const slug = slugByDocumentId.get(documentId);
    return slug ? docStore.get(slug) : undefined;
  };
  const ids = referencedImageIds(
    messages,
    (documentId) => sourceForId(documentId)?.file_type,
  );
  const images = new Map<string, LlmImage>();
  for (const documentId of ids) {
    const source = sourceForId(documentId)!;
    const bytes = await downloadFile(source.storage_path);
    if (!bytes) throw new Error(`Attached image "${source.filename}" is unavailable.`);
    images.set(
      documentId,
      toLlmImage(source.filename, bytes, source.file_type),
    );
  }
  return images;
}

export async function loadLocalChatImages(
  messages: ChatMessage[],
  userId: string,
): Promise<Map<string, LlmImage>> {
  const documentIds = new Set(
    messages.flatMap((message) =>
      (message.files ?? []).flatMap((file) =>
        file.document_id ? [file.document_id] : [],
      ),
    ),
  );
  const candidates = await getLocalVersionFiles(userId, documentIds);
  const ids = referencedImageIds(
    messages,
    (documentId) => candidates.get(documentId)?.fileType,
  );
  const images = new Map<string, LlmImage>();
  for (const documentId of ids) {
    const source = candidates.get(documentId)!;
    images.set(
      documentId,
      toLlmImage(
        source.filename,
        await readFile(source.path),
        source.fileType,
      ),
    );
  }
  return images;
}

export function imagesForMessage(
  message: ChatMessage,
  imagesByDocumentId: Map<string, LlmImage>,
) {
  const images = (message.files ?? []).flatMap((file) => {
    const image = file.document_id
      ? imagesByDocumentId.get(file.document_id)
      : undefined;
    return image ? [image] : [];
  });
  return images.length ? images : undefined;
}
