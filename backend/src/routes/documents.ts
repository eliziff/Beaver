import type { Request, Response } from "express";
import { createCloudDocument } from "../lib/cloudDocumentStore";
import { validateDocumentFile } from "../lib/documentTypes";
import type { createServerSupabase } from "../lib/supabase";

export async function handleDocumentUpload(
  req: Request,
  res: Response,
  userId: string,
  projectId: string | null,
  db: ReturnType<typeof createServerSupabase>,
  options: {
    libraryKind?: "file" | "template";
    libraryFolderId?: string | null;
  } = {},
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });
  const validated = validateDocumentFile(file.originalname, file.buffer);
  if (!validated.ok) {
    return void res.status(400).json({ detail: validated.error });
  }
  try {
    const document = await createCloudDocument(db, {
      userId,
      userEmail: res.locals.userEmail as string | undefined,
      projectId,
      libraryKind: options.libraryKind,
      libraryFolderId: options.libraryFolderId,
      file,
      fileType: validated.fileType,
    });
    res.status(201).json(document);
  } catch (error) {
    res.status(500).json({
      detail: error instanceof Error ? error.message : "Document processing failed",
    });
  }
}
