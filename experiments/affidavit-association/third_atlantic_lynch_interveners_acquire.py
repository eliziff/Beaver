"""Actual five interlocutor instruments named in the complete reply and official inventory."""
from third_atlantic_sources import acquire,s,O
names=['FM030_Intervener_Ontario-Landowners-Association.pdf','FM040_Intervener_Attorney-General-of-British-Columbia.pdf','FM050_Intervener_City-of-Surrey.pdf','FM060_Intervener_Canadian-Home-Builders-Association.pdf','FM070_Intervener_Ecojustice-Canada-Society.pdf']
items=[dict(url='https://www.scc-csc.ca/pdf/case-documents/40302/'+f,label='SCC40302-Lynch-'+f,jurisdiction='nl',kind='court-record',landing_url='https://www.scc-csc.ca/data/case-documents/40302.json',discovery='Literal filenames in acquired official inventorySHA7c9abab75b222ceab812de88166edbdf3a539db64bb5f3ceec37f6a0d6c5d925; all five expressly identified in whole City reply.')for f in names];s.dump(O/'lynch-intervener-sources.json',items)
for x in items:
 r=acquire(x);print(r['sha256'],r['pages'],r['label'],flush=True);s.extract(r)
