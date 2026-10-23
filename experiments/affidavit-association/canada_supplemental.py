"""Direct collaboration author evidence packets; never invokes a model runner."""
import pathlib,json,sys,hashlib
import us_author as u
OUT=u.ROOT/'benchmarks/local-data/affidavit-association/expansion/supplemental-canada'
IDS=[f'us-cand-overture-google-entry-{n}' for n in [26,37,70,82,133,186]]+[f'us-cand-apple-samsung-entry-{n}' for n in [1082,1098]]+[f'us-cand-oracle-google-entry-{n}' for n in [1562,1566]]
def main():
    OUT.mkdir(exist_ok=True);items={x['case']['record']+'-entry-'+str(x['entry']):x for x in u.sources()};selection=[]
    for rid in IDS:
        d=OUT/'pending'/rid;d.mkdir(parents=True,exist_ok=True);parts,prompt,images=u.packet(items[rid],d)
        (d/'case.json').write_text(json.dumps(items[rid]['case'],indent=2),encoding='utf-8')
        for part in parts:(d/f"source-{part['attachment']}.txt").write_text(part['text'],encoding='utf-8')
        (d/'full-view.txt').write_text('\n'.join(f"ATTACHMENT {p['attachment']} {p['pages']} PAGES\n"+p['text'] for p in parts),encoding='utf-8')
        (d/'source-view-manifest.json').write_text(json.dumps({'origin':'machine_test','run_id':'affidavit-association-supplemental-canada-20261022','author_method':'codex_collaboration','status':'pending_direct_author','sources':[{'attachment':p['attachment'],'sha256':p['sha256'],'url':p['url'],'pages':p['pages'],'text_sha256':hashlib.sha256(p['text'].encode()).hexdigest()} for p in parts],'images':[{'path':str(p.relative_to(OUT)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in images]},indent=2),encoding='utf-8')
        selection.append({'record_id':rid,'parts':len(parts),'main_chars':len(parts[0]['text']),'pages':sum(p['pages'] for p in parts)});print(selection[-1],flush=True)
    (OUT/'selection.json').write_text(json.dumps(selection,indent=2),encoding='utf-8')
if __name__=='__main__':main()
