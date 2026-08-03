/** Precise delimiter of one opinion's text, at every available resolution. */
export type OpinionDelimiter = {
  role: string;
  names: string[];
  /** Semantic spine: first and last paragraph label numbers of the opinion. */
  paragraphs: { from: number; to: number } | null;
  /** Character offsets into the source text. Null when the paragraph spine
   *  cannot be resolved (e.g. no paragraph spine, only pages). */
  offset: { start: number; end: number } | null;
  /** Combined page spine: the reporter page containing the start and end
   *  offsets, when the mature page lane found pages for them. */
  page: { start: number; end: number } | null;
};

export type Claims = {
  status: string;
  panel: string[];
  bindings: Array<{
    role: string;
    names: string[];
    from: number | null;
    to: number | null;
    page: number | null;
    line: string;
  }>;
  markers: Array<{
    paragraph: number;
    kind: string;
    name: string | null;
    role: string | null;
  }>;
  refusals: string[];
  partition: {
    status: string;
    note: string | null;
    /** Per-role paragraph spans the partition resolved, even when partial. */
    spans: Record<string, { from: number; to: number }[]>;
    judges: Array<{ name: string; role: string }>;
  };
  /** Reporter page spine recovered by the mature A2AJ page lane, when any. */
  pages: number[] | null;
  /** One entry per opinion the header delimited, with precise text ranges. */
  opinions: OpinionDelimiter[];
};

export type WorkerJob = {
  documentId: number;
  citation: string;
  dataset: string;
  name: string | null;
  text: string;
  url: string | null;
  alternateCitation: string | null;
};

export type WorkerResult = {
  documentId: number;
  sourceSha256: string;
  claims: Claims;
};
