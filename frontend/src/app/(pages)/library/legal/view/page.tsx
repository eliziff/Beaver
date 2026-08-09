import { redirect } from "next/navigation";
export default async function DirectLegalSourcePage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const value = (name: string) => {
        const raw = params[name];
        return typeof raw === "string" ? raw : "";
    };
    const query = new URLSearchParams();
    for (const key of [
        "provider",
        "citation",
        "source_id",
        "doc_type",
        "language",
        "dataset",
    ]) {
        const item = value(key);
        if (item) query.set(key, item);
    }
    redirect(`/sources/view${query.size ? `?${query}` : ""}`);
}
