"""Public source inventories for three distinct, locally screened Canadian cases."""
import sys
from third_atlantic_sources import s,O,ROOT,provenance
sys.path.insert(0,str(ROOT/'tools'))
from ledger_utils import ledger_transaction
rows=[('39997','nb','Jennifer Basque v. His Majesty the King; New Brunswick impaired-driving sentence and credit for pre-sentence driving prohibition'),('40302','nl',"City of St. John's v. Wallace Lynch and others; Newfoundland real-property constructive expropriation and valuation"),('40332','bc','Franck Yvan Tayo Tompouba v. His Majesty the King; British Columbia criminal trial language and actual own-case findings')]
with ledger_transaction(O.parent/'case-claims.json',{'claims':{}}) as ledger:
 for no,j,description in rows:
  key='CA:SCC:'+no;old=ledger['claims'].get(key)
  assert not old or old.get('owner')=='atlantic-north',old
  ledger['claims'][key]=dict(owner='atlantic-north',max_new_records=3,basis=description+'; screening only, source-grounded positive instruments still required.',**provenance())
items=[]
for no,j,description in rows:
 for kind,url in [('source-listing',f'https://www.scc-csc.ca/data/case-documents/{no}.json'),('source-listing',f'https://www.scc-csc.ca/cases-dossiers/search-recherche/{no}/')]:
  items.append(dict(url=url,label=f'SCC{no} {description} public inventory or full listing',kind=kind,jurisdiction=j,discovery='Actual primary case citation from public-source search; JSON inventory is documented in the court page JavaScript. Local corpus and baseline screening retained next-three-local-screen.json.'))
s.dump(O/'next-three-sources.json',items)
print('three actual Canadian case claims and source plans retained')
