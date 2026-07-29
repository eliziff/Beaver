"use client";
import { useState, type ReactNode } from "react";
import { Download, Trash2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { MfaVerificationPopup, needsMfaVerification } from "@/app/components/popups/MfaVerificationPopup";
import { deleteAllChats, deleteAllProjects, deleteAllTabularReviews, exportAccountData, exportChatData, exportTabularReviewsData, isMfaRequiredError } from "@/app/lib/beaverApi";
import { accountGlassDangerOutlineButtonClassName, accountGlassPrimaryButtonClassName } from "../accountStyles";
import { AccountSection } from "../AccountSection";
import { downloadBlob } from "@/app/lib/download";

type DeleteAction = "chats" | "tabular-reviews" | "projects";
type ExportAction = "export-account" | "export-chats" | "export-tabular-reviews";
type PendingAction = DeleteAction | ExportAction;
const exports: { action: ExportAction; title: string; description: string; file: string; run: () => Promise<{ blob: Blob; filename: string | null }> }[] = [
    { action: "export-chats", title: "Export chats", description: "Assistant and review chat history as JSON.", file: "beaver-chat-export.json", run: exportChatData },
    { action: "export-tabular-reviews", title: "Export tabular reviews", description: "Owned reviews, cells, and review chats as JSON.", file: "beaver-tabular-reviews-export.json", run: exportTabularReviewsData },
    { action: "export-account", title: "Export account", description: "Account, project, document, workflow, and review data as JSON.", file: "beaver-account-export.json", run: exportAccountData },
];
const deletes: { action: DeleteAction; title: string; message: string }[] = [
    { action: "chats", title: "Delete all chats", message: "This permanently deletes assistant and review chat history." },
    { action: "tabular-reviews", title: "Delete all tabular reviews", message: "This permanently deletes reviews you own, including cells and review chats." },
    { action: "projects", title: "Delete all projects", message: "This permanently deletes projects you own, including documents, chats, and reviews." },
];

export default function PrivacyDataPage() {
    const { loadChats } = useChatHistoryContext();
    const [busy, setBusy] = useState<PendingAction | null>(null);
    const [pendingDelete, setPendingDelete] = useState<DeleteAction | null>(null);
    const [pendingMfa, setPendingMfa] = useState<PendingAction | null>(null);

    async function runExport(item: (typeof exports)[number]) {
        setBusy(item.action);
        try {
            if (await needsMfaVerification()) return setPendingMfa(item.action);
            const result = await item.run();
            downloadBlob(result.blob, result.filename ?? item.file);
        } catch (error) {
            if (isMfaRequiredError(error)) setPendingMfa(item.action);
            else alert("The export failed. Please try again.");
        } finally { setBusy(null); }
    }

    async function runDelete(action: DeleteAction) {
        setBusy(action);
        try {
            if (await needsMfaVerification()) return setPendingMfa(action);
            if (action === "chats") await deleteAllChats();
            else if (action === "tabular-reviews") await deleteAllTabularReviews();
            else await deleteAllProjects();
            if (action !== "tabular-reviews") await loadChats();
            setPendingDelete(null);
        } catch (error) {
            if (isMfaRequiredError(error)) setPendingMfa(action);
            else alert("The deletion failed. Please try again.");
        } finally { setBusy(null); }
    }

    async function retryMfa() {
        const action = pendingMfa;
        setPendingMfa(null);
        if (!action) return;
        const item = exports.find((entry) => entry.action === action);
        if (item) return runExport(item);
        await runDelete(action as DeleteAction);
    }

    const deleteCopy = deletes.find((item) => item.action === pendingDelete);
    return <div className="space-y-6">
        <section className="space-y-3"><h2 className="text-xl font-medium font-serif text-gray-900">Export data</h2><AccountSection>{exports.map((item, index) => <ActionRow key={item.action} title={item.title} description={item.description} icon={<Download className="h-4 w-4" />} label={busy === item.action ? "Exporting…" : "Export"} disabled={busy != null} className={accountGlassPrimaryButtonClassName} onClick={() => void runExport(item)} divider={index < exports.length - 1} />)}</AccountSection></section>
        <section className="space-y-3"><h2 className="text-xl font-medium font-serif text-gray-900">Delete data</h2><AccountSection>{deletes.map((item, index) => <ActionRow key={item.action} title={item.title} description={item.message} icon={<Trash2 className="h-4 w-4" />} label="Delete" disabled={busy != null} className={accountGlassDangerOutlineButtonClassName} onClick={() => setPendingDelete(item.action)} divider={index < deletes.length - 1} />)}</AccountSection></section>
        <ConfirmPopup open={!!pendingDelete} title={`${deleteCopy?.title ?? "Delete data"}?`} message={deleteCopy?.message} confirmLabel="Delete" confirmStatus={busy ? "loading" : "idle"} cancelLabel="Cancel" onCancel={() => { if (!busy) setPendingDelete(null); }} onConfirm={() => { if (pendingDelete) void runDelete(pendingDelete); }} />
        <MfaVerificationPopup open={!!pendingMfa} onCancel={() => setPendingMfa(null)} onVerified={() => void retryMfa()} title="Two-factor verification required" message="Enter a code from your authenticator app to continue." />
    </div>;
}

function ActionRow({ title, description, icon, label, disabled, className, onClick, divider }: { title: string; description: string; icon: ReactNode; label: string; disabled: boolean; className: string; onClick: () => void; divider: boolean }) {
    return <><div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-medium text-gray-900">{title}</p><p className="text-sm text-gray-500">{description}</p></div><Button variant="outline" onClick={onClick} disabled={disabled} className={`h-9 shrink-0 gap-1.5 text-sm ${className}`}>{!disabled && icon}{label}</Button></div>{divider && <div className="mx-4 h-px bg-gray-200" />}</>;
}
