"""Complete directly read LA19009 notice, with image-established reading conflicts."""
from third_atlantic_direct import materialize
from third_atlantic_sources import s
SH='afea5f87001a6f095033c932d429712b7fdc83629903bb07a4b2e4baf3075187'
RS='946bbd081c7349fd362a5950f15d7b1837e51cfd49d1be0fd01bb003776cc593'
rid='an3-pe-brownvolkswagen-notice-20190709'
part=lambda sh,pg:dict(sha256=sh,url=s.source(sh)['url'],pages=pg,cover_pages=[])
ref=dict(paragraph='Decision appealed',quote='final reading to the Bylaw amendment on the 21st day of June, 2019',source_sha256=SH,source_pages=[1])
labels=['May 13, 2019 Planning #9 resolution','PH-ZD.2-015 adoption and readings sheet','Bylaw PH-ZD.2-015 as attached']
g=dict(record_id=rid,country='CA',jurisdiction='pe',court='Island Regulatory and Appeals Commission',court_file='LA19009',family='pe-IRAC-LA19009',proceeding="Brown’s Volkswagen and others v. City of Charlottetown",subject='Industrial zoning amendment, public notice and alleged conflicts of interest',document='Notice of Appeal dated July 9, 2019',document_type='notice_of_appeal',date='2019-07-09',sworn_date=None,deponent=None,referring_document=dict(source_files=[part(SH,[1,2])],inventory_notes='Complete signed notice and its full continuation. All four attached pages retained. Generic legislative provisions are authorities rather than additional factual targets.'),exhibits=[],events=[],coverage=dict(full_inventory=True,full_body_pages=[1,2],all_attached_pages=[3,4,5,6],public_attachment_count=3,unavailable_attachment_count=0,source_limitations='No alphabetic exhibit labels. Readings sheet has an unreconciled May 17 recital versus June 17 first-reading fields. Blank ministerial approval cannot establish an effective date. OCR omits important handwriting; full original images govern, transcription fidelity remains pending.'))
for label,pages,desc,date in [(labels[0],[3],'Complete May 13 resolution approving the proposed industrial-use amendment, annotated carried 6–4 and identifying opposing councillors.','2019-05-13'),(labels[1],[4],'Complete adoption/readings sheet with handwritten voting and referral annotations; June 17 first-reading fields conflict with a printed May 17 recital.',None),(labels[2],[5,6],'Complete two-page amending bylaw including definition, June 17 and June 21 certification fields, June 26 certification signature date and unsigned ministerial approval.',None)]:
 g['exhibits'].append(dict(label=label,description=desc,date=date,author='City of Charlottetown',availability='available_complete_as_filed',source_files=[part(SH,pages)],references=[ref],aliases=['attached decision','amendment to the Zoning Bylaw'],notes='Named source instrument; no invented Exhibit A. Attachment boundaries checked against all original images.'))
def ev(date,p,q,claim,attr='Appellants’ allegation or requested relief',image=False,links=None):
 x=dict(event_id=f'e{len(g["events"])+1:02}',date=date,end_date=None,date_precision='day' if date else 'undated',event=claim,quote=q,source_sha256=SH,source_pages=[p],exhibits=links or [],attribution=attr)
 if image:x['quote_verification']='original_image'
 g['events'].append(x)
ev('2019-07-09',1,'JUL 09 2019','IRAC stamps the signed notice received July 9; counsel Nicole M. McKenna signs for the appellants on the same date.','Original receipt stamp and signature',True)
ev(None,2,'Cathy Feener, Resident','The appellants are Jamie Brown for Brown’s Volkswagen, Warren Phillips for Phillips Suzuki, Tim Kember for Centennial Auto Group and resident Cathy Feener.','Complete party list')
ev('2019-05-13',1,'13th','The notice identifies the May 13 Council decision to permit asphalt, aggregate and concrete plants in Heavy Industrial M-2.','Notice description of appealed decision',links=labels)
ev('2019-06-21',1,'final reading','The notice identifies June 21 as final reading, distinguishing it from the May 13 resolution.','Notice chronology',links=labels)
ev(None,2,'failed to comply with the notice provisions','Appellants allege failure to comply with statutory and municipal notice requirements.')
ev(None,2,'proper and adequate notice','Appellants allege the public received inadequate notice of the proposed amendment.')
ev(None,2,'did not have the opportunity','Appellants allege residents and interested persons lacked an opportunity to make representations.')
ev(None,2,'inconsistent with the City’s Official','Appellants allege the amendment conflicts with the Official Plan.')
ev(None,2,'sound planning principles','Appellants allege failure to apply sound planning principles.')
ev(None,2,'conflict of interest, real or perceived','Appellants allege councillors, Planning Board members or City employees failed to declare real or perceived conflicts; this is not a finding of misconduct.')
ev(None,2,'otherwise failed to comply','Appellants additionally allege noncompliance with the Planning Act and municipal bylaws.')
ev(None,2,'upon receipt of','Appellants reserve further grounds after receiving the complete decision record; the notice does not establish what later grounds were advanced.')
ev(None,1,'null and void','Appellants request allowance of the appeal, quashing and a declaration of invalidity; no such relief is granted by the notice.')
ev('2019-05-13',3,'6-4','The attached Planning #9 resolution is annotated carried 6–4, contrary to OCR reading the final digit as 1.','Original handwritten voting result',True,[labels[0]])
ev('2019-06-17',4,'June 17, 2019','The first-reading and first-approval fields are June 17; a later printed recital instead says first approved May 17. Both source statements remain unreconciled.','Original reading sheet',True,[labels[1]])
ev('2019-06-21',6,'21st','The bylaw certification records second reading, approval and adoption June 21.','Original handwritten certification',True,[labels[2]])
ev('2019-06-26',6,'June 26, 2019','The Chief Administrative Officer dates the true-copy certification June 26. This is not ministerial approval.','Original certification signature date',True,[labels[2]])
ev(None,6,'date as signed by the Minister','The effective-date clause depends on ministerial signature, but the published attachment leaves the ministerial signature/date blank; effectiveness is not established here.','Attached bylaw and blank approval block',links=[labels[2]])
spec=dict(record_id=rid,lane='atlantic-north',jurisdiction='pe',body_sha256=SH,body_pages=[1,2],sources=[dict(sha256=SH,role='Complete notice and all actual attachments; inspect every image including handwritten reading conflicts and unsigned ministerial approval.',pages=list(range(1,7)),image_pages=list(range(1,7)))],source_cautions='Direct author read all six original images and all text. No sworn affidavit claim. Resolution vote is 6–4, not OCR 6–1. June 17 fields versus May 17 recital are unresolved; do not silently normalize. Complete opposing response exists but its full merits have not been inspected by direct author; no counterparty fidelity claim. Review full source and every target, expand material chronology if needed.')
materialize(g,spec,[(SH,list(range(1,7)))],[])
