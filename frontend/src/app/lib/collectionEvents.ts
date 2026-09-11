import { onApiMutation } from "./api/mutationEvents";
// Invalidations carry collection identities only, never rows or document content.
export type CollectionChange = { tags: readonly string[] };
export function onCollectionChange(listener: (change: CollectionChange) => void) {
    return onApiMutation(({ path, method, fields }) => {
        const tags = collectionMutationTags(path, method, fields);
        if (tags.length) listener({ tags });
    });
}

// Central mutation boundary covers writes made outside collection components too
// (uploads, editors, library pickers, and account-wide deletion). Read-only POSTs
// and chat control/stream requests must not cause refresh storms.
export function collectionMutationTags(path: string, method: string, fields?: readonly string[]): string[] {
    if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return [];
    const route = path.split("?")[0];
    const project = /^\/projects(?:\/([^/]+))?(.*)$/.exec(route);
    if (project) {
        const [, id, rest] = project;
        return !id || !rest ? ["projects", ...(id ? [`directory:/projects/${id}`, "reviews", "chats"] : [])]
            : /^(?:\/documents|\/folders)/.test(rest) ? [`directory:/projects/${id}`] : [];
    }
    const library = /^\/library\/(files|templates)(?:\/|$)/.exec(route);
    if (library) return [`directory:/library/${library[1]}`];
    if (/^\/single-documents(?:\/|$)/.test(route)) {
        if (["/single-documents/parse-states", "/single-documents/download-zip"].includes(route)) return [];
        return ["directories"];
    }
    if (/^\/tabular-review(?:\/|$)/.test(route)) return ["reviews"];
    if (/^\/chat(?:\/|$)/.test(route)) {
        if (method.toUpperCase() === "PATCH" && fields?.every(field => field === "draft")) return [];
        return /^\/chat\/(?:create|[^/]+(?:\/(?:restore|permanent|generate-title))?)$/.test(route)
            ? ["chats"] : [];
    }
    if (/^\/(?:court-records|authorities)\/documents$/.test(route) ||
        /^\/source-workspaces(?:\/[^/]+\/bind|\/ensure)?$/.test(route)) return ["directories"];
    if (route === "/user/projects") return ["projects", "directories", "reviews", "chats"];
    if (route === "/user/chats") return ["chats"];
    if (route === "/user/tabular-reviews") return ["reviews"];
    return [];
}
