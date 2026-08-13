import { existsSync } from "node:fs";

/** Choose a receipt path without silently destroying an earlier run. */
export function receiptPath(
  defaultPath: string,
  options: { argv?: string[]; resume?: boolean } = {},
): string {
  const argv = options.argv ?? process.argv;
  const at = argv.indexOf("--output");
  if (at >= 0 && (at + 1 >= argv.length || argv[at + 1].startsWith("--"))) {
    throw new Error("--output needs a path");
  }
  const output = at >= 0 ? argv[at + 1] : defaultPath;
  if (!options.resume && existsSync(output) && !argv.includes("--force")) {
    throw new Error(
      `refusing to overwrite an existing receipt: ${output}\n` +
        "pass --output <newfile>, --resume to append, or --force to replace it",
    );
  }
  return output;
}
