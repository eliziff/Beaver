/**
 * Narrow dependency bridge for benchmarks/docx_edit.
 *
 * The benchmark lives outside the backend package, so third-party modules
 * resolve here. Keep this limited to the current DOCX compiler/session; the
 * benchmark must not grow its own runtime or persistence path.
 */
export {
  AlignmentType,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document,
  Footer,
  FootnoteReferenceRun,
  Header,
  InsertedTextRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

export { loadZip } from "../src/lib/zip";
export { renderMarkdownDocx } from "../src/lib/chat/tools/documentOps";
export { openDocxSession } from "../src/lib/docx/session";
export { extractDocxBodyText } from "../src/lib/docxTrackedChanges";
