# Public legal PDF corpus acquisition

This folder contains the local corpus requested for legal-document parsing
experiments. PDFs are organized as
`pdfs/<jurisdiction>/<generation>/<kind>/<source>/`; the append-only
`ledger.jsonl` records every attempted candidate, including rejected,
duplicate, quota-discarded, and failed leads.

The completed quota is 1,500 accepted PDFs:

- Canada 975; United States 150; United Kingdom 225; Australia 75; New Zealand 75.
- 750 digital-born and 750 non-digital (scanned or image-dominant/OCR).

The source mix covers court forms and filings, factums and briefs, affidavits,
orders, pleadings, exhibits, inquiry records, transcripts, procurement,
contracts, RFIs, RFPs, tenders, zoning and municipal bylaws, parliamentary and
tribunal submissions, financial/legal work product, historical legal volumes,
and other workflow documents. In particular, the accepted ledger includes
request-for-information, request-for-proposal, tender, zoning-bylaw, and
municipal-bylaw kinds.

Primary source lanes include Canadian courts and tribunals, Supreme Court and
commission/inquiry archives, CanadaBuys, municipal planning repositories,
Canadiana scans, UK government and inquiry repositories, scanned historical
English-law volumes from Internet Archive, US federal agencies and courts,
Australian court and regulatory repositories, and New Zealand courts,
tribunals, inquiries, and procurement repositories. `state/source_inventory.json`
records discovered-pool sizes, untried leads, source URLs, terms notes, and
landing-page examples.

Selection uses source and semantic-kind ceilings to prevent one inquiry or
document family from consuming the corpus. The broad scanned archives have
explicit bounded exceptions because their individual items vary materially in
layout, typography, age, and legal subject. The downloader enforces the
jurisdiction and generation quotas; the final verifier additionally checks
paths, PDF magic, byte sizes, SHA-256 hashes, duplicate accepted hashes, and
source/kind caps.

Useful commands:

```powershell
python experiments/legal_pdf_corpus/harvest.py self-test
python experiments/legal_pdf_corpus/harvest.py inventory
python experiments/legal_pdf_corpus/harvest.py verify
```

Only public links are used. A public link is not a statement that material is
authoritative legal advice or unrestricted for republication; consult the
originating body and the item-level terms where applicable.
