import { useParams } from "react-router-dom";
import { LegalLibrarySourcePage } from "@/app/components/legal/LegalLibrary";

export default function SourcePage() {
    const { id = "" } = useParams<{ id: string }>();
    return <LegalLibrarySourcePage referenceId={id} />;
}
