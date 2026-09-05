import { Check, Download, Files, FileCheck2, FolderUp, Loader2 } from "lucide-react";
import { PdfView } from "@/app/components/shared/views/PdfView";
import { Button } from "@/app/components/ui/button";
import { cn, formatBytes } from "@/app/lib/utils";
import { CourtCoverPreview } from "./CourtCoverPreview";
import { outputFilename } from "./validation";
import { hasMatchingExhibitCertificate } from "./types";
import type { BuildArtifact, BuildResult, ComplianceReport, CourtProfile, CoverValues, RecordEntry } from "./types";

type Props = {
  profile: CourtProfile;
  cover: CoverValues;
  entries: RecordEntry[];
  report: ComplianceReport;
  result?: BuildResult;
  building: boolean;
  saving: boolean;
  disabled?: boolean;
  progress?: string;
  error?: string;
  hostMode: "standalone" | "beaver";
  onBuild: () => void;
  onDownload: (artifact: BuildArtifact) => void;
  onSave?: () => void;
};

export function CourtRecordBuildPanel(props: Props) {
  const separate = props.profile.outputMode === "separate-files";
  const pdf = props.result?.artifacts.find((artifact) => artifact.mimeType === "application/pdf");
  const sourcePages = props.entries.reduce((sum, entry) => sum + (entry.pageCount ?? 0), 0);
  const sourceFiles = props.entries.filter((entry) => !entry.descriptionOnly).length;
  const outputFiles = props.result?.artifacts.length;
  const summary = separate || !props.profile.cover.generated;
  const forSignature = props.profile.documentKinds.some(({ generated }) =>
    generated === "federal-form-344-certificate") || !!props.profile.exhibitCertificate &&
    props.entries.some((entry) => entry.kindId === "exhibit" &&
      !hasMatchingExhibitCertificate(entry));
  const actionLabel = separate ? "Prepare filing set"
    : forSignature ? "Build for signature" : "Build record";
  return (
    <aside className="court-record-build-panel min-w-0" aria-label="Build output" aria-busy={props.building || props.saving}>
      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-4 py-3.5">
          <h2 className="text-base font-semibold leading-6 text-gray-950">
            {separate ? "Filing set" : pdf ? "Built record"
              : props.profile.cover.generated ? "Cover preview" : "Record"}
          </h2>
        </div>
        <div className={cn("flex items-center justify-center bg-gray-100 p-4",
          separate ? "h-48" : "h-[24rem]")}>
          {summary && !pdf ? (
            <div className="max-w-xs text-center">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-white text-gray-700 shadow-sm">
                <Files className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="mt-3 text-base font-semibold text-gray-950">
                {outputFiles !== undefined ? `${outputFiles} ${separate ? "filing file" : "record"}${outputFiles === 1 ? "" : "s"} prepared`
                  : sourceFiles ? `${sourceFiles} source file${sourceFiles === 1 ? "" : "s"}` : "No files added"}
              </p>
              <p className="mt-1 text-sm leading-5 text-gray-600">
                {separate
                  ? sourceFiles ? "Each file remains separate for filing."
                    : "Add the files required for this filing set."
                  : sourceFiles ? "The source pages will be combined without adding a cover."
                    : "Add the affidavit and any exhibits."}
              </p>
            </div>
          ) : pdf ? (
            <div className="flex h-full w-full overflow-hidden rounded-md border border-gray-300 bg-white">
              <PdfView doc={null} bytes={pdf.bytes} rounded={false} ariaLabel="Built court record preview" />
            </div>
          ) : (
            <CourtCoverPreview profile={props.profile} cover={props.cover} />
          )}
        </div>
        <div className="border-t border-gray-200 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-medium text-gray-900">{separate ? props.profile.label : outputFilename(props.profile, props.cover)}</h3>
              <p className="mt-0.5 text-xs text-gray-500">
                {sourceFiles ? `${sourceFiles} source file${sourceFiles === 1 ? "" : "s"}${sourcePages ? ` · ${sourcePages} page${sourcePages === 1 ? "" : "s"}` : ""} · ${formatBytes(props.report.inputBytes)}` : "No source files yet"}
              </p>
            </div>
            {props.report.ready && <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-800" title="Ready to assemble"><Check className="h-4 w-4" /><span className="sr-only">Ready to assemble</span></span>}
          </div>
          {!!props.report.review.length && (
            <details className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold text-amber-900">Needs attention ({props.report.review.length})</summary>
              <div className="mt-2 space-y-2">{props.report.review.map((item) => <p key={item.id} className="text-xs leading-5 text-amber-900">{item.detail}</p>)}</div>
            </details>
          )}
          <Button type="button" className="mt-3 h-11 w-full" disabled={props.disabled || props.building}
            aria-busy={props.building} onClick={props.onBuild} data-court-record-build>
            {props.building ? <Loader2 className="motion-safe:animate-spin" /> : <FileCheck2 />}
            {actionLabel}
          </Button>
          <p className={cn("mt-2 min-h-5 text-center text-xs leading-5", props.error ? "text-red-700" : "text-gray-600")} role="status" aria-live="polite" aria-atomic="true">{props.error ?? props.progress ?? ""}</p>
        </div>

        {props.result && (
          <div className="border-t border-gray-100 p-3">
            <div className="space-y-1.5">
              {props.result.artifacts.map((artifact) => (
                <button key={artifact.filename} type="button" disabled={props.disabled}
                  onClick={() => props.onDownload(artifact)} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50">
                  <Download className="h-4 w-4 shrink-0 text-red-700" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-800">{artifact.filename}</span>
                  <span className="shrink-0 text-xs text-gray-500">{formatBytes(artifact.bytes.byteLength)}</span>
                </button>
              ))}
            </div>
            {props.onSave && (
              <Button type="button" variant="outline" className="mt-2 h-9 w-full border-gray-500/80" disabled={props.disabled || props.saving} onClick={props.onSave}>
                {props.saving ? <Loader2 className="motion-safe:animate-spin" /> : <FolderUp />}
                {props.hostMode === "beaver" ? "Save to Library" : "Save output"}
              </Button>
            )}
          </div>
        )}
      </section>
    </aside>
  );
}
