import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { DocumentAutomation } from "../documents/DocumentAutomation";
import type {
  Citation,
  EditAnnotation,
  EditResolveHandlers,
} from "../shared/types";
import {
  expandCitationToEntries,
  getDocumentCitationQuotes,
  isDocxFilename,
  isSpreadsheetFilename,
} from "../shared/types";
import { DocumentViewer } from "../shared/views/DocumentViewer";
import { PillButton } from "../ui/pill-button";
import { downloadDocument } from "../../lib/beaverApi";
import { downloadBlob } from "../../lib/download";
import { useEditResolution } from "./EditCard";

export type DocPanelMode =
  | { kind: "document" }
  | { kind: "citation"; citation: Citation }
  | ({
      kind: "edit";
      edit: EditAnnotation;
      focusKey: number;
      isEditReloading?: boolean;
    } & EditResolveHandlers);

export function DocPanel({
  documentId,
  filename,
  projectId,
  versionId,
  versionNumber,
  mode,
  isReloading = false,
  warning,
  onWarningDismiss,
  initialScrollTop,
  onScrollChange,
}: {
  documentId: string;
  filename: string;
  projectId?: string;
  versionId: string | null;
  versionNumber: number | null;
  mode: DocPanelMode;
  isReloading?: boolean;
  warning?: string | null;
  onWarningDismiss?: () => void;
  initialScrollTop?: number | null;
  onScrollChange?: (scrollTop: number) => void;
}) {
  const [version, setVersion] = useState({ source: versionId, value: versionId });
  const [downloading, setDownloading] = useState(false);
  const activeVersion = version.source === versionId ? version.value : versionId;
  const documentQuotes = mode.kind === "citation"
    ? getDocumentCitationQuotes(mode.citation)
    : undefined;
  const editHighlight = mode.kind === "edit" ? {
    key: `${mode.edit.edit_id}:${mode.focusKey}`,
    inserted_text: mode.edit.inserted_text,
    deleted_text: mode.edit.deleted_text,
    ins_w_id: mode.edit.ins_w_id ?? null,
    del_w_id: mode.edit.del_w_id ?? null,
  } : null;

  async function download() {
    if (downloading || isReloading) return;
    setDownloading(true);
    try {
      const result = await downloadDocument(documentId, activeVersion);
      downloadBlob(result.blob, result.filename ?? filename);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {mode.kind === "edit" ? (
        <EditActions mode={mode} />
      ) : (
        <header className="flex items-center gap-3 px-3 py-3">
          <h2 className="min-w-0 flex-1 truncate font-serif text-xl" title={filename}>
            {filename}
            {!!versionNumber && <small className="ml-2 font-sans text-xs">V{versionNumber}</small>}
          </h2>
          <DocumentAutomation
            document={{ id: documentId, filename, project_id: projectId }}
            onDocumentChanged={(result) => setVersion({
              source: versionId,
              value: result.version_id,
            })}
          />
          <PillButton tone="white" onClick={() => void download()} disabled={downloading || isReloading}>
            {downloading || isReloading
              ? <Loader2 className="size-3.5 animate-spin" />
              : <Download className="size-3.5" />}
            Download
          </PillButton>
        </header>
      )}
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <DocumentViewer
          documentId={documentId}
          kind={isDocxFilename(filename)
            ? "docx"
            : isSpreadsheetFilename(filename) ? "spreadsheet" : "pdf"}
          versionId={activeVersion}
          quotes={mode.kind === "citation"
            ? expandCitationToEntries(mode.citation)
            : undefined}
          highlightEdit={editHighlight}
          highlightCells={documentQuotes
            ?.filter(({ cell, sheet }) => cell || sheet)
            .map(({ cell, sheet }) => ({ cell, sheet }))}
          warning={warning ?? null}
          onWarningDismiss={onWarningDismiss}
          initialScrollTop={initialScrollTop ?? null}
          onScrollChange={onScrollChange}
        />
      </div>
    </div>
  );
}

function EditActions({ mode }: { mode: Extract<DocPanelMode, { kind: "edit" }> }) {
  const { edit, isEditReloading, ...handlers } = mode;
  const { status, resolve, disabled } = useEditResolution(
    edit,
    undefined,
    isEditReloading,
    handlers,
  );
  return (
    <header className="flex justify-end gap-2 border-b p-2">
      <PillButton tone="black" onClick={() => resolve("accept")} disabled={disabled}>
        {status === "accepted" ? "Accepted" : "Accept"}
      </PillButton>
      <PillButton tone="white" onClick={() => resolve("reject")} disabled={disabled}>
        {status === "rejected" ? "Rejected" : "Reject"}
      </PillButton>
    </header>
  );
}
