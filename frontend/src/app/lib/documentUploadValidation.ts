export const SUPPORTED_DOCUMENT_ACCEPT =
    ".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt,.jpg,.jpeg,.png,.gif,.webp";
export const UNSUPPORTED_DOCUMENT_WARNING_MESSAGE =
    "Unsupported file type. Use PDF, Word, Excel, PowerPoint, JPEG, PNG, GIF, or WebP.";

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

function filenameExtension(filename: string) {
    const trimmed = filename.trim();
    const dotIndex = trimmed.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === trimmed.length - 1) return null;
    return trimmed.slice(dotIndex);
}

export function hasFilenameExtensionChange(previous: string, next: string) {
    const previousExtension = filenameExtension(previous);
    return (
        previousExtension != null &&
        filenameExtension(next)?.toLowerCase() !==
        previousExtension.toLowerCase()
    );
}

export function filenameExtensionChangeWarning(filename: string) {
    const extension = filenameExtension(filename);
    return extension
        ? `File extensions cannot be changed here. Keep ${extension} at the end of the name.`
        : "File extensions cannot be changed here.";
}
