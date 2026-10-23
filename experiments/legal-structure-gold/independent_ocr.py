"""Record source-bound independent Tesseract lines for a failed gold extraction."""
import argparse
from pathlib import Path

import fitz
from author import digest, witnessed_lines, write_json
from gold import low_priority


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('pdf', type=Path)
    p.add_argument('--tessdata', type=Path, default=Path('C:/Program Files/Tesseract-OCR/tessdata'))
    a = p.parse_args()
    low_priority()
    source = digest(a.pdf)
    output = Path(__file__).resolve().parents[2]/'benchmarks/local-data/legal-structure-gold/independent-extraction'/source/'tesseract.json.gz'
    value = {'schema_version':'legal-structure-gold.extraction.v1', 'source_sha256':source,
             'method':{'provider':'pymupdf-tesseract', 'pymupdf_version':fitz.VersionBind,
                       'mupdf_version':fitz.VersionFitz, 'tesseract_version':'not exposed by PyMuPDF',
                       'dpi':300, 'full_page':True, 'model_sha256':digest(a.tessdata/'eng.traineddata')},
             'pages':[]}
    with fitz.open(a.pdf) as pdf:
        value['page_count'] = len(pdf)
        for number, page in enumerate(pdf, 1):
            textpage = page.get_textpage_ocr(language='eng', dpi=300, full=True, tessdata=str(a.tessdata))
            lines = []
            for block in page.get_text('dict', textpage=textpage)['blocks']:
                for line in block.get('lines', []):
                    text = ''.join(span['text'] for span in line['spans']).strip()
                    if text:
                        lines.append({'id':f'p{number}-l{len(lines)+1}', 'text':text})
            value['pages'].append({'page':number, 'lines':lines})
    witnessed_lines(value, source, value['page_count'])
    write_json(output, value)
    print(output)


if __name__ == '__main__':
    main()
