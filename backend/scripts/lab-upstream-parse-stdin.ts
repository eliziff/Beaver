/** Parse one trusted LAB source with the corrected Mike parser used by the comparator. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { textParserFor } from "../src/lib/chat/tools/documentOps";

type Input = { path: string; filename: string };

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8")) as Input;
  const fileType = extname(input.filename).slice(1).toLocaleLowerCase();
  const parser = textParserFor(fileType);
  if (!parser) throw new Error(`No Mike text parser for .${fileType}`);
  const text = await parser.run(readFileSync(input.path));

  process.stdout.write(
    JSON.stringify({
      text,
      parser: parser.parser,
      parser_version: parser.version,
      text_chars: text.length,
      text_sha256: createHash("sha256").update(text).digest("hex"),
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
