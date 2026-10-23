"""Independent tribunal review views and full-page mechanical coverage, never approval."""
from pathlib import Path
import json, hashlib, os, sys, fitz
from PIL import Image, ImageDraw

O=Path('benchmarks/local-data/affidavit-association/expansion-2/tribunals')
H=Path(os.environ['LOCALAPPDATA'])/'OpenLegalData'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    rid=sys.argv[1];r=O/'records'/rid;g=json.loads((r/'source-gold.json').read_text(encoding='utf-8'));folder=O/'review/inspection'/rid;folder.mkdir(parents=True,exist_ok=True)
    ori=g['original_referring_instrument'];bykey={ori['source_sha256']:dict(path=H/ori['canonical_source_path'],pages=set([ori['source_pages'][0],ori['source_pages'][-1]]))}
    inventory=[]
    for e in g['exhibits']:
        key=e.get('source_sha256');pages=e.get('source_pages',[])
        if not key or not pages:inventory.append(dict(label=e['label'],availability=e.get('availability'),unavailability_reason=e.get('unavailability_reason')));continue
        metadata=json.loads((O/'sources'/f'{key}.json').read_text(encoding='utf-8'))
        bykey.setdefault(key,dict(path=H/metadata['canonical_path'],pages=set()))['pages'].update([pages[0],pages[-1]]+e.get('source_cover_pages',[]))
        doc=fitz.open(H/metadata['canonical_path']);assert sha(H/metadata['canonical_path'])==key
        page_audit=[]
        for n in pages:
            pg=doc[n-1];cache=O/'source-text'/key/f'page-{n:04}.txt';extract=json.loads(cache.with_suffix('.json').read_text(encoding='utf-8'));native=pg.get_text();text=cache.read_text(encoding='utf-8');page_audit.append(dict(source_page=n,native_characters=len(native),text_characters=len(text),extraction=extract,image_count=len(pg.get_image_info()),vector_drawing_count=len(pg.get_drawings()),source_text_sha256=sha(cache)))
        start=(O/'source-text'/key/f'page-{pages[0]:04}.txt').read_text(encoding='utf-8');end=(O/'source-text'/key/f'page-{pages[-1]:04}.txt').read_text(encoding='utf-8')
        inventory.append(dict(label=e['label'],source_sha256=key,source_pages=pages,cover_pages=e.get('source_cover_pages',[]),description=e.get('description'),date=e.get('date'),first_page_text=start,last_page_text=end,page_coverage=page_audit))
    imgs=[]
    for key,info in bykey.items():
        doc=fitz.open(info['path']);pages=sorted(info['pages'])
        for offset in range(0,len(pages),16):
            selected=pages[offset:offset+16];im=Image.new('RGB',(1600,((len(selected)+3)//4)*550),'#bbb');draw=ImageDraw.Draw(im)
            for i,n in enumerate(selected):
                pix=doc[n-1].get_pixmap(dpi=85,alpha=False);page=Image.frombytes('RGB',[pix.width,pix.height],pix.samples);page.thumbnail((395,520));x=i%4*400;y=i//4*550;im.paste(page,(x,y+25));draw.text((x+5,y+5),f'{key[:8]} p{n}',fill='black')
            dest=folder/f'{key[:12]}-{offset//16}.png';im.save(dest);imgs.append(dict(file=dest.relative_to(O).as_posix(),sha256=sha(dest),source_sha256=key,original_source_pages=selected))
    out=dict(status='inspection_preparation_only_not_reviewed_or_accepted',record_id=rid,author_gold_sha256_at_preparation=sha(r/'source-gold.json'),original_instrument=ori,inventory=inventory,images=imgs)
    (folder/'inventory.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(rid,'IMAGES',len(imgs),'LABELS',len(inventory))

if __name__=='__main__':main()
