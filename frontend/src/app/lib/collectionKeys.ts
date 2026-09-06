import type { CollectionSpec } from "./collections";
import type { DirectoryScope } from "./api/documents";
import type { listProjects } from "./api/projects";
import type { listTabularReviews } from "./api/tabular";

function identity(resource: string, options: object, tags: string[]): CollectionSpec {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options))
        if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    params.sort();
    return { key: `${resource}${params.size ? `?${params}` : ""}`, tags };
}
export const projectsCollection = (options: Omit<NonNullable<Parameters<typeof listProjects>[0]>, "cursor"> = {}) =>
    identity("/projects", { ...options, scope: options.scope ?? "all" }, ["projects"]);
export const tabularReviewsCollection = (options: Omit<NonNullable<Parameters<typeof listTabularReviews>[0]>, "cursor"> = {}) =>
    identity("/tabular-review", options, ["reviews"]);
export function directoryCollection(scope: DirectoryScope, q = "") {
    const root = "projectId" in scope ? `/projects/${encodeURIComponent(scope.projectId)}` : `/library/${scope.library}`;
    return identity(`${root}/collection`, { q: q.trim() }, ["directories", `directory:${root}`]);
}
