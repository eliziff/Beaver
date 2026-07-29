import { LegalLibrarySourcePage } from "@/app/components/legal/LegalLibrary";
export default async function LegalSourcePage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    return <LegalLibrarySourcePage referenceId={id} markingId={id} />;
}
