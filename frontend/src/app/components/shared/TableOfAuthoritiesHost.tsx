import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { launchTableOfAuthorities } from "@/app/lib/beaverApi";
import { AuthoritiesShell } from "@/app/components/shared/TableOfAuthoritiesFrame";
const BOOT_TIMEOUT_MS = 15_000;
const JOB_ID = /^[0-9a-f]{32}$/;
const PROJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface TableOfAuthoritiesHostProps {
  active: boolean;
  pending?: boolean;
  enabled: boolean;
}
export function TableOfAuthoritiesHost({
  active,
  pending = false,
  enabled,
}: TableOfAuthoritiesHostProps) {
  const [searchParams] = useSearchParams();
  const [url, setUrl] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [frameScope, setFrameScope] = useState("");
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const urlRef = useRef("");
  const expectedOriginRef = useRef("");
  const attemptRef = useRef("");
  const watchdogRef = useRef<number | null>(null);
  const serviceRef = useRef<ReturnType<typeof launchTableOfAuthorities> | null>(null);
  const visible = active || pending;
  const requestedJob = searchParams.get("job") ?? "";
  const requestedProject = searchParams.get("project") ?? "";
  const targetJob = !pending && JOB_ID.test(requestedJob) ? requestedJob : "";
  const targetProject = !pending && PROJECT_ID.test(requestedProject)
    ? requestedProject
    : "";
  const scopeSignature = `${targetJob}:${targetProject}`;
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
    } catch {
      // Cross-origin frames cannot expose their location; postMessage is safe.
    }
    target.postMessage(
      { type: "mike:authorities-helper-probe" },
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
      if (data.type === "mike:authorities-helper-ready") {
        clearWatchdog();
        setError(null);
        setFrameReady(true);
      } else if (data.type === "mike:authorities-helper-error") {
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
    return () => {
      window.removeEventListener("message", onReady);
      clearWatchdog();
    };
  }, [clearWatchdog, pingFrame, startWatchdog]);
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
              visible && frameScope === scopeSignature ? "" : "invisible"
            }`}
          />
        )}
        {!frameCurrent && visibleError ? (
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
