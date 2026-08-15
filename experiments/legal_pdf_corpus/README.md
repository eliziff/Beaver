# Public legal PDF corpus acquisition

This folder is a local-only acquisition workspace. `harvest.py` discovers and
downloads public PDFs into `pdfs/<jurisdiction>/<generation>/<kind>/<source>/`
and appends one compact JSON object per attempted file to `ledger.jsonl`.

The requested final quotas are 1,500 PDFs: Canada 975, United States 150,
United Kingdom 225, Australia 75, and New Zealand 75; 750 digital-born and
750 non-digital (scanned or mixed). The downloader enforces those quotas on
accepted files and records rejected, duplicate, invalid, and failed candidates
without hiding them.

The source lanes are deliberately varied legal-workflow material rather than
ordinary statute, regulation, or case-opinion feeds:

- Supreme Court of Canada public factums, memoranda, and condensed books;
- Cullen Commission exhibits and Canadian inquiry evidence;
- UK Post Office Horizon Inquiry public witness statements, exhibits,
  submissions, and hearing documents;
- Australian parliamentary inquiry submissions and public inquiry exhibits;
- New Zealand Waitangi Tribunal briefs, evidence, submissions, and memoranda.

Discovery can find many more URLs than are downloaded. The downloader applies
diversity ceilings: at most 80 accepted files from one source family, 40 from
one semantic kind, and 12 from one source/kind pair. Selection favours
underrepresented source families and kinds before filling jurisdiction quotas.
This prevents a large exhibit index or one repeated filing series from
consuming the corpus. `state/source_inventory.json` records partial crawl
counts, repository-size signals, landing-page leads, and status counts so
future source expansion remains traceable.

Only public links are used. The ledger records the landing page, source URL,
access date, source terms note, byte hash, page count, and PDF generation
signals. A public link is not treated as a statement that the material is
authoritative legal advice; consult the originating body for the official
record and any third-party copyright restrictions.

Examples:

```powershell
python experiments/legal_pdf_corpus/harvest.py discover --source all
python experiments/legal_pdf_corpus/harvest.py download --max-new 100
python experiments/legal_pdf_corpus/harvest.py verify
```
