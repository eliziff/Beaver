"use client";

import { type FormEvent, useEffect, useState } from "react";
import {
    createLegalResearchLabel,
    createLegalResearchProject,
    getLegalSourceMarking,
    listLegalResearchProjects,
    saveLegalSourceMark,
    type LegalResearchEdge,
    type LegalResearchNode,
    type LegalResearchProject,
    type LegalSourceMarking,
} from "@/app/lib/beaverApi";
import {
    LegalResearchLabelsPanel,
    type CreateLegalResearchLabelInput,
} from "./LegalResearchLabelsPanel";

const ACTIVE_PROJECT_KEY = "beaver:legal-research-project";

function message(reason: unknown) {
    return reason instanceof Error ? reason.message : "The change could not be saved";
}

function storedProjectId() {
    try {
        return window.localStorage.getItem(ACTIVE_PROJECT_KEY);
    } catch {
        return null;
    }
}

function rememberProjectId(projectId: string) {
    try {
        window.localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
    } catch {
        // The active choice remains usable for this page.
    }
}

export function LegalSourceMarkingPanel({ sourceId }: { sourceId: string }) {
    const [projects, setProjects] = useState<LegalResearchProject[] | null>(
        null,
    );
    const [activeProjectId, setActiveProjectId] = useState("");
    const [nodes, setNodes] = useState<LegalResearchNode[]>([]);
    const [edges, setEdges] = useState<LegalResearchEdge[]>([]);
    const [assignedNodeIds, setAssignedNodeIds] = useState<string[]>([]);
    const [note, setNote] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [creatingProject, setCreatingProject] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        let active = true;
        listLegalResearchProjects()
            .then((items) => {
                if (!active) return;
                setProjects(items);
                const remembered = storedProjectId();
                const selected =
                    items.find((item) => item.id === remembered)?.id ??
                    items[0]?.id ??
                    "";
                setActiveProjectId(selected);
                if (!selected) setLoading(false);
            })
            .catch((reason: unknown) => {
                if (!active) return;
                setProjects([]);
                setLoading(false);
                setError(message(reason));
            });
        return () => {
            active = false;
        };
    }, []);

    useEffect(() => {
        if (!activeProjectId) return;
        let active = true;
        setLoading(true);
        setError(null);
        getLegalSourceMarking(activeProjectId, sourceId)
            .then((marking) => {
                if (!active) return;
                applyMarking(marking);
                setLoading(false);
            })
            .catch((reason: unknown) => {
                if (!active) return;
                setLoading(false);
                setError(message(reason));
            });
        return () => {
            active = false;
        };
    }, [activeProjectId, sourceId]);

    function applyMarking(marking: LegalSourceMarking) {
        setNodes(marking.nodes);
        setEdges(marking.edges);
        setAssignedNodeIds(marking.mark?.label_ids ?? []);
        setNote(marking.mark?.note ?? "");
        setSaved(false);
    }

    function selectProject(projectId: string) {
        rememberProjectId(projectId);
        setActiveProjectId(projectId);
    }

    async function createLabel(input: CreateLegalResearchLabelInput) {
        if (!activeProjectId) return;
        setError(null);
        try {
            await createLegalResearchLabel(activeProjectId, input);
            applyMarking(
                await getLegalSourceMarking(activeProjectId, sourceId),
            );
        } catch (reason) {
            setError(message(reason));
        }
    }

    async function saveMark() {
        if (!activeProjectId) return;
        setSaving(true);
        setError(null);
        setSaved(false);
        try {
            const result = await saveLegalSourceMark(
                activeProjectId,
                sourceId,
                { labelIds: assignedNodeIds, note },
            );
            setAssignedNodeIds(result?.label_ids ?? []);
            setNote(result?.note ?? "");
            setSaved(true);
        } catch (reason) {
            setError(message(reason));
        } finally {
            setSaving(false);
        }
    }

    async function createProject(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = event.currentTarget;
        const name = String(new FormData(form).get("projectName") ?? "").trim();
        if (!name) return;
        setCreatingProject(true);
        setError(null);
        try {
            const project = await createLegalResearchProject(name);
            setProjects((current) => [...(current ?? []), project]);
            selectProject(project.id);
            form.reset();
        } catch (reason) {
            setError(message(reason));
        } finally {
            setCreatingProject(false);
        }
    }

    if (projects === null) {
        return (
            <p className="p-4 text-sm text-gray-500" role="status">
                Loading marks…
            </p>
        );
    }

    return (
        <div className="min-w-0">
            {error ? (
                <p
                    role="alert"
                    className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                >
                    {error}
                </p>
            ) : null}
            {saved ? (
                <p
                    role="status"
                    className="mb-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
                >
                    Saved
                </p>
            ) : null}
            {loading ? (
                <p className="rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-500">
                    Loading marks…
                </p>
            ) : (
                <LegalResearchLabelsPanel
                    nodes={nodes}
                    edges={edges.map((edge) => ({
                        sourceId: edge.from_node_id,
                        targetId: edge.to_node_id,
                        kind: edge.relation,
                    }))}
                    assignedNodeIds={assignedNodeIds}
                    note={note}
                    onAssignedNodeIdsChange={(ids) => {
                        setAssignedNodeIds(ids);
                        setSaved(false);
                    }}
                    onNoteChange={(value) => {
                        setNote(value);
                        setSaved(false);
                    }}
                    projectChoices={projects}
                    activeProjectId={activeProjectId}
                    onActiveProjectIdChange={selectProject}
                    onCreateLabel={(input) => void createLabel(input)}
                    onSave={() => void saveMark()}
                    isSaving={saving}
                />
            )}
            <details className="mt-2 rounded-md border border-gray-200 bg-white">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-gray-800">
                    New project
                </summary>
                <form
                    onSubmit={(event) => void createProject(event)}
                    className="flex min-w-0 gap-2 border-t border-gray-200 p-3"
                >
                    <label className="min-w-0 flex-1 text-xs font-medium text-gray-700">
                        Project name
                        <input
                            name="projectName"
                            required
                            maxLength={120}
                            className="mt-1 block h-9 w-full min-w-0 rounded-md border border-gray-300 px-3 text-sm font-normal outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                        />
                    </label>
                    <button
                        type="submit"
                        disabled={creatingProject}
                        className="mt-5 h-9 shrink-0 rounded-md bg-gray-900 px-3 text-sm font-medium text-white disabled:bg-gray-300"
                    >
                        {creatingProject ? "Creating…" : "Create"}
                    </button>
                </form>
            </details>
        </div>
    );
}
