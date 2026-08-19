import { useSearchParams } from "react-router-dom";
import { LegalLibrarySourcePage } from "@/app/components/legal/LegalLibrary";
import type { LegalDocumentType } from "@/app/lib/beaverApi";

export default function DirectSourcePage() {
    const [params] = useSearchParams();
    const rawType = params.get("doc_type");
    const docType: LegalDocumentType | "auto" =
        rawType === "laws" || rawType === "articles" || rawType === "auto"
            ? rawType
            : "cases";
    return (
        <LegalLibrarySourcePage
            provider={params.get("provider") === "journal" ? "journal" : "a2aj"}
            citation={params.get("citation") ?? ""}
            sourceId={params.get("source_id")}
            docType={docType}
            language={params.get("language") === "fr" ? "fr" : "en"}
            dataset={params.get("dataset")}
        />
    );
}
