"""Primary Newfoundland criminal source discovery, identity checked before claims."""
import sys
from third_atlantic_sources import s,O,ROOT,provenance
sys.path.insert(0,str(ROOT/'tools'))
from ledger_utils import ledger_transaction
case='37314'
with ledger_transaction(O.parent/'case-claims.json',{'claims':{}}) as ledger:
    key='CA:SCC:'+case
    old=ledger['claims'].get(key)
    assert not old or old.get('owner')=='atlantic-north',old
    ledger['claims'][key]=dict(owner='atlantic-north',max_new_records=3,basis='Actual Supreme Court public case37314, Crown v Hubert Hunt, William Parsons, Gary Hillyard and John King; origin NL201501H0014/201301G3482, pre-charge delay criminal prosecution. Screening only; no acceptance claimed.',**provenance())
items=[dict(url='https://www.scc-csc.ca/data/case-documents/37314.json',label='SCC37314 Hunt public original inventory',kind='source-listing',jurisdiction='nl'),dict(url='https://www.scc-csc.ca/cases-dossiers/search-recherche/37314/',label='SCC37314 Hunt complete primary case listing',kind='source-listing',jurisdiction='nl'),dict(url='https://records.court.nl.ca/public/supremecourt/decisiondownload/?decision-id=2842&mode=stream',label='Hunt2016NLCA61 complete official original',kind='judgment',jurisdiction='nl',landing_url='https://www.scc-csc.ca/cases-dossiers/search-recherche/37314/',discovery='Exact official original indexed by primary-source search; not a guessed document ID. November4,2016, Welsh/Rowe majority and Hoegg dissent, docket201501H0014.')]
s.dump(O/'hunt-sources.json',items)
print('Hunt actual case reserved and exact primary acquisition plan retained')
