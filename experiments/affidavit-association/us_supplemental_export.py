"""Materialize pending direct-source annotations without inference or acceptance."""
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
import sys

import fitz
import us_author as u
from us_supplemental import OUT


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def export(rid,metadata_only=False):
    work=OUT/'work'/rid
    prepared=json.loads((work/'sources.json').read_text(encoding='utf8'))
    parts=[{**p,'text':(OUT/p['text_path']).read_text(encoding='utf8'),
            'images':[str(OUT/i['path']) for i in p['images']]} for p in prepared]
    item=json.loads((work/'item.json').read_text(encoding='utf8'))
    proposal=json.loads((work/'annotation.json').read_text(encoding='utf8'))
    u.OUT=OUT
    target=OUT/'records'/rid
    target.mkdir(parents=True,exist_ok=True)
    error=None
    previous_path=target/'candidate-gold.json'
    previous=json.loads(previous_path.read_text(encoding='utf8')) if previous_path.exists() else {}
    if metadata_only:
        error=previous.get('view_unavailable_reason')
    elif not item.get('view_unavailable'):
        try:
            u.build(rid,item,parts,proposal,None,work)
        except Exception as exc:
            error=str(exc)
    else:
        error=item['view_unavailable']
    candidate=target/'candidate-gold.json'
    projection=json.loads(candidate.read_text(encoding='utf8')) if candidate.exists() else {}
    gold=json.loads(proposal['gold_json'])
    projection_files={e['label']:e.get('file') for e in projection.get('exhibits',[])}
    for e in gold['exhibits']:
        if projection_files.get(e['label']):e['file']=projection_files[e['label']]
    gold['family']=item['case']['prefix']
    gold['hardness']=['same_proceeding_distractors','source_attachment_label_disambiguation','conflicting_dates_or_nested_references']
    lookup={p['attachment']:p for p in prepared}
    original={e['label']:e for e in json.loads(proposal['gold_json'])['exhibits']}
    source_exhibits=[]
    for label,exhibit in original.items():
        selection=[m for m in proposal['mapping'] if m['label']==label]
        entry={k:v for k,v in exhibit.items() if k!='file'}
        entry['source_files']=[{'attachment':m['attachment'],'sha256':lookup[m['attachment']]['sha256'],
            'url':lookup[m['attachment']]['url'],'path':lookup[m['attachment']]['path'],
            'pages':list(range(m['first'],m['last']+1)),'cover_pages':[m['first']] if m['cover'] else []}
            for m in selection]
        texts=[]
        for m in selection:
            p=lookup[m['attachment']]
            text=(OUT/p.get('readable_path',p['text_path'])).read_text(encoding='utf8')
            pages=re.split(r'\[(?:source )?page (\d+)\]\s*',text)
            for i in range(1,len(pages),2):
                page=int(pages[i])
                if m['first']+int(m['cover'])<=page<=m['last']:
                    texts.append(f"[source {p['sha256']} page {page}]\n{pages[i+1]}")
        text_dir=target/'source-texts';text_dir.mkdir(exist_ok=True)
        text_path=text_dir/f'exhibit-{label}.txt'
        text_path.write_text('\n'.join(texts),encoding='utf8')
        entry.update(source_text=str(text_path.relative_to(OUT)),source_text_sha256=sha(text_path),review_status='pending')
        source_exhibits.append(entry)
    gold['source_exhibits']=source_exhibits
    gold['source_attachments']=[{'attachment':p['attachment'],'sha256':p['sha256'],'url':p['url'],
        'path':p['path'],'pages':p['pages'],'source_text':p.get('readable_path',p['text_path']),
        'source_text_sha256':p.get('readable_sha256',p['text_sha256'])} for p in prepared]
    gold['source_referring_document']={'sha256':prepared[0]['sha256'],'url':prepared[0]['url'],
        'path':prepared[0]['path'],'pages':item.get('affidavit_pages',list(range(1,prepared[0]['pages']+1)))}
    gold['review_status']='pending'
    gold['view_status']='unavailable' if error else 'pending_independent_fidelity_review'
    if error:
        gold['view_unavailable_reason']=error
    gold['gold_provenance']={'origin':'machine_test','method':'codex_collaboration','agent':'/root/gold_us',
        'task':'/root/gold_us','run_id':'b8f0b04d-f69e-49ce-aed9-6d48581face5',
        'job_id':'7856f4ae-3a74-447d-a085-48ff905f85e1','label':'Codex source-authored gold candidate (hard tier)',
        'human_review_status':'not_human_reviewed','recorded':datetime.now(timezone.utc).isoformat(),
        'author_receipt':str((target/'author_receipt.json').relative_to(OUT))}
    u.dump(candidate,gold)
    u.dump(target/'source.json',{'source_documents':gold['source_attachments'],'referring_document':gold['source_referring_document'],
        'origin':'machine_test','method':'codex_collaboration','record_id':rid})
    if not (target/'split.json').exists():
        u.dump(target/'split.json',{'record_id':rid,'view_status':'unavailable','reason':error,'exhibits':[]})
    if not (target/'affidavit.txt').exists():
        primary=prepared[0]
        text=(OUT/primary.get('readable_path',primary['text_path'])).read_text(encoding='utf8')
        (target/'affidavit.txt').write_text(text,encoding='utf8')
    view_dir=target/'review-views';view_dir.mkdir(exist_ok=True)
    outputs=[]
    for pdf in [target/'affidavit.pdf',*sorted((target/'files').glob('*.pdf'))]:
        if not pdf.exists():
            continue
        with fitz.open(pdf) as doc:
            for index,page in enumerate(doc):
                path=view_dir/f'{pdf.stem}-page-{index+1}.png'
                if not metadata_only or not path.exists():
                    page.get_pixmap(matrix=fitz.Matrix(1200/page.rect.width,1200/page.rect.width),alpha=False).save(path)
                outputs.append({'path':str(path.relative_to(OUT)),'sha256':sha(path),'pdf_sha256':sha(pdf),'page':index+1})
    u.dump(target/'author_receipt.json',{'origin':'machine_test','method':'codex_collaboration',
        'agent':'/root/gold_us','task':'/root/gold_us','job_id':'7856f4ae-3a74-447d-a085-48ff905f85e1',
        'started':'2026-10-22T13:52:20.480404+00:00','finished':datetime.now(timezone.utc).isoformat(),
        'review_status':'pending','source_views':prepared,'materialized_review_inputs':outputs,
        'annotation_sha256':sha(work/'annotation.json'),'candidate_sha256':sha(candidate),
        'view_claim':'Native and OCR full text and specifically viewed image evidence are author inputs; generated all-page images are retained for independent review, not claimed independently reviewed by the author.'})
    print(rid,len(gold['source_exhibits']),gold['view_status'],flush=True)


if __name__=='__main__':
    for rid in sys.argv[1:]:
        if rid!='--metadata-only':export(rid,'--metadata-only' in sys.argv)
