"""The citations of the clusters a pack holds, one JSON line each: {"id", "citations": [[volume, reporter, page, type], ...]}.

  python -I pack_citations.py CITATIONS.csv.bz2 CLUSTER_IDS OUT.jsonl
"""
import bz2, csv, json, sys, collections

source, ids, out = sys.argv[1:4]
csv.field_size_limit(1 << 24)
wanted = set(open(ids).read().split())
found = collections.defaultdict(list)
rows = 0
with bz2.open(source, 'rt', encoding='utf-8', newline='') as f:
    reader = csv.DictReader(f)
    print(reader.fieldnames, flush=True)
    for row in reader:
        rows += 1
        cluster = row['cluster_id']
        if cluster in wanted:
            found[cluster].append([row['volume'], row['reporter'], row['page'], row['type']])
with open(out, 'w', encoding='utf-8') as o:
    for cluster, citations in found.items():
        o.write(json.dumps({'id': cluster, 'citations': citations}, ensure_ascii=False) + '\n')
print(rows, 'rows,', len(found), 'clusters', flush=True)
