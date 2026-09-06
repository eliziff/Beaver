import { execFile } from "node:child_process";
import path from "node:path";
import { isolatedProcessEnv } from "./subprocessEnv";

export type QuoteCitationUnit = { status: string; reasons: string[];
  parts: Array<{ start: number; end: number; text: string; anchors: string[];
    fields: { status: string; corrected: string; kind: string; link_candidate: string;
      pinpoint_fragments: string[]; page_pinpoints: number[]; bare_citation: string;
      citation_with_style: string; short_form: string; reasons: string[] } }>;
  delimiters: Array<[number, number, string]> };

export function splitQuoteCitationUnits(texts: string[], signal?: AbortSignal): Promise<QuoteCitationUnit[]> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.BEAVER_PYTHON || (process.platform === "win32" ? "python" : "python3"),
      ["-B", "-X", "utf8", path.resolve(__dirname, "../../../packages/alr-quote-splitter/run.py")], {
        env: isolatedProcessEnv(), windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, signal,
      }, (error, stdout) => {
        if (error) { reject(new Error("Citation splitting failed. Check that Python 3.10+ is available.", { cause: error })); return; }
        try { resolve(JSON.parse(stdout) as QuoteCitationUnit[]); } catch (failure) { reject(failure); }
      });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(texts));
  });
}
