"""Full nine-exhibit Alberta appeal record; no report/brief length cutoff."""
from second_canada_author import *
from second_canada_initial_specs import ref,event
from second_canada_ur_specs import reference,ev

def main():
    p=pages_for(source('d4d402e08a'))
    s=dict(record_id='ca2-abca-song-2026',source='d4d402e08a',jurisdiction='ab',court='Court of Appeal of Alberta',court_file='2501-0282AC',family='ca/ab/song-law-society-2301-14224',proceeding='Yue Song v Law Society of Alberta',subject='professional governance, compulsory education and appeal-record procedure',deponent='Yue (Roger) Song',sworn_date='2026-06-04',body_pages=[1,2],visual_pages=[1,2,3,4,207,208,209,267,268,269,349,350,351,354,355,357,358,364,365,374,375,379,380,385],difficulty=['Three long competing lower-court briefs on same governance dispute, with many shared authorities and underlying-record references.','Two rounds of counsel request/response letters and two near-twin administrative decisions on adding those briefs to appeal record.','Lowercourtfile2301-14224differsfromappeal2501-0282AC; nested references to earlier Song exhibits do not create new own labels.'],discrepancies=['The attached briefs refer to exhibits in earlier affidavits; those nested labels are not own attachments of this June4affidavit.','All385originalpages retained in source transcript; complete204pageA/59pageB/81pageCtext views have no first-N limit.'],distractors=[dict(label='F',role='other_target_exhibit',same_proceeding=True,reason='March9CMOdecision is distinct from May7reconsiderationdecisionI; both are own positives.'),dict(label='G',role='other_target_exhibit',same_proceeding=True,reason='March19reconsideration request near twin of February5initial requestD; both retain complete nested correspondence.')])
    table=[('A',4,207,3,1,2,'Applicant amended brief filedApril7,2025','brief','2025-04-07'),('B',209,267,208,1,3,'Respondent written submissions filedApril8,2025','brief','2025-04-08'),('C',269,349,268,2,4,'Applicant surreply brief filedApril23,2025','brief','2025-04-23'),('D',351,353,350,2,5,'Blackett February5,2026request to include lowercourtbriefs','letter','2026-02-05'),('E',355,356,354,2,6,'Kully February10,2026response to CMO','letter','2026-02-10'),('F',358,363,357,2,7,'March9,2026CMOadministrative decision denying permission','decision','2026-03-09'),('G',365,373,364,2,8,'Blackett March19,2026reconsideration request','letter','2026-03-19'),('H',375,378,374,2,9,'Kully March26,2026response to reconsideration request','letter','2026-03-26'),('I',380,385,379,2,10,'May7,2026CMOadministrative decision again denying permission','decision','2026-05-07')]
    s['exhibits']=[];s['events']=[]
    for l,a,b,cover,rp,pa,desc,kind,date in table:
        r=ref(p,1,pa) if rp==1 else reference(p,2,pa,str(pa)+'. Attached',str(pa+1)+'. ')
        s['exhibits'].append(dict(label=l,pages=list(range(a,b+1)),cover_pages=[cover],description=desc,kind=kind,date=date,date_precision='day',references=[r]))
        s['events'].append(dict(**r,date=date,event=desc,labels=[l],date_precision='day'))
    s['events'].append(ev(p,2,11,'11. I make','Yuet',None,'Song supports application underRules14.36(3)/14.56to amend March9order and permit lowercourtwrittenargument in appeal record'))
    old=json.loads((OUT/'author-specs.json').read_text(encoding='utf-8'))
    if s['record_id'] not in {x['record_id'] for x in old}:dump(OUT/'author-specs.json',old+[s])
if __name__=='__main__':main()
