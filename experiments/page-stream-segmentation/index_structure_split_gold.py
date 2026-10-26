"""Reference existing private structure records; never duplicate their labels."""
import gzip
import hashlib
import json
from pathlib import Path
import sys


def semantic_hash(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def unit_starts(gold):
    first=next(i for i,u in enumerate(gold['units']) if 'document_type' in u)
    return {next(span['line_id'] for k in unit['lines'] for span in gold['typed'][k]['spans'])
        for i,unit in enumerate(gold['units']) if i>first and unit['starts_document']}


def split_hash(gold):
    return semantic_hash(dict(sha256=gold['source_sha256'],pages=gold['page_count'],lines=gold['lines'],
        starts=sorted(unit_starts(gold)),body_line_ids=sorted({s['line_id'] for t in gold['typed']
            if t['region'] not in {'furniture','page_label','line_label'} for s in t['spans']})))


def index(checkout):
    path=checkout/'page-stream-gold/index.json'
    value=json.loads(path.read_bytes()); records=[]
    for batch in ('b5','b6'):
        for source in sorted((checkout/'structure-gold'/batch/'a').rglob('gold.json.gz')):
            gold=json.loads(gzip.decompress(source.read_bytes())); sha=gold['source_sha256']
            row=dict(sha256=sha,batch=batch,path=source.relative_to(checkout).as_posix(),
                semantic_sha256=semantic_hash(gold),physical_pages=gold['page_count'],unit_starts=len(unit_starts(gold)))
            row['split_supervision_sha256']=split_hash(gold)
            other=checkout/'structure-gold'/batch/'b'/source.parent.name/source.name
            if other.exists():
                second=json.loads(gzip.decompress(other.read_bytes()))
                assert unit_starts(gold)==unit_starts(second), 'Unadjudicated structure start disagreement'
                row['agreement_reference']=other.relative_to(checkout).as_posix()
                row['agreement_semantic_sha256']=semantic_hash(second)
            records.append(row)
    assert len({r['sha256'] for r in records})==len(records)
    value['structure_gold_sources']=records
    value['structure_usage_policy']='Use existing authored unit starts, excluding the first document. Preserve exact anchors; ambiguous page-vs-line placement and conflicts require exclusion, never invented labels.'
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(dict(sources=len(records),physical_pages=sum(r['physical_pages'] for r in records),
        authored_starts=sum(r['unit_starts'] for r in records),double_authored_agreement_sources=sum('agreement_reference' in r for r in records))))


if __name__=='__main__': index(Path(sys.argv[1]))
