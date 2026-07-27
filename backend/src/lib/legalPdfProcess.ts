import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function legalPdfEngineRoot() {
  return path.resolve(
    process.env.LEGALPDF_ENGINE_ROOT?.trim() ||
      path.join(__dirname, "../../../universal-legal-pdf-engine"),
  );
}

export async function runLegalPdf(
  args: string[],
  options?: { timeoutMs?: number; signal?: AbortSignal },
) {
  const root = legalPdfEngineRoot();
  const executable =
    process.env.LEGALPDF_PYTHON?.trim() ||
    (process.platform === "win32" ? "python" : "python3");
  return execFileAsync(
    executable,
    ["-X", "utf8", "-m", "legalpdf.cli", ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: [path.join(root, "src"), process.env.PYTHONPATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: options?.timeoutMs ?? 11 * 60 * 1000,
      signal: options?.signal,
      windowsHide: true,
    },
  );
}
