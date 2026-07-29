import { LegalLibraryDirectDocumentPage } from "@/app/components/legal/LegalLibrary";
import type { LegalDocumentType } from "@/app/lib/beaverApi";
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
    const rawType = value("doc_type");
    const docType: LegalDocumentType | "auto" =
        rawType === "laws" || rawType === "articles" || rawType === "auto"
            ? rawType
            : "cases";
    return (
        <LegalLibraryDirectDocumentPage
            provider={value("provider") === "journal" ? "journal" : "a2aj"}
            citation={value("citation")}
            sourceId={value("source_id") || null}
            docType={docType}
            language={value("language") === "fr" ? "fr" : "en"}
            dataset={value("dataset") || null}
        />
    );
}
