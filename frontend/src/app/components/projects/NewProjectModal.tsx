import { useRef, useState } from "react";
import { User, X } from "lucide-react";
import {
  addDocumentToProject,
  directoryResource,
  uploadDocumentsSettled,
  type Document,
} from "@/app/lib/api/documents";
import { createProject, type Project } from "@/app/lib/api/projects";
import type { UserLookupResult } from "@/app/lib/api/account";
import { useAuth } from "@/app/contexts/AuthContext";
import { formatUnsupportedDocumentWarning, partitionSupportedDocumentFiles,
    SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";
import { UploadAction } from "../documents/UploadAction";
import { Modal } from "../modals/Modal";
import { FieldGroup, FormField } from "../modals/ModalFieldLabel";
import { ModalTextInput } from "../modals/ModalTextInput";
import { AddUserInput } from "../shared/AddUserInput";
import { FileDirectory } from "../shared/FileDirectory";


import { Button } from "../ui/button";
import { ProjectPracticeField } from "./ProjectPracticeField";

type Props = { open: boolean; onClose: () => void; onCreated: (project: Project) => void };

export function NewProjectModal({ open, ...props }: Props) {
    return open ? <OpenNewProjectModal {...props} /> : null;
}

function OpenNewProjectModal({ onClose, onCreated }: Omit<Props, "open">) {
    const [step, setStep] = useState<"details" | "documents">("details");
    const [practice, setPractice] = useState("");
    const [users, setUsers] = useState<UserLookupResult[]>([]);
    const [documents, setDocuments] = useState<Document[]>([]);
    const [files, setFiles] = useState<File[]>([]);
    const [createdProject, setCreatedProject] = useState<Project | null>(null);
    const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
    const [error, setError] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);
    const folderInput = useRef<HTMLInputElement>(null);
    const projectFilesRef = useRef<ReturnType<typeof directoryResource> | null>(null);
    const ownEmail = useAuth().user?.email?.trim().toLowerCase();
    const formId = "new-project-modal-form";

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const name = String(form.get("name") ?? "").trim();
        if (!name) return;
        if (step === "details") {
            setStep("documents");
            return;
        }
        const cm = String(form.get("cmNumber") ?? "").trim();
        const area = practice.trim();
        setStatus("loading");
        setError("");
        try {
            const project = createdProject ?? await createProject(name, cm || undefined,
                area || undefined,
                users.map(({ email }) => email).filter((email) => email !== ownEmail));
            if (!createdProject) setCreatedProject(project);
            const projectFiles = projectFilesRef.current ??=
                directoryResource({ projectId: project.id });
            const looseFiles = files.filter((file) => !file.webkitRelativePath);
            const folderFiles = files.filter((file) => file.webkitRelativePath);
            const additions = [
                ...documents.map(({ id }) => ({ kind: "document" as const, id })),
                ...looseFiles.map((file) => ({ kind: "file" as const, id: file.name })),
            ];
            const [documentResults, fileResults, folderResult] = await Promise.all([
                Promise.allSettled(documents.map(({ id }) =>
                    addDocumentToProject(project.id, id))),
                uploadDocumentsSettled(looseFiles, projectFiles.uploadDocument),
                Promise.allSettled(folderFiles.length
                    ? [projectFiles.uploadDirectory(folderFiles)] : []),
            ]);
            const results = [...documentResults, ...fileResults];
            const succeeded = new Set(additions.flatMap((addition, index) =>
                results[index].status === "fulfilled" ? [`${addition.kind}:${addition.id}`] : []));
            setDocuments((current) => current.filter(({ id }) =>
                !succeeded.has(`document:${id}`)));
            setFiles((current) => current.filter((file) => file.webkitRelativePath
                ? folderResult[0]?.status !== "fulfilled"
                : !succeeded.has(`file:${file.name}`)));
            const failed = results.filter(({ status: resultStatus }) =>
                resultStatus === "rejected").length +
                (folderResult[0]?.status === "rejected" ? folderFiles.length : 0);
            if (failed) throw new Error(
                `Project created, but ${failed} item${failed === 1 ? "" : "s"} could not be added. Try again.`,
            );
            onCreated(project);
            onClose();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Failed to create project");
            setStatus("error");
        }
    }
    function addFiles(event: React.ChangeEvent<HTMLInputElement>) {
        const { supported, unsupported } = partitionSupportedDocumentFiles(
            Array.from(event.target.files ?? []));
        event.target.value = "";
        setError(formatUnsupportedDocumentWarning(unsupported) ?? "");
        setFiles((current) => [...current, ...supported.filter((file) =>
            !current.some((existing) => (existing.webkitRelativePath || existing.name) ===
                (file.webkitRelativePath || file.name)))]);
    }
    function validateUser(email: string) {
        if (email === ownEmail) return "You cannot share a project with yourself.";
        return users.some((user) => user.email.trim().toLowerCase() === email)
            ? `${email} already has access.` : null;
    }
    const loading = status === "loading";
    return <Modal open onClose={onClose} size="lg"
        className="!h-[min(28rem,calc(100dvh-2rem))]"
        breadcrumbs={["Projects", "New project"]}
        headerAction={step === "documents" ? <UploadAction busy={loading} actions={{
            files: () => fileInput.current?.click(),
            folder: () => folderInput.current?.click(),
        }} /> : undefined}
        cancelAction={step === "documents"
            ? { label: "Back", onClick: () => setStep("details"), disabled: loading } : undefined}
        primaryAction={{ label: step === "details" ? "Next" : loading ? "Creating…" : "Create project",
            type: "submit", form: formId, disabled: loading }}>
        <input ref={fileInput} type="file" multiple accept={SUPPORTED_DOCUMENT_ACCEPT}
            className="hidden" onChange={addFiles} />
        <input ref={folderInput} type="file" multiple className="hidden" onChange={addFiles}
            accept={SUPPORTED_DOCUMENT_ACCEPT} {...{ webkitdirectory: "", directory: "" }} />
        <form id={formId} onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div hidden={step !== "details"} className="space-y-4 pb-4">
                <FormField label="Project name" htmlFor="new-project-name">
                    <ModalTextInput name="name" placeholder="Add project name" required autoFocus />
                </FormField>
                <FormField label="CM number" htmlFor="new-project-cm-number">
                    <ModalTextInput name="cmNumber" placeholder="Optional" />
                </FormField>
                <FormField label="Practice" htmlFor="new-project-practice">
                    <ProjectPracticeField id="new-project-practice" value={practice} onChange={setPractice} />
                </FormField>
                <FieldGroup legend="Share with">
                    <AddUserInput placeholder="Add colleagues by email..." validateEmail={validateUser}
                        onAdd={(user) => setUsers((current) => [...current,
                            { ...user, email: user.email.trim().toLowerCase() }])} />
                    {!!users.length && <ul className="space-y-1 pt-1">
                        {users.map((user) => <li key={user.email}
                            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100/70">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 shadow-sm">
                                {user.display_name?.trim()
                                    ? <span className="font-serif text-[11px] leading-none">{user.display_name.trim().charAt(0).toUpperCase()}</span>
                                    : <User className="h-2.5 w-2.5" aria-hidden="true" />}
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                                {user.display_name?.trim() || "User"} · {user.email}
                            </span>
                            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${user.email}`}
                                onClick={() => setUsers((current) => current.filter(
                                    ({ email }) => email !== user.email))}
                                className="rounded-full text-gray-500 hover:text-red-600">
                                <X className="h-3 w-3" />
                            </Button>
                        </li>)}
                    </ul>}
                </FieldGroup>
            </div>
            {step === "documents" && <div className="flex min-h-0 flex-1 flex-col">
                <FileDirectory selectedDocuments={documents}
                    onChange={setDocuments} showTabs />
                {!!files.length && <div className="shrink-0 border-t border-gray-200 py-3">
                    <p className="mb-2 text-xs font-medium text-gray-600">
                        {files.length} new file{files.length === 1 ? "" : "s"} ready to upload
                    </p>
                    <ul aria-label="Files ready to upload"
                        className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
                        {files.map((file) => <li key={file.webkitRelativePath || file.name}
                            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-1 text-xs text-gray-700">
                            <span className="truncate">{file.webkitRelativePath || file.name}</span>
                            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${file.webkitRelativePath || file.name}`}
                                className="text-gray-500 hover:bg-gray-200 hover:text-gray-900"
                                onClick={() => setFiles((current) => current.filter(
                                    (existing) => (existing.webkitRelativePath || existing.name) !==
                                        (file.webkitRelativePath || file.name)))}>
                                <X aria-hidden="true" className="h-3.5 w-3.5" />
                            </Button>
                        </li>)}
                    </ul>
                </div>}
            </div>}
            {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
        </form>
    </Modal>;
}
