"""Broaden the private source pool from free public RECAP object listings."""
import json
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime,timezone

import fitz

from us_expand import ROOT, OUT, dump
sys.path.insert(0,str(ROOT/'experiments/legal_pdf_corpus'))
import corpus_store as cs

CASES = [
    ('us-cand-oracle-google','cand.231846','Oracle America, Inc. v. Google Inc.; copyright and patent litigation','3:10-cv-03561'),
    ('us-cand-overture-google','cand.6770','Overture Services, Inc. v. Google Inc.; search advertising patent and discovery dispute','3:02-cv-01991'),
    ('us-cand-digitalenvoy-google','cand.19466','Digital Envoy, Inc. v. Google Inc.; licensing and trade-secret dispute','5:04-cv-01497'),
    ('us-wawd-zhong-uw','wawd.345063','Zhong v. University of Washington; employment dispute',''),
    ('us-mnd-lugo-concentrix','mnd.226009','Lugo v. Concentrix Corporation; civil employment dispute','0:25-cv-02585'),
    ('us-nysd-jones-equifax','nysd.389353','Jones v. Equifax et al.; credit-reporting civil action','11-cv-9136'),
]
BASE='https://com-courtlistener-storage.s3.us-west-2.amazonaws.com/'
MORE_CASES=[
 ('us-cand-apple-samsung','cand.239768','Apple Inc. v. Samsung Electronics Co. Ltd.; patent and design litigation','5:11-cv-01846'),
 ('us-wawd-ftc-amazon','wawd.323520','Federal Trade Commission v. Amazon.com Inc.; online subscription consumer protection','2:23-cv-00932'),
 ('us-nysd-sec-ripple','nysd.551082','Securities and Exchange Commission v. Ripple Labs Inc.; securities enforcement','1:20-cv-10832'),
]


def run(cases=CASES,name='new-case'):
    connection=cs.connect()
    listings=[]
    candidates=[]
    retrieved=datetime.now(timezone.utc).isoformat()
    for record,prefix,title,court_file in cases:
        case={'record':record,'prefix':'recap/gov.uscourts.'+prefix,'title':title,'court_file':court_file}
        url=BASE+'?'+urllib.parse.urlencode({'list-type':'2','prefix':case['prefix'],'max-keys':1000})
        xml=urllib.request.urlopen(url,timeout=90).read()
        root=ET.fromstring(xml)
        ns={'s':'http://s3.amazonaws.com/doc/2006-03-01/'}
        objects=[{'key':x.find('s:Key',ns).text,'bytes':int(x.find('s:Size',ns).text)} for x in root.findall('s:Contents',ns)]
        listings.append({'case':case,'url':url,'objects':objects,'retrieved':retrieved,
                         'truncated':root.find('s:IsTruncated',ns).text=='true'})
        dump(OUT/(name+'-listings.json'),listings)
        groups={}
        for obj in objects:
            match=re.search(r'\.(\d+)\.(\d+)\.pdf$',obj['key'])
            if match:
                groups.setdefault(int(match[1]),{})[int(match[2])]=obj
        screened=0
        for entry,group in sorted(groups.items()):
            if 0 not in group or not 3<=len(group)<=31:
                continue
            if screened>=45:
                break
            screened+=1
            source_url=BASE+group[0]['key']
            sha,status=cs.fetch(connection,source_url,{'collection':'court-record-sources','jurisdiction':'us',
                 'kind':'court-record','label':title+f' entry {entry}','provenance':'Free RECAP public S3 listing '+retrieved},refresh=False)
            if not sha:
                continue
            row=connection.execute('select path from files where sha256=?',(sha,)).fetchone()
            path=cs.HOME/row[0]
            if path.suffix.lower()!='.pdf':
                continue
            try:
                with fitz.open(path) as document:
                    if len(document)>90:
                        continue
                    text='\n'.join(f'[source page {i+1}]\n{p.get_text()}' for i,p in enumerate(document))
                    if len(re.findall(r'\b(?:exhibits?|Ex\.)',text,re.I))<2:
                        continue
                    candidates.append({'case':case,'entry':entry,'main':group[0],
                        'parts':[obj for n,obj in sorted(group.items()) if n], 'url':source_url,
                        'sha256':sha,'path':str(path),'pages':len(document),'text':text})
                    dump(OUT/(name+'-screen.json'),candidates)
                    print('NEW CASE CANDIDATE',record,entry,len(document),flush=True)
            except Exception as exc:
                print('REJECT SOURCE',source_url,str(exc),flush=True)
    dump(OUT/(name+'-screen.json'),candidates)


if __name__=='__main__':
    run()
