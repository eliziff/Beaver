type FileTypeKind =
    | "pdf"
    | "word"
    | "excel"
    | "ppt"
    | "image"
    | "other";
const FILE_SYMBOLS: Record<FileTypeKind, string> = {
    pdf: "§",
    word: "≡",
    excel: "▦",
    ppt: "◴",
    image: "▧",
    other: "□",
};
export function fileTypeKind(value: string | null | undefined): FileTypeKind {
    const raw = (value ?? "").toLowerCase().trim();
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
    className = "h-3.5 w-3.5",
    muted = false,
}: {
    fileType: string | null | undefined;
    className?: string;
    muted?: boolean;
}) {
    const kind = fileTypeKind(fileType);
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
