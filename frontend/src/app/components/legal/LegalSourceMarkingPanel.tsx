"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { CheckboxInput } from "@/app/components/ui/checkbox";
import {
    createLegalResearchLabel,
    createLegalResearchProject,
    getLegalSourceMarking,
    listProjects,
    saveLegalSourceMark,
    type LegalResearchNode,
    type LegalResearchProject,
    type LegalSourceMarking,
} from "@/app/lib/beaverApi";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";

const PROJECT_KEY = "beaver:legal-research-project";
const EMPTY_MARK = { label_ids: [] as string[], note: "" };

function message(reason: unknown) {
    return reason instanceof Error ? reason.message : "The change could not be saved";
}

function labelPaths(marking: LegalSourceMarking) {
    const labels = marking.nodes.filter((node) => node.kind === "label");
    const byId = new Map(labels.map((node) => [node.id, node]));
    const parents = new Map(
        marking.edges
            .filter((edge) => edge.relation === "parent")
            .map((edge) => [edge.from_node_id, edge.to_node_id]),
    );
    return labels.map((node) => {
        const path: string[] = [];
        const seen = new Set<string>();
        for (
            let part: LegalResearchNode | undefined = node;
            part && !seen.has(part.id);
            part = byId.get(parents.get(part.id) ?? "")
        ) {
            seen.add(part.id);
            path.unshift(part.name);
        }
        return { node, name: path.join(" › ") };
    });
}

export function LegalSourceMarkingPanel({ sourceId }: { sourceId: string }) {
    const [projectId, setProjectId] = useState("");
    const [projectQuery, setProjectQuery] = useState("");
    const [loaded, setLoaded] = useState<{ key: string; value: LegalSourceMarking } | null>(null);
    const [parentId, setParentId] = useState<string | null>(null);
    const [status, setStatus] = useState("");
    const [error, setError] = useState("");
    const key = `${projectId}:${sourceId}`;
    const marking = loaded?.key === key ? loaded.value : null;
    const paths = useMemo(() => (marking ? labelPaths(marking) : []), [marking]);
    const page = usePagedQuery((cursor, signal) =>
        listProjects({ q: projectQuery, cursor }, signal), [projectQuery]);
    const projects: LegalResearchProject[] = useMemo(() => [
        ...("general research".includes(projectQuery.toLowerCase())
            ? [{ id: "general", name: "General research", order: 0 }]
            : []),
        ...page.items.map(({ id, name }, order) => ({ id, name, order: order + 1 })),
    ], [page.items, projectQuery]);

    useEffect(() => {
        if (projectId) return;
        const remembered = localStorage.getItem(PROJECT_KEY);
        setProjectId(projects.some(({ id }) => id === remembered) ? remembered! : "general");
    }, [projectId, projects]);
    useEffect(() => { if (page.error) setError(message(page.error)); }, [page.error]);

    useEffect(() => {
        if (!projectId) return;
        let live = true;
        getLegalSourceMarking(projectId, sourceId)
            .then((value) => {
                if (live) setLoaded({ key, value });
            })
            .catch((reason) => {
                if (live) setError(message(reason));
            });
        return () => { live = false; };
    }, [key, projectId, sourceId]);

    function chooseProject(id: string) {
        localStorage.setItem(PROJECT_KEY, id);
        setProjectId(id);
        setParentId(null);
        setStatus("");
        setError("");
    }

    function changeMark(update: (mark: typeof EMPTY_MARK) => typeof EMPTY_MARK) {
        setLoaded((current) => {
            if (current?.key !== key) return current;
            const mark = update({ ...EMPTY_MARK, ...current.value.mark });
            return { ...current, value: { ...current.value, mark } };
        });
    }

    function updateMark(next: Partial<typeof EMPTY_MARK>) {
        setStatus("");
        changeMark((mark) => ({ ...mark, ...next }));
    }

    async function createProject(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = event.currentTarget;
        const name = new FormData(form).get("name")?.toString().trim();
        if (!name) return;
        try {
            const project = await createLegalResearchProject(name);
            setProjectQuery("");
            chooseProject(project.id);
            form.reset();
        } catch (reason) {
            setError(message(reason));
        }
    }

    async function createLabel(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!projectId) return;
        const form = event.currentTarget;
        const data = new FormData(form);
        const name = data.get("name")?.toString().trim();
        if (!name) return;
        try {
            await createLegalResearchLabel(projectId, {
                name,
                color: data.get("color")?.toString() || "#b91c1c",
                parentId,
            });
            setLoaded({ key, value: await getLegalSourceMarking(projectId, sourceId) });
            setParentId(null);
            setStatus("");
            form.reset();
        } catch (reason) {
            setError(message(reason));
        }
    }

    async function save() {
        if (!projectId || !marking) return;
        setStatus("Saving…");
        try {
            const saved = await saveLegalSourceMark(projectId, sourceId, {
                labelIds: marking.mark?.label_ids ?? [],
                note: marking.mark?.note ?? "",
            });
            changeMark(() => saved ?? EMPTY_MARK);
            setStatus("Saved");
        } catch (reason) {
            setStatus("");
            setError(message(reason));
        }
    }

    return (
        <div className="min-w-0 space-y-3">
            {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
            <input
                type="search"
                value={projectQuery}
                onChange={(event) => setProjectQuery(event.target.value)}
                placeholder="Find project"
                aria-label="Find project"
                className="h-9 w-full rounded border border-gray-300 bg-white px-3 text-sm"
            />
            <div className="max-h-32 overflow-y-auto rounded border border-gray-200 bg-white p-1">
                {projects.map((project) => (
                    <button
                        key={project.id}
                        type="button"
                        onClick={() => chooseProject(project.id)}
                        className={`block h-9 w-full truncate rounded px-2 text-left text-sm ${
                            project.id === projectId ? "bg-red-50 text-brand" : "hover:bg-gray-50"
                        }`}
                    >
                        {project.name}
                    </button>
                ))}
                {page.loading && <p className="p-2 text-sm text-gray-500">Loading...</p>}
                {page.hasMore && <button type="button" onClick={() => void page.loadMore()}
                    className="h-9 w-full text-sm text-gray-600">Load more</button>}
            </div>
            <details className="rounded border border-gray-200 bg-white">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">New project</summary>
                <form onSubmit={createProject} className="flex gap-2 border-t border-gray-200 p-2">
                    <input name="name" aria-label="Project name" className="h-9 min-w-0 flex-1 rounded border border-gray-300 px-3 text-sm" />
                    <button className="h-9 rounded bg-gray-900 px-3 text-sm text-white">Create</button>
                </form>
            </details>
            {projectId && !marking ? (
                <p className="p-2 text-sm text-gray-500">Loading marks…</p>
            ) : marking ? (
                <>
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                        {paths.map(({ node, name }) => {
                            const assigned = marking.mark?.label_ids ?? [];
                            const checked = assigned.includes(node.id);
                            return (
                                <div key={node.id} className="grid min-h-9 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded px-2 hover:bg-gray-100">
                                    <CheckboxInput
                                        checked={checked}
                                        onChange={() => updateMark({
                                            label_ids: checked
                                                ? assigned.filter((id) => id !== node.id)
                                                : [...assigned, node.id],
                                        })}
                                        aria-label={name}
                                        style={{ accentColor: node.color }}
                                    />
                                    <span className="truncate text-sm" title={name}>{name}</span>
                                    <button type="button" onClick={() => setParentId(node.id)} className="text-xs text-gray-600 hover:text-gray-950">Add child</button>
                                </div>
                            );
                        })}
                    </div>
                    <form onSubmit={createLabel} className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2">
                        <input name="color" type="color" defaultValue="#b91c1c" aria-label="Label colour" className="h-9 w-9 rounded border border-gray-300 bg-white p-1" />
                        <input name="name" required aria-label="New label name" placeholder={parentId ? `Child of ${marking.nodes.find(({ id }) => id === parentId)?.name}` : "New label"} className="h-9 min-w-0 rounded border border-gray-300 px-3 text-sm" />
                        <button className="h-9 rounded border border-gray-300 bg-white px-3 text-sm">Add</button>
                    </form>
                    {parentId && <button type="button" onClick={() => setParentId(null)} className="text-xs text-gray-600">Add at top level instead</button>}
                    <textarea
                        value={marking.mark?.note ?? ""}
                        onChange={(event) => updateMark({ note: event.target.value })}
                        placeholder="Notes"
                        aria-label="Note"
                        rows={3}
                        className="w-full resize-y rounded border border-gray-300 p-3 text-sm"
                    />
                    <button type="button" onClick={() => void save()} disabled={status === "Saving…"} className="h-9 w-full rounded bg-brand px-3 text-sm font-medium text-white disabled:opacity-50">
                        <span role={status === "Saved" ? "status" : undefined}>{status || "Save"}</span>
                    </button>
                </>
            ) : null}
        </div>
    );
}
