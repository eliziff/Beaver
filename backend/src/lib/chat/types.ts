import type { LlmImage, LlmMessage } from "../llm/types";
import type { EditDiffSegment } from "../docxTrackedChanges";

const isDev = process.env.NODE_ENV !== "production";
export const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};


export type WorkflowStore = Map<string, { title: string; skill_md: string }>;

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
  cells: Map<
    string,
    { summary: string; flag?: string; reasoning?: string } | null
  >;
};

export type ChatMessage = {
  role: string;
  content: string | null;
  files?: { filename: string; document_id: string }[];
  workflow?: { id: string; title: string };
  /** Resolved server-side from file references; never accepted as raw client bytes. */
  images?: LlmImage[];
  /** Internal provider continuation metadata; never accepted from the browser. */
  contextCheckpoint?: LlmMessage["contextCheckpoint"];
};


export type AskInputOption = {
  value: string;
};

export type AskInputItem =
  | {
      id: string;
      kind: "choice";
      question: string;
      options: AskInputOption[];
    }
  | {
      id: string;
      kind: "documents";
      document_types: string[];
    };

export type AskInputsEvent = {
  type: "ask_inputs";
  items: AskInputItem[];
};

export type AskInputResponseItem =
  | {
      id: string;
      kind: "choice";
      answer?: string;
    }
  | {
      id: string;
      kind: "documents";
      documents: { document_id: string; filename: string }[];
    };

export type AskInputsResponseRequest = {
  responses: AskInputResponseItem[];
};

export type EditAnnotation = {
  edit_id: string;
  document_id: string;
  version_id: string;
  version_number?: number | null;
  del_w_id?: string;
  ins_w_id?: string;
  deleted_text: string;
  inserted_text: string;
  context_before: string;
  context_after: string;
  reason?: string;
  diff: EditDiffSegment[];
  status: "pending" | "accepted" | "rejected";
};
