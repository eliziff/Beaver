"""Render explicit source boundary selections for author visual inspection."""
from pathlib import Path
import json,sys,fitz
from PIL import Image,ImageDraw
O=Path('benchmarks/local-data/affidavit-association/expansion-2/regulatory')
def main():
 p=json.loads((O/'plans'/f'{sys.argv[1]}.json').read_text(encoding='utf-8'));r=next(r for r in json.loads((O/'acquisitions.json').read_text()) if p['source_sha256'] in r.get('output',''));d=fitz.open(r['output'].strip().split('\t')[-1]);pages=p['inspected_image_pages']
 for batch in range(0,len(pages),20):
  pp=pages[batch:batch+20];c=Image.new('RGB',(1800,((len(pp)+4)//5)*500),'#bbb');dr=ImageDraw.Draw(c)
  for i,n in enumerate(pp):
   pix=d[n-1].get_pixmap(dpi=70,alpha=False);im=Image.frombytes('RGB',[pix.width,pix.height],pix.samples);im.thumbnail((355,470));x=i%5*360;y=i//5*500;c.paste(im,(x,y+25));dr.text((x+5,y+5),str(n),fill='black')
  out=O/f'{sys.argv[1]}-contact-{batch//20}.png';c.save(out);print(out)
if __name__=='__main__':main()
