import { BookMarked } from "lucide-react";

type FileTypeKind =
    | "research"
    | "pdf"
    | "word"
    | "excel"
    | "ppt"
    | "image"
    | "other";
const FILE_SYMBOLS: Record<Exclude<FileTypeKind, "research">, string> = {
    pdf: "§",
    word: "≡",
    excel: "▦",
    ppt: "◴",
    image: "▧",
    other: "□",
};
export function fileTypeKind(value: string | null | undefined): FileTypeKind {
    const raw = (value ?? "").toLowerCase().trim();
    if (raw.endsWith(".research.md")) return "research";
    const ext = raw.includes("/")
        ? (raw.split("/").pop() ?? "")
        : raw.includes(".")
          ? (raw.split(".").pop() ?? "")
          : raw;
    if (ext === "pdf") return "pdf";
    if (ext === "docx" || ext === "doc") return "word";
    if (ext === "xlsx" || ext === "xlsm" || ext === "xls") return "excel";
    if (ext === "pptx" || ext === "ppt") return "ppt";
    if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
    return "other";
}
export function FileTypeIcon({
    fileType,
    filename,
    className = "h-3.5 w-3.5",
    muted = false,
}: {
    fileType: string | null | undefined;
    filename?: string;
    className?: string;
    muted?: boolean;
}) {
    const kind = fileTypeKind(filename) === "research" ? "research" : fileTypeKind(fileType);
    if (kind === "research") return <BookMarked aria-hidden="true" data-file-kind={kind}
        className={`${className} shrink-0 text-red-700${muted ? " opacity-35" : ""}`} />;
    return (
        <span
            aria-hidden="true"
            data-file-kind={kind}
            className={`file-type-symbol ${className} shrink-0${muted ? " opacity-35" : ""}`}
        >
            {FILE_SYMBOLS[kind]}
        </span>
    );
}
