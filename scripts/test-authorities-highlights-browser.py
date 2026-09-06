"""Real browser selection/drawing -> persisted draft -> real book export -> independent PDF edit.

Start backend/scripts/authorities-highlight-browser-runtime.ts with tsx (port 3037),
then Vite on port 3036 with BEAVER_API_ORIGIN=http://127.0.0.1:3037.
Requires Python playwright + pymupdf and a Chromium browser. No OCR or metered API calls.
"""
from __future__ import annotations
import argparse
import json
import re
import shutil
from pathlib import Path
import pymupdf as fitz
from playwright.sync_api import sync_playwright, expect


def run(url: str, output: Path, browser: str | None):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        chromium = playwright.chromium.launch(executable_path=browser, headless=True, args=['--no-sandbox'])
        page = chromium.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        errors: list[str] = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url, wait_until='networkidle')
        page.get_by_role('button', name='Edit in PDF').click()
        sidebar = page.get_by_role('complementary', name='Highlights')
        expect(sidebar.get_by_role('listitem')).to_have_count(2)
        page.wait_for_function("document.querySelectorAll('[data-page-number]').length === 12")
        page.screenshot(path=str(output / '01-editor.png'))
        assert page.locator('canvas').count() <= 5, 'Do not rasterize the whole document.'
        sidebar.get_by_role('button', name=re.compile('para 42.*Second independent quote')).click()
        expect(page.get_by_role('textbox', name='PDF page')).to_have_value('2')
        expect(page.locator('[data-page-number="2"] canvas')).to_be_attached()
        page.screenshot(path=str(output / '01b-focused-quote.png'))
        first = sidebar.get_by_role('listitem').filter(has_text='First independent quote')
        first.get_by_role('button', name='Delete para 42 · Quote').click()
        expect(sidebar.get_by_role('listitem')).to_have_count(1)

        def jump(number: int):
            field = page.get_by_role('textbox', name='PDF page')
            field.fill(str(number)); field.press('Enter')
            expect(page.locator(f'[data-page-number="{number}"] canvas')).to_be_attached()
            return page.locator(f'[data-page-number="{number}"]')

        def drag(box, left, top, right, bottom):
            page.mouse.move(box['x'] + left * box['width'], box['y'] + top * box['height'])
            page.mouse.down()
            page.mouse.move(box['x'] + right * box['width'], box['y'] + bottom * box['height'], steps=12)
            page.mouse.up()

        source_page = jump(7)
        page.get_by_role('button', name='Highlight text', exact=True).click()
        text = source_page.locator('.pdf-text-layer > span').filter(has_text='Uncited passage on page 7.')
        expect(text).to_be_visible()
        drag(text.bounding_box(), .01, .5, .99, .5)
        expect(sidebar.get_by_role('listitem')).to_have_count(2)
        expect(sidebar.get_by_role('listitem').filter(has_text='Uncited passage')).to_have_count(1)
        page.get_by_role('combobox', name='Remove highlighting').select_option('erase-text')
        drag(text.bounding_box(), .01, .5, .48, .5)
        expect(sidebar.get_by_role('listitem')).to_have_count(2)
        page.get_by_role('button', name='Undo', exact=True).click()
        expect(sidebar.get_by_role('listitem').filter(has_text='Uncited passage')).to_have_count(1)
        page.get_by_role('button', name='Redo', exact=True).click()
        expect(sidebar.get_by_role('listitem').filter(has_text='Uncited passage')).to_have_count(0)

        rotated = jump(6)
        page.get_by_role('button', name='Draw highlight', exact=True).click()
        drag(rotated.bounding_box(), .15, .15, .45, .21)
        expect(sidebar.get_by_role('listitem')).to_have_count(3)
        page.keyboard.press('Control+z'); expect(sidebar.get_by_role('listitem')).to_have_count(2)
        page.keyboard.press('Control+Shift+z'); expect(sidebar.get_by_role('listitem')).to_have_count(3)
        page.screenshot(path=str(output / '02-rotated-edit.png'))
        page.get_by_role('combobox', name='Authority PDF').select_option('scan-en')
        expect(page.locator('[data-page-number]')).to_have_count(1)
        expect(page.locator('canvas')).to_have_count(1)
        page.get_by_role('button', name='Draw highlight', exact=True).click()
        drag(page.locator('[data-page-number="1"]').bounding_box(), .12, .20, .85, .28)
        expect(sidebar.get_by_role('listitem')).to_have_count(1)
        page.screenshot(path=str(output / '03-scan-edit.png'))
        page.get_by_role('button', name='Save and close', exact=True).click()
        expect(page.get_by_role('dialog')).to_have_count(0)
        saved = page.evaluate('window.annotationTestProduct')
        text_marks = saved['state']['authorities']['text']['annotations']['text-en']['marks']
        assert len(text_marks) == 3
        assert all(mark['excerpt'] != 'First independent quote' for mark in text_marks)
        assert len(saved['state']['authorities']['scan']['annotations']['scan-en']['marks']) == 1
        (output / 'saved-draft.json').write_text(json.dumps(saved, indent=2))
        page.get_by_role('button', name='Edit in PDF').click()
        expect(sidebar.get_by_role('listitem')).to_have_count(3)
        page.set_viewport_size({'width': 760, 'height': 900})
        page.screenshot(path=str(output / '04-narrow-editor.png'))
        dialog = page.get_by_role('dialog').first
        assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth + 2'), 'Editor overflows horizontally.'
        page.get_by_role('button', name='Save and close', exact=True).click()
        expect(page.get_by_role('dialog')).to_have_count(0)
        with page.expect_download() as download:
            page.get_by_role('button', name='Build test book').click()
        pdf_path = output / 'edited-book.pdf'
        download.value.save_as(str(pdf_path))
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.get_by_role('button', name='Start with no automatic highlights').click()
        page.get_by_role('button', name='Edit in PDF').click()
        expect(sidebar.get_by_role('listitem')).to_have_count(0)
        expect(page.locator('[data-page-number]')).to_have_count(12)
        page.get_by_role('button', name='Draw highlight', exact=True).click()
        drag(page.locator('[data-page-number="1"]').bounding_box(), .15, .15, .45, .20)
        expect(sidebar.get_by_role('listitem')).to_have_count(1)
        page.get_by_role('button', name='Save and close', exact=True).click()
        expect(page.get_by_role('dialog')).to_have_count(0)
        manual = page.evaluate('window.annotationTestProduct')
        assert manual['state']['settings']['passageMarking'] == 'none'
        assert len(manual['state']['authorities']['text']['annotations']['text-en']['marks']) == 1
        with page.expect_download() as download:
            page.get_by_role('button', name='Build test book').click()
        download.value.save_as(str(output / 'manual-only-book.pdf'))
        assert not errors, errors
        chromium.close()

    # PyMuPDF is independent of the writer: inspect, render, delete, save and reopen its annotations.
    document = fitz.open(pdf_path)
    count = sum(len(list(page.annots() or [])) for page in document)
    assert count == 4, count
    assert all(annot.type[0] == fitz.PDF_ANNOT_HIGHLIGHT for page in document for annot in page.annots() or [])
    assert 'Second independent quote' in document[3].get_text()
    document[3].get_pixmap().save(output / '05-export.png')
    rotated_mark = next(mark for mark in text_marks if mark['fragments'][0]['pageNumber'] == 6)
    rect = rotated_mark['fragments'][0]['rects'][0]
    image = document[7].get_pixmap()
    pixel = image.pixel(int(image.width*(rect[0]+rect[2])/2), int(image.height*(rect[1]+rect[3])/2))
    assert pixel[0] > pixel[2] + 20, ('Rotated highlight drifted', pixel)
    document[7].get_pixmap().save(output / '06-rotated-export.png')
    owner = document[3]
    owner.delete_annot(next(owner.annots()))
    document.save(output / 'roundtrip-deleted.pdf')
    document.close()
    with fitz.open(output / 'roundtrip-deleted.pdf') as reread:
        assert sum(len(list(page.annots() or [])) for page in reread) == 3
        assert 'Second independent quote' in reread[3].get_text()
    with fitz.open(output / 'manual-only-book.pdf') as manual_pdf:
        assert sum(len(list(page.annots() or [])) for page in manual_pdf) == 1
    report = {'browser_errors': errors, 'exported_annotations': count, 'roundtrip_annotations_after_delete': 3,
              'manual_only_annotations': 1, 'rotated_pixel': pixel, 'passed': True}
    (output / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:3036/tests/authorities-highlights/')
    parser.add_argument('--output', type=Path, default=Path('/tmp/authorities-highlight-test'))
    parser.add_argument('--browser', default=shutil.which('google-chrome') or shutil.which('chromium'))
    args = parser.parse_args()
    run(args.url, args.output, args.browser)
