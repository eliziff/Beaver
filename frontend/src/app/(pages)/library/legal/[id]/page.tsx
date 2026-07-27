import { LegalLibraryDocumentPage } from "@/app/components/legal/LegalLibrary";

export default async function LegalSourcePage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    return <LegalLibraryDocumentPage referenceId={id} />;
}
