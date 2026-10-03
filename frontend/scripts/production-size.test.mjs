import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { measureProductionSize } from "./production-size.mjs";

test("the ledger counts duplicate and lazy payloads, extras, and verifies sidecars", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "beaver-size-gate-"));
    try {
        const dist = path.join(root, "dist");
        await mkdir(path.join(dist, "assets"), { recursive: true });
        const code = Buffer.from("export const preserved = 1;".repeat(60));
        await writeFile(path.join(dist, "assets/main.js"), code);
        await writeFile(path.join(dist, "assets/lazy-worker.js"), code);
        await writeFile(path.join(dist, "assets/main.js.gz"), gzipSync(code, { level: 6 }));
        const html = path.join(root, "offline.html");
        await writeFile(html, "<html>self-contained</html>");
        const report = await measureProductionSize(dist, [html]);
        assert.equal(report.fileCount, 3);
        assert.equal(report.rawBytes, code.length * 2 + 27);
        assert.equal(report.gzipBytes, gzipSync(code, { level: 6 }).length * 2 + gzipSync(Buffer.from("<html>self-contained</html>"), { level: 6 }).length);
        await writeFile(path.join(dist, "assets/main.js.gz"), gzipSync(Buffer.from("wrong")));
        await assert.rejects(measureProductionSize(dist), /Stale compressed representation/u);
        await rm(path.join(dist, "assets/main.js.gz"));
        await writeFile(path.join(dist, "assets/missing.js.gz"), gzipSync(code));
        await assert.rejects(measureProductionSize(dist), /Orphan compressed representations/u);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
