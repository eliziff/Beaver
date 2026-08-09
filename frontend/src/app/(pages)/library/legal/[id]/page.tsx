import { redirect } from "next/navigation";
export default async function LegalSourcePage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    redirect(`/sources/${encodeURIComponent(id)}`);
}
