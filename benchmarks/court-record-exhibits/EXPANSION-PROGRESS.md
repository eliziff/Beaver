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
