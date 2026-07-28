"use client";

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import type { Project } from "../shared/types";
import { FolderSvgIcon } from "../shared/FolderSvgIcon";
import { SearchBar } from "../ui/search-bar";

interface Props {
    projects: Project[];
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
    const visible = useMemo(() => {
        const query = search.trim().toLocaleLowerCase();
        if (!query) return projects;
        return projects.filter((project) =>
            `${project.name} ${project.cm_number ?? ""}`
                .toLocaleLowerCase()
                .includes(query),
        );
    }, [projects, search]);

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
                className="max-h-48 overflow-y-auto p-1"
            >
                {loading ? (
                    <p className="px-2 py-3 text-sm text-gray-500">
                        Loading projects…
                    </p>
                ) : visible.length ? (
                    visible.map((project) => {
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
                                {selected ? (
                                    <Check
                                        className="h-4 w-4 shrink-0"
                                        aria-hidden="true"
                                    />
                                ) : null}
                            </button>
                        );
                    })
                ) : (
                    <p className="px-2 py-3 text-sm text-gray-500">
                        {search ? "No matching projects" : "No projects yet"}
                    </p>
                )}
            </div>
        </div>
    );
}
