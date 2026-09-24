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

## Lane B (non-insolvency subjects: class actions, human rights/Charter, employment, IP, estates, family, regulatory)

| id | jur | level | subject | source | exhibits | matter_docs | notes |
|---|---|---|---|---|---|---|---|

## Lane C (appellate levels + judicial review/administrative + families)

| id | jur | level | subject | source | exhibits | matter_docs | notes |
|---|---|---|---|---|---|---|---|
