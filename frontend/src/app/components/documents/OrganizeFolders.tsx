import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText } from "lucide-react";
import { applyFolders, proposeFolders, type FolderProposal, type OrganizeTarget } from "@/app/lib/api/organize";
import type { ProposalProgress } from "@/app/lib/api/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { Modal } from "../modals/Modal";
import { FolderSvgIcon } from "../shared/FolderSvgIcon";
import { useSelectedModel, useSelectedReasoningEffort } from "@/app/hooks/useSelectedModel";

const META = "text-xs text-gray-500";
const INPUT = "w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900";
const ROW = "flex h-9 items-center gap-1.5 truncate px-2 text-sm text-gray-800";
type Props = { open: boolean; onClose: () => void; target: OrganizeTarget; title: string; onOrganized?: () => void };

/** The proposal as the folder tree it would create: every folder with the files it would hold, then whatever stays put. */
function ProposedTree({ proposal }: { proposal: FolderProposal }) {
    const branch = (parentKey: string | null, depth: number): ReactNode[] =>
        proposal.folders.filter((folder) => folder.parentKey === parentKey).map((folder) =>
            <li key={folder.key}>
                <div className={`${ROW} font-medium text-gray-900`} style={{ paddingInlineStart: `${depth * 16 + 8}px` }}>
                    <FolderSvgIcon className="size-3.5 shrink-0" /> {folder.name}
                </div>
                <ul>{branch(folder.key, depth + 1)}{folder.documents.map((document) =>
                    <li key={document.id} className={ROW} style={{ paddingInlineStart: `${(depth + 1) * 16 + 8}px` }}>
                        <FileText aria-hidden className="size-3.5 shrink-0 text-gray-400" /> {document.filename}
                    </li>)}</ul>
            </li>);
    return <ul className="min-w-0">{branch(null, 0)}
        {proposal.unfiled.map((document) => <li key={document.id} className={ROW}>
            <FileText aria-hidden className="size-3.5 shrink-0 text-gray-400" /> {document.filename}
        </li>)}</ul>;
}

/** The lawyer says what the folders are for; one model reading proposes them; nothing moves until Apply. */
export const OrganizeFolders = ({ open, ...props }: Props) => open ? <OpenOrganizeFolders {...props} /> : null;

function OpenOrganizeFolders({ onClose, target, title, onOrganized }: Omit<Props, "open">) {
    const [instruction, setInstruction] = useState(""), [proposal, setProposal] = useState<FolderProposal | null>(null);
    const [busy, setBusy] = useState(false), [applying, setApplying] = useState(false), [error, setError] = useState("");
    const [progress, setProgress] = useState<ProposalProgress | null>(null), [started, setStarted] = useState(0), [now, setNow] = useState(0);
    const generation = useRef(0), running = useRef<AbortController | null>(null);
    const [model] = useSelectedModel(), [effort] = useSelectedReasoningEffort();
    useEffect(() => { if (!busy) return; const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [busy]);
    useEffect(() => () => { generation.current++; running.current?.abort(); }, []);
    async function propose() {
        if (!instruction.trim() || busy) return;
        running.current?.abort(); const controller = new AbortController(); running.current = controller;
        const run = ++generation.current;
        setBusy(true); setError(""); setProgress({ stage: "reading" }); setStarted(Date.now()); setNow(Date.now());
        try {
            const next = await proposeFolders(target, { instruction: instruction.trim(), model,
                ...(effort ? { reasoningEffort: effort } : {}) },
                (event) => { if (run === generation.current) setProgress(event); }, controller.signal);
            if (run === generation.current) setProposal(next);
        } catch (reason) { if (run === generation.current && !controller.signal.aborted)
            setError(errorMessage(reason, "Could not propose folders; nothing was moved")); }
        finally { if (run === generation.current) { setBusy(false); setProgress(null); } }
    }
    async function apply() {
        if (!proposal || applying || busy) return;
        setApplying(true); setError("");
        try { await applyFolders(target, { fingerprint: proposal.fingerprint, design: proposal.design });
            onOrganized?.(); onClose(); }
        catch (reason) { setError(errorMessage(reason, "Could not file these documents. Propose again before trying.")); }
        finally { setApplying(false); }
    }
    const cancel = () => { running.current?.abort(); generation.current++; setBusy(false); setProgress(null); };
    const elapsed = started ? Math.max(0, Math.round((now - started) / 1000)) : 0;
    const shortModel = (value = model) => value.split(":").pop() ?? value;
    const working = progress?.stage === "reading" ? "Reading these files…"
        : progress?.stage === "asking" ? [`Asking ${shortModel(progress.model)}…`,
            progress.chars ? `${progress.chars.toLocaleString()} characters` : "", `${elapsed} s`].filter(Boolean).join(" · ")
        : progress?.stage === "checking" ? "Checking the proposed folders against these files…"
        : progress?.stage === "retrying" ? `The first proposal was rejected (${progress.note}); asking for a correction…` : "";
    return <Modal open onClose={onClose} size="lg" breadcrumbs={[title, "Organize"]}
        footerStatus={error ? <p role="alert" className="me-auto text-sm text-red-700">{error}</p>
            : busy && proposal ? <p role="status" className={`me-auto ${META}`}>{working}</p> : undefined}
        secondaryAction={busy ? { label: "Cancel", onClick: cancel }
            : proposal ? { label: "Propose again", disabled: applying, onClick: () => void propose() } : undefined}
        primaryAction={busy ? { label: "Proposing…", disabled: true }
            : !proposal ? { label: "Propose folders", disabled: !instruction.trim(), onClick: () => void propose() }
            : { label: applying ? "Filing…" : "Apply", disabled: applying, onClick: () => void apply() }}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 py-4">
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-1" aria-busy={busy}>
                {busy && !proposal ? <div role="status" className="flex flex-col gap-3">
                    <p className={META}>{working}</p>
                    {[0, 1, 2].map((key) => <div key={key} className="h-20 shrink-0 animate-pulse rounded-lg bg-gray-100" />)}
                </div>
                : !proposal ? <div className="flex flex-col gap-2">
                    <p className="text-sm text-gray-700">The model reads these files and proposes the folders they
                        belong in, then files each one. Nothing moves until you apply it.</p>
                    <p className={META}>Runs on {shortModel()}{effort ? ` · ${effort} reasoning` : ""}</p>
                </div>
                : <ProposedTree proposal={proposal} />}
            </div>
            <label className="flex shrink-0 flex-col gap-1">
                <span className={META}>{proposal ? "Change the proposal" : "How to organize these files"}</span>
                <input value={instruction} disabled={busy || applying} className={INPUT} aria-label="How to organize these files"
                    placeholder="e.g. organize by transaction workstream and counterparty"
                    onChange={(event) => setInstruction(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void propose(); } }} />
            </label>
        </div>
    </Modal>;
}
