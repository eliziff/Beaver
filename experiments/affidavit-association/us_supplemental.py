"""Prepare source views and pending gold for direct Codex collaboration; no inference runner."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import fitz
import us_author as u


OUT=u.OUT.parent/'supplemental-us'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare(ids):
    items={x['case']['record']+'-entry-'+str(x['entry']):x for x in u.sources()}
    connection=u.cs.connect()
    for rid in ids:
        item=items[rid]
        folder=OUT/'work'/rid
        folder.mkdir(parents=True,exist_ok=True)
        parts=[]
        for ordinal,obj in enumerate([item.get('main') or item['objects'].get('0') or item['objects'].get(0)]+item['parts']):
            url='https://com-courtlistener-storage.s3.us-west-2.amazonaws.com/'+obj['key']
            digest,status=u.cs.fetch(connection,url,{'collection':'court-record-sources','jurisdiction':'us','kind':'court-record',
                'label':item['case']['title']+' '+str(item['entry']),'provenance':'Direct collaboration gold source preparation '+datetime.now(timezone.utc).isoformat()},refresh=False)
            if not digest:
                raise ValueError(url+': '+str(status))
            path=u.cs.HOME/connection.execute('select path from files where sha256=?',(digest,)).fetchone()[0]
            attachment=0 if ordinal==0 else int(obj['key'].rsplit('.',2)[1])
            with fitz.open(path) as pdf:
                text='\n'.join(f'[source page {i+1}]\n{p.get_text()}' for i,p in enumerate(pdf))
                text_path=folder/f'original-{attachment}.txt'
                text_path.write_text(text,encoding='utf8')
                images=[]
                for index in sorted({0,len(pdf)-1}):
                    image=folder/f'original-{attachment}-page-{index+1}.png'
                    page=pdf[index]
                    page.get_pixmap(matrix=fitz.Matrix(1400/page.rect.width,1400/page.rect.width),alpha=False).save(image)
                    images.append({'page':index+1,'path':str(image.relative_to(OUT)),'sha256':sha(image)})
                parts.append({'attachment':attachment,'url':url,'sha256':digest,'path':str(path),'pages':len(pdf),
                    'text_path':str(text_path.relative_to(OUT)),'text_sha256':sha(text_path),'images':images})
        u.dump(folder/'sources.json',parts)
        u.dump(folder/'item.json',item)
        print(rid,[(p['attachment'],p['pages'],Path(OUT/p['text_path']).stat().st_size) for p in parts],flush=True)


def readable(rid, attachments):
    """Retain replayable full-page OCR views for scan-only source authoring."""
    folder=OUT/'work'/rid
    parts=json.loads((folder/'sources.json').read_text(encoding='utf8'))
    for part in parts:
        if part['attachment'] not in attachments:
            continue
        if part.get('readable_path') and len(part['images'])==part['pages'] and (OUT/part['readable_path']).exists():
            continue
        views=[]
        texts=[]
        with fitz.open(part['path']) as pdf:
            for index,page in enumerate(pdf):
                path=folder/f"original-{part['attachment']}-page-{index+1}.png"
                page.get_pixmap(matrix=fitz.Matrix(1400/page.rect.width,1400/page.rect.width),alpha=False).save(path)
                views.append({'page':index+1,'path':str(path.relative_to(OUT)),'sha256':sha(path)})
                text=page.get_text()
                if len(text.split())<40:
                    text=u.split.tesseract_cli(page)
                texts.append(f'[source page {index+1}]\n{text}')
        path=folder/f"readable-{part['attachment']}.txt"
        path.write_text('\n'.join(texts),encoding='utf8')
        part.update(readable_path=str(path.relative_to(OUT)),readable_sha256=sha(path),images=views)
        print(rid,part['attachment'],len('\n'.join(texts)),flush=True)
    u.dump(folder/'sources.json',parts)


if __name__=='__main__':
    import sys
    prepare(sys.argv[1:])
