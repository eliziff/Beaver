"""Complete original-page PDFium OCR derivatives for independent source-view repair."""
import os
import subprocess
import sys

import pypdfium2 as pdfium

from second_canada_review_prepare import OUT, original
from second_tribunals_sources import dump, sha


def main(digest, pages):
    folder = OUT / 'review-peer/source-ocr' / digest
    folder.mkdir(parents=True, exist_ok=True)
    pdf = pdfium.PdfDocument(str(original(digest)))
    executable = os.environ.get('TESSERACT_EXE', r'C:\Program Files\Tesseract-OCR\tesseract.exe')
    for number in pages:
        page = pdf[number - 1]
        bitmap = page.render(scale=300 / 72)
        image = bitmap.to_pil()
        target = folder / f'{number:04}.png'
        image.save(target)
        text = subprocess.run([executable, str(target), 'stdout', '-l', 'eng'], capture_output=True,
                              encoding='utf-8', check=True, env=dict(os.environ, OMP_THREAD_LIMIT='1')).stdout
        text_path = target.with_suffix('.txt')
        text_path.write_text(text, encoding='utf8')
        dump(target.with_suffix('.json'), dict(original_source_sha256=digest, original_page=number,
             method='full_original_pdfium_300dpi_tesseract_eng', image_sha256=sha(target),
             text_sha256=sha(text_path), no_content_redaction=True))
        image.close()
        bitmap.close()
        page.close()
        print(number, len(text), flush=True)
    pdf.close()


if __name__ == '__main__':
    main(sys.argv[1], [int(number) for number in sys.argv[2:]])
