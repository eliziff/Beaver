"""Bind accepted gold to canonical bytes, approving receipts and inspected outputs."""
from collections import Counter
import hashlib,re
import fitz
import regulatory_expand as w

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def identity(g):
    name=g.get('deponent','').casefold().strip()
    name=re.sub(r'^(?:(?:dr|chief|grand chief|reverend|rev|professor)\.?\s+)+','',name)
    return re.sub(r'\W','',name),g.get('sworn_date','')

def main():
    summary=w.read_json(w.OUT/'summary.json');baseline={};seen={};sources=[];failures=[];cases=Counter();low=0;canonical_hashes={}
    for root in [w.HOME/'benchmarks/court-record-exhibits/records',w.ROOT/'benchmarks/court-record-exhibits/records']:
        for path in root.glob('*/gold.json'):
            gold=w.read_json(path);key=identity(gold)
            if key[0] and key[1]:baseline.setdefault(key,set()).add(path.parent.name)
    for rid in summary['accepted']:
        dest=w.OUT/'records'/rid;gold=w.read_json(dest/'gold.json');source=w.read_json(dest/'source.json');split=w.read_json(dest/'split.json');errors=w.verify.check(str(dest));key=identity(gold)
        if key[0] and key[1] and key in baseline:errors.append('Duplicate baseline deponent/execution: '+str(baseline[key]))
        if key[0] and key[1] and key in seen:errors.append('Duplicate new deponent/execution: '+seen[key])
        seen[key]=rid
        canonical=w.HOME/source['canonical_source_path'];actual=canonical_hashes.setdefault(source['source_sha256'],digest(canonical))
        if actual!=source['source_sha256']:errors.append('Canonical source hash mismatch')
        receipt_path=w.OUT/gold['gold_provenance']['review_receipt'];receipt=w.read_json(receipt_path);completed=[a for a in receipt['attempts'] if a['status']=='complete'];image_hashes={h for a in completed for h in a.get('image_sha256s',[])}
        if not completed:errors.append('No completed independent review')
        response=w.read_json(receipt_path.with_name('response.json'));approved=any(r.get('record_id')==rid and r.get('accept') for r in response['records']) if 'records' in response else response.get('accept')
        if not approved:errors.append('Independent response did not approve this record')
        visual='/visual-review/' in gold['gold_provenance']['review_receipt']
        selection=w.read_json(dest/'review-selection.json') if (dest/'review-selection.json').exists() else dict(source_sha256=source['source_sha256'],complete_affidavit_source_pages=split['affidavit_pages'],exhibits=[])
        if visual:
            selection=dict(source_sha256=source['source_sha256'],complete_affidavit_source_pages=split['affidavit_pages'],original_image_pages=list(range(1,source['source_pages']+1)),exhibits=[])
            for n in selection['original_image_pages']:
                image=w.OUT/'review'/rid/f'original-{n:04}.jpg'
                if not image.exists() or digest(image) not in image_hashes:errors.append(f'Original source image {n} absent approving receipt')
        else:
            original_pages=selection.get('original_image_pages') or sorted(set(split['affidavit_pages']+source.get('source_review_extra_pages',[])+[e.get('cover_page') or e.get('stamp_page') or e['source_pages'][0] for e in split['exhibits']]))
            with fitz.open(canonical) as original:
                for n in original_pages:
                    rendered=hashlib.sha256(original[n-1].get_pixmap(matrix=fitz.Matrix(1.2,1.2)).tobytes('jpg')).hexdigest()
                    if rendered not in image_hashes:errors.append(f'Original selected source image {n} differs from approving input')
            selection['original_image_pages']=original_pages
        for ex in split['exhibits']:
            path=dest/'files'/ex['file'];sha=digest(path)
            if visual:inspected=list(range(1,len(ex['source_pages'])+1))
            else:
                entry=next((x for x in selection['exhibits'] if x['file']==ex['file']),None)
                if entry is None:errors.append('Missing selected-output provenance: '+ex['file']);continue
                if entry['pdf_sha256']!=sha:errors.append('Output PDF changed since independent review: '+ex['file'])
                inspected=entry['inspected_output_image_pages']
            with fitz.open(path) as pdf:
                for n in inspected:
                    rendered=hashlib.sha256(pdf[n-1].get_pixmap(matrix=fitz.Matrix(1.4 if visual else 1.2,1.4 if visual else 1.2)).tobytes('jpg')).hexdigest()
                    if rendered not in image_hashes:errors.append(f'Current {ex["file"]} page{n} differs from approving image inputs')
            if visual:selection['exhibits'].append(dict(file=ex['file'],pdf_sha256=sha,text_selection=dict(mode='full'),inspected_output_image_pages=inspected,corresponding_source_pages=ex['source_pages']))
        w.atomic_json(dest/'review-selection.json',selection)
        if split.get('divider_pages'):errors.append('Accepted record has omitted divider pages requiring explicit visual audit')
        if (dest/'distractors.json').exists():
            for item in w.read_json(dest/'distractors.json'):
                if item['review_status']!='accepted' or not isinstance(item.get('same_proceeding'),bool):errors.append('Counterpart review/relationship incomplete')
                if digest(dest/item['file'])!=item['sha256']:errors.append('Counterpart hash changed')
                peer_source=item.get('canonical_source_path')
                if not peer_source and item.get('source_record_id'):
                    peer=dest.parent/item['source_record_id']/'source.json'
                    if peer.exists():peer_source=w.read_json(peer)['canonical_source_path']
                if peer_source and digest(w.HOME/peer_source)!=item['source_sha256']:errors.append('Counterpart canonical source hash mismatch')
                inspected=next((entry for entry in selection.get('counterparts',[]) if entry['file']==item['file']),None)
                if not inspected:errors.append('Missing counterpart selected-image provenance');continue
                with fitz.open(dest/item['file']) as pdf:
                    for n in inspected['inspected_output_image_pages']:
                        rendered=hashlib.sha256(pdf[n-1].get_pixmap(matrix=fitz.Matrix(1.2,1.2)).tobytes('jpg')).hexdigest()
                        if rendered not in image_hashes:errors.append(f'Counterpart {item["file"]} page{n} differs from approving input')
        case=gold.get('jurisdiction','').casefold()+':'+re.sub(r'\W','',gold.get('court_file','').casefold());cases[case]+=1;low+=len(gold['exhibits'])<=2
        if errors:failures.append(dict(record_id=rid,errors=errors))
        sources.append(dict(record_id=rid,source_url=source['url'],source_sha256=source['source_sha256'],canonical_source_path=source['canonical_source_path'],affidavit_pages=split['affidavit_pages'],gold_sha256=digest(dest/'gold.json'),split_sha256=digest(dest/'split.json'),review_selection_sha256=digest(dest/'review-selection.json'),review_receipt=gold['gold_provenance']['review_receipt'],exhibits=len(gold['exhibits']),events=len(gold['events'])))
    if cases and max(cases.values())>8:failures.append(dict(reason='More than8 records from one normalized proceeding',cases=dict(cases)))
    if low>8 or (sources and low/len(sources)>.25):failures.append(dict(reason='Low-exhibit balance exceeded',count=low))
    audit=dict(origin='machine_test',run_id=w.RUN,accepted=len(sources),canonical_sources=len(canonical_hashes),exhibits=sum(s['exhibits'] for s in sources),events=sum(s['events'] for s in sources),normalized_proceedings=dict(cases),low_exhibit_records=low,model_call_attempts=summary['model_call_attempts'],failures=failures,source_and_current_output_image_receipt_checks='passed' if not failures else 'failed')
    w.atomic_json(w.OUT/'accepted-sources.json',sources);w.atomic_json(w.OUT/'quality-audit.json',audit);print(audit)
    if failures:raise SystemExit(1)

if __name__=='__main__':main()
