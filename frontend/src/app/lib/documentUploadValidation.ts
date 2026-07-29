export const SUPPORTED_DOCUMENT_ACCEPT =
    ".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt,.jpg,.jpeg,.png,.gif,.webp,.eml";
const UNSUPPORTED_DOCUMENT_WARNING_MESSAGE =
    "Unsupported file type. Use PDF, Word, Excel, PowerPoint, email (.eml), JPEG, PNG, GIF, or WebP.";
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
    "pdf",
    "docx",
    "doc",
    "xlsx",
    "xlsm",
    "xls",
    "pptx",
    "ppt",
    "jpg",
    "jpeg",
    "png",
    "gif",
    "webp",
    "eml",
]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function isSupportedDocumentFile(file: File): boolean {
    const extension = file.name.split(".").pop()?.toLowerCase();
    return (
        !!extension &&
        SUPPORTED_DOCUMENT_EXTENSIONS.has(extension) &&
        (!IMAGE_EXTENSIONS.has(extension) || file.size <= MAX_IMAGE_BYTES)
    );
}
export function partitionSupportedDocumentFiles(files: File[]) {
    const supported: File[] = [];
    const unsupported: File[] = [];
    for (const file of files) {
        if (isSupportedDocumentFile(file)) supported.push(file);
        else unsupported.push(file);
    }
    return { supported, unsupported };
}
export function formatUnsupportedDocumentWarning(files: File[]): string | null {
    if (files.length === 0) return null;
    if (
        files.some((file) => {
            const extension = file.name.split(".").pop()?.toLowerCase();
            return (
                !!extension &&
                IMAGE_EXTENSIONS.has(extension) &&
                file.size > MAX_IMAGE_BYTES
            );
        })
    ) {
        return "Images must be 5 MB or smaller.";
    }
    return UNSUPPORTED_DOCUMENT_WARNING_MESSAGE;
}
