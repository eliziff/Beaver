// A2AJ's Parquet corpus (a2ajCorpus.ts) in a folder on this computer: the folder the page
// downloads into is read here the same way, by the desktop runtime and Beaver's server.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { A2AJCorpusFolder, Sha256 } from "./a2ajCorpus";
import { A2AJParquetCorpus, folderA2AJSource } from "./a2ajParquet";
import { legalProviderDatabase } from "./legalDataPath";
import { structureNative } from "./structureNative";

/** The corpus folder: MIKE_A2AJ_PARQUET_DIR, else the shared legal data's providers/a2aj/parquet. */
export function a2ajParquetDirectory() {
  const configured = process.env.MIKE_A2AJ_PARQUET_DIR?.trim();
  return configured ? path.resolve(configured) : legalProviderDatabase("a2aj", "parquet");
}

export const nodeSha256: Sha256 = () => createHash("sha256");

export function nodeA2AJFolder(root: string): A2AJCorpusFolder {
  const at = (relative: string) => path.join(root, ...relative.split("/"));
  const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
  return {
    readText: (relative) => readFile(at(relative), "utf8").catch((error) => { if (absent(error)) return null; throw error; }),
    async writeText(relative, text) {
      const target = at(relative), temporary = `${target}.${process.pid}.tmp`;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temporary, text);
      await rename(temporary, target);
    },
    size: (relative) => stat(at(relative)).then((info) => info.size, (error) => { if (absent(error)) return null; throw error; }),
    async read(relative, start, end) {
      const handle = await open(at(relative), "r");
      try {
        const bytes = new Uint8Array(Math.max(end - start, 0));
        let done = 0;
        while (done < bytes.length) {
          const { bytesRead } = await handle.read(bytes, done, bytes.length - done, start + done);
          if (!bytesRead) break;
          done += bytesRead;
        }
        return done === bytes.length ? bytes : bytes.subarray(0, done);
      } finally { await handle.close(); }
    },
    async append(relative, offset) {
      const target = at(relative);
      await mkdir(path.dirname(target), { recursive: true });
      const handle = await open(target, offset ? "r+" : "w");
      await handle.truncate(offset);
      let position = offset;
      return {
        async write(bytes) { await handle.write(bytes, 0, bytes.length, position); position += bytes.length; },
        async close() { await handle.sync(); await handle.close(); },
      };
    },
    rename: (from, to) => rename(at(from), at(to)),
    remove: (relative) => rm(at(relative), { force: true }),
  };
}

/** The corpus in a folder on this computer (by default the shared one), read with Beaver's citation keys. */
export function nodeA2AJCorpus(root = a2ajParquetDirectory()) {
  return new A2AJParquetCorpus(folderA2AJSource(nodeA2AJFolder(root)),
    (texts) => structureNative().citationLookupKeys(texts));
}
