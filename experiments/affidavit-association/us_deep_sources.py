"""One additional free public listing page; screen real declaration bodies, not title mentions."""
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime,timezone

import fitz
from us_new_cases import BASE,OUT,dump,cs


def main():
    prior=[]
    for name in ['new-case-listings.json','more-case-listings.json']:
        prior+=json.loads((OUT/name).read_text(encoding='utf8'))
    candidates=[]
    saved=[]
    known=set()
    for name in ['new-case-screen.json','more-case-screen.json']:
        known.update((x['case']['record'],x['entry']) for x in json.loads((OUT/name).read_text(encoding='utf8')))
    db=cs.connect()
    for listing in prior:
        if not listing['truncated']:
            continue
        case=listing['case']
        url=BASE+'?'+urllib.parse.urlencode({'list-type':'2','prefix':case['prefix'],
                 'start-after':listing['objects'][-1]['key'],'max-keys':1000})
        root=ET.fromstring(urllib.request.urlopen(url,timeout=90).read())
        ns={'s':'http://s3.amazonaws.com/doc/2006-03-01/'}
        new=[{'key':x.find('s:Key',ns).text,'bytes':int(x.find('s:Size',ns).text)} for x in root.findall('s:Contents',ns)]
        saved.append({'case':case,'url':url,'retrieved':datetime.now(timezone.utc).isoformat(),
                      'objects':new,'truncated':root.find('s:IsTruncated',ns).text=='true'})
        dump(OUT/'deep-case-listings.json',saved)
        groups={}
        for obj in listing['objects']+new:
            match=re.search(r'\.(\d+)\.(\d+)\.pdf$',obj['key'])
            if match:
                groups.setdefault(int(match[1]),{})[int(match[2])]=obj
        fetched=0
        for entry,objects in sorted(groups.items()):
            if (case['record'],entry) in known or 0 not in objects or not 3<=len(objects)<=31:
                continue
            if fetched>=65:
                break
            fetched+=1
            source=BASE+objects[0]['key']
            sha,status=cs.fetch(db,source,{'collection':'court-record-sources','jurisdiction':'us','kind':'court-record',
                      'label':case['title']+f' entry {entry}','provenance':'Free public RECAP listing; actual retrieval timestamp in corpus index'},refresh=False)
            if not sha:
                continue
            path=cs.HOME/db.execute('select path from files where sha256=?',(sha,)).fetchone()[0]
            try:
                with fitz.open(path) as doc:
                    if len(doc)>20:
                        continue
                    text='\n'.join(f'[source page {i+1}]\n{p.get_text()}' for i,p in enumerate(doc))
                    if not re.search(r'\bI,\s+[\w .’-]+,\s*(?:do\s+)?(?:hereby\s+)?(?:declare|pursuant)',text,re.I):
                        continue
                    if len(re.findall(r'\b(?:exhibits?|Ex\.)',text,re.I))<2:
                        continue
                    candidates.append({'case':case,'entry':entry,'main':objects[0],
                       'parts':[obj for n,obj in sorted(objects.items()) if n], 'url':source,'sha256':sha,
                       'path':str(path),'pages':len(doc),'text':text})
                    dump(OUT/'deep-case-screen.json',candidates)
                    print('ACTUAL DECLARATION',case['record'],entry,len(doc),len(objects)-1,flush=True)
            except Exception as exc:
                print('Source rejected',entry,str(exc)[:200],flush=True)
    dump(OUT/'deep-case-screen.json',candidates)


if __name__=='__main__':
    main()
