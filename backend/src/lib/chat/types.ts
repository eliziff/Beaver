import type { LlmImage, LlmMessage } from "../llm/types";
import type { TabularCell } from "../tabularStore";

export type WorkflowStore = Map<string, {
  workflow_id: string;
  title: string;
  skill_md: string;
}>;

export type DocIndex = Record<
  string,
  {
    document_id: string;
    filename: string;
    version_id?: string | null;
    version_number?: number | null;
  }
>;

export type TabularCellStore = {
  review_id: string;
  app_url?: string;
  columns: { index: number; name: string }[];
  documents: { id: string; filename: string }[];
  /** key: `${colIndex}:${docId}` */
  cells: Map<string, Pick<TabularCell, "content" | "status">>;
};

export type ChatMessage = {
  role: string;
  content: string | null;
  files?: { filename: string; document_id: string }[];
  workflow?: { id: string; variant_id?: string; title: string };
  /** Resolved server-side from file references; never accepted as raw client bytes. */
  images?: LlmImage[];
  /** Internal provider continuation metadata; never accepted from the browser. */
  contextCheckpoint?: LlmMessage["contextCheckpoint"];
};
