import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getApiAuthorization } from "@/app/lib/beaverApi";
import { AuthoritiesShell } from "@/app/components/shared/TableOfAuthoritiesFrame";

const BOOT_TIMEOUT_MS = 15_000;
const JOB_ID = /^[0-9a-f]{32}$/;
const PROJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TableOfAuthoritiesHostProps {
  active: boolean;
  enabled: boolean;
}

export function TableOfAuthoritiesHost({
  active,
  enabled,
}: TableOfAuthoritiesHostProps) {
  const [searchParams] = useSearchParams();
  const [frame, setFrame] = useState({ url: "", scope: "", attempt: "" });
  const [readyAttempt, setReadyAttempt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const watchdogRef = useRef<number | null>(null);
  const requestedJob = searchParams.get("job") ?? "";
  const requestedProject = searchParams.get("project") ?? "";
  const job = JOB_ID.test(requestedJob) ? requestedJob : "";
  const project = PROJECT_ID.test(requestedProject)
    ? requestedProject : "";
  const scope = `${job}:${project}`;

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
  }, []);

  const probe = useCallback(async () => {
    const target = frameRef.current?.contentWindow;
    if (!target || !frame.attempt) return;
    target.postMessage({
      type: "mike:authorities-helper-probe",
      attempt: frame.attempt,
      authorization: await getApiAuthorization(),
    }, window.location.origin);
  }, [frame.attempt]);

  useEffect(() => {
    if (!enabled || !active) return;
    if (frame.url && frame.scope === scope) {
      void probe();
      return;
    }
    const attempt = crypto.randomUUID();
    const query = new URLSearchParams({ mode: "mike", attempt });
    if (job) query.set("job", job);
    if (project) query.set("project", project);
    setReadyAttempt("");
    setError(null);
    setFrame({
      scope,
      attempt,
      url: `/authorities-helper/?${query}`,
    });
  }, [active, enabled, frame.scope, frame.url, job, probe, project, scope]);

  useEffect(() => {
    if (!frame.attempt) return;
    clearWatchdog();
    watchdogRef.current = window.setTimeout(() => {
      setReadyAttempt("");
      setError("Table of Authorities took too long to start.");
    }, BOOT_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.attempt !== frame.attempt) return;
      clearWatchdog();
      if (data.type === "mike:authorities-helper-ready") {
        setError(null);
        setReadyAttempt(frame.attempt);
      } else if (data.type === "mike:authorities-helper-error") {
        setReadyAttempt("");
        setError(typeof data.message === "string"
          ? data.message : "Table of Authorities could not be started.");
      }
    };
    window.addEventListener("message", onMessage);
    void probe();
    return () => {
      window.removeEventListener("message", onMessage);
      clearWatchdog();
    };
  }, [clearWatchdog, frame.attempt, probe]);

  const current = frame.scope === scope;
  const ready = current && readyAttempt === frame.attempt;
  return (
    <AuthoritiesShell active={active} busy={active && !ready && !error}>
      {frame.url ? (
        <iframe
          ref={frameRef}
          src={frame.url}
          title="Table of Authorities"
          referrerPolicy="no-referrer"
          aria-hidden={!active || !ready}
          tabIndex={active && ready ? 0 : -1}
          onLoad={() => void probe()}
          className={`absolute inset-0 h-full w-full border-0 bg-[#f3f4f6] ${
            active && current ? "" : "invisible"
          }`}
        />
      ) : null}
      {!ready && current && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white p-8">
          <div className="max-w-lg text-center">
            <h2 className="font-serif text-2xl text-gray-900">Authorities unavailable</h2>
            <p className="mt-3 text-sm leading-6 text-gray-600">{error}</p>
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
  );
}
