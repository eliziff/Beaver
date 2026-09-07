import { useCallback, useContext } from "react";
import { CollectionContext } from "@/app/contexts/CollectionContext";
import { projectsCollection, directoryCollection } from "@/app/lib/collectionKeys";
import { listProjects } from "@/app/lib/api/projects";
import { directoryResource } from "@/app/lib/api/documents";
import { preloadAppRoute } from "@/app/router";

export function useNavigationPrefetch() {
  const cache = useContext(CollectionContext);
  return useCallback((pathname: string) => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (!cache || navigator.onLine === false || connection?.saveData || /^(?:slow-)?2g$/u.test(connection?.effectiveType ?? "")) return;
    if (pathname === "/projects") {
      void preloadAppRoute(pathname);
      void cache.prefetch(projectsCollection(), (_key, cursor, signal) => listProjects({ cursor }, signal));
      return;
    }
    const project = /^\/projects\/([^/?#]+)$/u.exec(pathname);
    const library = pathname === "/library" || pathname === "/library/templates";
    if (!project && !library) return;
    let projectId: string | undefined;
    try { projectId = project ? decodeURIComponent(project[1]) : undefined; } catch { return; }
    const scope = projectId ? { projectId } : { library: pathname.endsWith("/templates") ? "templates" as const : "files" as const };
    void preloadAppRoute(pathname);
    void cache.prefetch(directoryCollection(scope), (_key, cursor, signal) =>
      directoryResource(scope).list({ cursor, parent_id: null }, signal), "root");
  }, [cache]);
}
