"""Mechanically enrich sparse training text without changing reviewed PDFs or gold."""
import hashlib,os,re,subprocess
from datetime import datetime,timezone
from pathlib import Path
import fitz
import regulatory_expand as w

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def blocks(text,count):
    matches=list(re.finditer(r'(?m)^\[page (\d+)\]\s*$',text))
    if len(matches)!=count or [int(m[1]) for m in matches]!=list(range(1,count+1)):raise ValueError('Unrecognized page-marked text; no overwrite')
    return [text[m.end():matches[i+1].start() if i+1<len(matches) else len(text)].strip() for i,m in enumerate(matches)]

def main():
    os.environ.setdefault('OMP_THREAD_LIMIT','1')
    exe=os.environ.get('TESSERACT_EXE') or next((p for p in [r'C:\Program Files\Tesseract-OCR\tesseract.exe'] if Path(p).exists()),'tesseract')
    version=subprocess.run([exe,'--version'],capture_output=True,text=True,check=True).stdout.splitlines()[0]
    total_pages=total_files=0;issues=[]
    for rid in w.read_json(w.OUT/'summary.json')['accepted']:
        dest=w.OUT/'records'/rid;gold_hash=digest(dest/'gold.json');aff_hash=digest(dest/'affidavit.txt');manifest=dest/'ocr-enrichment.json';history=w.read_json(manifest) if manifest.exists() else dict(origin='machine_test',run_id=w.RUN,method='Post-review mechanical visible-page OCR for text-only retrieval training; historical model review inputs remain unchanged in receipts and review-selection.json.',engine=version,files=[])
        paths=list((dest/'files').glob('*.pdf'))+list((dest/'distractors').glob('*.pdf'))
        for path in paths:
            txt=path.with_suffix('.txt');old=txt.read_text(encoding='utf-8');pdf_hash=digest(path)
            with fitz.open(path) as pdf:
                try:parts=blocks(old,len(pdf))
                except ValueError as exc:issues.append(dict(record_id=rid,file=path.relative_to(dest).as_posix(),reason=str(exc)));continue
                changes=[]
                for i,page in enumerate(pdf):
                    words=len(parts[i].split())
                    if words>=30:continue
                    candidate=w.split.tesseract_cli(page).strip()
                    if len(candidate.split())>=max(3,words+3) and len(re.findall(r'\b[A-Za-z]{2,}\b',candidate))>=2:
                        changes.append(dict(output_page=i+1,old_words=words,new_words=len(candidate.split())));parts[i]=candidate
                if not changes:continue
                before=digest(txt);w.atomic_write(txt,'\n'.join(f'[page {i+1}]\n{part}\n' for i,part in enumerate(parts)).encode());assert digest(path)==pdf_hash
                history['files'].append(dict(file=path.relative_to(dest).as_posix(),pdf_sha256=pdf_hash,old_text_sha256=before,text_sha256=digest(txt),pages=changes,recorded_at_utc=datetime.now(timezone.utc).isoformat()));w.atomic_json(manifest,history);total_pages+=len(changes);total_files+=1
                print(rid,path.name,'enriched',len(changes),'pages',flush=True)
        assert digest(dest/'gold.json')==gold_hash and digest(dest/'affidavit.txt')==aff_hash,'Gold/affidavit anchor text must remain unchanged'
    sparse=[]
    for rid in w.read_json(w.OUT/'summary.json')['accepted']:
        dest=w.OUT/'records'/rid
        for path in list((dest/'files').glob('*.txt'))+list((dest/'distractors').glob('*.txt')):
            text=re.sub(r'\[page \d+\]','',path.read_text(encoding='utf-8'));words=len(text.split())
            if words<5:sparse.append(dict(record_id=rid,file=path.relative_to(dest).as_posix(),words=words,limitation='Very little visible OCR text; a pure text embedding cannot use uncaptioned visual content.'))
    result=dict(origin='machine_test',run_id=w.RUN,engine=version,files_changed_this_pass=total_files,pages_enriched_this_pass=total_pages,issues=issues,remaining_sparse_files=sparse,recorded_at_utc=datetime.now(timezone.utc).isoformat());w.atomic_json(w.OUT/'ocr-enrichment-summary.json',result);print(result)
    if issues:raise SystemExit(1)

if __name__=='__main__':main()
