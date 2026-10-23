"""Flag lost native documentary lines for source-image review, not automatic approval."""
import json
import re
from pathlib import Path
import fitz
import us_author as u


def normal(text):
    return re.sub('[^a-z0-9]','',text.lower())


def main():
    flags=[]
    checked=0
    for folder in sorted((u.OUT/'records').iterdir()):
        if not (folder/'gold.json').exists():
            continue
        parts=json.loads((u.OUT/'work'/folder.name/'sources.json').read_text(encoding='utf8'))
        paths={Path(p['path']).name:p['path'] for p in parts}
        split=json.loads((folder/'split.json').read_text(encoding='utf8'))
        primary=next(p for p in parts if p['attachment']==0)
        referring={'file':'affidavit.pdf','referring':True,'source_files':[{'file':Path(primary['path']).name,'pages':split['affidavit_pages']}]}
        for exhibit in [referring]+split['exhibits']:
            output_path=folder/exhibit['file'] if exhibit.get('referring') else folder/'files'/exhibit['file']
            with fitz.open(output_path) as output:
                offset=0
                for source in exhibit['source_files']:
                    with fitz.open(paths[source['file']]) as original:
                        for number in source['pages']:
                            checked+=1
                            retained=normal(output[offset].get_text())
                            missing=[]
                            for line in original[number-1].get_text().splitlines():
                                header=re.sub(r'^[\x00-\x20*]+','',line)
                                if len(re.findall('[A-Za-z]{2,}',line))>=6 and not u.split.ECF_HEADER.match(header) and normal(line) not in retained:
                                    missing.append(line)
                            if missing:
                                flags.append({'record_id':folder.name,'file':exhibit['file'],
                                    'output_page':offset+1,'source_page':number,'missing_lines':missing})
                            offset+=1
                if offset!=len(output):
                    raise ValueError('Source/output page accounting mismatch: '+folder.name)
    u.dump(u.OUT/'native-content-audit-current.json',{'checked_pages':checked,'flags':flags,
        'interpretation':'Flags require source-image triage; this diagnostic does not itself approve physical fidelity.'})
    print(json.dumps({'checked_pages':checked,'flagged_pages':len(flags),'records':sorted({r['record_id'] for r in flags})}))


if __name__=='__main__':
    main()
