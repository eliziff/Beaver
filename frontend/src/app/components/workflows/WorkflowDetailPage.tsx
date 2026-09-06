import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Users } from "lucide-react";
import {
  deleteWorkflow,
  deleteWorkflowShare,
  getWorkflow,
  listWorkflowShares,
  shareWorkflow,
  updateWorkflow,
  exportWorkflow,
  type Workflow,
  type WorkflowVariant,
} from "@/app/lib/api/workflows";
import { lookupUserByEmail } from "@/app/lib/api/account";
import type { ProjectPeople } from "@/app/lib/api/projects";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { isLocalMode } from "@/app/lib/authMode";
import { downloadBlob } from "@/app/lib/download";
import type { ColumnConfig } from "@/app/lib/api/tabular";

import { AddColumnModal } from "../tabular/AddColumnModal";
import { PeopleModal } from "../modals/PeopleModal";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { MoreActionsMenu, type MoreActionsMenuItem } from "../shared/MoreActionsMenu";
import { PageHeader, type PageHeaderAction } from "../shared/PageHeader";
import { Button } from "../ui/button";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { workflowPath } from "./workflowRoutes";

type Modal = "details" | "share" | "delete" | null;
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const variantInput = ({ label, result, execution, skill_md, columns_config }: WorkflowVariant) =>
    ({ label, result, execution, skill_md, columns_config });

export function WorkflowDetailPage({ id }: { id: string }) {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const [workflow, setWorkflow] = useState<Workflow | null>();
    const [modal, setModal] = useState<Modal>(null);
    const [column, setColumn] = useState<ColumnConfig | "new" | null>(null);
    const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const [sharedWith, setSharedWith] = useState<string[]>([]);
    const [deleting, setDeleting] = useState(false);
    useEffect(() => {
        getWorkflow(id).then((loaded) => {
            if (loaded.is_system) { navigate(`/workflows?workflow=${encodeURIComponent(loaded.id)}`,
                { replace: true }); return; }
            if (loaded.launcher.kind !== "instructions") { navigate(workflowPath(loaded),
                { replace: true }); return; }
            setWorkflow(loaded);
        }).catch(() => setWorkflow(null));
    }, [id, navigate]);
    const variant = workflow?.launcher.kind === "instructions" ? workflow.launcher.variants[0] : undefined;
    const readOnly = workflow?.is_system !== false || workflow.allow_edit === false;
    const canShare = !isLocalMode && !readOnly && workflow?.is_owner !== false;
    const fetchPeople = useCallback(async (): Promise<ProjectPeople> => {
        const shares = await listWorkflowShares(id);
        const emails = shares.map(({ shared_with_email }) => normalizeEmail(shared_with_email));
        setSharedWith(emails);
        return { owner: { email: user?.email ?? null, display_name: profile?.displayName ?? null },
            members: await Promise.all(emails.map(async (email) => ({ email, display_name:
                (await lookupUserByEmail(email).catch(() => null))?.display_name ?? null }))) };
    }, [id, profile?.displayName, user?.email]);
    async function changeSharedWith(next: string[]) {
        const emails = [...new Set(next.map(normalizeEmail).filter(Boolean))];
        const current = await listWorkflowShares(id);
        const byEmail = new Map(current.map((share) => [normalizeEmail(share.shared_with_email), share]));
        await Promise.all([
            ...current.filter(({ shared_with_email }) => !emails.includes(normalizeEmail(shared_with_email)))
                .map(({ id: shareId }) => deleteWorkflowShare(id, shareId)),
            ...(emails.some((email) => !byEmail.has(email)) ? [shareWorkflow(id, {
                emails: emails.filter((email) => !byEmail.has(email)), allow_edit: false })] : []),
        ]);
        setSharedWith(emails);
    }
    async function saveVariant(next: WorkflowVariant) {
        if (!workflow || readOnly) return;
        setStatus("saving");
        try {
            const updated = await updateWorkflow(id, { launcher: { kind: "instructions",
                variants: [variantInput(next)] } });
            setWorkflow(updated);
            setStatus("saved"); setTimeout(() => setStatus("idle"), 1500);
        } catch { setStatus("error"); }
    }
    function saveColumns(next: ColumnConfig[]) {
        if (variant) void saveVariant({ ...variant, columns_config: next }); setColumn(null);
    }
    async function remove() {
        if (!workflow || readOnly) return;
        setDeleting(true);
        try { await deleteWorkflow(id); navigate("/workflows"); } finally { setDeleting(false); }
    }
    if (workflow === null) return <div className="grid h-full place-items-center text-sm text-gray-500">Workflow not found.</div>;
    const menuItems: MoreActionsMenuItem[] = workflow ? [{ label: "Download workflow",
        onSelect: () => void exportWorkflow(id)
            .then(({ blob, filename }) => downloadBlob(blob, filename ?? "workflow.zip")) },
        ...(!readOnly ? [{ label: "Edit details", onSelect: () => setModal("details") },
            { label: "Delete", onSelect: () => setModal("delete") }] : []),
    ] : [];
    const actions: (PageHeaderAction | null)[] | undefined = workflow ? [
        { type: "custom", render: <span role="status" className={`w-20 text-center text-xs ${
            status === "error" ? "text-red-700" : "text-gray-500"}`}>
            {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? "Save failed" : ""}
        </span> },
        canShare ? { title: "Share workflow", iconOnly: true,
            icon: <Users aria-hidden="true" className="h-4 w-4" />, onClick: () => setModal("share") } : null,
        { type: "custom", render: <MoreActionsMenu label="Workflow actions" items={menuItems} /> },
    ] : undefined;
    return <div className="flex h-full min-h-0 flex-col">
            <PageHeader shrink breadcrumbs={[
                { label: "Workflows", title: "Back to Workflows", onClick: () => navigate("/workflows") },
                workflow ? { label: workflow.metadata.title }
                    : { loading: true, skeletonClassName: "w-40" },
            ]} actions={actions} />
            {workflow && variant && <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
                <header className="mb-5">
                    <p className="text-xs font-medium text-gray-500">{workflow.metadata.category}</p>
                    <h1 className="mt-1 font-serif text-2xl font-medium text-gray-900">{workflow.metadata.title}</h1>
                    {workflow.metadata.description && <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">{workflow.metadata.description}</p>}
                </header>
                {variant.execution === "assistant" ? <textarea
                    key={variant.id} aria-label="Workflow instructions" readOnly={readOnly}
                    defaultValue={variant.skill_md ?? ""}
                    onBlur={(event) => { if (event.currentTarget.value !== (variant.skill_md ?? ""))
                        void saveVariant({ ...variant, skill_md: event.currentTarget.value }); }}
                    placeholder="Write the workflow instructions in Markdown."
                    className="min-h-96 w-full resize-y rounded-lg border border-gray-300 bg-white p-4 font-mono text-sm leading-6 text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 read-only:resize-none read-only:bg-gray-50" />
                : <section aria-labelledby="workflow-columns-title">
                    <div className="flex items-center justify-between gap-3">
                        <h2 id="workflow-columns-title" className="font-serif text-xl font-medium text-gray-900">Table columns</h2>
                        {!readOnly && <Button size="compact"
                            onClick={() => setColumn("new")}><Plus aria-hidden="true" className="h-4 w-4" />Add column</Button>}
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {(variant.columns_config ?? []).map((item) => <button
                                key={item.index} type="button" disabled={readOnly}
                                onClick={() => setColumn(item)}
                                className="min-h-20 rounded-lg bg-gray-50 p-3 text-left disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
                                <span className="block text-sm font-medium text-gray-800">{item.name}</span>
                                <span className="mt-1 block text-xs leading-5 text-gray-500">{item.prompt}</span>
                            </button>)}
                    </div>
                </section>}
            </main>}
            {workflow && <>
                <NewWorkflowModal open={modal === "details"} editWorkflow={workflow}
                    onClose={() => setModal(null)} onUpdated={setWorkflow} />
                <PeopleModal open={modal === "share"} fetchPeople={fetchPeople}
                    onClose={() => setModal(null)} resource={{ id, shared_with: sharedWith }}
                    currentUserEmail={user?.email ?? null} breadcrumb={["Workflows", workflow.metadata.title, "People"]}
                    onSharedWithChange={changeSharedWith} />
                <ConfirmPopup open={modal === "delete"} title="Delete workflow?"
                    message="This permanently deletes the workflow." confirmLabel="Delete workflow"
                    confirmStatus={deleting ? "loading" : "idle"}
                    onConfirm={() => void remove()} onCancel={() => setModal(null)} />
            </>}
            {workflow && variant && !readOnly && <AddColumnModal open={column !== null}
                existingCount={variant.columns_config?.length ?? 0} editingColumn={column === "new"
                    ? undefined : column ?? undefined}
                onClose={() => setColumn(null)}
                onAdd={(added) => saveColumns([...(variant.columns_config ?? []),
                    ...added.map((item, index) => ({ ...item,
                        index: (variant.columns_config?.length ?? 0) + index }))])}
                onSave={(updated) => saveColumns((variant.columns_config ?? []).map((item) =>
                    item.index === updated.index ? updated : item))}
                onDelete={column && column !== "new" ? () => saveColumns(
                    (variant.columns_config ?? []).filter(({ index }) => index !== column.index)
                        .map((item, index) => ({ ...item, index }))) : undefined} />}
        </div>;
}
