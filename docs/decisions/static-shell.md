# Static shell rewrite

Status: **partly adopted, partly rejected**. Vite and React now provide the one
browser client. Replacing cohesive React interactions with browser prompts or
visually inequivalent native controls was rejected after live UX review. Keep
the smaller build stack; preserve the established user experience.

## Objective

Replace the Next/OpenNext application shell with a small static browser client
while keeping Beaver's REST/SSE API, SQLite/AppData contract, cloud adapters,
document semantics, and legal evidence unchanged.

## Shape

- Build one static client with Vite and the existing React runtime first.
- Serve the same assets from the local Express process and from a cloud/static
  host; runtime API configuration must not require a rebuild.
- Keep one resource cache, one SSE event reducer, and native browser dialogs,
  popovers, forms, and routing primitives where they are sufficient.
- Load PDF, DOCX, spreadsheet, Authorities, and Tabular viewers in bounded
  route chunks. Assistant and Library remain warm primary routes.
- Replace provider SDK calls that are plain JSON/SSE with native `fetch`; keep
  Supabase and S3-compatible support behind cloud-only imports.
- Move features one vertical slice at a time. The old client remains the
  rollback target until every slice passes the gates.

## Gates

The shell replaces the current client only if the clean build and measured
runtime show all of the following:

- at least 40% fewer authored UI lines;
- at least 30% less production JavaScript;
- at least 50% faster clean build;
- no regression in first assistant token, warmed navigation, or upload/view;
- zero layout shifts in wide, narrow, and stepped viewport filmstrips;
- account-free local and cloud API paths both work;
- frontend and backend tests/builds pass.

If a slice fails a gate, discard that slice; do not preserve a second UI
implementation indefinitely.

## Order

1. Add the static shell, runtime API configuration, shared CSS tokens, and a
   minimal route/resource/SSE foundation without changing the existing client.
2. Port Assistant and Library as the first vertical slices and compare them
   against the recorded route and interaction baselines.
3. Port Authorities, Projects, and Tabular Review with bounded lazy chunks.
4. Port the document viewers and deterministic automation surfaces.
5. Replace plain provider SDK calls with `fetch` adapters and delete unused
   SDK/dependency trees.
6. Make Express serve the static client locally and retain a cloud/static
   deployment target; remove Next/OpenNext only after the gates pass.

## Measurement

Record the same production build, decoded route JavaScript, cold startup,
first-token, warmed navigation, layout-shift, and test commands before and
after each vertical slice. Do not trade useful warmup for a smaller build
number.
