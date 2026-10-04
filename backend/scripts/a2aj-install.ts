// Installs, updates and removes courts of Beaver's local A2AJ store (a2aj.sqlite) from A2AJ's
// Hugging Face datasets (a2ajInstall.ts).
//
//   npm run a2aj --prefix backend                     what is installed, and what has an update
//   npm run a2aj --prefix backend -- --update         brings every installed court up to date, and
//                                                     remakes citation keys the engine now makes differently
//   npm run a2aj --prefix backend -- cases/SCC laws/LEGISLATION-FED   installs or updates these
//   npm run a2aj --prefix backend -- --all            every court and jurisdiction
//   npm run a2aj --prefix backend -- --remove cases/SST
//
// The store is MIKE_A2AJ_BULK_DB, else OpenLegalData's providers/a2aj/a2aj.sqlite.
import { a2ajLocalBulkPath } from "../src/lib/a2ajLocalBulk";
import { A2AJ_KINDS, a2ajBytesToDownload, a2ajCourtStale, a2ajStoreStatus, fetchA2AJSnapshot,
  installA2AJCourts } from "../src/lib/a2ajInstall";

async function main() {
  const args = process.argv.slice(2);
  const removing = args.flatMap((arg, index) => args[index - 1] === "--remove" ? [arg] : []);
  const named = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--remove");
  const snapshots = Object.fromEntries(await Promise.all(A2AJ_KINDS.map(async (kind) => [kind, await fetchA2AJSnapshot(kind)])));
  const status = await a2ajStoreStatus(snapshots);
  const key = (court: { kind: string; court: string }) => `${court.kind}/${court.court}`;
  const wanted = args.includes("--all") ? status.filter((court) => court.remote).map(key)
    : args.includes("--update") ? status.filter(a2ajCourtStale).map(key) : named;
  const unknown = [...wanted, ...removing].filter((name) => !status.some((court) => key(court) === name));
  if (unknown.length) throw new Error(`A2AJ publishes no ${unknown.join(", ")}. Courts are named like cases/SCC and laws/LEGISLATION-FED.`);

  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
  if (!wanted.length && !removing.length && !args.includes("--update")) {
    console.log(a2ajLocalBulkPath());
    for (const court of status) console.log(`${key(court).padEnd(26)} ${court.installed ? `${court.installed.documents} documents` : "not installed"}${
      a2ajCourtStale(court) ? `, update available (${gb(court.remote!.size)})` : ""}`);
  } else {
    console.log(`Installing into ${a2ajLocalBulkPath()}: ${gb(a2ajBytesToDownload(status, wanted))} to download.`);
    const started = Date.now();
    let shown = "";
    await installA2AJCourts(snapshots, wanted, { remove: removing, progress: ({ kind, court, phase, downloaded, toDownload, documents }) => {
      const line = phase === "download" ? `${kind}/${court}: downloading, ${gb(downloaded)} of ${gb(toDownload)}`
        : `${kind}/${court}: ${phase === "import" ? "reading" : phase}, ${documents} documents`;
      if (line === shown) return;
      process.stdout.write(phase === "installed" || phase === "removed" ? `\r${line}\n` : `\r${line}`);
      shown = line;
    } });
    console.log(`Done in ${((Date.now() - started) / 60_000).toFixed(1)} min.`);
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
