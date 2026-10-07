import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Reuse the most recently built full-capability addon; never retry a failed load with older code. */
export function defaultNativeAddon(root) {
  const name = process.platform === "win32" ? "legal_structure_node.dll" :
    process.platform === "darwin" ? "liblegal_structure_node.dylib" : "liblegal_structure_node.so";
  const artifacts = ["debug", "release"].map(profile => path.join(root, "target", profile, name))
    .filter(filename => existsSync(filename))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!artifacts.length) throw new Error("Native engine missing. Run npm run native:build once.");
  return artifacts[0];
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
