import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import { CourtRecordsWorkspace } from "@/app/court-records/CourtRecordsWorkspace";
import { standaloneCourtRecordsHost } from "@/app/court-records/standaloneHost";

const container = document.getElementById("root");
if (!container) throw new Error("Missing Court Record Builder root");

createRoot(container).render(<CourtRecordsWorkspace host={standaloneCourtRecordsHost} />);
