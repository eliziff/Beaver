"""Render original boundary pages for human visual review; never alter source or model text."""
from PIL import Image,ImageDraw
from second_canada_author import *

def main():
    specs=json.loads((OUT/'author-specs.json').read_text(encoding='utf-8'))
    requested=[];seen=set()
    for s in specs:
        r=source(s['source'])
        for page in s.get('visual_pages',[]):
            key=(r['sha256'],page)
            if key not in seen: requested.append((r,page));seen.add(key)
    evidence=[]
    for batch in range(0,len(requested),12):
        sheet=Image.new('RGB',(1800,3240),'#eeeeee');draw=ImageDraw.Draw(sheet)
        items=requested[batch:batch+12]
        for k,(r,page) in enumerate(items):
            with fitz.open(r['canonical_path']) as doc:pix=doc[page-1].get_pixmap(dpi=72,alpha=False)
            im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples);im.thumbnail((590,780))
            x=(k%3)*600;y=(k//3)*810
            sheet.paste(im,(x,y+25));draw.text((x+5,y+5),r['sha256'][:12]+' physical '+str(page),fill='black')
        path=OUT/'views'/f'boundary-sheet-{batch//12+1:02}.png';sheet.save(path)
        evidence.append(dict(file=str(path.relative_to(OUT)),sha256=digest(path.read_bytes()),pages=[dict(source_sha256=r['sha256'],page=p) for r,p in items],status='rendered_pending_actual_visual_inspection'))
    dump(OUT/'boundary-view-manifest.json',dict(sheets=evidence))
    print(json.dumps([e['file'] for e in evidence]))
if __name__=='__main__':main()
