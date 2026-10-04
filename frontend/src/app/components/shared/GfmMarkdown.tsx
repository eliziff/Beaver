import { createContext, Fragment, useContext, type ComponentType, type JSX } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import { visit } from "unist-util-visit";
import type { Root, Element, Text } from "hast";
import { searchHighlightRanges } from "@/app/lib/searchHighlight";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";

export type Components = Partial<{
    [Tag in keyof JSX.IntrinsicElements]: ComponentType<JSX.IntrinsicElements[Tag] & { node?: Element }> | keyof JSX.IntrinsicElements
}>;

// Document Markdown preserves the protocols accepted by its previous renderer.
// Assistant links retain the stricter shared assistant URL policy.
function documentUrl(value: string): string {
    const protocol = /^([^/?#]*):/.exec(value)?.[1];
    return protocol === undefined || /^(https?|ircs?|mailto|xmpp)$/i.test(protocol) ? value : "";
}

export const MessageSearchHighlight = createContext("");

function highlightText(query: string) {
    return () => (tree: Root) => {
        const nodes: { node: Text; parent: Root | Element; start: number }[] = [];
        let text = "";
        function collect(parent: Root | Element) {
            for (const node of parent.children) {
                if (node.type === "text") {
                    nodes.push({ node, parent, start: text.length });
                    text += node.value;
                } else if (node.type === "element") collect(node);
            }
        }
        collect(tree);
        const matches = searchHighlightRanges(text, query);
        for (const { node, parent, start } of nodes) {
            const ranges = matches.filter(([from, to]) => from < start + node.value.length && to > start);
            if (!ranges.length) continue;
            const replacement: (Text | Element)[] = [];
            let cursor = 0;
            for (const [from, to] of ranges) {
                const left = Math.max(0, from - start), right = Math.min(node.value.length, to - start);
                if (left > cursor) replacement.push({ type: "text", value: node.value.slice(cursor, left) });
                replacement.push({ type: "element", tagName: "mark", properties: {
                    className: ["bg-amber-200", "text-gray-950"], "data-search-match": true,
                }, children: [{ type: "text", value: node.value.slice(left, right) }] });
                cursor = right;
            }
            if (cursor < node.value.length) replacement.push({ type: "text", value: node.value.slice(cursor) });
            parent.children.splice(parent.children.indexOf(node), 1, ...replacement);
        }
    };
}

// Markdown is parsed once per text, not on every render or mount: parsing is most of the cost
// of showing a message, and a chat re-mounts its messages whenever it opens or scrolls back.
// The cached tree already has safe URLs and raw HTML handled; it is only copied when a search
// highlight or an element filter has to change it.
const toHast = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true });
const parsedTrees = new Map<string, Root>();
const PARSED_TREE_LIMIT = 500;

function parsedTree(markdown: string, skipHtml: boolean, documentLinks: boolean) {
    const key = `${skipHtml ? 1 : 0}${documentLinks ? 1 : 0}\0${markdown}`;
    let tree = parsedTrees.get(key);
    if (tree) parsedTrees.delete(key);
    else {
        tree = toHast.runSync(toHast.parse(markdown)) as Root;
        visit(tree, (node, index, parent) => {
            delete node.position;
            if (node.type === "raw" && parent && index !== undefined) {
                if (skipHtml) parent.children.splice(index, 1);
                else parent.children[index] = { type: "text", value: node.value };
                return index;
            }
            if (node.type !== "element") return;
            for (const [name, tags] of Object.entries(urlAttributes)) {
                if (Object.hasOwn(node.properties, name) && (tags === null || tags.includes(node.tagName)))
                    node.properties[name] = documentLinks
                        ? documentUrl(String(node.properties[name] ?? ""))
                        : safeAssistantUrl(String(node.properties[name] ?? "")) ?? "";
            }
        });
        if (parsedTrees.size >= PARSED_TREE_LIMIT) parsedTrees.delete(parsedTrees.keys().next().value!);
    }
    parsedTrees.set(key, tree);
    return tree;
}

export function GfmMarkdown({ children, components, skipHtml = false, allowedElements, unwrapDisallowed, documentLinks = false }: {
    children?: string; components?: Components; skipHtml?: boolean;
    allowedElements?: string[]; unwrapDisallowed?: boolean; documentLinks?: boolean;
}) {
    const query = useContext(MessageSearchHighlight).trim();
    let tree = parsedTree(children ?? "", skipHtml, documentLinks);
    if (query || allowedElements) {
        tree = structuredClone(tree);
        if (query) highlightText(query)()(tree);
        if (allowedElements) visit(tree, "element", (node, index, parent) => {
            if (allowedElements.includes(node.tagName) || !parent || index === undefined) return;
            parent.children.splice(index, 1, ...(unwrapDisallowed ? node.children : []));
            return index;
        });
    }
    return toJsxRuntime(tree, { Fragment, jsx, jsxs, components, ignoreInvalidStyle: true,
        passKeys: true, passNode: true });
}
