#!/usr/bin/env node

async function main() {
  const runner = await import("../runner.ts");
  for (const [id, citation] of [[198181, "[1989] 1 SCR 1722"]] as Array<[number, string]>) {
    const record = await runner.loadCase({
      documentId: id,
      dataset: "SCC",
      citation,
      name: null,
      date: null,
    });
    const text = record.text ?? record.structure.header ?? "";
    const lines = text.split(/\r?\n/u);
    console.log("total lines:", lines.length);
    for (let i = 0; i < lines.length; i += 1) {
      if (/delivered by|Gonthier|GONTHIER/i.test(lines[i])) {
        console.log(`${i}:`, JSON.stringify(lines[i].slice(0, 160)));
      }
    }
  }
}

main();
