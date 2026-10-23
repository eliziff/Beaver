"""Check retained native filing dates against every retained source page."""
import json
import re
from pathlib import Path
import fitz
import us_author as u


DATE=re.compile(r'\bFiled:?\s+(?:on\s+)?(?:\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})\b',re.I)


def dates(page):
    return {re.sub(r'\s+',' ',m.group()).lower() for m in DATE.finditer(page.get_text())}


def main():
    errors=[]
    checked=0
    for folder in sorted((u.OUT/'records').iterdir()):
        if not (folder/'gold.json').exists():
            continue
        sources=json.loads((u.OUT/'work'/folder.name/'sources.json').read_text(encoding='utf8'))
        paths={Path(p['path']).name:p['path'] for p in sources}
        split=json.loads((folder/'split.json').read_text(encoding='utf8'))
        primary=next(p for p in sources if p['attachment']==0)
        referring={'file':'affidavit.pdf','referring':True,'source_files':[{'file':Path(primary['path']).name,'pages':split['affidavit_pages']}]}
        for exhibit in [referring]+split['exhibits']:
            output_path=folder/exhibit['file'] if exhibit.get('referring') else folder/'files'/exhibit['file']
            with fitz.open(output_path) as output:
                offset=0
                for source in exhibit['source_files']:
                    with fitz.open(paths[source['file']]) as original:
                        for number in source['pages']:
                            checked+=1
                            missing=dates(original[number-1])-dates(output[offset])
                            if missing:
                                errors.append({'record_id':folder.name,'file':exhibit['file'],
                                    'output_page':offset+1,'source_page':number,'missing_dates':sorted(missing)})
                            offset+=1
                if offset!=len(output):
                    raise ValueError('Source/output page accounting mismatch: '+folder.name)
    report={'checked_retained_source_pages':checked,'includes_referring_records':True,'errors':errors}
    u.dump(u.OUT/'filing-date-audit.json',report)
    print(json.dumps(report,indent=2))


if __name__=='__main__':
    main()
