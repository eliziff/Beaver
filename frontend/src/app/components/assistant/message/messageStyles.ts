export const RESPONSE_GLASS_SURFACE =
    "rounded-xl border border-gray-200 bg-white shadow-sm";
export function withoutMarkdownNode<P extends { node?: unknown }>(
    props: P,
): Omit<P, "node"> {
    const { node, ...rest } = props;
    void node;
    return rest;
}
