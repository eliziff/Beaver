# ChatGPT and Claude connector

Beaver runs as one MCP server that ChatGPT and Claude web add as a custom connector.
The hosts are thin adapters over the same operations Beaver chat and Authorities use;
nothing is reimplemented per host.

## Running it

1. Start Beaver (`scripts/mike.ps1 start`, API on :3000).
2. Build the app page once after frontend changes: `npm run build:mcp-app --prefix frontend`.
3. Start the connector: `npm run start:mcp --prefix backend` (after `npm run build --prefix backend`),
   or `npm run dev:mcp --prefix backend` from source. It listens on 127.0.0.1:3005
   (`BEAVER_MCP_PORT`) and calls Beaver at `BEAVER_API_ORIGIN` (default `http://127.0.0.1:3000`).
4. Publish it: `tailscale funnel --bg 3005` serves it at this machine's `https://<name>.ts.net`.

The connector URL is `https://<name>.ts.net/mcp/<secret>`; the secret is created once in
`OpenLegalData/apps/mike/mcp-server.json` and printed at startup. Anyone with the URL can use
the connector, so treat it as a credential. Add it in Claude under Customize → Connectors
(no sign-in) and in ChatGPT as a custom MCP server with no authentication.

## Tools

| Tool | Operation |
| --- | --- |
| `search_legal_sources` | `searchSources`, Beaver chat's `search_sources` schema |
| `read_passage` | `readLegalSourceResource`; also resolves a bare citation |
| `verify_quote` | the passage read plus `groundedProseErrors`/`quoteTextComparison` |
| `submit_grounded_answer` | Beaver chat's submit tool: `submitLegalEvidenceAnswer`, the citation plan and `createLegalEvidenceCitations` |
| `authorities_list`, `authorities_review`, `authorities_act`, `authorities_build` | `/api/authorities` routes |
| `authorities_open` | opens the Authorities workspace in the host |
| `beaver_api`, `beaver_download` | app-only: the page's Beaver requests and saved files |

The model cites by evidence id, as in Beaver chat: every passage it reads carries Beaver's
citation text and the link `<connector>/cite/<evidence_id>`, and the answers it writes link that
way (`/cite/<id>+<id>` for passages Beaver groups into one citation). Opening the link has Beaver
build its publisher link for that evidence — paragraph or section anchor and text fragment — and
redirects there. Receipts are kept in `OpenLegalData/apps/mike/mcp-evidence.jsonl`, so links and
citations survive restarts.

`submit_grounded_answer` is the grounded-answer contract: Beaver rejects claims whose quotations,
pinpoints or evidence do not match, then returns the answer with each claim's Beaver citation as
a `/cite` link. The host shows the same answer in Beaver's own message view, whose citation pills
open Beaver's publisher links directly.
Evidence ids appear to the user only inside citation links.

## App page

`frontend/mcp-app.html` (`src/mcpAppMain.tsx`, `src/mcpApp/`) is the MCP Apps page for every UI
tool. It is built as one module and served with its script and styles inlined, so it fetches
nothing: a host's sandbox may reach no other server (Chrome refuses a sandboxed page's requests to
a private-network address, which the connector has on its own tailnet). The page renders the
existing components (`AssistantMessage`, `AuthoritiesWorkspace` with `beaverAuthoritiesHost`);
their `/api` requests become calls of the app-only `beaver_api` tool, which the connector makes
to Beaver, limited to the routes those views use. Citation pills and other links open through
the host. Downloads use the host's `downloadFile`, or a 15-minute link from `beaver_download`
where the host has none.
