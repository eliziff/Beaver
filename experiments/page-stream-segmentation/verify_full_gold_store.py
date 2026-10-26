"""Prove every exported positive/edge belongs to the saved private gold."""
import argparse
import json
from pathlib import Path

from train_doc_split import digest,write
from register_split_gold import registered_sources,read
from index_structure_split_gold import unit_starts,split_hash


def verify(root,legal):
    base=root/'teacher-data'
    saved=json.loads((base/'private-gold-save.json').read_bytes())
    source_gold=json.loads((legal/'authoring-splits.json').read_bytes())
    counts={d['sha256']:d['pages'] for d in json.loads((legal/'authoring-manifest-all.json').read_bytes())['documents']}
    store=root/'gold-store'; index=read(store/'page-stream-gold/index.json')
    assert digest(store/'page-stream-gold/catalogue.sqlite')==saved['sqlite_catalogue_sha256']
    assert digest(legal/'authoring-splits.json')==index['existing_gold_sha256']
    additional=[]
    for record in index['additional_sources']:
        path=store/record['path']
        assert digest(path)==record['record_sha256']
        additional.append(read(path))
    edges={}; anchors=set(); line_reviewed=set()
    for source in source_gold['sources']:
        sha=source['sha256']; scope=set(source.get('pages',range(1,counts[sha]+1)))
        for page in scope:
            if page>1 and page-1 in scope: edges[sha,page]=int(page in source['document_starts'])
            line_reviewed.add((sha,page))
        anchors.update((sha,s['page'],s['line_id']) for s in source['document_starts'] if isinstance(s,dict))
    for source in additional:
        sha=source['sha256']
        for page,label in source['page_boundaries'].items():
            assert (sha,int(page)) not in edges, 'Gold store repeats an existing decision'
            edges[sha,int(page)]=label
        for start in source['internal_starts']:
            key=sha,start['page'],start['line_id']
            assert key not in anchors
            anchors.add(key); line_reviewed.add(key[:2])
    structure_anchors={}
    structure_refs={r['sha256']:r for r in index.get('structure_gold_sources',[])}
    for record in registered_sources('structure'):
        sha=record['sha256']; gold=read(record['path'])
        assert split_hash(gold)==structure_refs[sha]['split_supervision_sha256']
        starts=unit_starts(gold); structure_anchors[sha]=starts; first={}
        for line in gold['lines']: first.setdefault(line['page'],line['id'])
        for page in range(1,gold['page_count']+1):
            line_reviewed.add((sha,page))
            if page>1: edges.setdefault((sha,page),int(first.get(page) in starts))
    seen_edges=set()
    full=json.loads((base/'full-training.json').read_bytes())
    for case in full['cases']:
        for page,label in case['targets'].items():
            key=case['sha256'],int(page)
            assert key not in seen_edges and edges[key]==label
            seen_edges.add(key)
    seen_anchors=set()
    internal=json.loads((base/'internal-training.json').read_bytes())
    for page in internal['pages']:
        assert (page['sha256'],page['page']) in line_reviewed
        for candidate in page['candidates']:
            key=page['sha256'],page['page'],candidate['line_id']
            expected=(candidate['line_id'] in structure_anchors[page['sha256']] if page.get('gold_panel')=='registered-structure-unit-starts'
                else key in anchors)
            assert candidate['label']==int(expected)
            if candidate['label']:
                assert key not in seen_anchors
                seen_anchors.add(key)
    held=json.loads((base/'test.json').read_bytes())
    families={c['family_id'] for c in held['cases']}
    assert not families&{c['family_id'] for c in full['cases']+internal['pages']}
    result=dict(origin='machine_test',run_id='private-gold-export-coverage',private_commit=saved['commit'],
        exported_edges=len(seen_edges),exported_internal_starts=len(seen_anchors),
        private_index_sha256=digest(store/'page-stream-gold/index.json'),registered_structure_sources=len(structure_refs),
        private_sqlite_sha256=digest(store/'page-stream-gold/catalogue.sqlite'),
        edge_export_sha256=digest(base/'full-training.json'),
        internal_export_sha256=digest(base/'internal-training.json'),
        all_exported_labels_match_private_store=True,final_family_overlap=False)
    write(base/'private-gold-coverage.json',result)
    print(json.dumps(result))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True,type=Path)
    parser.add_argument('--legal-split-root',required=True,type=Path)
    args=parser.parse_args(); verify(args.root,args.legal_split_root)
