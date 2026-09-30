"""Select Canadian reporter cases from the app's installed A2AJ inventory."""
import collections
import json
import os
from pathlib import Path
import random
import re
import sqlite3

OUT = Path(__file__).resolve().parents[2] / 'tmp/pdf-pagination'
database = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalProducts/LegalData/providers/a2aj/a2aj.sqlite'
eras = [(1875, 1910), (1910, 1940), (1940, 1970), (1970, 1990),
        (1990, 2000), (2000, 2010), (2010, 2027)]
existing = {row['id']: row for row in json.loads((OUT / 'authorities-manifest.json').read_text(encoding='utf-8'))
            if row['provider'] == 'a2aj' and row['origin'] == 'original'}
groups = collections.defaultdict(list)
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
    for ident, court, en, alternate, fr, alternate_fr, date in connection.execute(
            "select id,dataset,citation_en,citation2_en,citation_fr,citation2_fr,document_date_en "
            "from document where doc_type='cases' and dataset='SCC'"):
        citation = next((value for value in [en, alternate, fr, alternate_fr]
                         if value and re.search(r'\b(?:S\.?\s*C\.?\s*R\.?|R\.?\s*C\.?\s*S\.?)\s+\d+\s*$', value)), None)
        if not citation:
            continue
        year = int(date[:4]) if date else int(re.search(r'\d{4}', citation)[0])
        era = next((f'{lo}-{hi-1}' for lo, hi in eras if lo <= year < hi), None)
        if not era:
            continue
        groups[era].append({'citation': existing.get(ident, {}).get('citation', citation),
                            'resolutionCitation': en or fr or citation,
                            'provider': 'a2aj', 'id': ident, 'jurisdiction': 'CA',
                            'court': court, 'reporter': 'SCR/RCS', 'year': year, 'stratum': era})
rng = random.Random(20260928)
coverage = {era: {'available_candidates': len(rows), 'target_originals': 50}
            for era, rows in sorted(groups.items())}
for rows in groups.values():
    rng.shuffle(rows)
    rows.sort(key=lambda row: row['id'] in existing)
selected = []
while any(groups.values()):
    for era in sorted(groups):
        if groups[era]:
            selected.append(groups[era].pop())
(OUT / 'canadian-authorities-candidates.json').write_text(json.dumps(selected, indent=2), encoding='utf-8')
(OUT / 'canadian-coverage.json').write_text(json.dumps({
    'target': 350, 'strata': coverage,
    'scope': 'SCC reporter PDFs acquired through the production Authorities resolver',
    'gaps': 'The installed citation fields expose SCR/RCS reporter starts, not provincial or Federal Court reporter starts. This run cannot certify those reporter families.'
}, indent=2), encoding='utf-8')
print(json.dumps(coverage))
