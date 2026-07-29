"use client";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { launchTableOfAuthorities } from "@/app/lib/beaverApi";
import { isAnonymousMode } from "@/app/lib/authMode";
import { PageHeader } from "@/app/components/shared/PageHeader";
const BOOT_TIMEOUT_MS = 15_000;
const JOB_ID = /^[0-9a-f]{32}$/;
const PROJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const warmedService =
  typeof window !== "undefined" && isAnonymousMode
    ? launchTableOfAuthorities()
    : null;
void warmedService?.catch(() => {});
interface TableOfAuthoritiesHostProps {
  active: boolean;
  pending?: boolean;
  enabled: boolean;
}
type AuthoritiesScope = {
  job: string;
  project: string;
};
function ScopeReader({
  active,
  onChange,
}: {
  active: boolean;
  onChange: (scope: AuthoritiesScope) => void;
}) {
  const searchParams = useSearchParams();
  const job = JOB_ID.test(searchParams.get("job") || "")
    ? searchParams.get("job")!
    : "";
  const project = PROJECT_ID.test(searchParams.get("project") || "")
    ? searchParams.get("project")!
    : "";
  useLayoutEffect(() => {
    if (active) onChange({ job, project });
  }, [active, job, onChange, project]);
  return null;
}
function AuthoritiesShell({
  active,
  busy,
  children,
}: {
  active: boolean;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="authorities-host"
      aria-hidden={!active}
      inert={!active}
      className={`absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#f3f4f6] ${
        active ? "" : "pointer-events-none opacity-0"
      }`}
    >
      <PageHeader shrink>
        <h1 className="font-serif text-2xl font-medium text-gray-900">
          Authorities
        </h1>
      </PageHeader>
      <div
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        aria-busy={busy}
      >
        {children}
      </div>
    </div>
  );
}
function AuthoritiesFirstFrame() {
  return (
    <div
      data-testid="authorities-neutral-cover"
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden bg-[#f3f4f6] font-sans text-[17px] text-[#111827]"
    >
      <div className="flex h-[45px] items-center gap-[.45rem] px-6 max-[480px]:grid max-[480px]:h-[43px] max-[480px]:grid-cols-[1.25fr_repeat(3,minmax(0,1fr))] max-[480px]:gap-1 max-[480px]:px-4">
        {["Automatic", "Manual", "History", "Settings"].map((label, index) => (
          <span
            key={label}
            className={`flex h-[36px] basis-[104px] items-center justify-center rounded-[8px] border px-[.7rem] py-[.35rem] text-[.875rem] font-medium [line-height:normal] max-[480px]:h-[35px] max-[480px]:min-w-0 max-[480px]:px-[.05rem] ${
              index
                ? "border-[#d1d5db] bg-white"
                : "border-[#d52b1e] bg-[#d52b1e] text-white"
            }`}
          >
            {label}
          </span>
        ))}
      </div>
      <div className="absolute inset-x-0 bottom-0 top-[45px] overflow-y-auto p-6 [scrollbar-gutter:stable] max-[480px]:top-[43px] max-[480px]:p-4">
        <div className="flex max-w-[760px] items-center justify-between gap-4 rounded-[10px] border border-[#d1d5db] bg-white p-4 max-[480px]:p-3">
          <strong className="font-semibold leading-[22px]">
            Start with a Word document.
          </strong>
          <span className="flex h-[40px] items-center rounded-[8px] border border-[#111827] bg-[#111827] px-[.8rem] py-2 text-[.875rem] font-medium text-white [line-height:normal]">
            Create
          </span>
        </div>
      </div>
    </div>
  );
}
export function TableOfAuthoritiesHost({
  active,
  pending = false,
  enabled,
}: TableOfAuthoritiesHostProps) {
  const [scope, setScope] = useState<AuthoritiesScope>({
    job: "",
    project: "",
  });
  const [url, setUrl] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [frameScope, setFrameScope] = useState("");
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const urlRef = useRef("");
  const expectedOriginRef = useRef("");
  const attemptRef = useRef("");
  const watchdogRef = useRef<number | null>(null);
  const serviceRef = useRef(warmedService);
  const visible = active || pending;
  const targetJob = pending ? "" : scope.job;
  const targetProject = pending ? "" : scope.project;
  const scopeSignature = `${targetJob}:${targetProject}`;
  const onScopeChange = useCallback((next: AuthoritiesScope) => {
    setScope((current) =>
      current.job === next.job && current.project === next.project
        ? current
        : next,
    );
  }, []);
  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);
  const startWatchdog = useCallback(
    (attempt: string) => {
      clearWatchdog();
      watchdogRef.current = window.setTimeout(() => {
        if (attemptRef.current !== attempt) return;
        watchdogRef.current = null;
        setFrameReady(false);
        setError("Table of Authorities took too long to start.");
      }, BOOT_TIMEOUT_MS);
    },
    [clearWatchdog],
  );
  const pingFrame = useCallback(() => {
    const target = frameRef.current?.contentWindow;
    const expectedOrigin = expectedOriginRef.current;
    if (!target || !expectedOrigin) return;
    try {
      if (target.location.origin !== expectedOrigin) return;
    } catch {}
    target.postMessage(
      { type: "mike:table-of-authorities-probe" },
      expectedOrigin,
    );
  }, []);
  useEffect(() => {
    const onReady = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.origin !== expectedOriginRef.current
      ) {
        return;
      }
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        data.attempt !== attemptRef.current
      ) {
        return;
      }
      if (data.type === "mike:table-of-authorities-ready") {
        clearWatchdog();
        setError(null);
        setFrameReady(true);
      } else if (data.type === "mike:table-of-authorities-error") {
        clearWatchdog();
        setFrameReady(false);
        setError(
          typeof data.message === "string"
            ? data.message
            : "Table of Authorities could not be started.",
        );
      }
    };
    window.addEventListener("message", onReady);
    if (urlRef.current) {
      startWatchdog(attemptRef.current);
      pingFrame();
    }
    return () => window.removeEventListener("message", onReady);
  }, [clearWatchdog, pingFrame, startWatchdog]);
  useEffect(
    () => () => {
      clearWatchdog();
    },
    [clearWatchdog],
  );
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    if (!serviceRef.current) {
      serviceRef.current = launchTableOfAuthorities();
    }
    serviceRef.current
      .then((service) => {
        if (!live) return;
        const serviceUrl = new URL(service.url);
        const currentOrigin = urlRef.current
          ? new URL(urlRef.current).origin
          : "";
        if (
          pending &&
          !active &&
          urlRef.current &&
          frameScope !== scopeSignature
        ) {
          return;
        }
        if (
          urlRef.current &&
          frameScope === scopeSignature &&
          currentOrigin === serviceUrl.origin
        ) {
          pingFrame();
          return;
        }
        const attempt = crypto.randomUUID();
        serviceUrl.searchParams.set("mode", "mike");
        serviceUrl.searchParams.set("attempt", attempt);
        if (targetJob) serviceUrl.searchParams.set("job", targetJob);
        if (targetProject) {
          serviceUrl.searchParams.set("project", targetProject);
        }
        setFrameScope(scopeSignature);
        urlRef.current = serviceUrl.toString();
        expectedOriginRef.current = serviceUrl.origin;
        attemptRef.current = attempt;
        setError(null);
        setFrameReady(false);
        startWatchdog(attempt);
        setUrl(urlRef.current);
      })
      .catch((reason: unknown) => {
        if (!live) return;
        clearWatchdog();
        setFrameScope(scopeSignature);
        setFrameReady(false);
        setError(
          reason instanceof Error
            ? reason.message
            : "Table of Authorities could not be started.",
        );
      });
    return () => {
      live = false;
    };
  }, [
    clearWatchdog,
    enabled,
    frameScope,
    pingFrame,
    active,
    pending,
    scopeSignature,
    startWatchdog,
    targetJob,
    targetProject,
  ]);
  const frameCurrent =
    frameReady && frameScope === scopeSignature;
  const visibleError =
    frameScope === scopeSignature ? error : null;
  return (
    <>
      <Suspense fallback={null}>
        <ScopeReader active={active} onChange={onScopeChange} />
      </Suspense>
      <AuthoritiesShell
        active={visible}
        busy={visible && !frameCurrent && !visibleError}
      >
        {url && (
          <iframe
            ref={frameRef}
            src={url}
            title="Table of Authorities"
            aria-hidden={!visible || !frameCurrent}
            tabIndex={visible && frameCurrent ? 0 : -1}
            onLoad={pingFrame}
            className={`absolute inset-0 h-full w-full border-0 bg-[#f3f4f6] ${
              frameCurrent ? "" : "invisible"
            }`}
          />
        )}
        {!frameCurrent && !visibleError ? (
          <AuthoritiesFirstFrame />
        ) : !frameCurrent && visibleError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white p-8">
            <div className="max-w-lg text-center">
              <h2 className="font-serif text-2xl text-gray-900">
                Authorities unavailable
              </h2>
              <p className="mt-3 text-sm leading-6 text-gray-600">
                {visibleError}
              </p>
              <button
                type="button"
                className="mt-5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
            </div>
          </div>
        ) : null}
      </AuthoritiesShell>
    </>
  );
}
