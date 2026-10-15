import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The optimized addon; a development loop pins its own build with LEGAL_STRUCTURE_NATIVE. A debug build newer than
 *  it stops the load rather than running older code unnoticed. */
export function defaultNativeAddon(root) {
  const name = process.platform === "win32" ? "legal_structure_node.dll" :
    process.platform === "darwin" ? "liblegal_structure_node.dylib" : "liblegal_structure_node.so";
  const [debug, release] = ["debug", "release"].map((profile) =>
    statSync(path.join(root, "target", profile, name), { throwIfNoEntry: false })?.mtimeMs ?? 0);
  if (!release || debug > release) throw new Error(`The ${release ? "debug engine is newer than the release engine"
    : "release engine is missing"}; set LEGAL_STRUCTURE_NATIVE to the build you mean, or run npm run native:build:release.`);
  return path.join(root, "target", "release", name);
}

export function nativeAddonFile(filename, root) {
  if (process.platform !== "win32" ||
      !/^target\/(debug|release)\/legal_structure_node\.dll$/.test(path.relative(root, filename).replaceAll("\\", "/")))
    return filename;
  // Windows locks loaded DLLs. Load an immutable copy so Cargo can replace its output.
  const bytes = readFileSync(filename), hash = createHash("sha256").update(bytes).digest("hex");
  const directory = path.dirname(filename), name = `legal_structure_node.${hash}.dll`;
  const loaded = path.join(directory, name);
  if (!existsSync(loaded)) {
    const temporary = `${loaded}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, bytes);
      try { renameSync(temporary, loaded); }
      catch (error) { if (!existsSync(loaded)) throw error; }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  for (const previous of readdirSync(directory)) {
    if (previous !== name && /^legal_structure_node\.[a-f0-9]{64}\.dll$/.test(previous)) {
      try { unlinkSync(path.join(directory, previous)); }
      catch (error) {
        if (!["EPERM", "EACCES", "EBUSY", "ENOENT"].includes(error.code ?? "")) throw error;
      }
    }
  }
  return loaded;
}
