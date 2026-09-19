import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isolatedProcessEnv } from "./subprocessEnv";

const exec = promisify(execFile);
const unique = (values: (string | undefined)[]) => [...new Set(values.filter((s): s is string => !!s))];

/** Shared by PDF conversion and the rich editor. No deployment-mode branch. */
export function resolveSofficeBinary(): string | null {
  const windows = process.platform === "win32";
  const names = windows ? ["soffice.exe", "soffice.com"] : ["soffice", "libreoffice"];
  const candidates = unique([
    process.env.SOFFICE_BINARY_PATH, process.env.LIBREOFFICE_BINARY_PATH, process.env.LIBRE_OFFICE_EXE,
    ...(process.env.PATH ?? "").split(path.delimiter).flatMap(d => names.map(n => path.join(d, n))),
    ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)
      .map(d => path.join(d!, "LibreOffice", "program", "soffice.exe")),
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    path.join(process.env.HOME ?? "", "Applications/LibreOffice.app/Contents/MacOS/soffice"),
    "/usr/bin/soffice", "/usr/bin/libreoffice", "/opt/libreoffice/program/soffice",
  ]);
  return candidates.find(file => {
    try { accessSync(file, constants.X_OK); return true; } catch { return false; }
  }) ?? null;
}

export type UnoRuntime = { python: string; soffice: string; modulePaths: string[];
  env: NodeJS.ProcessEnv; pythonVersion: string };
let cached: { key: string; result: Promise<UnoRuntime> } | undefined;

/** Use LibreOffice's own interpreter, or a probed ABI-compatible interpreter.
 * Never require a user to change PYTHONPATH, weaken signing, or select a Python version by guesswork.
 */
export function resolveUnoRuntime(): Promise<UnoRuntime> {
  const soffice = resolveSofficeBinary();
  if (!soffice) return Promise.reject(new Error("LibreOffice Writer is not installed; install LibreOffice or set SOFFICE_BINARY_PATH"));
  const key = [soffice, process.env.WORD_UNO_PYTHON ?? ""].join("\n");
  if (cached?.key === key) return cached.result;
  const result = (async () => {
    const program = path.dirname(soffice);
    const contents = process.platform === "darwin" ? path.dirname(program) : program;
    const modulePaths = unique([program, path.join(contents, "Resources"), path.join(contents, "Frameworks"),
      "/usr/lib/python3/dist-packages", "/usr/lib/libreoffice/program"]).filter(existsSync);
    const env = { ...isolatedProcessEnv(["SAL_*", "URE_*"]),
      PATH: [program, process.env.PATH ?? ""].join(path.delimiter),
      ...(process.platform === "darwin" ? { DYLD_FALLBACK_LIBRARY_PATH: path.join(contents, "Frameworks") } : {}),
    };
    const versionsRoot = path.join(contents, "Frameworks/LibreOfficePython.framework/Versions");
    const versions = existsSync(versionsRoot) ? readdirSync(versionsRoot).filter(n => /^3\.\d+$/u.test(n)) : [];
    const candidates = process.env.WORD_UNO_PYTHON ? [process.env.WORD_UNO_PYTHON] : unique([
      ...readdirSync(program).filter(n => n.startsWith("python-core-")).map(n =>
        path.join(program, n, "bin", process.platform === "win32" ? "python.exe" : "python3")),
      path.join(program, process.platform === "win32" ? "python.exe" : "python"),
      path.join(contents, "Resources/python"),
      ...versions.flatMap(v => [path.join(versionsRoot, v, "bin/python" + v),
        `/opt/homebrew/opt/python@${v}/bin/python${v}`, `/usr/local/opt/python@${v}/bin/python${v}`]),
      "/usr/bin/python3", "python3", "python", "python3.13", "python3.12", "python3.11",
    ]).filter(p => !path.isAbsolute(p) || existsSync(p));
    const probe = `import sys,os,json; sys.path[:0]=json.loads(sys.argv[1]); ` +
      `dlls=[os.add_dll_directory(p) for p in sys.path[:${modulePaths.length}] if os.name=='nt' and os.path.isdir(p)]; ` +
      `import uno; assert sys.version_info >= (3,10); print(json.dumps({'version':sys.version.split()[0]}))`;
    const errors: string[] = [];
    for (const python of candidates) {
      try {
        const { stdout } = await exec(python, ["-I", "-c", probe, JSON.stringify(modulePaths)],
          { env, windowsHide: true, timeout: 8000, maxBuffer: 8192 });
        const value = JSON.parse(stdout.trim());
        if (typeof value.version !== "string") throw new Error("Invalid Python probe");
        return { python, soffice, modulePaths, env, pythonVersion: value.version };
      } catch (error) {
        errors.push(path.basename(python) + ": " + (error instanceof Error ? error.message.slice(-250) : "probe failed"));
      }
    }
    throw new Error("No compatible Python/UNO runtime was found (tried " + errors.join(", ") +
      "). Install the LibreOffice Python component; Linux packages are python3-uno. WORD_UNO_PYTHON may select a compatible interpreter.");
  })();
  cached = { key, result };
  void result.catch(() => { if (cached?.result === result) cached = undefined; });
  return result;
}

export const UNO_BOOTSTRAP = `import sys,os,json,runpy; paths=json.loads(sys.argv.pop(1)); ` +
  `sys.path[:0]=paths; dlls=[os.add_dll_directory(p) for p in paths if os.name=='nt' and os.path.isdir(p)]; ` +
  `sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0],run_name='__main__')`;
