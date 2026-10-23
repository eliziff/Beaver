"""Supplementary full named-instrument inventory; frozen author Gold is immutable."""
from pathlib import Path
import json, hashlib, fitz
from collections import Counter

O=Path('benchmarks/local-data/affidavit-association/expansion-2/regulatory')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,v): p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def main():
    acq=json.loads((O/'acquisitions.json').read_text(encoding='utf-8'))
    record=O/'records/reg2-scc-40195-vipond-20220922'
    g=json.loads((record/'source-gold.json').read_text(encoding='utf-8'))
    specs=[('5b42aedaa368e900fbe2040c4b5c65103fc5ee69fd2c235f9a5c174f8fe94e9a','Climate Change Toolkit for Health Professionals',11,18,'2019-04','Complete244physical-page toolkit, including all eight modules. Source title page establishes April2019. The body cites Module8page10; that locator does not narrow the available instrument to one page.','available_named_instrument'),
           ('30a532cc1b2e92440bfb67a113c78ea2e71deaf6ffd93a44e4b60fbc827e36f4','Fractures in the Bridge: Unconventional (Fracked) Natural Gas, Climate Change and Human Health',12,19,'2020-01','The exact source-linked URL resolves to a complete four-page SUMMARY, explicitly described as a summary of CAPE’s new report. Preserve the linked object without declaring it the full underlying report. Underlying report remains not located in this packet.','available_linked_summary_full_report_unresolved'),
           ('8b08fdc263defeb69e1ce79168814f47c38e619d2a2cc52c48de2c73c78d3d5e','Healthy Recovery Plan: For a Safe and Sustainable Future',13,19,'2020','Complete30physical-page facing-spread PDF, containing the printed56-page report and covers. The body’s56page description is consistent with its interior pagination; no fictitious56physical pages are created.','available_named_instrument')]
    instruments=[]
    for key,title,para,reference_page,date,note,status in specs:
        r=next(r for r in acq if r['exit_code']==0 and key in r.get('output',''))
        source=Path(r['output'].strip().split('\t')[-1]);assert sha(source)==key
        doc=fitz.open(source);parts=[];page_audit=[]
        for i,page in enumerate(doc,1):
            base=O/'source-text'/key;raw=(base/f'{i:04}.native.txt').read_text(encoding='utf-8');op=base/f'{i:04}.ocr.txt'
            scan=any(fitz.Rect(v['bbox']).get_area()>page.rect.get_area()*.6 for v in page.get_image_info())
            bad=sum(ord(c)<32 and c not in '\r\n\t\f' for c in raw)>=5
            use_ocr=op.exists() and (scan or bad or len(raw.strip())<100)
            selected=op if use_ocr else base/f'{i:04}.native.txt';parts.append(selected.read_text(encoding='utf-8'))
            page_audit.append(dict(source_page=i,text_source=selected.relative_to(O).as_posix(),text_source_sha256=sha(selected),method='installed_tesseract_source_image_ocr' if use_ocr else 'full_original_native_text',native_character_count=len(raw),full_page_image=scan))
        dest=record/'named-instruments'/f'{key[:16]}.txt';dest.parent.mkdir(exist_ok=True);dest.write_text('\f'.join(parts),encoding='utf-8')
        instruments.append(dict(name=title,canonical_affidavit_exhibit=False,label_type='named_instrument',reference=dict(paragraph=para,source_pages=[reference_page],source_sha256=g['original_referring_instrument']['source_sha256']),date=date,date_precision='month' if len(date)==7 else 'year',availability=status,source_sha256=key,source_url=r['url'],canonical_source_path=str(source),source_pages=list(range(1,len(doc)+1)),text_file=dest.relative_to(record).as_posix(),text_sha256=sha(dest),notes=note,page_extraction_audit=page_audit,review_status='pending_distinct_peer_review'))
    write(record/'named-instrument-inventory.json',dict(origin='machine_test',run_id=g['run_id'],immutable_author_source_gold_sha256=sha(record/'source-gold.json'),scope='Supplementary complete original-linked instruments. No invented own exhibit letters. The canonical author Gold has not been changed; peer reviewer must independently validate and adopt as appropriate.',instruments=instruments))
    packets=[];proceedings=Counter();jurisdictions=Counter()
    for path in sorted((O/'records').glob('*/source-gold.json')):
        gold=json.loads(path.read_text(encoding='utf-8'));views=json.loads((path.parent/'model-views.json').read_text(encoding='utf-8'));assert views['source_gold_sha256'] in {sha(x) for x in [path,path.parent/'reviewed-source-gold.json'] if x.exists()}
        assert {v['label'] for v in views['views']}=={v['label'] for v in gold['exhibits']}
        for v in views['views']: assert sha(path.parent/v['text_file'])==v['text_sha256']
        counterparts=json.loads((path.parent/'distractors.json').read_text(encoding='utf-8'));counterparts=counterparts['documents'] if isinstance(counterparts,dict) else counterparts;assert sum(v.get('same_proceeding',False) for v in counterparts)>=2
        proceedings[gold['family']]+=1;jurisdictions[gold['jurisdiction']]+=1
        packets.append(dict(record_id=path.parent.name,source_gold_path=path.as_posix(),source_gold_sha256=sha(path),labels=len(gold['exhibits']),events=len(gold['events']),model_views=len(views['views']),status='authored_pending_distinct_peer_review'))
    assert len(packets)==33 and max(proceedings.values())<=4
    write(O/'author-handoff.json',dict(origin='machine_test',run_id=g['run_id'],job_id=g['author_provenance']['job_id'],agent='/root/gold_regulatory',method='codex_collaboration',runner_call=False,authored_count=len(packets),accepted_count='Determined exclusively by distinct peer review; author does not declare acceptance.',proceeding_counts=dict(proceedings),jurisdiction_counts=dict(jurisdictions),packets=packets,model_view_quality='Availability, full content and original identity remain separate review gates. Full text is retained even when model eligibility is pending or a posted candidate does not establish the filed version. See every per-record model-views.json.',additional_named_instrument_inventory=(record/'named-instrument-inventory.json').as_posix()))
    print(json.dumps(dict(authored=len(packets),proceedings=len(proceedings),jurisdictions=dict(jurisdictions),handoff_sha256=sha(O/'author-handoff.json'))))

if __name__=='__main__': main()
