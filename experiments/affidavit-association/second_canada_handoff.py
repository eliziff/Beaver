"""Freeze author inventory and mechanical source checks without self-acceptance."""
from second_canada_author import *
from collections import Counter,defaultdict

def main():
    status=json.loads((OUT/'status.json').read_text());ids=status['authored_records'];assert len(ids)==34
    records={rid:json.loads((OUT/'records'/rid/'source-gold.json').read_text(encoding='utf-8')) for rid in ids}
    families=defaultdict(list)
    for rid,g in records.items():families[g['family']].append(rid)
    errors=[];checks=0;inventory=[]
    phase3=json.loads((OUT/'views/phase3-manifest.json').read_text())
    for rid,g in records.items():
        d=OUT/'records'/rid;v=json.loads((d/'model-views.json').read_text());sh=digest((d/'source-gold.json').read_bytes())
        assert v['source_gold_sha256']==sh
        assert g['country']=='CA' and g['independent_source_review']['status']=='pending'
        assert digest((d/'affidavit.txt').read_bytes())==g['referring_document']['text_sha256']
        for x in v['views']:assert digest((d/x['text_file']).read_bytes())==x['text_sha256']
        src=json.loads((d/'source.json').read_text());ps=pages_for(source(src['sha256']))
        for e in g['events']:
            assert e['quote'] in ps[e['source_pages'][0]-1];checks+=1
        for e in g['exhibits']:
            for ref in e['references']:
                assert ref['quote'] in ps[ref['source_pages'][0]-1];checks+=1
        # Full peer bodies are actual source documents. Never turn a positive or its
        # overlapping source segment into a fabricated negative.
        counterparts=[]
        for peerid in families[g['family']]:
            if peerid==rid:continue
            peer=records[peerid];part=(peer['referring_document'].get('source_files') or peer['referring_document'].get('parts'))[0]
            overlap=any(e.get('source_sha256')==part['sha256'] and set(e.get('source_pages',[]))&set(part['pages']) for e in g['exhibits'])
            if overlap:continue
            name='peer-'+digest(peerid.encode())[:12]+'.txt';sha=textfile(d/'distractors'/name,(OUT/'records'/peerid/'affidavit.txt').read_text(encoding='utf-8'))
            counterparts.append(dict(record_id=peerid,file='distractors/'+name,text_sha256=sha,source_sha256=part['sha256'],source_url=part['url'],source_pages=part['pages'],same_proceeding=True,role='peer_referring_document',review_status='pending_independent_review',reason='Complete distinct referring instrument in same proceeding; no source-page overlap with this record’s positive targets.'))
        dump(d/'peer-counterparts.json',dict(review_status='pending_independent_review',documents=counterparts,coverage='Two or more materialized peers' if len(counterparts)>=2 else 'Limited public peer coverage; do not invent negatives or relabel own positives'))
        inventory.append(dict(record_id=rid,record_path='records/'+rid,source_gold_path='records/'+rid+'/source-gold.json',source_gold_sha256=sh,body_text_sha256=digest((d/'affidavit.txt').read_bytes()),model_views_sha256=digest((d/'model-views.json').read_bytes()),country='CA',jurisdiction=g['jurisdiction'],family=g['family'],exhibits=len(g['exhibits']),events=len(g['events']),unavailable_labels=[e['label'] for e in g['exhibits'] if not e.get('source_pages')],materialized_peer_count=len(counterparts)))
    corrections=[dict(record_id='ca2-fic-rigby',field='sworn_date',author_value='2024-11-04',source_supported_value='2024-11-08',evidence='Original physical2 jurat and physical3/7 certifications; views/rigby-jurat-detail.png, source SHA722b8154. OCR misread handwritten8 as4. Reviewer must correct in separate reviewed-source-gold.json.'),dict(record_id='ca2-on-ford-brandys-april2017',field='source_cover_pages',source_supported_value='Physical67 is certification for F, not E. E content64–66 remains correct; F content68–70 remains correct.',evidence='Original physical67 viewed in phase3-boundaries-10.png. Reviewer correct cover-page ownership in separate product.'),dict(record_id='ca2-ab-song-march2025',field='source_discrepancies',source_supported_value='Original body physical1 visibly says September26,2029; actual report B physical87 is September26,2019. This is genuine source discrepancy, not merely extraction uncertainty.',evidence='phase3-boundaries-7.png, original body physical1; original B native title physical87.'),dict(record_id='ca2-on-sixnations-saul',field='model_view_C',source_supported_value='Use accurate full14page PDFium source render/OCR from parent source-render-check; do not use garbled MuPDF-derived C text as faithful view.',evidence='../source-render-check/sngr-pdfium-{36..49}.png and matching.txt with parent source-bound receipt.'),dict(record_id='ca2-on-sixnations-hill',field='model_view_H',source_supported_value='Original red booklet cover physical171 is rotated; transcribe complete legible text after source-image rotation, not garbled raw orientation OCR.',evidence='views/sixnations-hill-171.png actually inspected; no underlying booklet pages attached.')]
    dump(OUT/'author-corrections-for-peer-review.json',dict(provenance=PROVENANCE,scope='Author self-detected corrections proposed for independent adjudication; frozen author Gold remains unchanged',corrections=corrections))
    dump(OUT/'author-view-evidence.json',dict(provenance=PROVENANCE,actual_visual_views=phase3,scope='All12phase3contact sheets actually inspected; source boundary/certification/jurat verification only, not a claim of full attachment merits image reading',additional_detail=dict(file='views/rigby-jurat-detail.png',sha256=digest((OUT/'views/rigby-jurat-detail.png').read_bytes()))))
    findings=['Older author packets use referring_document.parts instead of canonical source_files; peer canonicalization required without rewriting frozen author files.','Older packets use exhibit document_date/event exhibit_labels; peer must use canonical date/exhibits fields and reconcile duplicate source inventories.','Non-affidavit events need submission/document attribution rather than helper default Affiant statement.','Human-written descriptions and event summaries need spacing cleanup in some author packets; literal source quotations remain unchanged unless image-verified OCR repair is audited.','Full text views retain intrinsic page contents; inline outer exhibit certifications and assignment text still need exact source-audited removal in reviewed model views. Do not broad-regex away document titles, dates or nested labels.','No physical anonymous PDF exports supplied; text-only views bind canonical originals.','Every source-labelled target retained even where unavailable; named court-instrument alias queries are outside current exhibit-label parser and must not be invented as letters.','Same-proceeding peer coverage is incomplete for single-record families; own near-twin targets remain positive competitors, never counterfeit sibling negatives.','Gold source quotes bind native/OCR transcripts; source-image review should repair OCR errors before acceptance, retaining proposed/original text provenance.']
    counts=dict(records=len(inventory),proceedings=len(families),jurisdictions=dict(Counter(g['jurisdiction'] for g in records.values())),exhibits=sum(x['exhibits'] for x in inventory),events=sum(x['events'] for x in inventory),literal_source_quote_checks=checks,max_per_proceeding=max(map(len,families.values())))
    assert counts['max_per_proceeding']<=4
    manifest=dict(provenance=PROVENANCE,stage='author_complete_pending_independent_review',frozen_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),counts=counts,records=inventory,source_gold_paths={x['record_id']:x['source_gold_path'] for x in inventory},excluded_records=json.loads((OUT/'excluded-records.json').read_text()),independently_accepted=[],review_work=findings,correction_receipt='author-corrections-for-peer-review.json')
    dump(OUT/'frozen-source-gold.json',manifest)
    status.update(stage=manifest['stage'],counts=counts,author_manifest='frozen-source-gold.json',independently_accepted=[]);dump(OUT/'status.json',status)
    print(json.dumps(counts));print('manifest_sha256',digest((OUT/'frozen-source-gold.json').read_bytes()))
if __name__=='__main__':main()
