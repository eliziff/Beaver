/**
 * Dependency bridge for benchmarks/docx_edit.
 *
 * The benchmark tree has no node_modules of its own, so every third-party
 * import (`docx`, the zip helper) and every Beaver module it needs is
 * re-exported from here — one file, inside backend/, where module resolution
 * works. It also makes the benchmark's coupling to the product a single
 * reviewable surface: if this file stops compiling, the benchmark is out of
 * date with the product, which is exactly the signal we want.
 *
 * Read-only with respect to the product: nothing here is imported by
 * backend/src, and the benchmark never writes to product state.
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
  ImportedXmlComponent,
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
export {
  applyTrackedEdits,
  extractDocxBodyText,
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../src/lib/docxTrackedChanges";
export { compileAgreementSkeleton, readSection } from "../src/lib/legalTextSkeleton";
export {
  pageMapFromMarkers,
  parseAddress,
} from "../src/lib/legalDocumentNavigator";
export { crossReferenceGraph } from "../src/lib/legalCrossReference";
export { scanDocxPathology } from "../src/lib/docx/pathology";
export { extractDocxStories, storiesBodyText } from "../src/lib/docx/stories";

export type { OpenAIToolSchema } from "../src/lib/llm";
