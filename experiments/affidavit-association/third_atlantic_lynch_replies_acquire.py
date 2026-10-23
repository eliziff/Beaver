"""Literal filenames from previously captured official SCC40302 inventory."""
from third_atlantic_sources import acquire,s,O
items=[dict(url='https://www.scc-csc.ca/pdf/case-documents/40302/'+f,label='SCC40302-Lynch-'+f,jurisdiction='nl',kind='court-record',landing_url='https://www.scc-csc.ca/data/case-documents/40302.json',discovery='Literal actual public official case-document inventory, original SHA7c9abab75b222ceab812de88166edbdf3a539db64bb5f3ceec37f6a0d6c5d925; not guessed filename.')for f in ['FM080_Appellant_City-of-St-Johns_REPLY.pdf','MM030_Appellant_City-of-St-Johns.pdf']]
s.dump(O/'lynch-reply-sources.json',items)
for x in items:
 r=acquire(x);print(r['sha256'],r['pages'],r['label']);s.extract(r)
