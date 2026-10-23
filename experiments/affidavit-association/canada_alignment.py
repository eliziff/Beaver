"""Restore source characters for uniquely matched literal OCR quotations."""
import pathlib,json,re,hashlib

def mapped(text):
    chars=[];positions=[]
    for i,char in enumerate(text):
        if char.isspace():
            if chars and chars[-1] not in (' ','-'):chars.append(' ');positions.append(i)
            continue
        value=char.lower()
        if char in "\"'‘’“”":value="'"
        elif char in '‐‑–—−':value='-'
        elif char=='|' and (i==0 or not text[i-1].isalnum()) and (i+1==len(text) or not text[i+1].isalnum()):value='i'
        chars.extend(value);positions.extend([i]*len(value))
    if chars and chars[-1]==' ':chars.pop();positions.pop()
    return ''.join(chars),positions

def align(quote,source):
    if quote in source:return quote
    needle,_=mapped(quote);haystack,positions=mapped(source)
    if len(needle)<40 or len(quote.split())<6:return quote
    first=haystack.find(needle)
    if first<0 or haystack.find(needle,first+1)>=0:return quote
    return source[positions[first]:positions[first+len(needle)-1]+1]

def install(workflow):
    original=workflow.call
    def call(prompt,schema,images,directory,args,validate,**kw):
        rid=directory.parent.name;record=workflow.OUT/'records'/rid;affidavit=record/'affidavit.txt'
        def source_aligned(value):
            if not value.get('accept') or not affidavit.exists():return validate(value)
            try:gold=json.loads(value['gold_json'])
            except (KeyError,ValueError):return validate(value)
            if 'events' not in gold or 'exhibits' not in gold:return validate(value)
            source=affidavit.read_text(encoding='utf-8');corrections=[]
            for pointer,obj in [(f'/events/{i}',e) for i,e in enumerate(gold['events'])]+[(f'/exhibits/{i}/references/{j}',ref) for i,e in enumerate(gold['exhibits']) for j,ref in enumerate(e.get('references',[]))]:
                before=obj.get('quote','');after=align(before,source)
                if after!=before:
                    obj['quote']=after;start=source.index(after);pages=re.findall(r'\[page (\d+)\]',source[:start]);corrections.append({'pointer':pointer+'/quote','proposed':before,'source_aligned':after,'source_page':int(pages[-1]) if pages else None,'method':'Unique contiguous source span; whitespace, typographic punctuation and standalone OCR I/pipe equivalence only.'})
            for i,event in enumerate(gold['events']):
                date=event.get('date','')
                if isinstance(date,str) and re.fullmatch(r'\d{4}(?:-\d{2}){0,2}/\d{4}(?:-\d{2}){0,2}',date) and not event.get('end_date'):
                    event['date'],event['end_date']=date.split('/');event['precision']='range';corrections.append({'pointer':f'/events/{i}/date','proposed':date,'source_aligned':event['date'],'end_date':event['end_date'],'method':'Preserve authored range endpoints in separate ISO fields.'})
            if corrections:
                serialized=json.dumps(gold,ensure_ascii=False);value=dict(value,gold_json=serialized);folder=workflow.OUT/'source-alignments'/rid;folder.mkdir(parents=True,exist_ok=True);key=hashlib.sha256(value['gold_json'].encode()).hexdigest()[:16]
                workflow.atomic_json(folder/(key+'.json'),{'origin':'machine_test','run_id':workflow.RUN,'corrections':corrections,'requires_independent_source_review':True})
            return validate(value)
        return original(prompt,schema,images,directory,args,source_aligned,**kw)
    workflow.call=call
