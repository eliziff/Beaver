import { useRef, useState } from "react";
import { Upload, User, X } from "lucide-react";
import { addDocumentToProject, createProject, directoryResource,
    type UserLookupResult } from "@/app/lib/beaverApi";
import { useAuth } from "@/app/contexts/AuthContext";
import { Modal, MODAL_INPUT_CLASS, MODAL_LABEL_CLASS } from "../modals/Modal";
import { AddUserInput } from "../shared/AddUserInput";
import { FileDirectory } from "../shared/FileDirectory";
import type { Document, Project } from "../shared/types";
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
    const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
    const [error, setError] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);
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
            const project = await createProject(name, cm || undefined,
                area || undefined,
                users.map(({ email }) => email).filter((email) => email !== ownEmail));
            const projectFiles = directoryResource({ projectId: project.id });
            await Promise.all([
                ...documents.map(({ id }) => addDocumentToProject(project.id, id).catch(() => {})),
                ...files.map((file) => projectFiles.uploadDocument(file).catch(() => {})),
            ]);
            onCreated(project);
            onClose();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Failed to create project");
            setStatus("error");
        }
    }
    function addFiles(event: React.ChangeEvent<HTMLInputElement>) {
        const added = Array.from(event.target.files ?? []);
        event.target.value = "";
        setFiles((current) => [...current, ...added.filter((file) =>
            !current.some(({ name }) => name === file.name))]);
    }
    function validateUser(email: string) {
        if (email === ownEmail) return "You cannot share a project with yourself.";
        return users.some((user) => user.email.trim().toLowerCase() === email)
            ? `${email} already has access.` : null;
    }
    const loading = status === "loading";
    return <Modal open onClose={onClose}
        breadcrumbs={["Projects", "New project", step === "details" ? "Details" : "Add Documents"]}
        secondaryAction={step === "documents" ? { label: `Upload${files.length ? ` (${files.length})` : ""}`,
            icon: <Upload className="h-3.5 w-3.5" />, onClick: () => fileInput.current?.click(),
            disabled: loading } : undefined}
        cancelAction={step === "documents"
            ? { label: "Back", onClick: () => setStep("details"), disabled: loading } : undefined}
        primaryAction={{ label: step === "details" ? "Next" : loading ? "Creating…" : "Create project",
            type: "submit", form: formId, disabled: loading }}>
        <input ref={fileInput} type="file" multiple className="hidden" onChange={addFiles} />
        <form id={formId} onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div hidden={step !== "details"} className="space-y-6">
                <div>
                    <label className={MODAL_LABEL_CLASS} htmlFor="new-project-name">Project name</label>
                    <input className={MODAL_INPUT_CLASS} id="new-project-name" name="name"
                        placeholder="Add project name" required autoFocus />
                </div>
                <div>
                    <label className={MODAL_LABEL_CLASS} htmlFor="new-project-cm-number">CM number</label>
                    <input className={`${MODAL_INPUT_CLASS} text-xl text-gray-600`}
                        id="new-project-cm-number" name="cmNumber" placeholder="Add a CM number…" />
                </div>
                <div>
                    <label className={MODAL_LABEL_CLASS} htmlFor="new-project-practice">Practice</label>
                    <ProjectPracticeField id="new-project-practice" value={practice}
                        onChange={setPractice} />
                </div>
                <div className="space-y-2">
                    <p className={MODAL_LABEL_CLASS}>Share with</p>
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
                            <button type="button" aria-label={`Remove ${user.email}`}
                                onClick={() => setUsers((current) => current.filter(
                                    ({ email }) => email !== user.email))}
                                className="rounded-full p-1 text-gray-500 hover:text-red-600">
                                <X className="h-3 w-3" />
                            </button>
                        </li>)}
                    </ul>}
                </div>
            </div>
            {step === "documents" && <div className="flex min-h-0 flex-1 flex-col">
                <FileDirectory selectedDocuments={documents}
                    onChange={setDocuments} showTabs />
            </div>}
            {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
        </form>
    </Modal>;
}
