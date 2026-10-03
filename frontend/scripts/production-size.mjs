// Count every shipped payload, including lazy chunks, workers, fonts and extra
// self-contained pages. Sidecars are representations, not additional payloads.
// node frontend/scripts/production-size.mjs frontend/dist --extra=AuthoritiesHelper/modern/out/Authorities.html --limit-gzip=BYTES
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync, gzipSync } from "node:zlib";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function filesIn(directory, prefix = "") {
    const files = [];
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        assert(!item.isSymbolicLink(), `Output must contain its assets: ${path.join(directory, item.name)}`);
        const name = prefix + item.name;
        if (item.isDirectory()) files.push(...await filesIn(path.join(directory, item.name), `${name}/`));
        else if (item.isFile()) files.push({ name, file: path.join(directory, item.name) });
    }
    return files;
}

export async function measureProductionSize(dist, extras = []) {
    const inputs = await filesIn(dist);
    for (const [index, file] of extras.entries()) inputs.push({ name: `standalone/${index}/${path.basename(file)}`, file });
    const sidecars = new Map(inputs.filter(({ name }) => /\.(?:gz|br)$/u.test(name)).map(({ name, file }) => [name, file]));
    const files = [];
    let storedBytes = 0;
    for (const { name, file } of inputs) {
        const bytes = await readFile(file);
        storedBytes += bytes.length;
        if (/\.(?:gz|br)$/u.test(name)) continue;
        const gzip = gzipSync(bytes, { level: 6 });
        const brotli = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
        for (const [suffix, decompress] of [["gz", gunzipSync], ["br", brotliDecompressSync]]) {
            const sidecar = sidecars.get(`${name}.${suffix}`);
            if (sidecar) {
                assert.deepEqual(decompress(await readFile(sidecar)), bytes, `Stale compressed representation: ${name}.${suffix}`);
                sidecars.delete(`${name}.${suffix}`);
            }
        }
        files.push({ name, rawBytes: bytes.length, gzipBytes: gzip.length, brotliBytes: brotli.length, sha256: sha256(bytes) });
    }
    assert.equal(sidecars.size, 0, `Orphan compressed representations: ${[...sidecars.keys()].join(", ")}`);
    const total = (key) => files.reduce((sum, file) => sum + file[key], 0);
    return { compression: { gzipLevel: 6, brotliQuality: 5 }, fileCount: files.length,
        rawBytes: total("rawBytes"), gzipBytes: total("gzipBytes"), brotliBytes: total("brotliBytes"), storedBytes, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const args = process.argv.slice(2);
    const dist = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? path.join(import.meta.dirname, "../dist"));
    const report = await measureProductionSize(dist, args.filter((arg) => arg.startsWith("--extra=")).map((arg) => path.resolve(arg.slice(8))));
    const json = args.find((arg) => arg.startsWith("--json="))?.slice(7);
    if (json) await writeFile(json, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ ...report, files: undefined }));
    const limit = args.find((arg) => arg.startsWith("--limit-gzip="))?.slice(13);
    if (limit !== undefined) {
        assert(Number.isSafeInteger(Number(limit)) && Number(limit) >= 0, "--limit-gzip must be a nonnegative byte count");
        assert(report.gzipBytes <= Number(limit), `Production gzip budget exceeded: ${report.gzipBytes} > ${limit}`);
    }
}
