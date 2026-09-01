import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { standaloneAuthoritiesHost } from "@/app/authorities/standaloneHost";

const container = document.getElementById("root");
if (!container) throw new Error("Missing Authorities root");

function StandaloneAuthorities() {
  const [search, setSearch] = useState(location.search);
  useEffect(() => {
    const sync = () => setSearch(location.search);
    addEventListener("popstate", sync); return () => removeEventListener("popstate", sync);
  }, []);
  const params = new URLSearchParams(search);
  const replaceDraft = (id?: string) => {
    const next = new URL(location.href);
    if (id) next.searchParams.set("draft", id); else next.searchParams.delete("draft");
    history.replaceState(history.state, "", next); setSearch(next.search);
  };
  return <AuthoritiesWorkspace host={standaloneAuthoritiesHost} route={{
    draftId: params.get("draft") ?? "", replaceDraft,
  }} />;
}

createRoot(container).render(<StrictMode><StandaloneAuthorities /></StrictMode>);
