"""The opinions of each case, with their types, from the whole dump: which writings a case holds beyond the record in hand.

    python -I sibling_sheet.py OPINIONS.csv.bz2 CLUSTERS[,CLUSTERS] OUT.jsonl [THREADS]

Writes {"cluster": id, "opinions": [[opinion id, type], ...]}, a line a case. courtlistener-structure grade reads it as --siblings.
"""
import collections, json, sys
import indexed_bzip2
import pyarrow as pa
import pyarrow.csv as pcsv

dump, clusters, out = sys.argv[1:4]
threads = int(sys.argv[4]) if len(sys.argv) > 4 else 6
wanted = {line.strip() for name in clusters.split(",") for line in open(name, encoding="utf-8") if line.strip()}
head = pcsv.open_csv(indexed_bzip2.open(dump, parallelization=1), read_options=pcsv.ReadOptions(block_size=1 << 24), parse_options=pcsv.ParseOptions(escape_char="\\", double_quote=False, newlines_in_values=True, invalid_row_handler=lambda row: "skip")).schema.names
reader = pcsv.open_csv(indexed_bzip2.open(dump, parallelization=threads),
                       read_options=pcsv.ReadOptions(block_size=64 << 20, use_threads=True),
                       parse_options=pcsv.ParseOptions(escape_char="\\", double_quote=False, newlines_in_values=True, invalid_row_handler=lambda row: "skip"),
                       convert_options=pcsv.ConvertOptions(column_types={name: pa.string() for name in head}, include_columns=["id", "type", "cluster_id"], strings_can_be_null=True))
cases = collections.defaultdict(list)
rows = 0
for batch in reader:
    rows += batch.num_rows
    ids, kinds, owners = batch.column("id").to_pylist(), batch.column("type").to_pylist(), batch.column("cluster_id").to_pylist()
    for opinion, kind, cluster in zip(ids, kinds, owners):
        if cluster in wanted:
            cases[cluster].append([opinion, kind or ""])
with open(out, "w", encoding="utf-8", newline="\n") as sheet:
    for cluster, opinions in cases.items():
        sheet.write(json.dumps({"cluster": cluster, "opinions": opinions}) + "\n")
print("done rows", rows, "cases", len(cases), "with more than one opinion", sum(1 for opinions in cases.values() if len(opinions) > 1))
