export const RESPONSE_GLASS_SURFACE =
    "rounded-xl border border-gray-200 bg-white shadow-sm";
export const RESPONSE_GLASS_ANNOTATION =
    "inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-200 bg-gray-100 font-serif text-[12px] font-medium text-gray-800 hover:bg-gray-200 hover:text-gray-950";

export function withoutMarkdownNode<P extends { node?: unknown }>(
    props: P,
): Omit<P, "node"> {
    const { node, ...rest } = props;
    void node;
    return rest;
}
