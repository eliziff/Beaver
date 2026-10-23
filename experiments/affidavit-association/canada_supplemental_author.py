"""Materialize direct Codex source-authored proposals, never accepted gold or model calls."""
import pathlib,json,re,hashlib,subprocess,sys,datetime,fitz,os,base64
from canada_supplemental import OUT
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'benchmarks/court-record-exhibits'))
import split
SPECS={
'us-cand-overture-google-entry-26':dict(who='Michael S. Kwun',date='2002-10-07',title='Declaration supporting extension of initial invalidity contentions',ex=[('5',5,1,0,6,'letter','September17 Kwun to Berenzweig follow-up'),('6',6,1,0,7,'letter','September19 Berenzweig to Kwun'),('7',7,1,0,7,'letter','September19 Kwun response to Berenzweig'),('8',8,1,0,8,'letter','September24 Berenzweig to Kwun')],ev=[(3,'2002-08-19','Initial joint case-management statement filed',[]),(4,'2002-09-16','Overture served preliminary infringement contentions',[]),(6,'2002-09-17','Counsel discussed supplementing contentions and Kwun sent follow-up letter',['5']),(7,'2002-09-19','Opposing counsel exchanged letters',['6','7']),(8,'2002-09-23','Counsel discussed the issue and a further letter was promised',[]),(8,'2002-09-24','Kwun received further opposing letter',['8']),(9,'2002-09-27','Counsel agreed they had reached an impasse',[])]),
'us-cand-overture-google-entry-37':dict(who='Michael S. Kwun',date='2002-12-12',title='Declaration supporting reply regarding initial invalidity contentions',ex=[('A',1,1,0,7,'letter','October8 opposing-counsel letter'),('D',4,1,0,11,'webpage','SearchUP screenshot, underlying Davis exhibit4'),('E',5,1,0,12,'webpage','Screenshot underlying Davis exhibit5'),('F',6,1,0,13,'webpage','Screenshot underlying Davis exhibit11'),('G',7,1,0,14,'webpage','Screenshot underlying Davis exhibit17'),('H',8,1,0,15,'webpage','Screenshot underlying Davis exhibit23'),('I',9,1,0,16,'webpage','Annotated Google search-results printout')],ev=[(3,'2002-09-16','Overture served infringement contentions',[]),(4,'2002-10-11','Google produced approximately60000 pages',[]),(6,'2002-10-23','Original deadline for Overture discovery responses',[]),(6,'2002-11-06','Extended deadline for written discovery responses',[]),(7,'2002-10-08','Opposing letter sent on or about this date',['A']),(9,'1999-10-22','PTO petition submitted on or about this date',[]),(10,'1999-10-22','Davis supporting declaration submitted on or about this date',[]),(16,None,'Kwun authenticated an annotated search-results printout',['I'])]),
'us-cand-overture-google-entry-70':dict(who='Charles M. McMahon',date='2003-08-04',title='Declaration supporting protective order against excessive third-party discovery',primary=2,aff_pages=[1,2,3,4],ex=[('A',2,5,1,2,'notice','June19 notice of25 third-party subpoenas',7),('B',2,8,1,2,'notice','Sample subpoena accompanying June19 notice',11),('C',2,12,1,3,'notice','July21 notice of46 additional subpoenas',16),('D',2,17,1,3,'notice','Sample subpoena accompanying July21 notice',20),('E',2,21,1,4,'letter','July24 McMahon letter confirming Sun conversation',23)],ev=[(2,'2003-06-19','Google gave notice of25 third-party subpoenas',['A','B']),(3,'2003-07-21','Google gave notice of46 additional subpoenas',['C','D']),(4,'2003-07-23','McMahon asked Sun to withdraw subpoenas and she refused',[]),(4,'2003-07-24','McMahon confirmed conversation and voice message by letter',['E']),(5,'1998-03-03','Beginning of the source-code archive date range',[]),(5,'1998-05-28','End of the source-code archive date range',[])]),
'us-cand-overture-google-entry-82':dict(who='Christine P. Sun',date='2003-08-11',title='Declaration opposing protective order',ex=[('C',3,1,0,4,'public_record','May19 1998 GoTo financing press release'),('F',6,1,0,7,'court_filing','April6 2000 patent-prosecution response'),('I',7,1,0,10,'affidavit','September16 2000 Davis patent-prosecution declaration'),('L',10,1,0,13,'letter','January21 2003 McMahon to Sun discovery letter'),('M',11,1,0,15,'court_filing','Google second interrogatories December12 2002'),('P',14,1,0,17,'letter','July8 2003 Sun to Egghead subpoena letter'),('Q',15,1,0,18,'financial_statement','AttorneysTrust subpoena response THD00009–10')],ev=[(3,'1999-01-17','Affidavit identifies OfficeAction date; preserve source as written',[]),(4,'1998-05-19','GoTo financing press release',['C']),(5,'1999-10-22','Davis declaration supporting special application',[]),(6,'1999-08-27','Information disclosure statement',[]),(7,'2000-04-06','Patent-prosecution response',['F']),(10,'2000-09-16','Davis declaration',['I']),(11,'2001-03-23','Notice of allowability',[]),(12,'2002-09-20','Google first document requests',[]),(13,'2003-01-21','McMahon discovery letter',['L']),(15,'2002-12-12','Google second interrogatories',['M']),(15,'2003-01-10','Overture supplied approximately500 names and addresses',[]),(17,'2003-06','Sun served25 subpoenas to California advertisers',[]),(17,'2003-07-08','Example letter to subpoena recipient Egghead',['P']),(18,'2000-01-31','Month-end period for received advertiser bill',['Q']),(20,'2003-07-23','McMahon could not identify an advertiser complaining of harassment',[]),(20,'2003-08-04','Sun and McMahon discussed shortened briefing schedule',[])]),
'us-cand-overture-google-entry-133':dict(who='Christine P. Sun',date='2004-02-17',title='Declaration opposing motion to compel damages documents',ex=[('A',1,1,0,4,'letter','January9 Sun response to Byrnes'),('B',2,1,0,4,'letter','February13 Riewerts letter without attachments'),('C',3,1,0,6,'letter','January20 Byrnes to Durie revised constructions'),('D',4,1,0,6,'letter','January22 Byrnes to Sun sur-reply refusal'),('E',5,1,0,9,'letter','January27 Byrnes demand letter'),('F',6,1,0,10,'letter','January27 Sun reply letter')],ev=[(2,'2002-08','Parties agreed approximately to postpone damages discovery',[]),(2,'2003-02-12','Prior McMahon letter cited, not attached',[]),(3,'2004-01-08','Byrnes demanded damages discovery',[]),(4,'2004-01-09','Sun responded to demand',['A']),(4,'2004-02-13','Google supplemented responses and privilege log',['B']),(5,'2004-01-21','Overture proposed exchange after Markman hearing',[]),(6,'2004-01-20','Overture announced revised constructions',['C']),(6,'2004-01-22','Overture refused stipulation for sur-reply',['D']),(6,'2004-02-06','Court granted sur-reply request',[]),(7,'2004-01-23','Google said it was considering a date certain',[]),(8,'2004-01-26','Sun proposed financial-data exchange in earlyApril',[]),(9,'2004-01-27','Byrnes threatened motion and sent fax',['E']),(10,'2004-01-27','Sun replied requesting more assessment time',['F'])]),
'us-cand-overture-google-entry-186':dict(who='Ravind S. Grewal',date='2004-07-06',title='Supplemental declaration supporting patent-prosecution discovery',ex=[('A',1,1,1,2,'email_chain','Emails accompanying March1998 GoTo business plan'),('B',2,1,1,3,'transcript','May20 2003 Davis deposition excerpts and errata'),('C',3,1,1,4,'transcript','July18 2003 ElaineLee deposition excerpts')],ev=[(1,'2004-07-01','Overture de-designated exhibits by letter',[]),(2,'1998-03','Business-plan emails associated with March1998 plan',['A']),(3,'2003-05-20','Davis deposition and later errata authenticated',['B']),(4,'2003-07-18','ElaineLee deposition excerpts',['C']),(5,'2003-07-23','Rauch deposition and errata referenced; available but unselected',[])]),
'us-cand-apple-samsung-entry-1082':dict(who='Thomas Watson',date='2012-05-25',title='Declaration supporting reconsideration of May21 orders',ex=[('6',3,1,1,7,'photograph','035mockup and iPad2 side view APLNDC-X00005874'),('7',4,1,1,8,'photograph','035mockup and iPad2 back view APLNDC-X00005857'),('8',5,1,1,9,'photograph','035mockup and iPad2 front view APLNDC-X00005858'),('9',6,1,1,10,'photograph','035mockup corner close-up APLNDC-X00005885')],ev=[(4,'2011-11-04','ChristopherStringer deposition authenticated; not available in selected files',[]),(6,'2011-10-25','QuinHoellwarth deposition excerpt available but unselected',[]),(11,'2011-10-21','DanieleDeIuliis deposition referenced; unavailable',[]),(12,'2011-10-31','RichardHowarth deposition available but unselected',[]),(16,'2012-04-27','RussellWiner deposition available but unselected',[]),(17,'2012-03-22','Apple served VanLiere report referenced in declaration',[]),(18,'2009-10-02','OfficeAction identified in reply-title reference',[]),(19,'2009-11-13','OfficeAction identified in separate reply-title reference',[]),(20,'2012-03-28','Counsel letter referenced; unavailable',[])]),
'us-cand-apple-samsung-entry-1098':dict(who='Cyndi Wheeler',date='2012-06-14',title='Declaration supporting administrative sealing motions',ex=[('A',1,2,1,13,'letter','Publicly redacted Trac exhibit14 counsel letter'),('B',2,2,1,14,'letter','Publicly redacted Trac exhibit15 counsel letter'),('C',3,2,1,15,'letter','Publicly redacted Trac exhibit16 counsel letter'),('D',4,2,1,16,'letter','Publicly redacted Trac exhibit17 counsel letter')],ev=[(2,'2012-04-20','Wagner corrected expert report identified, requested sealed',[]),(8,'2012-04-20','Sood deposition identified, requested sealed',[]),(13,None,'Wheeler proposes public redactions for Trac exhibit14',['A']),(14,None,'Wheeler proposes public redactions for Trac exhibit15',['B']),(15,None,'Wheeler proposes public redactions for Trac exhibit16',['C']),(16,None,'Wheeler proposes public redactions for Trac exhibit17',['D'])]),
'us-cand-oracle-google-entry-1562':dict(who='Maya Karwande',date='2016-03-23',title='Declaration supporting Google motions in limine1–6',ex=[('3',3,1,1,4,'transcript','March4 2016 DouglasSchmidt deposition excerpts'),('4',4,1,1,5,'report','February3 2012 IanCockburn report excerpt'),('6',6,1,1,7,'transcript','March17 2016 JamesMalackowski deposition excerpts')],ev=[(2,'2016-03-03','ChrisKemerer deposition available but unselected',[]),(3,'2016-03-10','AdamJaffe deposition referenced but sealplaceholder only',[]),(4,'2016-03-04','DouglasSchmidt deposition',['3']),(5,'2012-02-03','IanCockburn report',['4']),(6,'2016-01-08','OwenAstrachan opening report available but unselected',[]),(7,'2016-03-17','JamesMalackowski deposition',['6']),(8,'2010-08-06','Lindholm email referenced; sealplaceholder only',[]),(9,'2016-03-10','GregoryLeonard corrected report referenced; sealplaceholder only',[]),(10,'2016-12-02','Source identifies future Ringhofer deposition date; unresolved chronology conflict',[]),(11,'2007-11-14','TerranceBarr email referenced; sealplaceholder only',[]),(12,'2016-01-14','HenrikStahl deposition referenced; sealplaceholder only',[])]),
'us-cand-oracle-google-entry-1566':dict(who='Andrew D. Silverman',date='2016-03-23',title='Declaration supporting Oracle motions in limine',ex=[('23',6,1,1,25,'transcript','November20 2015 DonaldSmith deposition excerpts'),('26',9,1,1,28,'transcript','March8 2016 ItamarSimonson deposition excerpts'),('27',10,1,1,29,'transcript','March10 2016 OlivierToubia deposition excerpts'),('28',11,1,1,30,'email_chain','Leonard/staff/Kim email exchange LEONARD0000002–6')],ev=[(3,'2016-01-08','Astrachan first expert report referenced; sealplaceholder',[]),(4,'2016-02-08','Astrachan second expert report available but unselected',[]),(5,'2016-02-29','Astrachan third expert report sealplaceholder',[]),(6,'2016-03-10','Leonard first corrected report sealplaceholder',[]),(7,'2016-02-29','Leonard second report sealplaceholder',[]),(8,'2016-01-08','Hall first report referenced but not publicly supplied',[]),(9,'2016-02-08','Hall second report referenced but not publicly supplied',[]),(10,'2016-02-29','Hall third report referenced but not publicly supplied',[]),(12,'2016-02-29','Jaffe second report referenced but not publicly supplied',[]),(15,'2007-11-13','Beust email referenced but not publicly supplied',[]),(16,'2011-07-07','Swetland deposition referenced but not publicly supplied',[]),(17,'2007-05-07','Rubin email referenced but not publicly supplied',[]),(18,'2007-08-12','BobLee email referenced but not publicly supplied',[]),(19,'2009-12-07','Bloch email referenced but not publicly supplied',[]),(20,'2011-07-08','Bloch deposition referenced but not publicly supplied',[]),(22,'2015-11-12','Google second supplemental answer to interrogatory37',[]),(23,'2015-12-16','Google first supplemental interrogatory answers38–40,42',[]),(24,'2016-03-04','AndrewHall deposition referenced',[]),(25,'2015-11-20','DonaldSmith deposition excerpts',['23']),(26,'2016-03-14','Astrachan second deposition available but unselected',[]),(27,'2015-12-09','AnwarGhuloum30b6 deposition referenced',[]),(28,'2016-03-08','ItamarSimonson deposition excerpts',['26']),(29,'2016-03-10','OlivierToubia deposition excerpts',['27']),(30,None,'Expert email exchange authenticated',['28']),(31,'2011-10-03','AlanCox first report referenced but not supplied',[]),(32,'2016-03-17','Malackowski deposition referenced but not supplied',[]),(33,'2016-03-11','GregoryLeonard deposition referenced but not supplied',[])]),
'us-nysd-sec-ripple-entry-187':dict(who='John E. Deaton',date='2021-05-17',title='Declaration supporting proposed intervenors reply',ex=[('B',2,1,1,4,'webpage','Various JohnDeaton Twitter posts'),('C',3,1,1,5,'webpage','As-filed screenshot and URL for satirical mockexamination; underlyingvideo not supplied'),('E',5,1,1,7,'webpage','Cambridge dictionary definition of incompetent')],ev=[(4,None,'Deaton authenticates Twitter posts',['B']),(5,None,'Deaton authenticates filed screenshot/link for satirical mockexamination',['C']),(7,None,'Deaton authenticates dictionary-definition printout',['E'])]),
}

karwande=SPECS['us-cand-oracle-google-entry-1562']
karwande['ex']=[('3',3,1,1,4,'transcript','March4 2016 DouglasSchmidt deposition excerpts'),('5',5,1,1,6,'report','January8 2016 OwenAstrachan fair-use report excerpts'),('7',7,1,1,8,'email','August6 2010 TimLindholm email, underlyingTrialExhibit10'),('8',8,1,1,9,'report','March10 2016 GregoryLeonard corrected report excerpts')]
karwande['ev']=[(para,date,('IanCockburn report available but unselected' if para==5 else 'OwenAstrachan opening report' if para==6 else 'JamesMalackowski deposition referenced; sealplaceholder only' if para==7 else 'Lindholm email authenticated' if para==8 else 'GregoryLeonard corrected report authenticated' if para==9 else desc),(['5'] if para==6 else ['7'] if para==8 else ['8'] if para==9 else [] if para in [5,7] else labels)) for para,date,desc,labels in karwande['ev']]
karwande['ex']=[x for x in karwande['ex'] if x[0]!='8']
karwande['ev']=[(p,d,'GregoryLeonard corrected report available but unselected: filing overlay touches visible confidentiality marking' if p==9 else desc,[] if p==9 else labels) for p,d,desc,labels in karwande['ev']]
silverman=SPECS['us-cand-oracle-google-entry-1566'];silverman['ex']=[x for x in silverman['ex'] if x[0]!='23'];silverman['ev']=[(p,d,'DonaldSmith deposition available but unselected: filing overlay touches visible transcript pagination' if p==25 else desc,[] if p==25 else labels) for p,d,desc,labels in silverman['ev']]
deaton=SPECS['us-nysd-sec-ripple-entry-187'];deaton['ex']=[('A',1,1,1,3,'webpage','As-filed compilation of media criticism of SEC leadership')]+[x for x in deaton['ex'] if x[0]!='E'];deaton['ev']=[(3,None,'Deaton authenticates compilation of media criticism of SEC leadership',['A'])]+[(p,d,desc,[] if p==7 else labels) for p,d,desc,labels in deaton['ev']]

def dump(p,v):p.write_text(json.dumps(v,indent=2,ensure_ascii=False),encoding='utf-8')
def exact_native_filing_operator(doc,page,expected_entry):
    """Rewrite only plain horizontal native ECF Tj operands; preserve other operators."""
    from PIL import Image,ImageChops
    operations=[]
    for xref in page.get_contents():
        raw=doc.xref_stream(xref);rewritten=raw
        for match in list(re.finditer(rb'\((Case[^()\r\n]+)\)\s*Tj',raw)):
            text=match[1].decode('ascii')
            if not split.ECF_HEADER.match(text):continue
            if not re.search(r'\bDocument\s+'+str(expected_entry)+r'(?:-\d+)?\s',text):continue
            date=re.search(r'Filed\s+\d{1,2}/\d{1,2}/\d{2,4}',text)
            if not date:continue
            traces=[t for t in page.get_texttrace() if ''.join(chr(c[0]) for c in t['chars'])==text]
            if len(traces)!=1:continue
            trace=traces[0];assert tuple(trace['dir'])==(1.0,0.0)
            assert trace['color'][0]<.1 and trace['color'][1]<.1 and trace['color'][2]>.4,'Unrecognized non-blue filing overlay'
            fonts=re.findall(rb'/[^\s]+\s+([\d.]+)\s+Tf',raw[:match.start()]);assert fonts
            font_size=float(fonts[-1]);assert abs(font_size-trace['size'])<.001
            advance=trace['chars'][date.start()][2][0]-trace['chars'][0][2][0]
            dates=page.search_for(date.group());dates=[r for r in dates if r.intersects(fitz.Rect(trace['bbox']))];assert len(dates)==1
            crop=dates[0]+(-1,-1,1,1);before=page.get_pixmap(matrix=fitz.Matrix(2,2),clip=crop,alpha=False)
            replacement=b'['+format(-advance/font_size*1000,'.10f').encode()+b' ('+date.group().encode()+b')]TJ'
            assert raw.count(match.group())==1
            rewritten=rewritten.replace(match.group(),replacement)
            others=[(t['type'],t['font'],tuple((c[0],tuple(c[2]),tuple(c[3])) for c in t['chars'])) for t in page.get_texttrace() if t!=trace]
            doc.update_stream(xref,rewritten)
            after=page.get_pixmap(matrix=fitz.Matrix(2,2),clip=crop,alpha=False)
            assert before.width==after.width and before.height==after.height and before.samples==after.samples,'Original filed-date pixels changed'
            remaining=[t for t in page.get_texttrace() if ''.join(chr(c[0]) for c in t['chars'])!=date.group()]
            assert others==[(t['type'],t['font'],tuple((c[0],tuple(c[2]),tuple(c[3])) for c in t['chars'])) for t in remaining],'Other native glyphs changed'
            operations.append({'xref':xref,'before_stream_sha256':hashlib.sha256(raw).hexdigest(),'after_stream_sha256':hashlib.sha256(rewritten).hexdigest(),'before_stream_base64':base64.b64encode(raw).decode(),'after_stream_base64':base64.b64encode(rewritten).decode(),'original_text_show':match.group().decode(),'replacement_text_show':replacement.decode(),'preserved_filed_date':date.group(),'preserved_date_crop':list(crop),'date_crop_pixel_sha256':hashlib.sha256(before.samples).hexdigest(),'date_pixels_identical_at_144dpi':True,'all_other_native_glyphs_identical':True})
    return operations
def source_input(part,d):
    """Remove only native blue Justia wrappers before shared filing-stamp handling."""
    original=pathlib.Path(part['path']);audit=[];dest=d/f"native-wrapper-{part['attachment']}.pdf"
    with fitz.open(original) as doc:
        for n,page in enumerate(doc):
            page_image_hashes=[hashlib.sha256(doc.extract_image(x[0])['image']).hexdigest() for x in page.get_images(full=True)]
            rows=[]
            for block in page.get_text('dict')['blocks']:
                for line in block.get('lines',[]):
                    text=''.join(s['text'] for s in line['spans']);box=fitz.Rect(line['bbox'])
                    wrapper=(box.y0<20 or box.y1>page.rect.height-20) and (text.strip()=='Dockets.Justia.com' or re.fullmatch(r'Doc\.\s*\d+(?:\s+Att\.\s*\d+)?',text.strip()) or (' v. ' in text and box.y0<1))
                    if wrapper:
                        assert all(s['color'] not in (0,16777215) for s in line['spans']),text
                        page.add_redact_annot(box,fill=False,cross_out=False);rows.append({'text':text,'rect':list(box)})
            if rows:
                before=[hashlib.sha256(doc.extract_image(x[0])['image']).hexdigest() for x in page.get_images(full=True)]
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,graphics=fitz.PDF_REDACT_LINE_ART_NONE)
                after=[hashlib.sha256(doc.extract_image(x[0])['image']).hexdigest() for x in page.get_images(full=True)];assert before==after
                audit.append({'source_page':n+1,'native_only_transparent_no_fill':True,'removed_justia_wrappers':rows,'underlying_image_sha256s':before})
            entry=re.search(r'\.(\d+)\.\d+\.pdf$',part['url']);assert entry,part['url']
            operator_audit=exact_native_filing_operator(doc,page,int(entry[1]))
            if operator_audit:
                assert page_image_hashes==[hashlib.sha256(doc.extract_image(x[0])['image']).hexdigest() for x in page.get_images(full=True)]
                audit.append({'source_page':n+1,'method':'Exact native ECF text-show operator rewrite; no geometric redaction; all other operators/glyphs unchanged.','underlying_image_sha256s':page_image_hashes,'operations':operator_audit})
            try:split.ecf_headers(page,True)
            except ValueError:
                lines=[(fitz.Rect(l['bbox']),''.join(s['text'] for s in l['spans'])) for b in page.get_text('dict')['blocks'] for l in b.get('lines',[])]
                stamps=[(r,t) for r,t in lines if split.ECF_HEADER.match(t) and (r.y0<page.rect.height*.12 or r.y1>page.rect.height*.88)]
                pieces=[];keep=[]
                for r,t in stamps:
                    for match in re.finditer(r'Filed\s+\d{1,2}/\d{1,2}/\d{2,4}',t):keep += [x+(-.5,-.5,.5,.5) for x in page.search_for(match.group()) if x.intersects(r)]
                for r,t in stamps:
                    spans=[r]
                    for k in keep:
                        spans=[z for x in spans for z in ([fitz.Rect(x.x0,x.y0,min(x.x1,k.x0),x.y1),fitz.Rect(max(x.x0,k.x1),x.y0,x.x1,x.y1)] if x.intersects(k) else [x]) if not z.is_empty]
                    pieces+=spans
                assert pieces
                hidden=[]
                for trace in page.get_texttrace():
                    chars=''.join(chr(c[0]) for c in trace['chars']);is_stamp=split.ECF_HEADER.match(chars)
                    for char in trace['chars']:
                        if not any(fitz.Rect(char[3]).intersects(r) for r in pieces):continue
                        if is_stamp:continue
                        assert trace['type']==3,('Visible substantive native overlap',original,n+1,chars)
                        hidden.append({'codepoint':char[0],'bbox':list(char[3]),'trace_type':trace['type']})
                before=[hashlib.sha256(doc.extract_image(x[0])['image']).hexdigest() for x in page.get_images(full=True)]
                for r in pieces:page.add_redact_annot(r,fill=False,cross_out=False)
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,graphics=fitz.PDF_REDACT_LINE_ART_NONE)
                assert before==[hashlib.sha256(doc.extract_image(x[0])['image']).hexdigest() for x in page.get_images(full=True)]
                audit.append({'source_page':n+1,'method':'Native filing overlay removal with invisible-OCR overlap only; affected full page re-OCR required. Original OCR is not claimed preserved.','removed_stamp_rects':[list(r) for r in pieces],'preserved_original_date_boxes':[list(r) for r in keep],'removed_invisible_ocr_glyphs':hidden,'underlying_image_sha256s':before})
        if audit:dest.write_bytes(doc.tobytes(garbage=4,deflate=True))
    if audit:
        dump(d/f"native-wrapper-{part['attachment']}-audit.json",{'original_sha256':part['sha256'],'derivative_sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'pages':audit});return str(dest)
    return str(original)
def paragraph(text,n):
    start=re.search(r'(?m)^\s*'+str(n)+r'\.\s*',text);assert start,(n,text[:80]);tail=text[start.end():];end=re.search(r'(?m)^\s*\d{1,2}\.\s*',tail)
    value=tail[:end.start()] if end else tail
    # Jurat closes the final numbered paragraph; do not incorporate unrelated attestations.
    value=re.split(r'I declare under penalty|Executed on|Executed this',value)[0]
    return value.strip()

def main():
    fitz.TOOLS.mupdf_display_errors(False);fitz.TOOLS.mupdf_display_warnings(False)
    for rid,spec in SPECS.items():
        if len(sys.argv)>1 and rid not in sys.argv[1:]:continue
        d=OUT/'pending'/rid;parts=json.loads((d/'sources.json').read_text(encoding='utf-8'));by={p['attachment']:p for p in parts};prepared={n:source_input(p,d) for n,p in by.items() if n in {spec.get('primary',0)}|{x[1] for x in spec['ex']}};primary=by[spec.get('primary',0)];source=fitz.open(prepared[spec.get('primary',0)]);affpages=spec.get('aff_pages',list(range(1,len(source)+1)))
        with split.clean_copy(source,[p-1 for p in affpages],preserve_filing_dates=True) as aff:afftext=split.text_of(aff)
        target=OUT/'records'/rid;target.mkdir(parents=True,exist_ok=True)
        manifest={'affidavit':prepared[spec.get('primary',0)],'exhibits':{},'preserve_filing_dates':True,'label_on_content':[]}
        for label,att,first,cover,para,kind,desc,*last in spec['ex']:
            end=last[0] if last else by[att]['pages'];manifest['exhibits'][label]=prepared[att]+f':{first}-{end}'
            if not cover:manifest['label_on_content'].append(label)
        dump(d/'manifest.json',manifest);meta={'url':primary['url'],'landing_url':'https://www.courtlistener.com/recap/','source_sha256':primary['sha256'],'origin':'machine_test','run_id':'affidavit-association-supplemental-canada-20261022','source_primary_attachment':spec.get('primary',0),'source_primary_pages':affpages,'source_inventory':[{k:p[k] for k in ['attachment','sha256','url','pages','path']} for p in parts],'urls':{pathlib.Path(path).name:by[n]['url'] for n,path in prepared.items()}};dump(d/'meta.json',meta)
        cmd=[sys.executable,str(ROOT/'benchmarks/court-record-exhibits/split.py'),rid,'--manifest',str(d/'manifest.json'),'--meta',str(d/'meta.json'),'--out',str(OUT/'records')]
        covers=[x[0] for x in spec['ex'] if x[3]]
        if covers:cmd+=['--covers',','.join(covers)]
        if 'aff_pages' in spec:cmd+=['--pages',f'{affpages[0]}-{affpages[-1]}']
        result=subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8',errors='replace')
        if result.returncode:print('MATERIALIZATION REJECT',rid,result.stderr[-250:],flush=True);continue
        spl=json.loads((target/'split.json').read_text(encoding='utf-8'));files={x['label']:x['file'] for x in spl['exhibits']};gold={'record_id':rid,'court':'United States District Court, '+('Southern District of New York' if 'sec-ripple' in rid else 'Northern District of California'),'court_level':'federal_trial','jurisdiction':'US','subject':'securities_regulation' if 'sec-ripple' in rid else 'patent_copyright','proceeding':json.loads((d/'case.json').read_text(encoding='utf-8'))['title'],'document':spec['title'],'deponent':spec['who'],'sworn_date':spec['date'],'court_file':json.loads((d/'case.json').read_text(encoding='utf-8')).get('court_file'),'family':json.loads((d/'case.json').read_text(encoding='utf-8'))['prefix'],'exhibits':[],'events':[],'association_scope':'explicit_selected_complete_filed_exhibits','notes':'Only selected complete as-filed exhibits evaluated. Original sources and complete reference body retained. Unselected/publicly unavailable referenced instruments are not assumed absent from the original filing. No underlying missing pages or media reconstructed. Pending separate independent cross-review.','gold_provenance':{'origin':'machine_test','run_id':'affidavit-association-supplemental-canada-20261022','method':'codex_collaboration direct source author; independent review pending','author_agent':'/root/gold_canada','author_receipt':'author_receipt.json','review_status':'pending'}}
        if rid.endswith('entry-82'):
            output=target/'files'/files['Q']
            with fitz.open(prepared[15]) as original,split.clean_copy(original,list(range(len(original))),preserve_filing_dates=True) as faithful:output.write_bytes(faithful.tobytes(garbage=4,deflate=True))
            spl['legitimate_document_pagination_preserved']={'label':'Q','source_sha256':by[15]['sha256'],'source_page':2,'reason':'Original GoTo statement PAGE2OF2 is substantive document pagination, not compiled filing folio; rebuild through clean_copy without record_folios heuristic. Full-page pixel comparison required.'};dump(target/'split.json',spl)
        for label,att,first,cover,para,kind,desc,*last in spec['ex']:
            gold['exhibits'].append({'label':label,'file':files[label],'kind':kind,'description':desc,'references':[{'paragraph':para,'quote':paragraph(afftext,para)}]})
        for para,date,desc,labels in spec['ev']:
            gold['events'].append({'id':'e'+str(len(gold['events'])+1),'date':date,'precision':'day' if date and len(date)==10 else 'month' if date and len(date)==7 else 'undated','description':desc,'quote':paragraph(afftext,para),'paragraph':para,'exhibits':labels})
        jurat=re.search(r'(?:I declare under penalty|Executed on May 17)[\s\S]*',afftext).group()[:1000]
        gold['events'].append({'id':'e'+str(len(gold['events'])+1),'date':spec['date'],'precision':'day','description':'Declarant executed declaration under penalty of perjury','quote':jurat,'exhibits':[]})
        # Entire output texts and every image page are durable evidence for cross-review.
        outputs=[]
        for p in (target/'files').glob('*.pdf'):
            with fitz.open(p) as doc:
                texts=[]
                for n,page in enumerate(doc):
                    native=page.get_text();text=split.tesseract_cli(page) if page.get_images() else native;texts.append(f'[page {n+1}]\n'+text)
                p.with_suffix('.txt').write_text('\n'.join(texts),encoding='utf-8')
            outputs.append({'file':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'text_sha256':hashlib.sha256(p.with_suffix('.txt').read_bytes()).hexdigest()})
        dump(target/'candidate-gold.json',gold);dump(d/'author-proposal.json',{'origin':'machine_test','method':'codex_collaboration','record_id':rid,'mapping':spec['ex'],'status':'pending_full_content_author_read_and_separate_cross_review','output_files':outputs});print('PENDING',rid,len(gold['exhibits']),len(gold['events']),flush=True)

if __name__=='__main__':main()
