import path from "node:path";
import type { LlmImage } from "./types";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_IMAGES = 4;

const IMAGE_MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
} as const;

export type ImageDocumentType = keyof typeof IMAGE_MIME_BY_EXTENSION;

export function isImageDocumentType(
  fileType: string | null | undefined,
): fileType is ImageDocumentType {
  return Object.hasOwn(
    IMAGE_MIME_BY_EXTENSION,
    (fileType ?? "").toLowerCase(),
  );
}

function hasExpectedSignature(type: ImageDocumentType, bytes: Buffer) {
  if (type === "jpg" || type === "jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[2] === 0xff;
  }
  if (type === "png") {
    return bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (type === "gif") {
    const header = bytes.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  return bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export function validateImageBytes(
  filename: string,
  value: Buffer | ArrayBuffer,
): LlmImage["mimeType"] {
  const fileType = path.extname(filename).slice(1).toLowerCase();
  if (!isImageDocumentType(fileType)) {
    throw new Error("Unsupported image type. Use JPEG, PNG, GIF, or WebP.");
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (!bytes.length) throw new Error(`Image "${filename}" is empty.`);
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image "${filename}" exceeds the 5 MB limit.`);
  }
  if (!hasExpectedSignature(fileType, bytes)) {
    throw new Error(`Image "${filename}" does not match its file type.`);
  }
  return IMAGE_MIME_BY_EXTENSION[fileType];
}

export function toLlmImage(
  filename: string,
  value: Buffer | ArrayBuffer,
  fileType?: string,
): LlmImage {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const validationName = fileType ? `image.${fileType}` : filename;
  return {
    filename: path.basename(filename).slice(0, 200) || "image",
    mimeType: validateImageBytes(validationName, bytes),
    data: bytes.toString("base64"),
  };
}

export function imageValidationError(
  filename: string,
  value: Buffer | ArrayBuffer,
): string | null {
  if (!isImageDocumentType(path.extname(filename).slice(1))) return null;
  try {
    validateImageBytes(filename, value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid image.";
  }
}
