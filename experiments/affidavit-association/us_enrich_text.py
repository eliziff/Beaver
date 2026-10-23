"""Enrich sparse reviewed-output text without altering reviewed PDFs or receipts."""
import hashlib
import json
from datetime import datetime, timezone

import fitz
import us_author as u


def main():
    report_path=u.OUT/'text-enrichment.json'
    previous=json.loads(report_path.read_text(encoding='utf8')) if report_path.exists() else {}
    changes=previous.get('changes',[])
    for folder in sorted((u.OUT/'records').iterdir()):
        if not (folder/'gold.json').exists():
            continue
        for path in sorted((folder/'files').glob('*.pdf')):
            txt=path.with_suffix('.txt')
            before=txt.read_bytes()
            if len(before.decode('utf8').split())>=40:
                continue
            with fitz.open(path) as document:
                text='\n'.join(f'[page {i+1}]\n{u.split.tesseract_cli(page)}' for i,page in enumerate(document))
            if len(text.split())<=len(before.decode('utf8').split())+30:
                continue
            txt.write_text(text,encoding='utf8')
            changes.append({'record_id':folder.name,'file':txt.name,
                'previous_sha256':hashlib.sha256(before).hexdigest(),
                'sha256':hashlib.sha256(txt.read_bytes()).hexdigest(),
                'pdf_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                'words':len(text.split())})
    report={'operation':'mechanical OCR enrichment of reviewed PDF outputs; original review input manifests remain unchanged',
            'recorded':datetime.now(timezone.utc).isoformat(),'changes':changes}
    u.dump(report_path,report)
    print(json.dumps(report,indent=2))


if __name__=='__main__':
    main()
