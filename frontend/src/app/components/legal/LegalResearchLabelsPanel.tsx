"use client";
import { Fragment, type FormEvent, useState } from "react";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { CheckboxInput } from "@/app/components/ui/checkbox";
export interface LegalResearchGraphNode {
    id: string;
    kind: string;
    name: string;
    color?: string;
}
export interface LegalResearchGraphEdge {
    sourceId: string;
    targetId: string;
    kind: string;
}
export interface LegalResearchProjectChoice {
    id: string;
    name: string;
}
export interface CreateLegalResearchLabelInput {
    name: string;
    color: string;
    parentId: string | null;
}
export interface LegalResearchLabelsPanelProps {
    nodes: readonly LegalResearchGraphNode[];
    edges: readonly LegalResearchGraphEdge[];
    assignedNodeIds: readonly string[];
    note: string;
    onAssignedNodeIdsChange: (nodeIds: string[]) => void;
    onNoteChange: (note: string) => void;
    projectChoices?: readonly LegalResearchProjectChoice[];
    activeProjectId?: string;
    onActiveProjectIdChange?: (projectId: string) => void;
    onCreateLabel?: (label: CreateLegalResearchLabelInput) => void;
    onSave?: () => void;
    isSaving?: boolean;
}
function labelPaths(
    nodes: readonly LegalResearchGraphNode[],
    edges: readonly LegalResearchGraphEdge[],
) {
    const labels = nodes.filter((node) => node.kind === "label");
    const labelsById = new Map(labels.map((node) => [node.id, node]));
    const parentByChild = new Map<string, string>();
    for (const edge of edges) {
        if (
            edge.kind === "parent" &&
            labelsById.has(edge.sourceId) &&
            labelsById.has(edge.targetId) &&
            !parentByChild.has(edge.sourceId)
        ) {
            parentByChild.set(edge.sourceId, edge.targetId);
        }
    }
    return labels.map((node) => {
        const path: LegalResearchGraphNode[] = [];
        const visited = new Set<string>();
        let current: LegalResearchGraphNode | undefined = node;
        while (current && !visited.has(current.id)) {
            visited.add(current.id);
            path.unshift(current);
            current = labelsById.get(parentByChild.get(current.id) ?? "");
        }
        return { node, path };
    });
}
export function LegalResearchLabelsPanel({
    nodes,
    edges,
    assignedNodeIds,
    note,
    onAssignedNodeIdsChange,
    onNoteChange,
    projectChoices,
    activeProjectId,
    onActiveProjectIdChange,
    onCreateLabel,
    onSave,
    isSaving = false,
}: LegalResearchLabelsPanelProps) {
    const [newParentId, setNewParentId] = useState("");
    const assigned = new Set(assignedNodeIds);
    const paths = labelPaths(nodes, edges);
    const assignedLabelCount = paths.filter(({ node }) =>
        assigned.has(node.id),
    ).length;
    function toggleNode(nodeId: string) {
        onAssignedNodeIdsChange(
            assigned.has(nodeId)
                ? assignedNodeIds.filter((id) => id !== nodeId)
                : [...assignedNodeIds, nodeId],
        );
    }
    function createLabel(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!onCreateLabel) return;
        const form = event.currentTarget;
        const data = new FormData(form);
        const name = String(data.get("name") ?? "").trim();
        if (!name) return;
        const parentId = String(data.get("parentId") ?? "");
        onCreateLabel({
            name,
            color: String(data.get("color") ?? "#b91c1c"),
            parentId: parentId || null,
        });
        form.reset();
        setNewParentId("");
    }
    return (
        <section
            aria-label="Mark source"
            aria-busy={isSaving}
            className="rounded-lg border border-gray-200 bg-white p-4"
        >
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="text-base font-semibold text-gray-900">
                    Mark source
                </h2>
                <span className="text-xs text-gray-500">
                    {assignedLabelCount} selected
                </span>
            </div>
            {projectChoices?.length ? (
                <label
                    htmlFor="legal-research-project"
                    className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-gray-800"
                >
                    Project
                    <ModalSelect
                        id="legal-research-project"
                        value={activeProjectId ?? ""}
                        onChange={(value) =>
                            onActiveProjectIdChange?.(value)
                        }
                        disabled={!onActiveProjectIdChange}
                        searchable
                        options={[
                            { value: "", label: "Select project" },
                            ...projectChoices.map((project) => ({
                                value: project.id,
                                label: project.name,
                            })),
                        ]}
                        className="!h-9 min-w-48 max-w-full font-normal"
                    />
                </label>
            ) : null}
            <fieldset className="mt-4 min-w-0">
                <legend className="mb-2 text-sm font-medium text-gray-800">
                    Labels
                </legend>
                {paths.length ? (
                    <div className="max-h-56 space-y-1 overflow-y-auto overscroll-contain pr-1">
                        {paths.map(({ node, path }) => {
                            const checked = assigned.has(node.id);
                            const pathName = path
                                .map((part) => part.name)
                                .join(" › ");
                            return (
                                <label
                                    key={node.id}
                                    className={`grid min-h-10 min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md border px-3 py-2 text-sm focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-brand ${
                                        checked
                                            ? "border-gray-400 bg-gray-50"
                                            : "border-gray-200 hover:bg-gray-50"
                                    }`}
                                >
                                    <CheckboxInput
                                        checked={checked}
                                        onChange={() => toggleNode(node.id)}
                                        aria-label={pathName}
                                        style={{
                                            accentColor:
                                                node.color ?? "#b91c1c",
                                        }}
                                    />
                                    <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 break-normal">
                                        {path.map((part, index) => (
                                            <Fragment key={part.id}>
                                                {index > 0 ? (
                                                    <span
                                                        aria-hidden="true"
                                                        className="shrink-0 text-gray-400"
                                                    >
                                                        ›
                                                    </span>
                                                ) : null}
                                                <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 break-normal">
                                                    <span
                                                        aria-hidden="true"
                                                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                                                        style={{
                                                            backgroundColor:
                                                                part.color ??
                                                                "#9ca3af",
                                                        }}
                                                    />
                                                    <span className="min-w-0 break-normal">
                                                        {part.name}
                                                    </span>
                                                </span>
                                            </Fragment>
                                        ))}
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                ) : (
                    <p className="text-sm text-gray-500">No labels yet.</p>
                )}
            </fieldset>
            {onCreateLabel ? (
                <details className="mt-3 rounded-md border border-gray-200 bg-gray-50">
                    <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-gray-800">
                        New label
                    </summary>
                    <form
                        onSubmit={createLabel}
                        className="space-y-3 border-t border-gray-200 px-3 py-3"
                    >
                        <label className="block min-w-0 text-xs font-medium text-gray-700">
                            Name
                            <input
                                type="text"
                                name="name"
                                required
                                maxLength={120}
                                className="mt-1 block h-9 w-full min-w-0 rounded-md border border-gray-300 bg-white px-3 text-sm font-normal text-gray-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                            />
                        </label>
                        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3">
                            <label className="block text-xs font-medium text-gray-700">
                                Color
                                <input
                                    type="color"
                                    name="color"
                                    defaultValue="#b91c1c"
                                    className="mt-1 block h-9 w-12 cursor-pointer rounded-md border border-gray-300 bg-white p-1"
                                />
                            </label>
                            <label
                                htmlFor="legal-research-parent"
                                className="block min-w-0 text-xs font-medium text-gray-700"
                            >
                                Parent
                                <input
                                    type="hidden"
                                    name="parentId"
                                    value={newParentId}
                                    readOnly
                                />
                                <ModalSelect
                                    id="legal-research-parent"
                                    value={newParentId}
                                    onChange={setNewParentId}
                                    searchable
                                    options={[
                                        { value: "", label: "No parent" },
                                        ...paths.map(({ node, path }) => ({
                                            value: node.id,
                                            label: path
                                                .map((part) => part.name)
                                                .join(" \u203a "),
                                        })),
                                    ]}
                                    className="mt-1 !h-9 font-normal"
                                />
                            </label>
                        </div>
                        <div className="flex justify-end">
                            <button
                                type="submit"
                                className="h-9 rounded-md bg-gray-900 px-3 text-sm font-medium text-white hover:bg-gray-700"
                            >
                                Create label
                            </button>
                        </div>
                    </form>
                </details>
            ) : null}
            <label className="mt-4 block min-w-0 text-sm font-medium text-gray-800">
                Note
                <textarea
                    value={note}
                    onChange={(event) => onNoteChange(event.target.value)}
                    rows={3}
                    className="mt-2 block w-full min-w-0 resize-y rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-normal text-gray-900 outline-none placeholder:text-gray-400 focus:border-brand focus:ring-1 focus:ring-brand"
                    placeholder="Add a note"
                />
            </label>
            {onSave ? (
                <div className="mt-4 flex justify-end">
                    <button
                        type="button"
                        onClick={onSave}
                        disabled={isSaving}
                        className="h-9 rounded-md bg-brand px-4 text-sm font-medium text-white hover:bg-brand-dark disabled:cursor-wait disabled:bg-gray-300"
                    >
                        {isSaving ? "Saving\u2026" : "Save"}
                    </button>
                </div>
            ) : null}
        </section>
    );
}
