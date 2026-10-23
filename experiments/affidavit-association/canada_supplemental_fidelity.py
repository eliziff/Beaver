"""Full-page source/output rendering proof outside precisely identified filing wrappers."""
import pathlib,json,hashlib,fitz,re,sys
from PIL import Image,ImageChops,ImageDraw
import canada_supplemental_author as a
O=a.OUT
def main():
    fitz.TOOLS.mupdf_display_errors(False);fitz.TOOLS.mupdf_display_warnings(False);summary=[]
    for rid,spec in a.SPECS.items():
        target=O/'records'/rid;review=target/'render-review';review.mkdir(exist_ok=True);parts=json.loads((O/'pending'/rid/'sources.json').read_text(encoding='utf-8'));by={p['attachment']:p for p in parts};spl=json.loads((target/'split.json').read_text(encoding='utf-8'));exs={e['label']:e for e in spl['exhibits']};results=[];previews=[]
        for label,att,first,cover,para,kind,desc,*last in spec['ex']:
            end=last[0] if last else by[att]['pages'];pages=list(range(first+int(cover),end+1));path=target/'files'/exs[label]['file']
            with fitz.open(by[att]['path']) as source,fitz.open(path) as output:
                assert len(output)==len(pages)
                for i,n in enumerate(pages):
                    original=source[n-1];clean=output[i];assert original.rect==clean.rect
                    p=original.get_pixmap(alpha=False);q=clean.get_pixmap(alpha=False);im=Image.frombytes('RGB',(p.width,p.height),p.samples);out=Image.frombytes('RGB',(q.width,q.height),q.samples);diff=ImageChops.difference(im,out);mask=Image.new('L',im.size,0);draw=ImageDraw.Draw(mask);allowed=[]
                    for block in original.get_text('dict')['blocks']:
                        for line in block.get('lines',[]):
                            text=''.join(s['text'] for s in line['spans']);r=fitz.Rect(line['bbox'])
                            wrapper=a.split.ECF_HEADER.match(text) or ((r.y0<20 or r.y1>original.rect.height-20) and (text.strip()=='Dockets.Justia.com' or re.fullmatch(r'Doc\.\s*\d+(?:\s+Att\.\s*\d+)?',text.strip()) or (' v. ' in text and r.y0<1)))
                            if wrapper:
                                r=r+(-1,-1,1,1);draw.rectangle(tuple(r),fill=255);allowed.append({'text':text,'rect':list(r)})
                    diff.paste((0,0,0),mask=mask);bbox=diff.getbbox();row={'label':label,'output_page':i+1,'source_page':n,'source_sha256':by[att]['sha256'],'output_pdf_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'outside_wrapper_pixel_difference_bbox':bbox,'allowed_native_filing_wrapper_rects':allowed,'original_render_sha256':hashlib.sha256(p.samples).hexdigest(),'output_render_sha256':hashlib.sha256(q.samples).hexdigest()};results.append(row)
                    if i in {0,len(pages)-1} or bbox:
                        name=f'{label}-{n:03}-source.png';im.save(review/name);outname=f'{label}-{n:03}-output.png';out.save(review/outname);row['original_image']='render-review/'+name;row['output_image']='render-review/'+outname
                        if i in {0,len(pages)-1}:
                            tile=Image.new('RGB',(610,430),'#ddd');d=ImageDraw.Draw(tile);im.thumbnail((300,405));out.thumbnail((300,405));tile.paste(im,(0,22));tile.paste(out,(310,22));d.text((4,4),f'{label} original page{n}',fill='black');d.text((314,4),f'output page{i+1}',fill='black');previews.append(tile)
        contact=Image.new('RGB',(1220,430*((len(previews)+1)//2)),'white')
        for i,tile in enumerate(previews):contact.paste(tile,((i%2)*610,(i//2)*430))
        contact.save(review/'contact.png');a.dump(target/'render-fidelity.json',{'method':'Every eligible physical content page rendered at72dpi; exact source/output pixels compared outside only identified native filing wrappers. Filed-date identity separately checked144dpi by operator audit. Unexplained differences require independent source review; never silently waived.','pages':results});bad=[x for x in results if x['outside_wrapper_pixel_difference_bbox']];summary.append({'record_id':rid,'pages':len(results),'unexplained_page_differences':len(bad)});print(summary[-1],flush=True)
    a.dump(O/'render-fidelity-summary.json',summary)
if __name__=='__main__':main()
