import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@/app/globals.css";
import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { standaloneAuthoritiesHost } from "@/app/authorities/standaloneHost";

const container = document.getElementById("root");
if (!container) throw new Error("Missing Authorities root");

createRoot(container).render(<StrictMode><BrowserRouter>
  <main className="min-h-dvh">
    <AuthoritiesWorkspace host={standaloneAuthoritiesHost} />
  </main>
</BrowserRouter></StrictMode>);
