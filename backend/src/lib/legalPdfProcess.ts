import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LEGAL_PDF_DOCUMENT_SCHEMA = "legalpdf.document.v2";
export const LEGAL_PDF_PARSER_VERSION = "0.3.0";

type LegalPdfRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  engineRoot?: string;
  exists?: (candidate: string) => boolean;
};

function legalPdfEngineRoot(options?: LegalPdfRuntimeOptions) {
  const env = options?.env ?? process.env;
  return path.resolve(
    options?.engineRoot ||
      env.LEGALPDF_ENGINE_ROOT?.trim() ||
      path.join(__dirname, "../../../universal-legal-pdf-engine"),
  );
}

export function legalPdfPython(options?: LegalPdfRuntimeOptions) {
  const env = options?.env ?? process.env;
  const configured = env.LEGALPDF_PYTHON?.trim();
  if (configured) return configured;

  const platform = options?.platform ?? process.platform;
  const root = legalPdfEngineRoot({ ...options, env });
  const managed = path.join(
    root,
    ".venv",
    platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  if ((options?.exists ?? existsSync)(managed)) return managed;

  return platform === "win32" ? "python" : "python3";
}

export async function runLegalPdf(
  args: string[],
  options?: { timeoutMs?: number; signal?: AbortSignal },
) {
  const root = legalPdfEngineRoot();
  return execFileAsync(
    legalPdfPython({ engineRoot: root }),
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
