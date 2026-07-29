import { useCallback, useEffect, useRef, useState } from "react";
import { getLibrary, listProjects } from "@/app/lib/beaverApi";
import type { Document, LibraryFolder, Project } from "./types";
export type DirectoryTab = "files" | "templates" | "projects";
const EMPTY_LOADING: Record<DirectoryTab, boolean> = {
    files: false,
    templates: false,
    projects: false,
};
type TabState = "idle" | "loading" | "loaded" | "failed";
const EMPTY_STATE: Record<DirectoryTab, TabState> = {
    files: "idle",
    templates: "idle",
    projects: "idle",
};
function sortDocuments(docs: Document[]) {
    return [...docs].sort((a, b) =>
        (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    );
}
async function loadLibrary(kind: "files" | "templates") {
    const library = await getLibrary(kind);
    return {
        documents: sortDocuments(library.documents),
        folders: library.folders,
    };
}
async function loadProjects() {
    const projects = await listProjects({ includeDocuments: true });
    return projects.map((project) => ({
        ...project,
        document_count:
            project.documents?.length ?? project.document_count ?? 0,
    }));
}
export function useDirectoryData(
    enabled: boolean,
    initialTab: DirectoryTab = "files",
) {
    const [standaloneDocuments, setStandaloneDocuments] = useState<Document[]>([]);
    const [templateDocuments, setTemplateDocuments] = useState<Document[]>([]);
    const [fileFolders, setFileFolders] = useState<LibraryFolder[]>([]);
    const [templateFolders, setTemplateFolders] = useState<LibraryFolder[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [loadingTabs, setLoadingTabs] =
        useState<Record<DirectoryTab, boolean>>(EMPTY_LOADING);
    const tabStateRef = useRef({ ...EMPTY_STATE });
    const loadTab = useCallback(
        async (tab: DirectoryTab) => {
            const state = tabStateRef.current[tab];
            if (!enabled || state === "loading" || state === "loaded") return;
            tabStateRef.current[tab] = "loading";
            setLoadingTabs((prev) => ({ ...prev, [tab]: true }));
            try {
                if (tab === "files") {
                    const files = await loadLibrary("files");
                    setStandaloneDocuments(files.documents);
                    setFileFolders(files.folders);
                } else if (tab === "templates") {
                    const templates = await loadLibrary("templates");
                    setTemplateDocuments(templates.documents);
                    setTemplateFolders(templates.folders);
                } else {
                    setProjects(await loadProjects());
                }
                tabStateRef.current[tab] = "loaded";
            } catch {
                tabStateRef.current[tab] = "failed";
                if (tab === "files") {
                    setStandaloneDocuments([]);
                    setFileFolders([]);
                } else if (tab === "templates") {
                    setTemplateDocuments([]);
                    setTemplateFolders([]);
                } else {
                    setProjects([]);
                }
            } finally {
                setLoadingTabs((prev) => ({ ...prev, [tab]: false }));
            }
        },
        [enabled],
    );
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            void loadTab(initialTab);
        });
        return () => {
            cancelled = true;
        };
    }, [enabled, initialTab, loadTab]);
    const resolvedLoadingTabs = {
        ...loadingTabs,
        [initialTab]:
            enabled && tabStateRef.current[initialTab] === "idle"
                ? true
                : loadingTabs[initialTab],
    };
    return {
        loading: resolvedLoadingTabs[initialTab],
        loadingTabs: resolvedLoadingTabs,
        standaloneDocuments,
        templateDocuments,
        fileFolders,
        templateFolders,
        projects,
        loadTab,
    };
}
