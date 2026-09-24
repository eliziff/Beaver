# Expansion for diversity and breadth (2026-09-23)

Goal: ~30 new records filling gaps (NL, PE, QC, territories, NB/SK/MB; appellate; non-insolvency subjects; sources beyond FTI/JCCF).
Rejects go to `rejected-sources.jsonl` (scratchpad harvest.py logs its drops automatically; rej.py for manual ones).
Scratchpad helpers: harvest.py (triage), go.py (split + print), grid.py (PNG glance), md.py (matter docs), fin.py (event ids from scratchpad g/<id>.json, verify, copy to repo), rej.py.
Gold now carries `"subject"` (ledger.py reads it when present).

## Done

| id | jur | level | subject | source | exhibits | matter_docs | notes |
|---|---|---|---|---|---|---|---|
| nlsc-ppdi-inkpen | NL | superior_trial | insolvency (childcare NOI) | srstack.ca (S.R. Stack, trustee) | 12 | 2 | first NL |
| pesc-imd-coffin | PE | superior_trial | insolvency (dairy distributor NOI) | mnpdebt.ca | 4 | 2 | first PE; --covers A=6,B=9,B1=45,C=54 --ocr-affidavit (scanned jurat) |

## Leads

- Coffin family (PE): the Jan/Mar/Apr 2025 Coffin affidavits are 2 pages with no exhibits; rejected, family not buildable. Only pesc-imd-coffin exists.
- Pass 2 (resumed agent): work split among 3 sub-agents, each appending rows to its own section below.

- srstack.ca WP media (wpm.py) has NL NOIs/CCAA (Ocean View Farms, 2025 01G 4683): mostly scans.
- mnpdebt.ca engagement pages list PDFs (grep '/-/media/...pdf').

## Lane A (regions: QC-English, territories, NB/SK/MB/NL/PE; trustee/monitor sites not yet mined)

| id | jur | level | subject | source | exhibits | matter_docs | notes |
|---|---|---|---|---|---|---|---|
| nbkb-royaloaks-randall | NB | superior_trial | insolvency (golf club receivership, s.243 BIA) | insolvencies.deloitte.ca | 20 | 2 | first NB; Deloitte is Akamai-blocked for curl: fetch with scratchpad laneA/bfetch.py (headless chromium) + harvest BROWSER=<landing>; --covers (F1 missed, "0"=O); 3 image-only green tab sheets trail B/H/P |
| nlsc-kami-nagra | NL | superior_trial | insolvency (iron-ore mine receivership, Sprott lender) | insolvencies.deloitte.ca | 29 | 3 | numeric labels 1-29; credit agreement posted twice, so --covers (no p74) --drop 74 removes the repeated Exhibit 4 cover; Nagra #2/#3 have no exhibits (matter docs) |
| mbkb-356assiniboine-page | MB | superior_trial | insolvency (First Nation wellness-centre receivership; Bridging Finance receiver as creditor) | insolvencies.deloitte.ca | 30 | 3 | A-DD; --covers only to fix M read as "WT"; Deloitte doc URLs follow en-ca-insolv-<Matter>-<DocName><Date>.pdf (search the prefix in quotes) |
| mbkb-genesus-herman | MB | superior_trial | insolvency (receivership; judgment creditor's preference challenge) | bdo.ca (Genesus Inc. et al.) | 4 | 2 | family genesus; label D reads "0" in the text layer |
| mbkb-genesus-barrington2 | MB | superior_trial | insolvency (BMO receivership application, supplemental) | bdo.ca | 4 | 2 | family genesus; labels BBB-EEE (continues the 516-page first affidavit, which is 90% scanned: not built) |
| mbkb-genesus-barrington3 | MB | superior_trial | insolvency (BMO reply to Herman on the forbearance/second mortgage) | bdo.ca | 27 | 3 | family genesus; whole-page covers detected as stamps, so --covers from stamp pages (else jurat text stays on page 1); new split.py `--relabel IT=U` flag for a misread stamp |

- Lane A leads: Guru Peer Transport (MB, Deloitte, CI 25-01-55032): Abu-Qube (Dec 14 2025) and Kehler (Dec 16 2025) affidavits exist but their URLs are not guessable (Deloitte engagement pages 403 even in headless chrome; only PDFs fetch). Atlantic Oriental Wholesale (Deloitte): Liam Wilson affidavit A-J kept in raw/ (nlsc-affidavit-20of-20l-20wilson...) but it is NSSC (Hfx 532179), page 1 image-only and split.py's PyMuPDF OCR truncates it after para 4 (tesseract CLI reads it all): rejected for now. BDO SK Hardeep Singh 2026 affidavit rejected (posted PDF lacks Exhibits E-G). Quebec English (KPMG/EY) and territorial searches found nothing usable. Goshen Professional Care (SK, MNP): Onasanya affidavit's exhibit stamps are handwritten OCR noise on content pages. BDO Genesus: first Barrington affidavit (516 pp, 465 image-only) would complete the family with OCR.

## Lane B (non-insolvency subjects: class actions, human rights/Charter, employment, IP, estates, family, regulatory)

| id | jur | level | subject | source | exhibits | matter_docs | notes |
|---|---|---|---|---|---|---|---|
| fc-ibh-weistche | federal | federal_trial | class_action (Indian Boarding Homes settlement) | callkleinlawyers.com | 5 | 2 | family ibh-percival; --covers A=6,B=10,C=17,D=24,E=27 (caption covers otherwise kept as stamp pages) |
| fc-ibh-langlois | federal | federal_trial | class_action (IBH settlement + fees; Quebec subclass counsel history) | callkleinlawyers.com | 33 | 2 | family ibh-percival; 1,106 pp; --covers from first-run stamp pages; 8 image-only exhibits checked by eye; 49 events |
| fc-bccla-rcmp-moore | federal | federal_trial | charter (BCCLA mandamus vs RCMP Commissioner delay on CRCC surveillance complaint) | bccla.org | 16 | 3 | family bccla-rcmp-crcc (applicant side); --covers (O read as "0") |
| fc-bccla-rcmp-omalley | federal | federal_trial | charter (same application, respondents' affidavit) | bccla.org | 16 | 2 | family bccla-rcmp-crcc; E/F/G/L/N/O are the same letters as Moore H/I/K/N/O/P (cross-record duplicates); --covers (body mentions of "Exhibit A"/"E" of another affidavit fooled triage) |

| chrt-caring-bisson | federal | administrative_tribunal | human_rights (AFN AGA resolutions update, T1340/7008) | fncaringsociety.com | 3 | 2 | family fncfcs-chrt-t1340 (joins existing chrt-caring-* / chrt-nccc-frost by file no.); 3 near-identical draft resolutions |
| chrt-caring-dulai | federal | administrative_tribunal | human_rights (COO evidence on NCCC interested-party motion) | fncaringsociety.com | 10 | 2 | family fncfcs-chrt-t1340; F/G/J page 1 and all of I image-only (checked by eye) |

- fncaringsociety.com leads (kept in raw/, triage passed, not built): Smylie (291 pp, A-G), Farthing-Nichol Mar 2025 (1,310 pp, A-I), Farthing-Nichol Dec 2025 (1,096 pp; triage labels messy), Canada Applicant's Record FC 2026-09-09 (845 pp, several affidavits). Tribunal-timeline page links /publications/<slug> pages, each holding the PDF.
- bccla.org blocks WP REST; crawl case-sitemap.xml pages for PDFs instead (laneB/bccla-pdfs.txt). Afghan-detainee 2012 affidavits and Walia (488 pp) are image-only.

- wagners.co (NS, Air Canada AC624 class action settlement): Boyle affidavit rejected (typed EXHIBIT "X" header on each exhibit's first content page leaks); Hodara/Liboy have 2 exhibits; Reese-Byrne scanned.
- callkleinlawyers.com 2023/08 IBH set (T-1417-18): Langlois affidavit (1,106 pp, A..FF+) is a big family candidate; Klein 508 pp mostly scanned.

## Lane C (appellate levels + judicial review/administrative + families)

| id | jur | level | subject | source | exhibits | matter_docs | notes |
|---|---|---|---|---|---|---|---|
| abkb-lynx-brigley | AB | superior_trial | insolvency (CCAA, airport AIF trust claim) | FTI lynxair | 4 | 2 | family lynx-air (with abkb-lynx-lisun; appeal ABCA 2401-0244AC) |
| abkb-lynx-boyd | AB | superior_trial | insolvency (CCAA, GTAA AIF trust claim) | FTI lynxair | 17 | 2 | family lynx-air; B, L scans |
| abkb-lynx-woodward | AB | superior_trial | insolvency (CCAA, debtor's response to AIF trust claims) | FTI lynxair | 17 | 2 | family lynx-air; C is a public placeholder for a confidential exhibit (leak waived) |
| abca-lynx-watts | AB | appellate | insolvency (application for permission to appeal 2024 ABKB 514) | FTI lynxair | 19 | 2 | family lynx-air; 1,254 pp; exhibits I/L/M are the Brigley/Boyd/Woodward affidavits; new split.py `--drop` flag for the source's repeated P/Q covers; abkb-lynx-lisun gold given family lynx-air |
| abkb-lynx-jones | AB | superior_trial | insolvency (CCAA, competitor Flair on SISP access) | FTI lynxair | 4 | 2 | family lynx-air; numeric labels 1-4 |
| ondc-ohc-parkes | ON | superior_divisional | administrative (JR of LTC licence approval, Orchard Villa) | ontariohealthcoalition.ca | 3 | 2 | first Divisional Court JR; family ohc-orchard-villa-jr; 21 events |
| ondc-ohc-mehra | ON | superior_divisional | administrative (same JR) | ontariohealthcoalition.ca | 9 | 2 | family ohc-orchard-villa-jr; A = audio placeholder page; F-I web printouts without text; H 1,228 pp inspection reports |
| onsc-bill7-parkinson | ON | superior_trial | charter (Bill 7 challenge; family caregiver) | ontariohealthcoalition.ca | 11 | 2 | family ohc-bill7-charter; 20 events |
| onsc-bill7-musyj | ON | superior_trial | charter (Bill 7; respondent's hospital CEO) | ontariohealthcoalition.ca | 17 | 2 | family ohc-bill7-charter; J and K posted with identical policy text |
| onsc-bill7-meadus | ON | superior_trial | charter (Bill 7; ACE lawyer, history of LTC placement law) | ontariohealthcoalition.ca | 17 | 2 | family ohc-bill7-charter; 30 events; D/E/I/K image-only |
| onsc-bill7-mehra | ON | superior_trial | charter (Bill 7; OHC standing/advocacy) | ontariohealthcoalition.ca | 13 | 2 | family ohc-bill7-charter; G = G(i)-(iii) in one file |
| onsc-bill7-carpenter | ON | superior_trial | charter (Bill 7; respondent's expert internist) | ontariohealthcoalition.ca | 11 | 2 | family ohc-bill7-charter; URL says 2025, sworn Feb 21 2024 |

- Bill 7 leftovers in raw/c-affidavit-of-*: Heckman A-D, Arya A-C, Sinha A-D, Pelc A-D (expert reports; fewer exhibits).

- Lane C dead ends: SCC case-documents JSON posts motion files only for 40371 (scanned 38500-40800); CCLA/CELA/Ecojustice/JCCF/DemocracyWatch WP media appeal records mostly lack text exhibit covers (Grassy Narrows leave apps, Gateway Baptist, Brinton appeal record); ccla.org blocks the harvest UA (curl with a shorter UA works).
- Lane C is building from ontariohealthcoalition.ca affidavits (WP media 'affidavit': 2023 Bill 7 challenge + 2024/2025 sets, raw/c-affidavit-of-*.pdf); other lanes please skip.
- Lynx leftovers: Pon/Kwasny/Stefaniuk affidavits are image-only scans; Vuong's own exhibits after A lack text covers.

## Pass 2 summary (resumed agent, 2026-09-23)

25 new records (lanes A 6, B 6, C 12) plus family slug added to abkb-lynx-lisun. verify --all: 120/120 in data dir; the 8 ct-* records are absent from the data dir (not rebuildable while Competition Tribunal is captcha-blocked).

```
128 records; 187 matter documents; 249 rejected sources logged

by jurisdiction (10): ON 40, federal 30, AB 20, BC 15, MB 7, NS 7, SK 4, NB 2, NL 2, PE 1

by level (6): superior_trial 93, federal_trial 14, administrative_tribunal 13, appellate 4, superior_divisional 2, apex_appellate 2

by subject (7): insolvency 63, other 51, charter 7, human_rights 2, class_action 2, administrative 2, indigenous_rights 1

```

## Pass 3 (2026-09-24, target ~160 after the vetting pass)

Scratchpad additions: mkmeta.py (writes raw/<name>.meta.json), g/<id>.json gold drafts.

| id | jur | level | subject | source | exhibits | family | notes |
|---|---|---|---|---|---|---|---|
| onsc-bill7-heckman | ON | superior_trial | charter | ontariohealthcoalition.ca | 4 | ohc-bill7-charter | expert; stamps clipped header chars of A-C |
| onsc-bill7-arya | ON | superior_trial | charter | ontariohealthcoalition.ca | 3 | ohc-bill7-charter | expert; B/C cited in footnotes |
| onsc-bill7-sinha | ON | superior_trial | charter | ontariohealthcoalition.ca | 4 | ohc-bill7-charter | expert; C(ii) not attached |
| onsc-bill7-pelc | ON | superior_trial | charter | ontariohealthcoalition.ca | 4 | ohc-bill7-charter | respondent expert; B OCR'd |
| chrt-caring-smylie | federal | administrative_tribunal | human_rights | fncaringsociety.com | 7 | fncfcs-chrt-t1340 | DOJ digital-signature covers: --covers from stamp pages; B broken encoding OCR'd |
| chrt-caring-farthingnichol1 | federal | administrative_tribunal | human_rights | fncaringsociety.com | 9 | fncfcs-chrt-t1340 | jurat March 7, 2025 (cited elsewhere as March 13); --covers by page |
| onsc-cp-fresco-brown-dp | ON | superior_trial | employment (unpaid overtime CP) | sotosclassactions.com | 6 | fresco-cibc-overtime | --pages 33-89; A,D-F broken encoding OCR'd; existing onsc-cp-fresco-brown (same file no.) has no family slug |
| onsc-cp-fresco-brown-sa | ON | superior_trial | employment (unpaid overtime CP) | sotosclassactions.com | 13 | fresco-cibc-overtime | --pages 10-679; 5 scans OCR'd; fn 15 mislabels Ankura report as Exhibit J |
| nlca-wabush-meakin | NL | appellate | insolvency (CCAA monitor on the NL pension-trust Reference) | FTI bloomlake | 3 | - | first NL appellate; NM-1..3 labels; NM-1 handwritten in body; redact_text 'NM-3.' |

- CAUTION: `rebuild.py --help` is not a help flag; it rebuilds EVERY record. Pass 3 ran it by mistake (piped to head, so it died after 5): abca-jmb-doran, abca-lynx-watts, abkb-420-norrisbrown, abkb-cwb-stark, abkb-dynamic-deiure were rewritten. Checked against scratchpad text-backup (identical where backed up), OCR'd texts untouched (it failed before writing them for lack of TESSDATA_PREFIX), verify ok on all five.
- Pass 3 dead ends: WebSearch budget exhausted (200/session). Union/advocacy WP media (cupe, opseu, psac, bcgeu, unifor, etfo, bctf, ecojustice, wcel, amnesty, leaf, ccf ...) return no affidavit PDFs; cela.ca and democracywatch hits were already harvested. FTI bloomlake (QC) affidavits are mostly image-only or motions with R-n pieces; MonetteFarms is ABKB. OHC 2024 JR application record (c-application-record-...) is the source of existing ondc-ohc-* (Armstrong has 2 real exhibits). LPAT Simcoe appeal record: handwritten covers. CELA Darlington (FC T-634-13): image covers.
| chrt-caring-farthingnichol2 | federal | administrative_tribunal | human_rights | fncaringsociety.com | 15 | fncfcs-chrt-t1340 | A = nested affidavit (leak waived); B,C,L-O duplicate farthingnichol1 exhibits |
| fc-moushoom-meawasige2022 | federal | federal_trial | class_action | sotosclassactions.com (2022 settlement MR) | 4 | moushoom-fn-child-welfare | --pages 27-64; existing fc-moushoom-meawasige/kugler have no family slug |
| fc-moushoom-ciavaglia | federal | federal_trial | class_action | same MR | 5 | moushoom-fn-child-welfare | --pages 153-235 --covers (D/E image stamps) |
| onsc-cl-baffinland-glen1 | ON | superior_trial | insolvency (CCAA, EDC DIP) | FTI Baffinland | 3 | baffinland-ccaa | leak A waived (credit agreement's own form exhibits) |
| onsc-cl-baffinland-glen2 | ON | superior_trial | insolvency (CCAA, SISP control) | FTI Baffinland | 4 | baffinland-ccaa | --covers (para 25 quotes 'Exhibit BB'); B posted as the approval order |
| onsc-cl-baffinland-gordon | ON | superior_trial | insolvency (CCAA, competing DIP) | FTI Baffinland | 5 | baffinland-ccaa | counsel's correspondence affidavit |
| fc-moushoom-colish | federal | federal_trial | class_action | same MR | 17 | moushoom-fn-child-welfare | --pages 236-1867; class counsel's settlement narrative, 32 events |
| onsc-cp-bell-gortana | ON | superior_trial | class_action (defendant's evidence) | sotosclassactions.com (Bell responding record) | 3 | bell-prison-collect-calls | --pages 13-96; A image-only RFP OCR'd |
| onsc-cp-bell-herbert | ON | superior_trial | regulatory (CRTC jurisdiction) | same record | 23 | bell-prison-collect-calls | --pages 98-391; index mislabels H |
| abkb-lynx-woodward0 | AB | superior_trial | insolvency (initial CCAA) | FTI lynxair | 43 | lynx-air | numeric 1-43; five near-identical note/guarantee/GSA sets; 5 files OCR'd |
| nssc-4499127-santimaw1 | NS | superior_trial | insolvency (receivership) | bdo.ca (4499127 Nova Scotia) | 5 | ns-4499127-receivership | all exhibits are Property Online printouts told apart by PID |
| nssc-4499127-santimaw2 | NS | superior_trial | insolvency (receivership) | bdo.ca | 4 | ns-4499127-receivership | same |
| mbkb-102149699-orth | MB | superior_trial | insolvency (s.243 receivership, motel) | bdo.ca | 8 | - | affidavit text layer doubled (native + OCR) |
| abkb-monette-monette2 | AB | superior_trial | insolvency (farm CCAA + Chapter 15) | FTI MonetteFarms | 7 | - | Delaware orders, SK land titles |

- Pass 3 tooling: ocr_exhibits.py counted '[page N]' markers as words, so multi-page image-only files (>20 pages) were never OCR'd; fixed (words() strips markers). ocr_exhibits.py only runs on records whose gold.json exists: run fin.py first, OCR, then fin.py again so the repo split.json gets ocr_files.
- Pass 3 sources: BDO engagement list (bdo.ca/services/financial-advisory-services/business-restructuring-turnaround-services/current-engagements) + scratchpad bdoaff.py <slug>...; MNP sitemap (mnpdebt.ca/sitemap.xml, 1,618 engagements) + mnpaff.py (stdin URLs). autoref.py <id> prints first exhibit mentions with paragraph numbers.
- Pass 3 dead ends: CLC v PPS OBGYN expert (CV fully redacted, 2 real exhibits); Pickle/Viminitz v U Lethbridge (ABKB, image stamps); Canada applicant's record T-3594-25 (Farthing-Nichol Oct 2025 exhibits lack covers); kmlaw Austin v Bell vol 1 (both affidavits already used); Moushoom Trout/Lach (2 exhibits); BCSC Keltic Ng (BC, garbled covers).
- Pass 3 added family slugs to the repo gold of siblings (onsc-cp-fresco-brown -> fresco-cibc-overtime and subject employment; fc-moushoom-meawasige/kugler -> moushoom-fn-child-welfare; onsc-cp-bell-capay/blum/fareau -> bell-prison-collect-calls). Data-dir copies were left untouched (rule: only the record being built); rebuild.py or a copy of gold.json syncs them.
| skqb-cds-runzer2 | SK | superior_trial | insolvency (NOI proposals, FireSong resort) | mnpdebt.ca | 3 | firesong-noi-sk | Runzer's first affidavit rejected (D stamp on a content page with garbled text) |
| skqb-cds-haverstock | SK | superior_trial | insolvency (creditor opposing) | mnpdebt.ca | 4 | firesong-noi-sk | BC land titles |
| mbkb-6525785-pacheco | MB | superior_trial | insolvency (s.243 receivership, fire-damaged apartment) | mnpdebt.ca | 19 | - | jurat day unclear (13 or 15 Feb 2023) |
| nssc-adts-montgomery | NS | superior_trial | insolvency (CCAA initial, trucking) | bdo.ca (adts) | 11 | - | scanned: --ocr-affidavit, covers by page; OCR reads C as '0', I as '1' |
| skkb-abbey-black2 | SK | superior_trial | insolvency (regulator's evidence: pipeline shut-down order) | mnpdebt.ca (abbey-resources) | 6 | - | scanned; --ocr-affidavit --drop 34,35 (PD1); affidavit labels E as 'D'; probe flags A (letter cites Gettis Exhibit A) |
| mbkb-customtransport-ahmad | MB | superior_trial | insolvency (s.243 receivership, trucking; forbearance) | bdo.ca (customtransport) | 12 | - | affirmed in Calgary |
| mbkb-padm-wang | MB | superior_trial | insolvency (s.243 receivership, 3D printing/medical) | bdo.ca (padmgroup) | 30 | - | --relabel DO=DD; 5+5 PPR searches, 4 postponements, 2 priority agreements (near-identical forms) |

## Pass 3 summary (2026-09-24)

30 new records (127 -> 157 in records/; 149 in the data dir, the 8 ct-* still absent). verify --all: 149/149. Leak column 0 on all new records except skkb-abbey-black2 (the Ministry letter cites another affidavit's "Exhibit A"; content, not a stamp). Matter docs copied from siblings for the Bill 7, CHRT, Moushoom, Bell, Fresco and Lynx families.

```
157 records
by jurisdiction (10): ON 50, federal 36, AB 22, BC 15, MB 11, NS 10, SK 7, NL 3, NB 2, PE 1
by level (6): superior_trial 115, federal_trial 17, administrative_tribunal 16, appellate 5, superior_divisional 2, apex_appellate 2
by subject (8): insolvency 78, charter 33, class_action 21, human_rights 8, competition 8, administrative 5, employment 3, indigenous_rights 1
families: 15 (58 records)
```

Leads left: Barrington first affidavit (Genesus, MB; 465 scanned pages, covers need reading by eye); Runzer first affidavit (SK FireSong; needs a stamp-page override for D); MNP/BDO regional engagements are mostly scans (Karwood NL, Universal Helicopters NL, Lighthouse/Voyager/Korf SK, Terra Firma NS) - an OCR-first pipeline would open them; Moushoom Trout/Lach and Treaty 9 Archibald/Crawford have 2 exhibits each; ryfan (NWT company, ABKB) E. Ngo A-H in raw/r6-sep-24-2025-affidavit-e-ngo.pdf; BCSC Kensington Brad Wise A-H and ABKB Ironclad Cameron supplementary A-E in raw/k8-*. Non-insolvency subjects remain the gap: without web search, sources were limited to known WP media sites (jccf, sotos, kmlaw, OHC, fncaringsociety, bccla).
- rebuild.py had the same '[page N]' word-count bug: fixed (imports words from ocr_exhibits), so image-only exhibits over ~20 pages are re-OCR'd on rebuild.
- Sibling gold edits (repo only) verified against the data-dir text copies: all six pass verify.py. Data-dir gold.json for those six still lacks the family slug until synced.
- harvest.py caveat: files are named from the URL basename, so two engagements posting the same file name collide (the 5684961 Manitoba Pacheco affidavit, 485 Furby, was overwritten by 6525785's; re-download it under another prefix to use it).
- Unexamined leads: democracywatch Affidavit1.pdf / Affidavit2.pdf (harvest kept, labels ACHM/PCRT garbled; an earlier note rejected 'web-affidavit1/2' for missing covers, not logged); treaty9 amended motion record tabs 5+ (J.R. Miller and later affidavits) unread.

## Lane E (civil and commercial, non-insolvency: 2026-09-24)

Scratchpad laneE/: harvest.py (logs to rejected-lane-E.jsonl), rej.py, crawl.py (link lister), mk.py (compact gold spec s/<id>.py -> g/<id>.json + fin), row.py.

| id | jur | level | subject | source | exhibits | family | notes |
|---|---|---|---|---|---|---|---|
| onsc-cp-crowncrest-krimker | ON | superior_trial | class_action (consumer HVAC leases/NOSIs, CPA) | sotosclassactions.com (Krimker responding MR) | 5 | - | --pages 4-53 --ocr-affidavit (jurat page scanned); B-E broken encoding OCR'd; A dated Mar 31 vs affidavit's May 31 |
| onsc-cp-tdam-wright2 | ON | superior_trial | securities (mutual fund trailer class action: settlement, fees, funding) | siskinds.com (TDAM consolidated MR, via Wayback CDX listing, live URL) | 9 | tdam-westwood | --pages 338-515; A and F pages 1-3 are vector-drawn text (no text layer, no images: ocr_exhibits skips them); E,G,H OCR'd |
| onsc-cp-tdam-wright1 | ON | superior_trial | securities (first-notice motion) | same TDAM consolidated MR | 3 | tdam-westwood | --pages 518-594 |
| onsc-cp-sino-wright-horsley | ON | superior_trial | securities (Sino-Forest class action, Horsley settlement approval) | siskinds.com (Sino settlement MR 2014) | 9 | sino-forest-securities | --pages 39-466 |
| onsc-cp-sino-wright-cdp | ON | superior_trial | securities (Sino-Forest E&Y settlement distribution protocol) | siskinds.com (Sino claims/distribution MR Nov 2013) | 6 | sino-forest-securities | --pages 77-462; OCR text layer lacks para numbers 1-9 (refs paragraph null); D is a backsheet + endorsement, not the order |
| onsc-cp-sino-wright-ey | ON | superior_trial | securities (Sino-Forest: $117M Ernst & Young settlement approval) | siskinds.com (Sino class action MR Feb 2013) | 35 | sino-forest-securities | --pages 32-842; B-1/B-2, E-1/E-2 labels; V/W same_text_as (filed vs proposed fresh as amended claims); cover '0' is O |
| onsc-cp-chl-branch | ON | superior_trial | class_action (junior hockey hazing, defendants' certification evidence) | kmlaw.ca (standalone affidavit PDF) | 10 | carcillo-chl-hazing | --pages 1-70 (backsheet off J); C,F,J OCR'd |
| onsc-cp-chl-courteau | ON | superior_trial | class_action (QMJHL commissioner) | kmlaw.ca | 17 | carcillo-chl-hazing | --pages 1-128 --drop 68,69 --covers (J is a video placeholder page: dropped, referenced_not_attached) |
| onsc-cp-chl-robison | ON | superior_trial | class_action (WHL commissioner) | kmlaw.ca | 7 | carcillo-chl-hazing | --pages 1-62 |
| onsc-cp-chl-mackenzie | ON | superior_trial | class_action (CHL president on IRP report) | kmlaw.ca | 6 | carcillo-chl-hazing | --pages 1-82 |
| onsc-hannan-scouts-hannan1 | ON | superior_trial | voluntary_association (Scouter non-renewal, procedural fairness) | documentcloud.org (CBC News upload of the application record) | 21 | hannan-scouts-canada | --pages 54-190; Q,S,T OCR'd; new source family: DocumentCloud API search (laneE/dc.py, UA=curl) |
| onsc-hannan-scouts-hannan2 | ON | superior_trial | voluntary_association (reply) | same application record | 5 | hannan-scouts-canada | --pages 208-236; A,C broken encoding OCR'd |
| onsc-uoft-encampment-dealy | ON | superior_trial | employment (union joinder in campus trespass injunction; collective agreements) | litigate.com via Wayback (id_ URL) | 15 | uoft-encampment-injunction | --pages 13-145; live litigate.com links 404, Wayback copies used (laneE/wb.py) |
| onsc-uoft-encampment-delorenzi | ON | superior_trial | employment (faculty association joinder) | litigate.com via Wayback | 13 | uoft-encampment-injunction | --pages 16-152 --covers (E and E.1 separate) --ocr-affidavit (jurat page scanned, holds para 25 citing L); D,E,E.1 OCR'd; affidavit misdates G,H,J |
| onsc-cp-leroux-simmons | ON | superior_trial | class_action (developmental-services waitlist CP, Crown's certification evidence) | kmlaw.ca (Responding MR 2018) | 15 | - | --pages 5-411 --covers (H cover scanned); audit leads background paras + D date from affidavit only; K dated June 2014 vs affidavit's March 2014 |
| onsc-cp-bell-marchessault | ON | superior_trial | pensions (Bell pension indexation CP, defendants' actuary) | kmlaw.ca (Bell responding MR Oct 2018) | 23 | austin-bell-pension | --pages 9-353 --covers by page (19 OCR-garbled cover labels: audit cover findings are those); 7 image-only exhibits OCR'd; family slug added to repo gold of onsc-cp-bell-austin/randhawa; Iarusso/Nunes affidavits in same MR have image covers |
| onsc-cp-chl-carcillo | ON | superior_trial | class_action (junior hockey hazing, plaintiff's reply) | kmlaw.ca (Reply MR re certification, Dec 2021) | 4 | carcillo-chl-hazing | --pages 6-32; jurat day blank (Nov 26 per index/backsheet); A OCR'd |
| onsc-cp-chl-hammett | ON | superior_trial | class_action (junior hockey hazing, ex-WHL player's reply) | kmlaw.ca (same Reply MR) | 5 | carcillo-chl-hazing | --pages 33-55 (backsheet off E); B,C,E OCR'd; same affidavit also in the IRP motion record (not reused) |
| onsc-cp-chl-macdonald1 | ON | superior_trial | class_action (junior hockey hazing: production of Independent Review Panel report) | kmlaw.ca (revised IRP motion record, Dec 2021) | 6 | carcillo-chl-hazing | --pages 13-159 --covers (B holds the nested MacKenzie Dec 2020 affidavit: its Exhibit A cover waived); D,E OCR'd |
| onsc-cp-rbcgam-pao | ON | superior_trial | securities (mutual fund trailing-commission CP v RBC GAM: first notice of $45M settlement) | siskinds.com (RBC consolidated MR vol 3, Aug 2026) | 4 | - | --pages 56-396 --covers A=67,B=118,C=196,D=288; A,B,D scans OCR'd; audit exdate leads: A's filing stamp illegible, B/D dates in ordinal form ('25th DAY OF JULY'), C's day left blank; Wright affidavit in vol 2 not built (6 of 11 exhibits vector-drawn or Caesar-shifted fonts: no usable text) |
| onsc-cp-bell-cross | ON | superior_trial | pensions (Bell indexation CP: plaintiff's CPI expert) | kmlaw.ca (cert/SJ MR vol 2, 2018) | 4 | austin-bell-pension | --pages 67-232; B/C are the same StatCan publications as Randhawa G/H (cross-record); Ratnam affidavit (2021 MR vol 1) built then withdrawn: 20 redacted handwritten objection forms, 8+ indistinguishable |
| onsc-cp-chl-macdonald3 | ON | superior_trial | class_action (junior hockey hazing: individual issues protocol; Cromwell governance reports) | kmlaw.ca (IIP motion record, June 2023) | 7 | carcillo-chl-hazing | --pages 52-440 --covers (a 'Schedule B' line inside E fooled cover detection); A,D OCR'd; Wolfe/Jaffe expert affidavits in the same record not built |
| onsc-cp-chl-johnson | ON | superior_trial | class_action (junior hockey hazing: plaintiffs' hazing expert) | kmlaw.ca (certification MR vol 1 of 4, 2022 posting) | 3 | carcillo-chl-hazing | --pages 147-235; jurat day blank, Dec 2 from index; Hanvey 'declaration' (Charney tab 7, Berg v CHL) rejected: unsworn, image exhibits |
| onsc-cp-chl-macdonald2 | ON | superior_trial | class_action (junior hockey hazing: reply evidence, books on abuse in hockey, RCMP Kamloops report) | kmlaw.ca (Reply MR re certification) | 7 | carcillo-chl-hazing | --pages 108-264; A-G scans OCR'd (E stays text-less) |

## Lane D (public law: Charter, human rights, admin/JR, Indigenous, environmental, municipal, immigration, privacy, elections, police/prisons)

Helpers in scratchpad laneD/: harvest.py (logs to laneD/harvest.json, rejects to rejected-lane-D.jsonl), rej.py (same file), wpm3.py (WP media search, follows redirects), bs.py (Bing RSS search; operators ignored, near useless). WebSearch budget is exhausted for this session.

| id | jur | level | subject | source | exhibits | family | notes |
|---|---|---|---|---|---|---|---|
| abqb-amla-smolishunt2 | AB | superior_trial | charter (municipal bridge-lighting policy) | jccf.ca (supplemental affidavit) | 7 | amla-edmonton-bridge | F-L continue the first affidavit; para 11 unparsed ("11 ."), refs null; family slug added to repo gold of abqb-amla-smolishunt |
| cer-tmx-hobenshield | federal | administrative_tribunal | regulatory (TMX v Burnaby tree bylaw, CER motion + constitutional question) | apps.cer-rec.gc.ca REGDOCS 4039143 | 4 | - | first CER record; PDF holds the affidavit twice: --pages 14-37 (clean copy) |
| fc-ccfr-odell | federal | federal_trial | administrative (firearms OIC SOR/2020-96 JR) | firearmrights.ca | 14 | ccfr-firearms-oic | --ocr-affidavit; C posted as the bore-gauge image = E (same_text_as); 3 image exhibits OCR'd |
| fc-ccfr-mauser | federal | federal_trial | administrative (firearms OIC JR; criminologist expert) | firearmrights.ca | 20 | ccfr-firearms-oic | --covers by page (OCR-garbled '~xhibit' covers; audit's 10 cover findings are those); K/R described differently from the files |
| cer-sunrise-bowie | federal | administrative_tribunal | municipal (City of Abbotsford intervenor evidence, Westcoast Sunrise GH-001-2024) | REGDOCS 4542950 | 9 | - | paragraph numbers sit in a separate column: refs null; --covers by page; 5 map/scan exhibits OCR'd |
| cer-northriver-richardson | federal | administrative_tribunal | regulatory (NorthRiver notice of constitutional question; service on AGs) | REGDOCS 4479858 | 5 | cer-northriver-nebc | service affidavit; audit jurat on D is the nested Sturgeon affidavit's own jurat |
| cer-northriver-hume | federal | administrative_tribunal | indigenous_rights (Blueberry River Implementation Agreement New Disturbance, NorthRiver NEBC) | REGDOCS 4490313 | 6 | cer-northriver-nebc | Ratcliff lawyer's affidavit for BRFN |
| neb-line9-plain | federal | administrative_tribunal | indigenous_rights (Aamjiwnaang Chief's evidence, Line 9B OH-002-2013: Chemical Valley pollution, duty to consult) | REGDOCS C1-6-1..13 (multi-file) | 12 | neb-line9b-oh-002-2013 | first multi-file record in Lane D: raw/plain-*.pdf (multi-file sources must sit directly in raw/ for audit/rebuild); --covers all; 7 image exhibits OCR'd; family slug added to repo gold of neb-line9-laforme |
| oeb-goldcorp-major | ON | administrative_tribunal | administrative (s.19 OEB Act challenge: Transmission System Code bypass-compensation provisions ultra vires; Hydro One CCRA delay) | rds.oeb.ca 312673 | 25 | - | --covers by page (H/I/O covers OCR as 'IT','!','0'); all e-mails, 38 events |
| oeb-rrfe-lloyd | ON | administrative_tribunal | administrative (Northwatch motion to review OEB cost-award decision, RRFE consultation) | rds.oeb.ca 372105 | 10 | - | --pages 12-158 --covers by page (B/E read '8', C 'G', I '1'); refs paragraph null (unpunctuated para numbers); 1 matter doc (rds.oeb.ca throttles bursts: it refused connections for ~1 h after a 280-file triage) |
| bccomm-cullen-bamra | BC | administrative_tribunal | regulatory (Cullen money-laundering inquiry: BCLC AML manager on the anonymous complaint against VP Kroeker; STR meeting notes) | cullencommission.ca Exhibit 143 | 13 | cullen-commission | first public-inquiry record; --covers by page; C-M = 11 meeting notes told apart by date |
| bccomm-cullen-wenezenkiyolland | BC | administrative_tribunal | regulatory (Cullen inquiry: former ADM Finance on GPEB/BCLC oversight, AML strategy, JIGIT, 2013-2017) | cullencommission.ca Exhibit 922 | 37 | cullen-commission | A-KK in 688 pp; N/S same mandate letter attached twice (same_text_as); 62 events; OCR'd scanned pages |
| bcuc-png-aaswaakshin | BC | administrative_tribunal | indigenous_rights (Lax Kw'alaams on adequacy of consultation, PNG Salvus-Galloway CPCN) | docs.bcuc.com doc_62917 (C2-2) | 4 | - | first BCUC record; --pages 2-49 (confidentiality cover letter excluded); BCUC proceeding pages crawlable by applicationid (laneD/bcuc.py) |
| ondc-wpd-mcfarlane | ON | superior_divisional | municipal (Kawartha Lakes: uncertain legal status of Wild Turkey Road, forced/Quarter Sessions road; wind-farm JR) | rds.oeb.ca 472508 (Div Ct affidavit filed at the OEB, EB-2013-0442) | 7 | wpd-sumac-ridge-kawartha | --covers by page (A read '4', B '8'); blank page after each cover kept; --drop 258 backsheet; F/G OCR'd |
| ondc-wpd-taylor | ON | superior_divisional | municipal (Kawartha Lakes Director of Development Services: road refusal, DC and fire by-laws, template agreement vs wind farm) | rds.oeb.ca 472568 (126 MB, 1,416 pp) | 41 | wpd-sumac-ridge-kawartha | A-OO; --covers by page (B '8', I/L '1', Q 'C', II 'll'); V attached but not cited by letter; 5 files OCR'd; 45 events |
| oeb-union-tavares | ON | administrative_tribunal | regulatory (Union Gas 2014 penalty-charge exemption; TransAlta/Kitchener motion to compel interrogatory answers) | rds.oeb.ca 442410 | 12 | - | --pages 11-52; two-column paragraphs split in the text layer; counsel's-assistant affidavit |
| oeb-cme-derose | ON | administrative_tribunal | administrative (CME motion to review OEB cost-award decision; late supplementary cost claim, Union DSM plan) | rds.oeb.ca 355158 | 11 | - | --pages 8-76; E/F near-identical demand letters told apart by the enclosed invoice |
| oeb-hagar-samuel | ON | administrative_tribunal | regulatory (Union Gas Hagar LNG service; competitor Northeast Midstream's s.29 forbearance motion) | rds.oeb.ca 452413 | 5 | - | --pages 11-133; clean text covers |
| neb-vaughan-graziosi3 | federal | administrative_tribunal | municipal (City of Vaughan vs TransCanada King's North pipeline route: Street A / Block 59 planning, GHW-001-2014) | REGDOCS C15-12-02..09 (multi-file) | 7 | - | numeric 1-7; typed tab pages as first page of each exhibit file: --covers all; --ocr-affidavit (scanned) |
| neb-vmep-rossi | federal | administrative_tribunal | municipal (City of Vaughan planning evidence: Greenbelt, whitebelt growth lands vs Vaughan Mainline Expansion, GH-001-2016) | REGDOCS A76581 (multi-file) | 7 | neb-vmep-vaughan | labels 1-4, 5A, 5B, 6 (affidavit cites 'Exhibit 5' once); --ocr-affidavit; leak waiver 4 = image-only Greenbelt Plan cover |
| neb-vmep-graziosi | federal | administrative_tribunal | municipal (City of Vaughan: depth of cover at road crossings, natural heritage compensation, pathways; GH-001-2016) | REGDOCS A76403 (multi-file) | 10 | neb-vmep-vaughan | labels 8.1, 8.2.A-8.2.D (affidavit spells 8.2.a-d; four image-heavy drawing sets), 15.1-15.3, 17.1, 19.1; --ocr-affidavit |
| neb-tmx-planes | federal | administrative_tribunal | indigenous_rights (T'Sou-ke First Nation: Douglas Treaty rights, tanker traffic, consultation; TMX OH-001-2014) | REGDOCS C359-4-2..14 (multi-file) | 12 | neb-tmx-oh-001-2014 | --covers all (whole-page commissioner covers); no jurat page posted; fn 11 cites AIP as 'G' (it is H); B/G/L scanned OCR'd |
| neb-tmx-james | federal | administrative_tribunal | indigenous_rights (Shxw'owhamel First Nation: Line 1/Line 2 under Ohamil IR 1, Sumas leak, consultation; TMX OH-001-2014) | REGDOCS C312-7-2..11 (multi-file) | 9 | neb-tmx-oh-001-2014 | --covers all; posted cover of I reads 'H'; F/G = planes K/L letters |
| oeb-lsl-collins | ON | administrative_tribunal | indigenous_rights (BLP First Nations: Hydro One Lake Superior Link vs NextBridge East-West Tie; duty to consult, exclusivity) | rds.oeb.ca 607869 | 5 | - | --pages 49-90 of a 3-affidavit filing (Desmoulin/Michano have 2 exhibits each); tab-style covers --covers by page |
- Lane D resumed (2026-09-24): helpers laneD/dl.py (download+triage any URL list, keeps >=3 text covers), logdrops.py (drops -> rejected-lane-D.jsonl), row.py (inserts rows here), pg.py (page PNGs), oebq.py, bcuc.py; gold specs laneD/s/<id>.py built with laneE/mk.py. Multi-file sources must sit directly in raw/ (audit/rebuild look up raw/<basename>).
- OEB full-text search works: rds.oeb.ca/CMWebDrawer/Record?q=content:"referred to in the affidavit"&pageSize=500&start=N (oebq.py; 4,369 + 3,065 rows in laneD/oebc.txt, oebc2.txt). rds.oeb.ca refuses connections ~1 h after a ~280-file burst. Unbuilt OEB KEEPs in raw/: doeb-442410 (Union/TransAlta A-L), doeb-355158 (CME DeRose A-K), doeb-452413 (Northeast Midstream A-E), doeb-430824 (CEA Bradley A-C), doeb-471446 (NRG, same PDF as 471447/471448), doeb-286800/281322 (Snopko/Union summary judgment, EB-2011-0087), doeb-316396 (THESL/CANDAS, scanned).
- Cullen Commission (cullencommission.ca/exhibits/?page=1..11; laneD/cullen-pdfs.txt, 1,037 PDFs, 85 affidavits): only Bamra and Wenezenki-Yolland have text covers; the rest are scans (logged). Lead: Alderson affidavit (exhibit 1025, 35 pp scanned) + separate exhibits binder 1026 (A-S whole-page covers) = a --multi --ocr-affidavit candidate, the complainant's side of Bamra's story. Goluza (777): handwritten numeric labels.
- BCUC: www.bcuc.com/OurWork/ViewProceeding?applicationid=34..1450 lists docs.bcuc.com PDFs (laneD/bcuc-docs.txt, 22,942 links); file names rarely say 'affidavit' (5 hits). Dead ends: SCT (sct-trp.ca posts declarations only), IPC PHIPA prescribed-entity affidavits (no exhibits), treaty9disparity amended MR (Gauthier already built), CER Frank/Andrews/Miskokomon multi-part affidavits (body and first exhibits share one file; --multi cannot split by page), Sioui (unsworn scan), General 2022 (handwritten stamps on content pages).
- CER bundle-type postings are out of reach without a split.py change (one posted file holds several exhibits): Daniels (A70191, 'Exhibits 8-26'), Parise (C14328, C10426), Deanna Major (A91812), Frank/Andrews, COTTFN Miskokomon, Moin (C16404), Davies (A87282). One-exhibit-per-file TMX OH-001-2014 sets that remain: Jones/Pacheedaht (A70179), Miller/Katzie (A70188), McLeod/Upper Nicola (A70333, likely scanned stamps like Tsawout).
- Territorial registries probed: reviewboard.ca and nirb.ca site search return nothing for 'affidavit'; yesabregistry.ca is a JS app. AUC eFiling needs a login; NS UARB is FileMaker WebDirect; pubmanitoba.ca menus are JS-injected. Cullen: Alderson's exhibits are one binder PDF (bundle), not buildable.

## Lane F (geography + court level: QC-English, territories, Atlantic, Prairies, appellate, federal tribunals; sibling affidavits)

Helpers in scratchpad laneF/: harvest.py and rej.py log to rejected-lane-F.jsonl; gb.py (gold builder), mk_<name>.py per record; ddg.py/bsearch.py (DuckDuckGo captcha'd, Bing headless returns junk: no working web search); gtcrawl.py walks the Doane Grant Thornton creditor-updates document tree (docs.doanegrantthornton.ca/document-folder/fetch, POST id/node-id/_token).

| id | jur | level | subject | source | exhibits | family | notes |
|---|---|---|---|---|---|---|---|
| mbkb-5684961-pacheco | MB | superior_trial | insolvency (s.243 receivership, fire-damaged apartment, 485 Furby) | mnpdebt.ca | 17 | - | companion of mbkb-6525785-pacheco (same lender/deponent/day, other debtor); L garbled font OCR'd; O photos |
| mbkb-bokhari-sandhu | MB | superior_trial | construction (Builders' Liens Act holdback interpleader) | kpmg.com creditorlinks (Bokhari) | 8 | - | --covers (H read as 11H); first construction-lien record |
| mbkb-bokhari-peltonen | MB | superior_trial | insolvency (supplier property claim in receivership) | kpmg.com creditorlinks (Bokhari) | 3 | - | doubled text layer; --covers (body cites another affidavit's Exhibit C); sibling first affidavit (Jan 8 2025) is scanned |
| nssc-chesterbasin-teixeira | NS | superior_trial | insolvency (receivership application after failed NOI; DIP + assigned TD/Pluto debt, fishing vessels) | grantthornton.ca creditor updates | 28 | chester-basin-seafood | scanned+OCR'd; O,Q,W,Y noisy text; jurat day illegible (sworn_date 2024-02) |
| nssc-chesterbasin-kingston | NS | superior_trial | insolvency (counsel's registry searches: NS/NB/PE/NL PPR, ship registry) | grantthornton.ca | 9 | chester-basin-seafood | 4 Atlantic PPR reports |
| nssc-chesterbasin-santimaw | NS | superior_trial | insolvency (trustee counsel's searches) | grantthornton.ca | 5 | chester-basin-seafood | Hfx No. 530600 |
| nssc-chesterbasin-breau | NS | superior_trial | insolvency (NOI stay extension; board dispute) | grantthornton.ca | 3 | chester-basin-seafood | A = nested affidavit (leak waived); B/C = teixeira B/E |

- Grant Thornton (Doane) document tree: laneF/gtfiles.json (10,236 files, 616 affidavits). Download = view endpoint -> webpal viewer key -> _ajax/download; laneF/gtget.py fetch() does it with curl + cookie jar. source.json url is the stable view endpoint, which returns JSON (not the PDF): **rebuild.py cannot refetch these sources directly** (same class as Deloitte's browser-only fetch); use gtget.fetch. In Git Bash set MSYS_NO_PATHCONV=1 before passing '/CreditorUpdates/...' paths.
- GT sha256 is stable across fetches (Breau fetched twice = source.json sha), so gtget.fetch rebuilds these sources exactly.
- Lane F is building the NB CCLA v NB (FM-76-2023) siblings from raw/j-april-15-2024-ccla-v-nb-gda-and-odc-motion-record.pdf (Leung, Kimberly); other lanes please skip. Six Lane D rows that had been appended at the file end (inside this table) were moved to the Lane D table; please insert rows inside your own table rather than appending to the file.
- Insolvency cap reached for Lane F (6 of 8). Harvested but NOT built (insolvency, all text covers, in raw/gt-*): Canada Fluorspar NL CCAA (Clarke Mar 2022 A-G, May 2023 A-D, Sep 2023 A-C, Jan 2024 A-C; Page Feb 2022 A-C: a 5-record family), 720434 NB Inc. (Ford x3, Molyneaux A-I), 5448124 Manitoba (Minor Sept 2015 A-Z + supp A-C), 5993092 Manitoba (Coonan, 1,049 pp, numeric 1-26+), Mernova NS (Mackay A-AA), Superport NS (BMO Langlois), World Energy GH2 NL (Hugh A-G, posted twice).
| cer-poucecoupe-general | federal | administrative_tribunal | indigenous_rights (Duncan's First Nation, Treaty 8, OH-001-2024) | REGDOCS 4542970 | 14 | - | A's own title 'Exhibit A - Written Evidence' redacted (redact_text + waiver, rebuilt); F/I image letters, K broken font: OCR'd |
| neb-tmx-bird | federal | administrative_tribunal | environmental (TWN application for review, TMX reconsideration: orca habitat, SeaRose spill) | REGDOCS 3716296 | 5 | - | first NEB-era record; D broken font OCR'd |
| neb-tmx-allan | federal | administrative_tribunal | municipal (Burnaby's evidence vs TMX motion/NCQ on city permits, MH-081-2017) | REGDOCS 3385658 | 4 | - | audit 'dated' leads are background paragraphs; Pelletier (Burnaby) affidavit skipped: stamp labels misread |
| nbkb-ccla-kimberly | NB | superior_trial | charter (Policy 713 JR; GDA intervention) | jccf.ca (GDA/ODC motion record, pp 14-82) | 5 | ccla-nb-policy713 | image-only covers: --covers by page; A,E broken fonts OCR'd; family slug added to repo gold of nbkb-ccla-ab |
| nbkb-ccla-leung | NB | superior_trial | charter (Policy 713 JR; counsel's affidavit: expert CV, will-say, anonymized affidavits) | same motion record (pp 106-479) | 6 | ccla-nb-policy713 | --covers by page; D/E/F nested affidavits (D = nbkb-ccla-ab's affidavit; D,F leaks waived); E's 200 exhibit pages image-only |
- Lane F stopped at 9 records (6 insolvency, 3 non-insolvency). Dead ends: SCC case-documents JSON 40800-41900 lists only factums/memoranda; West Coast LEAF, JCCF, democracywatch intervention/appeal PDFs have no text exhibit covers; WP media of Atlantic/Prairie unions, class-action firms and First Nations sites returns nothing; KPMG primewest (SKCA), Bokhari other affidavits and NBCA 720434 Ford (Exhibit A cover only) rejected. Leads: LPC Avocat (lpclex.com) posts Quebec English class-action exhibits R-1.. as separate PDFs (split.py needs a multi-file mode: new flag, not built); Barrick appeal record/compendium (cfmlawyers, raw/f-app-appeal-record-...); GT insolvency set above.
| oeb-summitt-martin | ON | administrative_tribunal | regulatory (OEB administrative penalty proceeding, Energy Consumer Protection Act) | rds.oeb.ca 331194 | 16 | - | first OEB record; --covers by page (header+tab covers); exdate leads are superscript ordinals ('7 th') |
| oeb-king-somerville | ON | administrative_tribunal | municipal (Township of King vs Enbridge pipeline route, leave to seek review) | rds.oeb.ca 857831 | 10 | - | --pages 14-60 (covering letter/report/motion excluded) |
| neb-line9-laforme | federal | administrative_tribunal | indigenous_rights (MNCFN Chief's evidence, Enbridge Line 9B reversal OH-002-2013) | REGDOCS 1042654 | 6 | - | --covers by page (noisy notary covers) |

## Lane G (multi-file split mode; QC-English, NL Fluorspar, Barrick appeal, Atlantic/Prairie/territorial: 2026-09-24)

split.py multi-file mode (`--multi AFF --exhibit A=f.pdf B=g1.pdf+g2.pdf`, or `--manifest`; `--covers A,B` = first page a cover read by eye) and rebuild.py support (source.json `sources[]`, split.json `multi_file` + per-exhibit `source_files`); rebuild.py also refetches Doane Grant Thornton view URLs directly now. Helpers in scratchpad laneG/.

| id | jur | level | subject | source | exhibits | family | notes |
|---|---|---|---|---|---|---|---|
| fc-bcm-gusdal | federal | federal_trial | administrative (Canada Summer Jobs refusals to Christian camps, JR) | jccf.ca applicant's record (Tab 5) | 9 | bcm-csj-attestation | same source as fc-bcm-whitehead (other pages); --pages 251-290 --covers; family slug added to repo gold of fc-bcm-whitehead |
| fc-peckford-peckford | federal | federal_trial | charter (COVID air-travel vaccine mandate; former Premier's evidence) | jccf.ca compilation (pages 1-90) | 5 | peckford-travel-mandate | 3rd record of the consolidated applications; family slug added to repo gold of fc-peckford-baigent and fc-bennaoum-little; B/C covers garbled -> --covers |
| onca-barrick-magrofa | ON | appellate | transnational_tort (forum non conveniens stay; fresh evidence on appeal re Tanzania) | cfmlawyers.ca fresh-evidence motion record | 7 | - | scanned; --ocr-affidavit, --covers by page; exdate A/G audit leads are false alarms (A: date on cover only; G: access date) |
| nlsc-cfl-clarke2023a | NL | superior_trial | insolvency (CCAA: add CFI Newspar as debtor, extend stay) | Grant Thornton docs tree (Canada Fluorspar) | 4 | canada-fluorspar-ccaa | source OCR layer poor (paras 3, 12 read as '3,' '12,': paragraph null); exdate A/B leads are OCR garble |
| nlsc-cfl-clarke2023b | NL | superior_trial | insolvency (CCAA after reverse vesting sale: stay, claims process, interim distribution) | Grant Thornton docs tree (Canada Fluorspar) | 3 | canada-fluorspar-ccaa | --drop 10,33,57 (garbled TAB pages); exdate leads = dates in illegible scan areas |
| nlsc-cfl-page | NL | superior_trial | insolvency (secured lender's BIA s. 47 interim receivership application, fluorspar mine) | Grant Thornton docs tree (Canada Fluorspar) | 3 | canada-fluorspar-ccaa | born-digital affidavit, scanned exhibits with text layer; audit clean |
| nlsc-cfl-clarke2022 | NL | superior_trial | insolvency (interim receiver's CCAA initial application: DIP, charges, SISP) | Grant Thornton docs tree (Canada Fluorspar) | 7 | canada-fluorspar-ccaa | 430 pp; --drop 7 garbled TAB pages; leak B waived (HSBC agreement's own Exhibit B); para 33 OCR '3 3.' -> paragraph null |
| cer-northriver-general | federal | administrative_tribunal | indigenous_rights (Duncan's First Nation Treaty 8 hunting/land-use evidence, NEBC Connector OH-001-2022) | REGDOCS C22591 (9 separate PDFs) | 8 | cer-northriver-nebc | first --multi record: affidavit + A-H posted separately; handwritten stamps inside the scans whited out with new --blank; argmax 0.125 (affidavit names exhibits by title only) |
| neb-vaughan-sioui | federal | administrative_tribunal | indigenous_rights (Huron-Wendat archaeological heritage, TransCanada Vaughan Mainline GH-001-2016) | REGDOCS A76418 (4 separate PDFs) | 3 | - | French solemn declaration (Wendake, QC), --ocr-affidavit; pièces 1-2 typed filing headers removed text-only (--blank N=t:); audit 'dated' leads = file number OF-...-2015-05-01 in footer; baseline 0/3 (French vs English/image exhibits) |

- Lane G resume (2026-09-24): rebuild check passed on abca-jmb-doran and abkb-cwb-stark (files/*.txt byte-identical; PDFs render- and text-identical, bytes differ only by PyMuPDF save metadata), repeated after the split.py/rebuild.py changes below plus on cer-northriver-general. split.py multi mode gained `f.pdf:a-b` page ranges (tested: reproduces nlsc-cfl-clarke2023a's A/C/D cuts with covers stripped) and `--blank` (image-pixel or `t:` text-only whiteout of an exhibit's first-page region), both replayed by rebuild.py; README step 2 documents them.
- Insolvency is OVER the cap: 4 of the 7 records added in this resume (the four nlsc-cfl-* rows) are insolvency. Do not build more insolvency here until non-insolvency catches up (needs 5 more).
- Dead ends this resume: Quebec registry (19 English sworn statements, exhibits never posted; Nehra has no covers), lpclex.com (no sworn statements), Barrick appeal compendium (excerpts only), DocumentCloud (Cloudflare block even headless), pwc.com Victoria Gold (docs not in DOM), provincial utility boards, REGDOCS scans with stamps on every page (Tsawout, Moin, Arbeau #2, Shepard, Treaty 2 C45-04). Details in rejected-lane-G.jsonl.
- Leads left: Dean Jones affidavits (NorthPoint v Manitoba Hydro, CER C27944 + C27205 complaint original; SK/MB; all-image rotated scans, stamps in image: needs --blank on a range inside one exhibits file); Canada Fluorspar Jan 2024 Clarke rejected as duplicate; GT insolvency harvest untouched (Minor MB A-Z, Molyneaux NB A-I, Langlois NS, Hugh NL A-G, Mackay NS A-AA: raw/gt-* except Mackay); Victoria Gold (Yukon) receivership docs on pwc.com need a clicking headless crawl; REGDOCS tools in scratchpad laneG/ (rds.py search, rdv.py folder list, regget.py fetch+triage).

## Lane H (subject diversity, no insolvency: 2026-09-24)

Scratchpad laneH/: dcfilt.py (filters cached DocumentCloud search lists from laneE/dc*.txt), s/<id>.py gold specs built with laneE/mk.py, row.py, rej.py. DocumentCloud API is rate-blocked (500 calls/day) but s3.documentcloud.org PDFs download with a curl UA (UA=curl/8 for laneD/dl.py).

| id | jur | level | subject | source | exhibits | family | notes |
|---|---|---|---|---|---|---|---|
| abkb-odl-palandjian | AB | superior_trial | indigenous_rights (SLCN duty-to-consult JR of the Water Act licence for O'Leary's Wonder Valley AI data centre; ODL application to strike) | s3.documentcloud.org 28061504 (CBC/DocumentCloud upload) | 32 | - | numeric 1-32, --covers by page; scanned exhibits carry an OCR layer (25 audit exdate leads = OCR-garbled or differently formatted dates); 3 and 14 OCR'd; jurat page scanned (para 19 number lost) |
| fc-sfm-macdonald1 | federal | federal_trial | environmental (pesticide regulation: PMRA chlorpyrifos phase-out, no special review, MRLs kept; JR) | s3.documentcloud.org 23570108 (Applicants' Record vol 2 of 15, Ecojustice) | 20 | safe-food-matters-chlorpyrifos | --pages 23-396 --drop 85,86 (D = cover + 'moved to Tab 18' note: referenced_not_attached) and 322,325,328,332,334 (Q.2-Q.6 sub-covers: the affidavit cites only 'Exhibit Q', so the six provincial documents form one file Q); --covers by page; broken-font pages OCR'd; 76 events |
| fc-sfm-macdonald2 | federal | federal_trial | environmental (pesticide regulation: PMRA Amended Decision REV2021-04, respondents' concession, drinking water modelling, Stockholm Convention) | s3.documentcloud.org 23570107 (Applicants' Record vol 3 of 15) | 21 | safe-food-matters-chlorpyrifos | --pages 23-488 --drop 59,60 (A = cover + 'see Exhibit A folder' placeholder: referenced_not_attached); --covers by page; audit 'dated' leads = later mentions of the May 13 2021 decision; U misdated 2021 in the file (the affidavit says so) |
| fc-sfm-mcdonald | federal | federal_trial | environmental (pesticides: applicant NGO's notices of objection and standing, chlorpyrifos phase-out JR) | s3.documentcloud.org 23570119 (Applicants' Record vol 7, pp 23-116) | 7 | safe-food-matters-chlorpyrifos | audit clean but one exdate lead (G's date is in the letter's e-signature block, not text) |
| fc-sfm-sears | federal | federal_trial | environmental (pesticides: Prevent Cancer Now's submissions, cumulative risk framework, sales data, data call-in) | s3.documentcloud.org 23570119 (Applicants' Record vol 7, pp 117-204) | 8 | safe-food-matters-chlorpyrifos | covers D-H print labels in a shifted font (' ( ) * +): --covers by page, audit cover findings are those |
| onsc-9448-lasry | ON | superior_trial | real_property (commercial mortgage enforcement, Cornwall; summary judgment vs borrower and guarantor) | s3.documentcloud.org 24521090 (CBC upload of amended motion record; Lane E had dropped it at triage) | 30 | - | --pages 24-154, scanned: covers typed+stamped pages read by eye (--covers by page, A-N, O1-O7, P-X), --ocr-affidavit; paragraph 8 (citing J) and the start of 16 (X, F) are missing from the scan; O4/O5 are out of date order on the covers; 30 audit cover + 23 exdate leads are OCR garble, 3 mention leads = 'O-1'/'ST, U7'/'FP' OCR |
| onsc-cp-medjedovic-day | ON | superior_trial | class_action (DeFi cyber-attack victims v absconding hacker: substituted service, Mareva/Anton Piller background) | s3.documentcloud.org 26511048 (CBC upload; Lane E dropped it at triage) | 7 | - | --pages 12-161; B-G covers in a shifted font (%&'()*) --covers by page (audit cover findings are those); A = the deponent's nested Dec 2021 affidavit (116 pp) with its own numeric covers inside |
| fc-mnr-beerstore-tsetsos | federal | federal_trial | tax (CRA unnamed persons requirement: ETA s. 289(3) / ITA s. 231.2(3) authorization for Beer Store licensee sales data) | s3.documentcloud.org 4953220 (CBC upload of the Minister's motion record) | 3 | - | --pages 12-28, CamScanner scan with OCR layer; audit 'dated' leads are the requested future periods |
| fc-pbo-mulcair-brown | federal | federal_trial | administrative (Parliamentary Budget Officer's s. 18.3 reference on his mandate; Mulcair-PBO correspondence) | s3.documentcloud.org 522211 (CBC upload) | 4 | - | --pages 14-23, scanned with OCR layer; para 5 OCR'd as 's.' (D reference paragraph null); audit clean |
- Lane H summary: 9 records (none insolvency): 1 AB, 1 ON real property, 1 ON class action, 6 federal (4 Safe Food Matters environmental family, tax, administrative). WebSearch budget exhausted (200/200). Source was Lane E's cached DocumentCloud search lists (laneE/dc*.txt, 4,911 docs): the API is rate-blocked but s3.documentcloud.org serves PDFs to a curl UA. CAUTION for rebuild.py: s3.documentcloud.org refuses rebuild.py's browser UA (curl -f fails), so the 9 Lane H records and the two onsc-hannan-scouts records do not refetch until rebuild.fetch uses UA 'curl/8' for documentcloud URLs (one-line change, not made: outside this lane's allowed tool change). split.py unchanged (the multi-file page-range mode already existed), so no rebuild check was needed.
- Lane H dead ends (rejected-lane-H.jsonl): 1,500+ DocumentCloud candidates triaged twice (text covers, then short cover-like pages); POEC AFF.* affidavits (one-exhibit institutional reports, scanned); CIPPIC Wayback (Voltage/TekSavvy costs records scanned; T-955-21 truncated at 1 MB); Snopko v Union Gas McMurphy/Wachsmuth affidavits (exhibits cited only as ranges 'D to I', unlabelable); Saskatchewan v AGC carbon tax T-1674-24 (notary stamps inside exhibit images); CER Deanna Major MMTP parts all image-only; Wayback CDX regex queries on union/NGO domains mostly 504.
- Lane H leads: Gaudrault (TekSavvy CEO) affidavit A-I in the Voltage costs record (IP/privacy, FC T-2058-12): buildable if split.py's --ocr-affidavit used the tesseract CLI (PyMuPDF OCR drops ~6 top lines per page); Gabel affidavit (SFM chlorpyrifos, ~47 exhibits over Applicants' Record vols 4-6, DocumentCloud 23570105/06/56) via --multi page ranges; Kellar v Medjedovic Dec 2021 Day affidavit (inside Exhibit A of onsc-cp-medjedovic-day, numeric exhibits, shifted font) would duplicate content.

## Lane I (subject diversity from the DocumentCloud cache and Lane H leads, no insolvency: 2026-09-24)

Scratchpad laneI/: rej.py, row.py, s/<id>.py gold specs (laneE/mk.py). Same DocumentCloud source as Lane H.
| id | jur | level | subject | source | exhibits | family | notes |
|---|---|---|---|---|---|---|---|
| fc-voltage-teksavvy-gaudrault | federal | federal_trial | intellectual_property (copyright Norwich order; ISP subscriber privacy; TekSavvy's compliance costs) | Wayback cippic.ca TekSavvy Costs Record vol 1 (Lane H lead) | 9 | - | all scanned: --pages 90-196, --covers by eye (record page + 4), --ocr-affidavit --ocr-cli; J (Arbor invoice) is past the posted volume's end: referenced_not_attached; audit: 2 mention leads = OCR garble of D/I refs, 4 exdate leads = e-mail headers lost at the top of scanned pages, 2 dated paragraphs added as events; baseline leak 0 |
- split.py: new opt-in `--ocr-cli` (with --ocr-affidavit, OCR through the tesseract executable; source.json affidavit_ocr='tesseract-cli'). Default path unchanged. Rebuild check after the change: abca-jmb-doran and abkb-cwb-stark rebuilt, samepdf.py IDENTICAL on both. rebuild.py takes affidavit text from --text-backup, so it does not replay the CLI OCR (same as the PyMuPDF path).
| fc-sask-fuelcharge-marier | federal | federal_trial | tax (GGPPA fuel charge: stay of CRA collection against Saskatchewan) | s3.documentcloud.org 24794216 (motion record; Lane H had rejected the whole record for image stamps, which affect only the Bayda/Wilson affidavits) | 3 | sask-fuelcharge-t1674-24 | --pages 12-33, typed covers; B broken font OCR'd; audit 0 findings; baseline 3/3, leak 0 |
| fc-sask-fuelcharge-wilson | federal | federal_trial | tax (GGPPA fuel charge assessments, objection, s. 148(12) postponement, CRA requirement to pay on the Province's RBC account) | s3.documentcloud.org 24794216 (same motion record as fc-sask-fuelcharge-marier, pp 54-197) | 12 | sask-fuelcharge-t1674-24 | multi mode over page ranges of the one PDF, each range starting at the typed divider (stripped); exhibit stamp + notary seal inside rotated (/Rotate 270) scans whited out with --blank. CAUTION: split.py's --blank rects are applied in unrotated page space, so derotated fractions were passed (laneI/wilson-blank.txt); label-free stamp edges remain on A-C. First pages image-only (no text); audit: 3 exdate leads = those empty first pages; baseline leak 0 |
- Bayda affidavit in the same record rejected: its stamps sit on OCR'd content pages, and split.py's text-stamp detector redacts whole content blocks matching 'Province of' along with the stamp (paragraphs of B and C disappeared). Fix would be a split.py change (skip text-stamp redaction when --blank covers the stamp), not made.
