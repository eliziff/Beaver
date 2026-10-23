"""Revised Ontario capacity-auction expert evidence: explicit original-source Gold."""
from pathlib import Path
import json, fitz, re

O = Path('benchmarks/local-data/affidavit-association/expansion-2/regulatory')
K = 'd614b710eacc261b99c24af78b7cc65259d8052a45398d360fcdbd69888ecec1'

def main():
    acquisitions = json.loads((O/'acquisitions.json').read_text(encoding='utf-8'))
    row = next(r for r in acquisitions if K in r.get('output', ''))
    doc = fitz.open(row['output'].strip().split('\t')[-1])
    contact = json.loads((O/'plans/rivard-contact.json').read_text(encoding='utf-8'))
    p = dict(record_id='reg2-oeb-ampco-rivard-20191121', country='CA', jurisdiction='on',
             court='Ontario Energy Board', court_file='EB-2019-0242', family='on/oeb/EB-2019-0242',
             proceeding='AMPCO review of IESO transitional capacity auction market rule amendments',
             document_type='affidavit', document='Revised affidavit and expert evidence of Brian Rivard, sworn November 21, 2019',
             deponent='Brian Rivard', sworn_date='2019-11-21', source_sha256=K,
             affidavit_pages=[3]+list(range(8,58))+list(range(710,718)), text_policy='native_or_scan_ocr',
             inspected_image_pages=contact['inspected_image_pages'], exhibits=[], events=[], distractors=[],
             source_gold_scope='Complete revised referring instrument, its eight separately appended figures, and all actual content pages of fourteen certified exhibits A–N. Complete filed excerpts remain complete targets even where the underlying publication is longer.',
             hardness=['opposing_experts_in_same_market_rule_review', 'fourteen_own_labels_and_other_affiants_reused_I_J_labels', 'collective_320_page_hourly_dataset', '2015_and_2019_near_twin_PJM_reports', 'revised_figures_appended_after_last_exhibit', 'index_vs_intrinsic_date_conflict', 'foreign_regulatory_comparators_with_distinct_Ontario_market_structure', 'native_mathematical_fonts_and_signed_scans'],
             notes='This is one revised Canadian affidavit, not separate records for its November 8 original evidence date and November 21 revision. The sworn jurat is November 21. The signed Form A is dated November 8. The compiled index calls F March 18, 2019, but the actual FERC NOPR is March 18, 2010. Own I/J are PJM demand-response report excerpts; Short’s I/J are different instruments expressly attributed to him in footnotes 16/17. The DR Corp./GEN Corp. examples are hypothetical, not historical corporate transactions. All economic and policy conclusions are Rivard’s expert opinions, not Board findings. Figures 1A–4B follow the end of N at physical pages 710–717 and belong to Rivard’s referring evidence, not the Brown/Sappington paper. No foreign proceeding is being counted.',
             boundary_notes='Referring cover3, contents/body8–57, separately appended figures710–717. Body ends with signed jurat at57 (printed50of51); source58 is TAB A, not a missing body page. Exhibit content A60; B63–67; C70–133; D136–156; E159–183; F186–224; G227–235; H238–557; I560–583; J586–617; K620–639; L642–656; M659–680; N683–709. Each is preceded by its standalone certification and an outer TAB divider. M includes its as-filed publisher advertisement at680. No intrinsic document page, blank report verso, table, bibliography or mathematical appendix is removed.',
             source_conflicts=[dict(source_pages=[5,186], description='Compiled index dates F March 18, 2019; actual FERC NOPR title page says March 18, 2010.'),
                               dict(source_pages=[22], description='Paragraph 33 says the IESO working-group example was presented March 11, 2018; footnote17 identifies the underlying presentation as March 1, 2018. Neither is silently substituted.'),
                               dict(source_pages=[8,57,58], description='Pagination claims 51 pages, but the supplied continuous referring body runs printed1–50 and is followed immediately by TAB A. All supplied pages are retained; no unseen page51 is invented.')],
             referenced_not_attached=[])
    p['text_page_overrides']={f'{K}:57':f'source-text/{K}/0057.native-with-visible-name.txt',f'{K}:238':f'source-text/{K}/0238.native-with-visible-header.txt'}
    specs = [
      ('A',60,60,59,2,10,'2019-11-08','day','Brian Rivard’s signed Form A acknowledgement of expert duty.'),
      ('B',63,67,62,4,10,None,'undated','Complete five-page curriculum vitae of Brian Rivard, including employment history, selected engagements and publications.'),
      ('C',70,133,69,28,19,'2019-10-15','day','IESO Market Manual 4, Part 4.3: Real-Time Scheduling of the Physical Markets, Issue 56.0, effective October 15, 2019; complete filed 64-page manual.'),
      ('D',136,156,135,49,34,'2019-07','month','Brian Rivard, Don’t leave me stranded: What to do with Ontario’s Global Adjustment?, complete July 2019 policy brief.'),
      ('E',159,183,158,51,35,'2018-12','month','Market Surveillance Panel, The Industrial Conservation Initiative: Evaluating its Impact and Potential Alternative Approaches, complete December 2018 report.'),
      ('F',186,224,185,54,40,'2010-03-18','day','FERC Notice of Proposed Rulemaking, Demand Response Compensation in Organized Wholesale Energy Markets, 130 FERC ¶61,213, March 18, 2010, including Commissioner Moeller’s dissent. Index incorrectly says 2019.'),
      ('G',227,235,226,59,43,'2011-06-29','day','Lin Xu, California ISO, Demand Response Net Benefits Test, June 29, 2011, including mathematical appendix.'),
      ('H',238,557,237,66,47,None,'undated','Complete 320-page IESO hourly dataset supplied for January 1, 2018 through October 28, 2019, not a standalone dated report. All actual filed rows and original table headings are retained.'),
      ('I',560,583,559,80,53,'2015','year','Monitoring Analytics, 2015 Quarterly State of the Market Report for PJM: January through June, complete filed Section 6 Demand Response excerpt, printed205–228, including final nearly blank report page.'),
      ('J',586,617,585,80,53,'2019','year','Monitoring Analytics, 2019 Quarterly State of the Market Report for PJM: January through June, complete filed Section 6 Demand Response excerpt, printed287–318, including final nearly blank report page.'),
      ('K',620,639,619,82,53,'2019','year','Steve Dahlke and Matt Prorok, Consumer Savings, Price, and Emissions Impacts of Increasing Demand Response in the Midcontinent Electricity Market, The Energy Journal, complete filed paper, printed243–262.'),
      ('L',642,656,641,83,54,'2013-10','month','Kai Van Horn, Isaac Castillo and George Gross, Fixing FERC’s Order No. 745, The Electricity Journal, October 2013, complete filed paper.'),
      ('M',659,680,658,84,54,'2016','year','Xu Chen and Andrew N. Kleit, Money for Nothing? Why FERC Order 745 Should have Died, The Energy Journal37(2), printed201–221 plus as-filed publisher advertisement.'),
      ('N',683,709,682,85,55,'2016-04-04','day','David P. Brown and David E. M. Sappington, On the optimal design of demand response policies, Journal of Regulatory Economics49:265–291, published online April 4, 2016; complete paper and mathematical proofs.')]
    for label, first, last, cover, para, n, date, precision, desc in specs:
        e = dict(label=label, date=date, date_precision=precision, description=desc,
                 kind='expert_acknowledgement' if label=='A' else 'expert_qualifications' if label=='B' else 'technical_economic_evidence',
                 author={'A':'Brian Rivard','B':'Brian Rivard','C':'Independent Electricity System Operator','D':'Brian Rivard','E':'Market Surveillance Panel','F':'Federal Energy Regulatory Commission','G':'Lin Xu / California ISO','H':'Independent Electricity System Operator','I':'Monitoring Analytics LLC','J':'Monitoring Analytics LLC','K':'Steve Dahlke and Matt Prorok','L':'Kai Van Horn, Isaac Castillo and George Gross','M':'Xu Chen and Andrew N. Kleit','N':'David P. Brown and David E. M. Sappington'}[label],
                 source_pages=list(range(first,last+1)), source_cover_page=cover,
                 references=[dict(paragraph=para, quote=f'Exhibit “{label}”', source_pages=[n])], completeness='complete_as_filed')
        if label=='H': e['data_coverage']=dict(start_date='2018-01-01',end_date='2019-10-28',hours_claimed_by_affiant=15984)
        if label=='N': e['date_basis']='Actual publication-online date on physical683; body and compiled index give only year2016.'
        if label=='A':
            e['text_extraction_limit']='Native text omits the rasterized signed date. Literal transcription supplies only the visible raster date and Signature label; original image independently inspected, and erroneous OCR date excluded.'
            p.setdefault('text_page_overrides',{})[f'{K}:60']=f'source-text/{K}/0060.native-with-visible-date.txt'
        p['exhibits'].append(e)
    def ev(date, precision, paragraphs, n, description, quote, links=(), **extra):
        p['events'].append(dict(id=f'e{len(p["events"])+1}', date=date, precision=precision, paragraphs=paragraphs,
                                description=description, quote=quote, source_pages=[n], exhibits=list(links), **extra))
    ev(None,'undated',[1,2,3,4],10,'Rivard identifies his Ivey research and teaching roles, testifies for KCLP, describes his economics qualifications and prior Competition Bureau work, and binds signed Form A and CV.', 'Kingston CoGen Limited Partnership', ['A','B'])
    ev('2000','year',[5],11,'After LECG consulting, Rivard joined the IESO as Senior Economic Advisor in Market Assessment and Compliance, reporting to the Market Surveillance Panel.', 'in 2000 as a Senior Economic Advisor', ['B'])
    ev('2006','year',[6],11,'He became Manager of Economics, assessing wholesale market design and policy effects.', 'In 2006', ['B'])
    ev('2010','year',[7],11,'He became Manager of Regulatory Affairs and Sector Policy Analysis and represented the IESO on the ISO-RTO Council Markets Committee during FERC Order745 development.', 'In 2010', ['B'])
    ev('2013','year',[8],11,'He became Director of Markets; the following page describes overseeing the OPA program transfer and initiating the demand response auction.', 'In 2013', ['B'])
    ev('2015','year',[9],12,'He left the IESO for Charles River Associates International as a Principal in its Energy Practice.', 'In 2015', ['B'])
    ev(None,'undated',[10,11,12],12,'He describes current energy research and education duties, Energy Journal peer review, professional membership, occasional teaching and previous OEB testimony; the next page continues his prior FERC testimony.', 'peer reviewer for the Energy Journal', ['B'])
    ev(None,'undated',[13,14,15],13,'KCLP retained him to assess AMPCO’s appeal. He distinguishes the TCA’s new non-committed generator participation and economic activations from separately compensated tests and reliability or emergency activations.', 'MR-00439-R00-R05')
    ev('2019-09-26','day',[15],13,'Footnote3 identifies AMPCO’s Notice of Appeal as filed September26,2019; this is the appeal filing date, not Rivard’s execution date.', 'filed September 26, 2019')
    ev(None,'undated',[16,17,18,19],14,'Counsel also asked him to address Procedural Order2’s request for comparable-market experience. His organized analysis addresses AMPCO’s alleged inequity, competition effects and the applicability of FERC745.', 'Procedural Order No. 2')
    ev(None,'undated',[19,20,21],15,'Rivard concludes that the amendments are equitable and efficient, while accurately attributing the opposite inequity and displacement assertions to AMPCO rather than adopting them as established facts.', 'In my opinion, the Amendments')
    ev('2019-10-11','day',[21],16,'He attributes AMPCO’s competing revenue-stream and activation-cost analysis to Colin Anderson’s October11 affidavit, particularly paragraphs12–19.', 'sworn October 11, 2019')
    ev(None,'undated',[22,23,24,25,26],17,'He distinguishes legitimate avoidable activation costs from an unsupported assumption that every curtailed load needs an extra payment, contrasting generation fuel costs and the value of lost load.', 'avoidable costs')
    ev('2019-10-25','day',[25],18,'Footnote16 expressly attributes the Navigant demand-response discussion paper to Exhibit I of David Short’s October25 affidavit. That cross-affiant I is not Rivard’s own PJM Exhibit I.', 'Exhibit “I” to the Affidavit of David Short')
    ev(None,'undated',[27,28,29,30],19,'He explains five-minute dispatchable-load instructions and the different hourly demand-response standby, notice and four-hour activation arrangements under the attached manual; bid choices manage the risk of uneconomic lost load.', 'section 7.2', ['C'])
    ev(None,'undated',[31,32,33],21,'He introduces horizontal equity and contrasts it with normative vertical equity before constructing hypothetical DR and generator examples.', 'Horizontal equity')
    ev(None,'conflicting',[33],22,'The narrative dates the IESO working-group example March11,2018, while footnote17 dates the presentation March1,2018. Preserve both claims without assigning one event date.', 'March 11, 2018', alternative_dates=['2018-03-11','2018-03-01'])
    ev(None,'hypothetical',[34,35,36,37,38,39],22,'DR Corp. and GEN Corp. are illustrative companies with the same physical generator and load but different metering. The examples compare capacity offer incentives with and without extra demand-response energy payments; these are not actual corporate transactions.', 'Consider two companies, DR Corp. and GEN Corp.')
    ev(None,'hypothetical',[40,41,42,43],29,'The second hypothetical raises DR fixed avoidable costs while retaining the generator’s lower costs, illustrating his opinion that an extra DR payment can reverse efficient capacity-offer rankings.', 'Figure 2')
    ev(None,'hypothetical',[44,45,46,47],32,'The third hypothetical gives generation a lower variable cost and distinguishes gross energy receipts from net revenue and avoided consumption cost. He argues only net generation revenue offsets its capacity offer.', 'Figure 3')
    ev('2005','year',[48,49],34,'He says the Global Adjustment was established in2005, then describes its contemporary45–60percent share of a typical bill and binds his July2019 policy brief.', 'established in 2005', ['D'])
    ev(None,'undated',[50,51,52],35,'He describes Industrial Conservation Initiative allocation by the five annual peak hours, contrasts ClassA with ClassB, and uses a fourth hypothetical to argue behind-the-meter generation receives an avoided-Global-Adjustment advantage.', 'highest five peak hours', ['D','E'])
    ev(None,'undated',[53,54,55,56],40,'He describes FERC745’s wholesale-market participation rationale, net-benefits condition and investment barriers. Its attached NOPR is an earlier procedural instrument, not the final rule itself.', 'Notice of Proposed Rule Making', ['F'])
    ev(None,'undated',[57,58,59,60,61,62,63,64,65],43,'Using the CAISO diagram, he distinguishes total societal efficiency from non-DR consumer benefits and argues Ontario’s Global Adjustment and net exports can defeat the United States-style benefits calculation.', 'net benefits test', ['G'])
    ev('2018-01-01','day',[66,67],47,'IESO supplied hourly observations through October28,2019. Rivard reports15,984 observations, of which14,436 satisfy his sufficient failure condition and1,548 remain for price analysis. These are his calculations, not independent findings.', '15,984 hours', ['H'], end_date='2019-10-28')
    ev(None,'undated',[68,69],48,'Among the remaining hours, he reports only17 with HOEP above100dollars per MWh and attributes higher actual DR bid prices to IESO working-group analysis.', 'only 17', ['H'])
    ev(None,'undated',[70,71,72,73],49,'He reports only three hours above200dollars per MWh, concludes the proposed benefits test would rarely pass, and identifies forecast inputs and the risk of blunt monthly thresholds.', 'only 3', ['G','H'])
    ev(None,'undated',[74,75,76],50,'He contrasts FERC’s historic wholesale-versus-retail participation barriers with present Ontario exposure to real-time prices; Navigant’s quoted analysis appears on the following page.', 'barriers to participation', ['F'])
    ev('2007','year',[77],51,'He dates the Ontario DR3 program to2007 and describes multi-year availability and utilization payments intended to fund responsiveness investments.', 'As early as 2007')
    ev('2015','year',[77],52,'He says the former OPA DR3 program was integrated into the IESO market through capacity-backed demand response and the demand response auction in2015.', 'In 2015')
    ev('2016','year',[78],52,'Quoting the Market Surveillance Panel, he reports42percent peak consumption reduction and an estimated520,000dollar Global Adjustment saving for a one-MW reduction in each of five2016peak hours.', '42% during peak demand conditions in 2016', ['E'])
    ev(None,'undated',[79,80,81],53,'His expressly non-exhaustive literature scan compares2015 and2019 PJM demand-response sections, including activity and monthly threshold prices; the source’s statement that elevated levels continued through2019 and then subsided is preserved as written.', 'non-exhaustive', ['I','J'])
    ev('2012-04','month',[80,81],53,'He dates PJM implementation of FERC745 to April2012 and attributes a subsequent activity increase to the compared PJM reports.', 'starting in April 2012', ['I','J'])
    ev('2019','year',[82],53,'He cites Dahlke and Prorok’s MISO study of consumer, emissions and price effects, continuing on the next page to its warning that load shifting can offset peak-hour benefits.', 'Steve Dahlke and Matt Prorok', ['K'])
    ev('2013-10','month',[83],54,'He cites Van Horn, Castillo and Gross’s net-benefits-test critique concerning transmission and distribution of consumer benefits.', 'October 2013', ['L'])
    ev('2016','year',[84],54,'He cites Chen and Kleit’s empirical concern that demand-response participants may inflate customer baseline loads.', 'customer baseline load', ['M'])
    ev('2016','year',[85],54,'He cites Brown and Sappington’s optimal-policy analysis, continuing on the next page to its conclusion that full-LMP payments can overcompensate demand response and reduce welfare.', 'David Brown and David Sappington', ['N'])
    ev(None,'undated',[86,87,88,89,90,91,92,93],55,'His final conclusions reject AMPCO’s alleged inequity, favour the amendments and argue Ontario’s existing incentives, Global Adjustment and implementation costs make FERC745-style energy compensation inappropriate. These remain attributed expert opinions.', 'SUMMARY CONCLUSIONS', ['C','D','E','F','G','H','I','J','K','L','M','N'])
    ev('2019-11-08','day',[],3,'The revised affidavit retains November8 as the evidence’s original date; that is distinct from the November21 revised execution.', 'November 8, 2019')
    ev('2019-11-21','day',[93],57,'The final signed jurat records swearing in the Town of Paris on November21,2019. The commissioner’s2022expiry is not an affidavit date.', '21st day of November, 2019', list('ABCDEFGHIJKLMN'))
    ev('2010-03-18','day',[],186,'The actual FERC notice is dated March18,2010, contrary to2019in the compiled index.', '(March 18, 2010)', ['F'])
    ev('2011-06-29','day',[],227,'The attached CAISO net-benefits paper identifies Lin Xu and June29,2011 on its title page.', 'June 29, 2011', ['G'])
    ev('2016-04-04','day',[],683,'The Brown and Sappington paper records publication online on April4,2016, a more precise intrinsic date than the referring body’s year-only citation.', 'Published online: 4 April 2016', ['N'])
    ev('2019-11-21','day',[],1,'The filed cover letter explains the revised DR/GEN labels, corrected Figure3marginal cost, corrected Figure4Bsettlements and negative-number colour conventions. Appended figures710–717 preserve the revised versions in full.', 'November 21, 2019')
    for key, pages, title in [('f3c626257ea2b1ba445f3d9205ed02ddbbffd1c50572fd5c64bf1acbbfdc6bd1',list(range(1,6)),'Colin Anderson sworn affidavit, October 11, 2019'),('31e93c24d1a92807ff8005700ddec928ec7e968070a88ef15eeb613448dfa13f',list(range(5,14)),'David Short sworn affidavit, October 25, 2019')]:
        r=next(r for r in acquisitions if key in r.get('output',''))
        p['distractors'].append(dict(id=key[:12]+'-body',same_proceeding=True,source_sha256=key,source_url=r['url'],canonical_source_path=r['output'].strip().split('\t')[-1],source_pages=pages,description=title,near_miss_rationale='Complete competing sworn referring body in the same AMPCO market-rule review, addressing the same demand-response compensation issues with different authorship, positions and own exhibit bindings. Only the body is used here; nested attachments are not silently treated as different documents.'))
    p['referenced_instruments']=[dict(name='Affidavit of Colin Anderson',reference_source_pages=[16,17],reference='Paragraph21 and footnotes11–14',source_sha256=p['distractors'][0]['source_sha256'],source_pages=list(range(1,6)),role='Explicitly cited competing evidence; not one of Rivard’s own fourteen certified exhibits.'),dict(name='Affidavit of David Short',reference_source_pages=[18,22],reference='Footnotes16–17',source_sha256=p['distractors'][1]['source_sha256'],source_pages=list(range(5,14)),role='Explicit source of the separately attributed Navigant I and IESO March1presentation J; not Rivard own I/J.'),dict(name='Navigant Demand Response Discussion Paper',reference_source_pages=[18,51],source_sha256=p['distractors'][1]['source_sha256'],source_pages=list(range(209,256)),source_alias='Exhibit I to David Short affidavit',role='Named other-affiant attachment, not Rivard own I.'),dict(name='IESO Presentation to Demand Response Working Group on Utilization Payments Discussion',date='2018-03-01',reference_source_pages=[22,48,49],source_sha256=p['distractors'][1]['source_sha256'],source_pages=list(range(258,276)),source_alias='Exhibit J to David Short affidavit',role='Named other-affiant attachment, not Rivard own J. Body paragraph33’s March11date conflicts with the explicit footnote17date.')]
    full_ranges={1:[10],5:[11,12],7:[12,13],8:[13,14],10:[14,15],11:[15,16],12:[16,17],13:[17,18],15:[19,20,21],16:[21,22],18:list(range(22,29)),19:list(range(29,32)),20:[32,33,34],22:list(range(35,40)),23:[39,40,41,42],24:[43,44,45,46],27:[49,50],28:[50,51],30:[52],35:[53,54],37:[54,55],38:[55,56,57],44:[1,2,710,711,712,713,714,715,716,717]}
    for e in p['events']:
        i=int(e['id'][1:])
        if i in full_ranges: e['source_pages']=full_ranges[i]
    for section in ['events','exhibits']:
        for item in p[section]:
            item['description']=re.sub(r'(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])',' ',item['description'])
    (O/'plans/rivard.json').write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

if __name__=='__main__': main()
