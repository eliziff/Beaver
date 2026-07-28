"use client";

import { useEffect, useRef, useState } from "react";
import { launchTableOfAuthorities } from "@/app/lib/beaverApi";
import { PageHeader } from "@/app/components/shared/PageHeader";

export default function TableOfAuthoritiesPage() {
  const [url, setUrl] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef("");

  useEffect(() => {
    let active = true;
    if (!sessionRef.current) {
      const key = "mike-table-of-authorities-session";
      try {
        const stored = window.sessionStorage.getItem(key);
        sessionRef.current =
          stored && /^[0-9a-f]{32}$/.test(stored)
            ? stored
            : crypto.randomUUID().replaceAll("-", "");
        window.sessionStorage.setItem(key, sessionRef.current);
      } catch {
        sessionRef.current = crypto.randomUUID().replaceAll("-", "");
      }
    }
    launchTableOfAuthorities()
      .then((result) => {
        if (!active) return;
        const query = new URLSearchParams(window.location.search);
        const job = query.get("job");
        const project = query.get("project");
        const serviceUrl = new URL(result.url);
        serviceUrl.searchParams.set("mode", "mike");
        serviceUrl.searchParams.set("session", sessionRef.current);
        if (job && /^[0-9a-f]{32}$/.test(job)) {
          serviceUrl.searchParams.set("job", job);
        }
        if (
          project &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            project,
          )
        ) {
          serviceUrl.searchParams.set("project", project);
        }
        setUrl(serviceUrl.toString());
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Table of Authorities could not be started.",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#f3f4f6]">
      <PageHeader shrink>
        <h1 className="font-serif text-2xl font-medium text-gray-900">
          Authorities
        </h1>
      </PageHeader>
      <div
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        aria-busy={!frameReady && !error}
      >
        {url && (
          <iframe
            src={url}
            title="Table of Authorities"
            aria-hidden={!frameReady}
            tabIndex={frameReady ? 0 : -1}
            onLoad={() => setFrameReady(true)}
            className="absolute inset-0 h-full w-full border-0 bg-[#f3f4f6]"
          />
        )}
        {!frameReady &&
          (error ? (
            <div className="absolute inset-0 flex items-center justify-center bg-white p-8">
              <div className="max-w-lg text-center">
                <h2 className="font-serif text-2xl text-gray-900">
                  Authorities unavailable
                </h2>
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
          ) : (
            <AuthoritiesReadyShell />
          ))}
      </div>
    </div>
  );
}

function AuthoritiesReadyShell() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 flex flex-col bg-[#f3f4f6] text-[#111827]"
    >
      <div className="grid h-[43px] w-full shrink-0 grid-cols-4 items-center gap-1 px-4 text-sm font-semibold min-[481px]:flex min-[481px]:h-[45px] min-[481px]:gap-[0.45rem] min-[481px]:px-6">
          <span className="flex h-9 w-full items-center justify-center rounded-lg border border-[#d52b1e] bg-[#d52b1e] text-white min-[481px]:w-[104px]">
            Automatic
          </span>
          {["Manual", "History", "Settings"].map((label) => (
            <span
              key={label}
              className="flex h-9 w-full items-center justify-center rounded-lg border border-[#d1d5db] bg-white min-[481px]:w-[104px]"
            >
              {label}
            </span>
          ))}
      </div>
      <div className="w-full p-4 min-[481px]:p-6 min-[481px]:pt-3">
        <div className="flex min-h-[77px] max-w-[560px] items-center justify-between gap-4 rounded-[10px] border border-[#d1d5db] bg-white p-3 text-[17px] font-semibold min-[481px]:p-4">
          <span>Start with a Word document.</span>
          <span className="flex min-h-10 items-center rounded-lg border border-[#111827] bg-[#111827] px-[0.8rem] py-2 text-sm text-white">
            Create
          </span>
        </div>
      </div>
    </div>
  );
}
