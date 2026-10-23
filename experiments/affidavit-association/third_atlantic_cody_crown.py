"""Whole Crown criminal-delay record, preserving ASF versions and actual report excerpt."""
from third_atlantic_sources import s,O
from third_atlantic_direct import materialize
import re
rid='an3-nl-cody-crown-factum-20170307';sh='f8c6396488fdea159ff59411ddecc3d0295e05e7af543b35a75f0737d7851573';ap='523d2115985adba15b4d612928113c0fbb8e0a5aadd6f4adca76e47fd45bcf38'
def part(d,p):return dict(sha256=d,url=s.source(d)['url'],pages=p,cover_pages=[])
g=dict(record_id=rid,country='CA',jurisdiction='nl',court='Supreme Court of Canada, on appeal from Newfoundland and Labrador',court_file='37310',family='ca-SCC-37310-Cody',proceeding='James Cody v. Her Majesty the Queen',subject='Criminal delay, competing disclosure and waiver accounts, corrected agreed facts and multiple rulings',document='Factum of the Respondent, Her Majesty the Queen',document_type='respondent_factum',date='2017-03-07',sworn_date=None,deponent=None,author='Croft Michaelson and Vanita Goela',referring_document=dict(source_files=[part(sh,list(range(1,43)))],inventory_notes='Complete main factum1–42: covers, contents, all119paragraphs, dated closure, authority tables. Actual labelled Appendix1 occupies43–48, all six filed excerpt pages. Entire48-page original accounted, no arbitrary excerpting.'),exhibits=[],events=[],coverage=dict(full_body_pages=list(range(1,43)),full_original_pages_accounted=list(range(1,49)),source_inventory_complete=True,source_limitations='All48pages read, including complete actual report excerpt. Original date and literal3013 typo images inspected; closure signature lines are blank. Full opposing32-page factum retained, explicitly substantially accepted and separately disputed at paragraph5. The complete public Martin excerpt is not the whole1993 report. All underlying own-case records, affidavit, ASF versions, hearing transcripts and identified rulings remain explicit unlocated originals; full citation inventory is additionally retained below. Generic legal authorities are not invented factual exhibits. No confidential informer identity reconstructed.'),selection_tags=['Newfoundland_criminal','ASF_original_vs_excised','many_precisely_dated_transcripts','source_date_typos','majority_dissent_Crown_arithmetic','complete_report_excerpt'])
def ex(l,d,p,q,digest=None,pages=None,date=None,n=''):
 g['exhibits'].append(dict(label=l,description=d,date=date,source_files=[part(digest,pages)]if digest else [],availability='complete_public_original'if digest else 'referenced_original_not_located',references=[dict(source_sha256=sh,source_pages=[p],quote=q)],notes=n))
ex('Appellant’s factum','Complete32-page opposing factum, facts substantially accepted and paragraph5 specifically invoked.',7,'facts set out in the appellant’s factum',ap,list(range(1,33)),n='Limited substantial agreement does not adopt every characterization; current Crown supplies a much fuller contrary account. Opposing document is a true positive.')
ex('Appendix1 — Martin Report excerpt','Complete six-page filed excerpt: report cover, underlying pages179/180/182, recommendations cover and recommendation page5.',5,'Appendix 1',sh,list(range(43,49)),'1993',n='Complete as actually filed, deliberately nonconsecutive source pages; do not invent missing page181 or claim full underlying report. Recommendation32 about withholding until counsel agrees not to share remains present alongside34/35 relied on by Crown. Explicit real attachment, not padding every generic authority.')
for l,d,p,q,date in [
 ('Cst Monica Murphy affidavit','RRVolumeI Tab1 actual affidavit, pages1–9.',7,'Affidavit of Constable Monica Murphy',None),
 ('Agreed Statement of Facts — signed version','RRVolumeI Tab28 actual193-paragraph31-page document signed May6,2013; later errors in168/174/180 identified.',14,'Agreed Statement of Facts, signed May 6, 2013','2013-05-06'),
 ('Excised ASF and reopened evidence','Later corrected facts and reopened witness evidence, distinct from entire original signed ASF.',18,'excise the errors',None),
 ('Indictment','Actual AppellantSupplementaryRecordTab1 indictment, two pages.',8,'Tab 1, Indictment',None),
 ('2013 NLTD(G)181','Actual initial search/arrest Charter ruling, December20,2013.',7,'2013 NLTD(G) 181','2013-12-20'),
 ('2014 NLTD(G)52','Actual ruling on ASF error and abuse/process arguments.',15,'2014 NLTD(G) 52','2014'),
 ('2014 NLTD(G)72','Actual reopened Charter voir-dire ruling after June24 evidence.',18,'2014 NLTD(G) 72','2014'),
 ('2014 NLTD(G)100','Actual recusal ruling, separate from earlier merits/ASF rulings.',18,'2014 NLTD(G) 100','2014-09-10'),
 ('2014 NLTD(G)161','Actual section11(b) stay ruling and delay chart.',19,'2014 NLTD(G) 161','2014'),
 ('2016 NLCA57','Actual full appellate reasons including Hoegg/Welsh majority and White dissent.',19,'2016 NLCA 57','2016-10-24'),
 ('Disclosure CDs and undertaking','Original two-CD disclosure offer with restrictions and proposed undertaking, not complete originals supplied by this factum.',9,'two CDs',None),
 ('Crown initial disclosure correspondence','RRVolumeI Tab3 actual Crown-to-defence letter.',9,'Tab 3, Correspondence',None),
 ('Crown July15/August6 correspondence','RRVolumeI Tab4 letters on without-prejudice undertaking and deemed election.',10,'August 6, 2010','2010-08-06'),
 ('Disclosure application and consent order','Actual superior-court disclosure applications and settlement order, RRI Tab6 and hearing material.',10,'a consent order',None),
 ('Change-of-counsel correspondence','RRI Tabs7/8 correspondence causing preliminary inquiry adjournment.',11,'Tabs 7-8',None),
 ('Defence delay waiver correspondence','RRI Tab9 letter and later explicit waivers, distinct from Crown’s implied-waiver argument.',11,'Tab 9',None),
 ('Counsel appointment correspondence','RRI Tabs10/11 actual counsel/court correspondence following judicial appointment.',12,'Tab 11',None),
 ('Crown April5 ASF draft letter','RRI Tab15 sending draft to defence for review.',14,'April 5, 2013','2013-04-05'),
 ('Crown July8 ASF filing letter','RRI Tab16 letter providing signed ASF to court.',14,'July 8, 2013','2013-07-08'),
 ('Crown misconduct-disclosure letter','RRI Tab19 original letter reporting potential misconduct issue.',13,'Tab 19',None),
 ('Officer discipline record and information','Actual record of disciplinary proceedings, information and additional documents disclosed June2013.',13,'record of proceedings, the information',None),
 ('Crown January2014 error letter','Letter reproduced in later ASF ruling paragraph9; underlying complete letter independently unlocated.',15,'reproduced at para. 9',None),
 ('November25 delay application','Actual defence stay application for unreasonable delay.',19,'November 25, 2014','2014-11-25'),
 ('Respondent’s Record','Collective multi-volume own-case record containing affidavits, correspondence and precisely dated transcript excerpts.',7,"Respondent's Record",None),
 ('Appellant’s Record','Collective own-case record containing stay and appeal reasons, not the factum itself.',19,"Appellant's Record",None),
 ('Appellant’s Supplementary Record','Collective supplementary record with indictment and five distinct ruling versions.',7,"Appellant's Supplementary Record",None)]:ex(l,d,p,q,date=date,n='Full original not independently acquired; quotation and nested record citation do not establish complete original bytes. All underlying references retained verbatim in primary and in citation inventory. Exact official appellate download failed; date supported by retained official discovery, not guessed from citation year.')
# Retain every underlying record-citation paragraph, including all exact dated transcript tabs,
# without pretending that grouped unavailable records are complete public targets.
g['source_reference_inventory']=[]
for p in range(7,40):
 t=(s.views_folder(s.source(sh))/f'page-{p:04}.txt').read_text('utf8')
 for block in re.split(r'\n(?=\d{1,3}\s+(?:Respondent|Appellant))',t):
  if re.match(r'^\d{1,3}\s+(?:Respondent|Appellant)',block):
   g['source_reference_inventory'].append(dict(source_sha256=sh,source_pages=[p],quote=block.strip(),availability='underlying_record_not_independently_located',scope='Complete literal citation block, preserving transcript date/tab/page/line aliases and nested original instrument titles; not a claim the underlying originals are supplied.'))
def ev(p,q,text,date=None,end=None,labels=None):g['events'].append(dict(event_id=f'e{len(g["events"])+1:02}',date=date,end_date=end,date_precision={4:'year',7:'month',10:'day'}.get(len(date),'undated')if date else 'undated',event=text,quote=q,source_sha256=sh,source_pages=[p],exhibits=labels or [],attribution='Crown’s account, attributed prior judicial finding or express contested characterization; not independent findings of guilt or counsel misconduct'))
rows=[
 (7,'September 2009','Police investigated an interprovincial operation from September2009 until the January2010 arrests.','2009-09',None,['Cst Monica Murphy affidavit']),
 (7,'January 12, 2010','Crown recounts arrest after the appellant first became a suspect that day, distinguishing him from the long-term principal target.','2010-01-12',None,['Cst Monica Murphy affidavit','Agreed Statement of Facts — signed version']),
 (8,'a “stun gun”','Crown alleges one kilogram cocaine, half kilogram marihuana and a stun gun found in appellant’s truck; larger investigation totals are separate.',None,None,['Indictment']),
 (9,'April 22, 2010','Crown records10,000-plus initial disclosure pages, later around20,000, and ongoing privilege/privacy vetting.','2010-04-22',None,['Disclosure CDs and undertaking']),
 (9,'June 30, 2010','TwoCD disclosure was offered subject to dissemination undertaking; some counsel accepted while appellant’s counsel objected.','2010-06-30',None,['Disclosure CDs and undertaking']),
 (9,'July 8, 2010','Counsel disputed conditions and agreed superior-court direction might be needed.','2010-07-08',None,['Disclosure application and consent order']),
 (9,'July 15, 2010','Crown offered signing without prejudice to later challenge, then threatened deemed election in its August6 letter.','2010-07-15',None,['Crown July15/August6 correspondence']),
 (10,'August 18, 2010','Provincial judge entered deemed election rather than permit indefinite adjournment without waiver.','2010-08-18',None,['Disclosure application and consent order']),
 (10,'September 29 and 30, 2010','Superior-court applications led to case management, settlement and consent order allowing accused personalCD copies subject to undertaking.','2010-09-29','2010-09-30',['Disclosure application and consent order']),
 (11,'October 18, 2010','Court set preliminary inquiry for March11,2011 despite counsel not being ready to set dates or waive delay.','2010-10-18',None,[]),
 (11,'April 7, 2011','New counsel unavailability moved preliminary inquiry from March11 to April7.','2011-04-07',None,['Change-of-counsel correspondence']),
 (11,'up to April 2, 2012','Appellant expressly waived almost a year after preliminary inquiry until trial-date setting.','2011-04-07','2012-04-02',['Defence delay waiver correspondence']),
 (12,'May 1, 2012','Trial set November5–9 after discussion of possible re-election; Crown unavailable September/October because of another trial.','2012-05-01',None,[]),
 (12,'June 29, 2012','Defence re-elected judge-alone and wanted initial trial dates used for Charter application.','2012-06-29',None,[]),
 (12,'October 5, 2012','Crown learned counsel appointed to bench on or about October5, prompting another change and adjournment.','2012-10-05',None,['Counsel appointment correspondence']),
 (12,'December 3, 2012','Charter application scheduled March26,2013, then rescheduled after January14 travel-conflict advice;1.5months expressly waived.','2012-12-03',None,['Defence delay waiver correspondence']),
 (13,'May 3, 3013','Original paragraph24 literally says3013 for misconduct notice; following paragraph says MondayMay6,2013 and footnote31 separately says2012. Preserve all source errors without inventing a clean date.',None,None,['Crown misconduct-disclosure letter']),
 (13,'May 6, 2013','Parties agreed to adjourn pending possible misconduct disclosure; at this point allegation was not an established disciplinary finding.','2013-05-06',None,['Officer discipline record and information']),
 (13,'June 28, 2013','Crown reported June12 discipline and disclosure, sought summer dates; court summer limits and defence September unavailability led October hearing.','2013-06-28',None,['Officer discipline record and information']),
 (14,'May 6, 2013','Appellant and counsel signed193-paragraph31-page ASF after receiving April5 draft; Crown filed it July8.','2013-05-06',None,['Agreed Statement of Facts — signed version','Crown April5 ASF draft letter','Crown July8 ASF filing letter']),
 (14,'October 8-11 and November 19, 2013','Charter exclusion hearing occurred over separated October and November dates, not a continuous six-week hearing.','2013-10-08','2013-10-11',['2013 NLTD(G)181']),
 (14,'December 20, 2013','Trial judge refused exclusion, finding arrest grounds and no specified Charter violations; remaining trial had not thereby resulted in conviction.','2013-12-20',None,['2013 NLTD(G)181']),
 (15,'In early January','Crown notified court/defence in early January2014 of ASF facts not known to arrest-ordering officer, also affecting ruling paragraph50.','2014-01',None,['Crown January2014 error letter','Agreed Statement of Facts — signed version']),
 (16,'January 30, 2014','Defence sought time to consider functus argument and expected application by February27.','2014-01-30',None,[]),
 (16,'February 27, 2014','Counsel illness adjourned status to March6; application still not filed and argument date became March28.','2014-02-27',None,[]),
 (16,'March 28, 2014','Defence shifted from functus argument to serious ASF-defect challenge; Crown identified sentences in168/174/180, which defence called ambush.','2014-03-28',None,['Agreed Statement of Facts — signed version']),
 (17,'April 25, 2014','Defence alleged deliberate misleading or wilful blindness/negligence and sought stay; judge rejected unsupported deliberate-error assertion.','2014-04-25',None,['2014 NLTD(G)52']),
 (18,'June 24, 2014','Four witnesses recalled for cross-examination; judge found remaining evidence supported arrest after errors excised.','2014-06-24',None,['Excised ASF and reopened evidence','2014 NLTD(G)72']),
 (18,'August 22, 2014','Recusal application heard August22 and rejected September10; distinct from ASF correction rulings.','2014-08-22',None,['2014 NLTD(G)100']),
 (19,'January 26, 2015','After September10 decision trial scheduled January26–30,2015; these were future scheduled dates, not proof trial completed.','2015-01-26','2015-01-30',[]),
 (19,'November 25, 2014','Appellant sought stay for unreasonable delay; trial judge granted stay under Morin, attributing disputed intervals to Crown.','2014-11-25',None,['November25 delay application','2014 NLTD(G)161']),
 (19,'March 16, 2016','Appeal heard before Jordan was released while reserved; court invited further submissions under the new framework.','2016-03-16',None,['2016 NLCA57']),
 (23,'16 months and three days','Crown quotes appellate majority’s net-delay figure and43months6days deduction; preserve figures as quoted, alongside Crown’s different20.5months calculation.',None,None,['2016 NLCA57']),
 (23,'White, J.A. dissented.','Crown recounts dissent’s contrary attribution of disclosure/ASF delay and disputes its view misconduct evidence was unused.',None,None,['2016 NLCA57']),
 (27,'implicitly waived','Crown treats December20–January30 discussion period as implied waiver, distinct from earlier expressly documented waivers.',None,None,['Defence delay waiver correspondence']),
 (34,'actually drafted by a Crown','Crown says ASF drafted by Crown counsel despite trial/appeal descriptions of police drafting. Preserve contrary authorship accounts.',None,None,['Agreed Statement of Facts — signed version']),
 (36,'His conviction was assured.','Crown asserts conviction assured and imputes motive to delay; these are sharply contested advocacy assertions, not established guilt or misconduct findings.',None,None,[]),
 (36,'20.5 months','Crown deducts40months from60.5, obtaining20.5, distinct from quoted appellate calculation.',None,None,[]),
 (40,'7th day of March, 2017','Factum dated March7,2017; both original signature lines are blank, so personal execution is not claimed.','2017-03-07',None,[]),
 (48,'32.','Filed report excerpt also recommends against withholding disclosure unless counsel promises not to share with client; retain this potentially contrary recommendation alongside custody/control recommendations.',None,None,['Appendix1 — Martin Report excerpt'])]
for row in rows:ev(*row)
sources=[dict(sha256=sh,pages=list(range(1,49)),role='Complete48-page Crown original, primary1–42 and complete six-page actual Appendix1 report excerpt43–48.',image_pages=[1,13,23,40,43,44,45,46,47,48]),dict(sha256=ap,pages=list(range(1,33)),role='Complete32-page appellant factum: explicit substantial factual adoption plus disputed paragraph5, true opposing positive.',image_pages=[])]
spec=dict(record_id=rid,lane='atlantic-north',jurisdiction='nl',body_sha256=sh,body_pages=list(range(1,43)),sources=sources,source_cautions='All48originalpagesread; primary1–42 plus actual filedreportexcerpt43–48, not entire1993report. FullopposingAP32positive. Numerousunderlyingrecordtranscripts/affidavit/ASF versions/rulings unlocated; complete literal recordcitationinventoryretains every citedtab/date/page/line withoutfalsecompletehashes. Original3013paragraph24/2012footnote31errorspreserved. ASFpolice-versus-Crown authorshipconflict, majority16months3days versus Crown20.5months, scheduledtrialversusactualcompletion, explicitversusimpliedwaivers allretained. No informeridentityreconstruction. Genericcasesandstatutesnotpositivepadding; real actualreportappendixcompleteasfiled.')
materialize(g,spec,[(sh,[13,40,43,48])],[])
