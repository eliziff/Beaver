import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Upload, X } from "lucide-react";
import {
  addDocumentToProject,
  directoryResource,
  uploadStandaloneDocument,
} from "@/app/lib/beaverApi";
import {
  SUPPORTED_DOCUMENT_ACCEPT,
  formatUnsupportedDocumentWarning,
  partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";
import { FileDirectory, type DirectoryTab } from "../shared/FileDirectory";
import type { Document } from "../shared/types";
import { Modal } from "./Modal";

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (documents: Document[], projectId?: string) => void | Promise<void>;
  breadcrumb: string[];
  initialTab?: DirectoryTab;
  projectId?: string;
  documents?: Document[];
  showTabs?: boolean;
  accept?: string;
  initialSelectedDocuments?: Document[];
  externalUploadedDocuments?: Document[];
  primaryLabel?: string;
  keepMounted?: boolean;
}

function merge(...groups: (Document[] | undefined)[]) {
  const unique = new Map<string, Document>();
  groups.flatMap((group) => group ?? []).forEach((document) => unique.set(document.id, document));
  return [...unique.values()];
}

function failure(verb: "upload" | "add", files: { filename?: string; name?: string }[]) {
  const subject = files.length === 1
    ? files[0].filename ?? files[0].name ?? "the document"
    : `${files.length} documents`;
  return `Unable to ${verb} ${subject}. Check your connection and try again.`;
}

export function AddDocumentsModal({
  open,
  onClose,
  onSelect,
  breadcrumb,
  initialTab = "files",
  projectId,
  documents,
  showTabs = true,
  accept = SUPPORTED_DOCUMENT_ACCEPT,
  initialSelectedDocuments,
  externalUploadedDocuments,
  primaryLabel = "Confirm",
  keepMounted = false,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  const [selected, setSelected] = useState<Document[]>([]);
  const [uploaded, setUploaded] = useState<Document[]>([]);
  const [pendingNames, setPendingNames] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [hasOpened, setHasOpened] = useState(open);
  const busy = pendingNames.length > 0;

  useEffect(() => {
    if (open) setHasOpened(true);
    if (!open) {
      wasOpen.current = false;
      return;
    }
    setSelected((current) => merge(wasOpen.current ? current : undefined, initialSelectedDocuments));
    setPendingNames([]);
    setWarning(null);
    if (!keepMounted) setUploaded([]);
    wasOpen.current = true;
  }, [open, keepMounted, initialSelectedDocuments]);

  useEffect(() => {
    if (!externalUploadedDocuments?.length) return;
    setUploaded((current) => merge(current, externalUploadedDocuments));
    if (open) setSelected((current) => merge(current, externalUploadedDocuments));
  }, [externalUploadedDocuments, open]);

  if (!open && (!keepMounted || !hasOpened)) return null;

  async function confirm() {
    if (!projectId) {
      const projects = new Set(selected.flatMap((document) => document.project_id ? [document.project_id] : []));
      await onSelect(selected, projects.size === 1 ? [...projects][0] : undefined);
      onClose();
      return;
    }
    const existing = selected.filter((document) => document.project_id === projectId);
    const incoming = selected.filter((document) => document.project_id !== projectId);
    if (!incoming.length) {
      await onSelect(existing, projectId);
      onClose();
      return;
    }
    setPendingNames(incoming.map(({ filename }) => filename));
    const results = await Promise.allSettled(
      incoming.map((document) => addDocumentToProject(projectId, document.id)),
    );
    const added = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const failed = incoming.filter((_, index) => results[index].status === "rejected");
    setPendingNames([]);
    if (failed.length) {
      setSelected(merge(existing, added, failed));
      setWarning(failure("add", failed));
    } else {
      await onSelect([...existing, ...added], projectId);
      onClose();
    }
  }

  async function upload(files: File[]) {
    const { supported, unsupported } = partitionSupportedDocumentFiles(files);
    const unsupportedMessage = formatUnsupportedDocumentWarning(unsupported);
    setWarning(unsupportedMessage);
    if (!supported.length) return;
    setPendingNames(supported.map(({ name }) => name));
    const results = await Promise.allSettled(supported.map((file) =>
      projectId
        ? directoryResource({ projectId }).uploadDocument(file)
        : uploadStandaloneDocument(file),
    ));
    const added = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const failed = supported.filter((_, index) => results[index].status === "rejected");
    setUploaded((current) => merge(added, current));
    setSelected((current) => merge(current, added));
    setPendingNames([]);
    setWarning([unsupportedMessage, failed.length ? failure("upload", failed) : null].filter(Boolean).join(" ") || null);
    if (projectId && added.length) {
      try {
        await onSelect(added, projectId);
      } catch {
        setWarning("The upload succeeded, but this view could not refresh. Try again.");
      }
    }
    if (input.current) input.current.value = "";
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      keepMounted={keepMounted}
      breadcrumbs={breadcrumb}
      secondaryAction={{
        label: busy ? "Uploading…" : "Upload",
        icon: busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />,
        onClick: () => input.current?.click(),
        disabled: busy,
      }}
      primaryAction={{
        label: busy ? "Saving…" : primaryLabel,
        onClick: () => void confirm(),
        disabled: !selected.length || busy,
      }}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple
        className="hidden"
        onChange={(event) => void upload([...event.currentTarget.files ?? []])}
      />
      {warning && (
        <p role="alert" aria-atomic="true" className="mb-2 flex items-center gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-gray-900">
          <AlertCircle className="size-3.5 shrink-0 text-red-600" aria-hidden="true" />
          <span className="min-w-0 flex-1">{warning}</span>
          <button type="button" onClick={() => setWarning(null)} aria-label="Dismiss warning"
            className="shrink-0 rounded p-0.5 text-black hover:bg-gray-100">
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <FileDirectory
          key={`${initialTab}:${open ? "open" : "closed"}`}
          documents={documents ? merge(uploaded, documents) : uploaded}
          selectedDocuments={selected}
          onChange={setSelected}
          uploadingFilenames={pendingNames}
          showTabs={showTabs}
          initialTab={initialTab}
          excludeProjectId={projectId}
        />
      </div>
    </Modal>
  );
}
