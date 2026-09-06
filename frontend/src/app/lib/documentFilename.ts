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

export const isSpreadsheetFilename = (filename: string) =>
  /\.(xlsx|xlsm|xls)$/i.test(filename);
export const isDocxFilename = (filename: string) =>
  /\.(docx|doc)$/i.test(filename);
