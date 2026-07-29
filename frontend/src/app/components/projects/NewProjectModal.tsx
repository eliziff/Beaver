import { useRef, useState } from "react";
import { Upload, User, X } from "lucide-react";
import {
    addDocumentToProject,
    createProject,
    uploadProjectDocument,
} from "@/app/lib/beaverApi";
import { FileDirectory } from "../shared/FileDirectory";
import { AddUserInput } from "../shared/AddUserInput";
import type { Document, Project } from "../shared/types";
import type { UserLookupResult } from "@/app/lib/beaverApi";
import { useAuth } from "@/app/contexts/AuthContext";
import { Modal } from "../modals/Modal";
import { ModalFieldLabel } from "../modals/ModalFieldLabel";
import { ModalTextInput } from "../modals/ModalTextInput";
import { ProjectPracticeField } from "./ProjectPracticeField";
interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (project: Project) => void;
}
export function NewProjectModal({ open, ...props }: Props) {
    if (!open) return null;
    return <OpenNewProjectModal {...props} />;
}
function OpenNewProjectModal({
    onClose,
    onCreated,
}: Omit<Props, "open">) {
    const [step, setStep] = useState<"details" | "documents">("details");
    const [practice, setPractice] = useState("");
    const [sharedUsers, setSharedUsers] = useState<UserLookupResult[]>([]);
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { user } = useAuth();
    const ownEmail = user?.email?.trim().toLowerCase() ?? null;
    const formId = "new-project-modal-form";
    function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (!files.length) return;
        setPendingFiles((prev) => [...prev, ...files.filter((f) => !prev.some((p) => p.name === f.name))]);
    }
    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const name = String(form.get("name") ?? "").trim();
        const cmNumber = String(form.get("cmNumber") ?? "").trim();
        const practice = String(form.get("practice") ?? "").trim();
        const submitter = (e.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
        if (!name) return;
        if (submitter?.value !== "create-project") {
            setStep("documents");
            return;
        }
        setLoading(true);
        setError("");
        try {
            const project = await createProject(
                name,
                cmNumber || undefined,
                practice && practice !== "Other"
                    ? practice
                    : undefined,
                sharedUsers
                    .map((user) => user.email)
                    .filter((email) => email !== ownEmail),
            );
            await Promise.all([
                ...selectedDocuments.map((document) =>
                    addDocumentToProject(project.id, document.id).catch(() => {}),
                ),
                ...pendingFiles.map((f) => uploadProjectDocument(project.id, f).catch(() => {})),
            ]);
            onCreated({
                ...project,
                document_count: selectedDocuments.length + pendingFiles.length,
            });
            onClose();
        } catch (err: unknown) {
            setError((err as Error).message || "Failed to create project");
        } finally {
            setLoading(false);
        }
    }
    function validateShareUser(email: string) {
        if (ownEmail && email === ownEmail) {
            return "You cannot share a project with yourself.";
        }
        if (
            sharedUsers.some(
                (user) => user.email.trim().toLowerCase() === email,
            )
        ) {
            return `${email} already has access.`;
        }
        return null;
    }
    function handleAddShareUser(user: UserLookupResult) {
        setSharedUsers((prev) => [
            ...prev,
            {
                ...user,
                email: user.email.trim().toLowerCase(),
            },
        ]);
    }
    function handleRemoveShareUser(email: string) {
        setSharedUsers((prev) =>
            prev.filter((user) => user.email !== email),
        );
    }
    return (
        <Modal
            open
            onClose={onClose}
            breadcrumbs={[
                "Projects",
                "New project",
                step === "details" ? "Details" : "Add Documents",
            ]}
            secondaryAction={
                step === "documents"
                    ? {
                          label: `Upload${pendingFiles.length > 0 ? ` (${pendingFiles.length})` : ""}`,
                          icon: <Upload className="h-3.5 w-3.5" />,
                          onClick: () => fileInputRef.current?.click(),
                          disabled: loading,
                      }
                    : undefined
            }
            cancelAction={
                step === "documents"
                    ? {
                          label: "Back",
                          onClick: () => setStep("details"),
                          disabled: loading,
                      }
                    : undefined
            }
            primaryAction={{
                label:
                    step === "details"
                        ? "Next"
                        : loading
                          ? "Creating…"
                          : "Create project",
                type: "submit",
                form: formId,
                name: "modalAction",
                value: step === "details" ? "next" : "create-project",
                disabled: loading,
            }}
        >
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
            />
            <form
                id={formId}
                onSubmit={handleSubmit}
                className="flex flex-col flex-1 min-h-0"
            >
                <input type="hidden" name="practice" value={practice} />
                <div
                    hidden={step !== "details"}
                    className="space-y-6"
                >
                        <div>
                            <ModalFieldLabel htmlFor="new-project-name">
                                Project name
                            </ModalFieldLabel>
                            <ModalTextInput
                                id="new-project-name"
                                name="name"
                                type="text"
                                placeholder="Add project name"
                                variant="minimal"
                                required
                                autoFocus
                            />
                        </div>
                        <div>
                            <ModalFieldLabel htmlFor="new-project-cm-number">
                                CM number
                            </ModalFieldLabel>
                            <ModalTextInput
                                id="new-project-cm-number"
                                name="cmNumber"
                                type="text"
                                placeholder="Add a CM number..."
                                variant="minimal"
                                className="text-xl text-gray-600"
                            />
                        </div>
                        <div>
                            <ModalFieldLabel htmlFor="new-project-practice">
                                Practice
                            </ModalFieldLabel>
                            <ProjectPracticeField
                                id="new-project-practice"
                                value={practice}
                                onChange={setPractice}
                            />
                        </div>
                        <div className="space-y-2">
                            <ModalFieldLabel as="p">
                                Share with
                            </ModalFieldLabel>
                            <AddUserInput
                                onAdd={handleAddShareUser}
                                validateEmail={validateShareUser}
                                placeholder="Add colleagues by email..."
                            />
                            {sharedUsers.length > 0 && (
                                <ul className="space-y-1 pt-1">
                                    {sharedUsers.map((entry) => {
                                        const displayName =
                                            entry.display_name?.trim();
                                        const primary = displayName || "User";
                                        const initial = displayName
                                            ?.charAt(0)
                                            .toUpperCase();
                                        return (
                                            <li
                                                key={entry.email}
                                                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-gray-100/70"
                                            >
                                                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 shadow-sm">
                                                    {initial ? (
                                                        <span className="font-serif text-[11px] leading-none">
                                                            {initial}
                                                        </span>
                                                    ) : (
                                                        <User className="h-2.5 w-2.5" />
                                                    )}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate text-xs text-gray-800">
                                                        {primary}
                                                        <span className="text-gray-400">
                                                            {" "}
                                                            · {entry.email}
                                                        </span>
                                                    </p>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        handleRemoveShareUser(
                                                            entry.email,
                                                        )
                                                    }
                                                    className="self-center inline-flex items-center rounded-full px-2 py-1 text-xs text-gray-500 hover:text-red-600"
                                                    aria-label={`Remove ${entry.email}`}
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </div>
                {step === "documents" && (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <FileDirectory
                            selectedDocuments={selectedDocuments}
                            onChange={setSelectedDocuments}
                            showTabs
                        />
                    </div>
                )}
                {error && (
                    <p className="mt-3 text-sm text-red-500">{error}</p>
                )}
            </form>
        </Modal>
    );
}
