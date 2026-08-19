import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import type { Project } from "../shared/types";
import { FolderSvgIcon } from "../shared/FolderSvgIcon";
import { SearchBar } from "../ui/search-bar";
import { getProject, listProjects } from "@/app/lib/beaverApi";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
interface Props {
    projects?: Project[];
    value: string | null;
    onChange: (projectId: string) => void;
    disabled?: boolean;
    loading?: boolean;
}
export function ProjectChoiceList({
    projects,
    value,
    onChange,
    disabled = false,
    loading = false,
}: Props) {
    const [search, setSearch] = useState("");
    const [selectedProject, setSelectedProject] = useState<Project | null>(null);
    const page = usePagedQuery(
        (cursor, signal) => listProjects({ q: search, cursor }, signal),
        [search],
        projects === undefined,
    );
    useEffect(() => {
        if (!value || projects?.some((project) => project.id === value) ||
            page.items.some((project) => project.id === value)) {
            setSelectedProject(null);
            return;
        }
        let cancelled = false;
        getProject(value).then((project) => {
            if (!cancelled) setSelectedProject(project);
        }).catch(() => {
            if (!cancelled) setSelectedProject(null);
        });
        return () => { cancelled = true; };
    }, [page.items, projects, value]);
    const visible = useMemo(() => {
        const source = projects ?? page.items;
        const query = search.trim().toLocaleLowerCase();
        const filtered = projects && query ? source.filter((project) =>
            `${project.name} ${project.cm_number ?? ""}`
                .toLocaleLowerCase()
                .includes(query),
        ) : source;
        return selectedProject && !filtered.some(({ id }) => id === selectedProject.id)
            ? [selectedProject, ...filtered]
            : filtered;
    }, [page.items, projects, search, selectedProject]);
    const isLoading = loading || (projects === undefined && page.loading);
    return (
        <div className="overflow-hidden rounded-md border border-gray-300 bg-white">
            <SearchBar
                value={search}
                onValueChange={setSearch}
                placeholder="Search projects"
                aria-label="Search projects"
                size="sm"
                className="rounded-none border-x-0 border-t-0"
                disabled={disabled}
            />
            <div
                role="listbox"
                aria-label="Projects"
                className="h-48 overflow-y-auto p-1"
            >
                {isLoading && visible.length === 0 ? (
                    <p className="px-2 py-3 text-sm text-gray-500">
                        Loading projects…
                    </p>
                ) : visible.length ? (
                    <>
                    {visible.map((project) => {
                        const selected = project.id === value;
                        return (
                            <button
                                key={project.id}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                disabled={disabled}
                                onClick={() => onChange(project.id)}
                                className={`flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm ${
                                    selected
                                        ? "bg-gray-900 text-white"
                                        : "text-gray-800 hover:bg-gray-100"
                                } disabled:opacity-50`}
                            >
                                <FolderSvgIcon className="h-4 w-4 shrink-0" />
                                <span className="min-w-0 flex-1 truncate">
                                    {project.name}
                                    {project.cm_number
                                        ? ` (#${project.cm_number})`
                                        : ""}
                                </span>
                                <Check
                                    className={`h-4 w-4 shrink-0 ${selected ? "" : "invisible"}`}
                                    aria-hidden="true"
                                />
                            </button>
                        );
                    })}
                    {projects === undefined && page.hasMore && (
                        <button type="button" onClick={() => void page.loadMore()}
                            disabled={page.loading}
                            className="min-h-10 w-full rounded px-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50">
                            {page.loading ? "Loading…" : "Load more"}
                        </button>
                    )}
                    </>
                ) : (
                    <p className="px-2 py-3 text-sm text-gray-500">
                        {search ? "No matching projects" : "No projects yet"}
                    </p>
                )}
            </div>
        </div>
    );
}
