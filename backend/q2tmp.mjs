import { DatabaseSync } from "node:sqlite";
import { parquetMetadataAsync, asyncBufferFromFile, parquetSchema } from "hyparquet";
const root = process.env.LOCALAPPDATA + "/OpenLegalData/providers/a2aj/";
const db = new DatabaseSync(root + "a2aj.sqlite", { readOnly: true });
const row = db.prepare("SELECT * FROM document WHERE dataset='SCC' AND citation_en='2016 SCC 29'").get();
for (const [k,v] of Object.entries(row ?? {})) console.log(k, JSON.stringify(typeof v === "string" ? v.slice(0,150) : v));
const law = db.prepare("SELECT * FROM document WHERE dataset='LEGISLATION-FED' LIMIT 1").get();
for (const [k,v] of Object.entries(law)) console.log("law", k, JSON.stringify(typeof v === "string" ? v.slice(0,150) : v));
for (const f of ["cases/SCC/train.parquet", "laws/LEGISLATION-FED/train.parquet"]) {
  const file = await asyncBufferFromFile(root + "parquet/" + f);
  const md = await parquetMetadataAsync(file);
  console.log(f, Number(md.num_rows), md.row_groups.length, md.schema.map(s => `${s.name}:${s.type ?? ""}:${s.converted_type ?? ""}:${JSON.stringify(s.logical_type ?? "")}:${s.num_children ?? ""}`).join(" | "));
  console.log(md.row_groups[0].columns.map(c => `${c.meta_data.path_in_schema.join(".")}=${(Number(c.meta_data.total_compressed_size)/1e6).toFixed(1)}MB ${c.meta_data.codec}`).join(", "));
}
