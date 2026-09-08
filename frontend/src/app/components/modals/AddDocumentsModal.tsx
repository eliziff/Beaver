import { useEffect, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import {
  addDocumentToProject,
  directoryResource,
  uploadDocumentsSettled,
  uploadStandaloneDocument,
  type Document,
} from "@/app/lib/api/documents";
import {
  SUPPORTED_DOCUMENT_ACCEPT,
  formatUnsupportedDocumentWarning,
  partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";
import { isResearchDocument } from "@/app/lib/researchFiles";
import { FileDirectory, type DirectoryTab } from "../shared/FileDirectory";
import { ModalSegmentedToggle } from "./ModalSegmentedToggle";

import { UploadAction } from "../documents/UploadAction";
import { Modal } from "./Modal";

interface Props {
  open: boolean;
  onClose: () => void;
  onUploadFiles?: (files: File[]) => Promise<void>;
  onSelect: (documents: Document[], projectId?: string) => void | Promise<void>;
  breadcrumb: string[];
  initialTab?: DirectoryTab;
  projectId?: string;
  documents?: Document[];
  showTabs?: boolean;
  accept?: string;
  documentFilter?: (document: Document) => boolean;
  multiple?: boolean;
  tabs?: [DirectoryTab, string][];
  busy?: boolean;
  initialSelectedDocuments?: Document[];
  externalUploadedDocuments?: Document[];
  primaryLabel?: string;
  keepMounted?: boolean;
  /** Workspace sources that are not rows yet; adding them extends the review's research selection. */
  sources?: { id: string; title: string }[];
  onAddSources?: (sourceIds: string[]) => void | Promise<void>;
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
  onUploadFiles,
  breadcrumb,
  initialTab = "files",
  projectId,
  documents,
  showTabs = true,
  accept = SUPPORTED_DOCUMENT_ACCEPT,
  documentFilter,
  multiple = true,
  tabs,
  busy: operationBusy = false,
  initialSelectedDocuments,
  externalUploadedDocuments,
  primaryLabel = "Confirm",
  keepMounted = false,
  sources,
  onAddSources,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  const [selected, setSelected] = useState<Document[]>([]);
  const [uploaded, setUploaded] = useState<Document[]>([]);
  const [pendingNames, setPendingNames] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [hasOpened, setHasOpened] = useState(open);
  const [view, setView] = useState<"documents" | "sources">("documents");
  const [pickedSources, setPickedSources] = useState<string[]>([]);
  const busy = operationBusy || pendingNames.length > 0;
  const eligible = (document: Document) => !isResearchDocument(document) && (!documentFilter || documentFilter(document)) &&
    (accept === SUPPORTED_DOCUMENT_ACCEPT || accept.split(",").some((extension) =>
      document.filename.toLowerCase().endsWith(extension.trim().toLowerCase())));
  const selectable = (documents: Document[]) => {
    const matches = documents.filter(eligible);
    return multiple ? matches : matches.slice(-1);
  };

  useEffect(() => {
    if (open) setHasOpened(true);
    if (!open) {
      wasOpen.current = false;
      return;
    }
    setSelected((current) => selectable(merge(wasOpen.current ? current : undefined, initialSelectedDocuments)));
    setPendingNames([]);
    setView("documents");
    setPickedSources([]);
    setWarning(null);
    if (!keepMounted) setUploaded([]);
    wasOpen.current = true;
  }, [open, keepMounted, initialSelectedDocuments]);

  useEffect(() => {
    if (!externalUploadedDocuments?.length) return;
    setUploaded((current) => merge(current, externalUploadedDocuments));
    if (open) setSelected((current) => selectable(merge(current, externalUploadedDocuments)));
  }, [externalUploadedDocuments, open]);

  if (!open && (!keepMounted || !hasOpened)) return null;

  async function addSources() {
    if (busy || !pickedSources.length) return;
    await onAddSources?.(pickedSources);
    onClose();
  }

  async function confirm() {
    if (busy || !selected.length || selected.some((document) => !eligible(document))) return;
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

  async function upload(files: File[], folder = false) {
    const allowed = files.filter((file) => accept === SUPPORTED_DOCUMENT_ACCEPT ||
      accept.split(",").some((extension) => file.name.toLowerCase().endsWith(extension.trim().toLowerCase())));
    if (allowed.length !== files.length) {
      setWarning(`Choose ${accept} files.`);
      return;
    }
    const { supported, unsupported } = partitionSupportedDocumentFiles(multiple ? allowed : allowed.slice(0, 1));
    const unsupportedMessage = formatUnsupportedDocumentWarning(unsupported);
    setWarning(unsupportedMessage);
    if (!supported.length) return;
    if (onUploadFiles) {
      await onUploadFiles(supported);
      onClose();
      return;
    }
    setPendingNames(supported.map(({ name }) => name));
    let added: Document[] = [], failed: File[] = [];
    if (folder && projectId) {
      try {
        added = await directoryResource({ projectId }).uploadDirectory(supported);
      } catch {
        failed = supported;
      }
    } else {
      const uploadDocument = projectId
        ? directoryResource({ projectId }).uploadDocument
        : uploadStandaloneDocument;
      const results = await uploadDocumentsSettled(supported, uploadDocument);
      added = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      failed = supported.filter((_, index) => results[index].status === "rejected");
    }
    setUploaded((current) => merge(added, current));
    setSelected((current) => selectable(merge(current, added)));
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
    if (folderInput.current) folderInput.current.value = "";
  }

  return (
    <Modal
      open={open}
      size="2xl"
      onClose={onClose}
      keepMounted={keepMounted}
      breadcrumbs={breadcrumb}
      headerAction={<UploadAction busy={busy} actions={{
        files: () => input.current?.click(),
        folder: () => folderInput.current?.click(),
      }} />}
      primaryAction={{
        label: busy ? "Saving…" : primaryLabel,
        onClick: () => void (view === "sources" ? addSources() : confirm()),
        disabled: busy || !(view === "sources" ? pickedSources.length : selected.length),
      }}
    >
      <input
        ref={input}
        type="file"
        aria-label="Upload files"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(event) => void upload([...event.currentTarget.files ?? []])}
      />
      <input ref={folderInput} type="file" aria-label="Upload folder" accept={accept} multiple
        className="hidden" {...{ webkitdirectory: "", directory: "" }}
        onChange={(event) => void upload([...event.currentTarget.files ?? []], true)} />
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
      {!!sources?.length && <div className="mb-3">
        <ModalSegmentedToggle value={view} onChange={setView}
          options={[{ value: "documents", label: "Documents" }, { value: "sources", label: "Sources" }]} />
      </div>}
      {view === "sources" ? <ul aria-label="Sources" className="min-h-0 flex-1 overflow-y-auto">
        {sources?.map(({ id, title }) => <li key={id}>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded px-2 text-sm">
            <input type="checkbox" aria-label={`Select ${title}`} checked={pickedSources.includes(id)}
              onChange={() => setPickedSources((current) => current.includes(id)
                ? current.filter((item) => item !== id) : [...current, id])}
              className="h-[18px] w-[18px] shrink-0 cursor-pointer rounded border-gray-500 accent-gray-950" />
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </label>
        </li>)}
      </ul> : <div className="flex min-h-0 flex-1 flex-col">
        <FileDirectory
          key={initialTab}
          documents={documents ? merge(uploaded, documents) : uploaded}
          selectedDocuments={selected}
          onChange={setSelected}
          uploadingFilenames={pendingNames}
          showTabs={showTabs}
          initialTab={initialTab}
          excludeProjectId={projectId}
          documentFilter={eligible}
          multiple={multiple}
          tabs={tabs}
        />
      </div>}
    </Modal>
  );
}
