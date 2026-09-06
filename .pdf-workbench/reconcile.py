from pathlib import Path
p = Path('frontend/src/app/components/shared/views/PdfView.test.tsx')
s = p.read_text()
def change(old, new):
    global s
    assert s.count(old) == 1, (old, s.count(old))
    s = s.replace(old, new)
change('it("renders every page with same-origin standard fonts and cancels obsolete work",', 'it("reserves every page with locators and same-origin fonts and cancels obsolete work",')
change('''        expect(container.querySelector(".pdf-text-layer")).toBeNull();''', '''        for (const page of container.querySelectorAll<HTMLElement>("[data-page-number]")) {
            expect(page).toHaveAttribute("data-legal-block");
            expect(page).toHaveAttribute("data-locator-kind", "page");
            expect(page).toHaveAttribute("data-locator-value", page.dataset.pageNumber);
        }
        expect(await screen.findByText("Page 1 text")).toBeVisible();''')
change('''    it("finishes exact mixed-size geometry and bounds canvases when jumping",''', '''    it("allows an ordinary reader selection to resolve to its PDF page", async () => {
        mocks.numPages = 1;
        render(<PdfView doc={null} bytes={new Uint8Array([1])} />);
        const text = await screen.findByText("Page 1 text");
        const range = document.createRange();
        range.setStart(text.firstChild!, 0);
        range.setEnd(text.firstChild!, 6);
        const selection = window.getSelection()!;
        selection.removeAllRanges(); selection.addRange(range);
        expect(selection.toString()).toBe("Page 1");
        expect(text.closest("[data-legal-block]")).toHaveAttribute("data-locator-value", "1");
        expect(text.parentElement).toHaveStyle({ userSelect: "text", pointerEvents: "auto" });
    });

    it("finishes exact mixed-size geometry and bounds canvases when jumping",''')
change('''        // Page 201 starts after 100 pairs of mixed-size pages and gaps.''', '''        await screen.findByText("Page 1 text");
        expect(pages[100].querySelector(".pdf-text-layer")).toBeNull();
        expect(mocks.textLayers.length).toBeLessThan(4);
        // Page 201 starts after 100 pairs of mixed-size pages and gaps.''')
change('''        expect(pages[200].querySelector("canvas")).toBeNull();''', '''        expect(pages[200].querySelector("canvas")).toBeNull();
        expect(pages[0].querySelectorAll(".pdf-text-layer")).toHaveLength(1);
        expect(mocks.textLayers.filter(page => page === 1)).toHaveLength(1);
        expect(mocks.textLayers.length).toBeLessThan(10);''')
change('''    it("shares a slow text layer between quote search and painting and keeps text selection in ordinary readers",''', '''    it("shares an in-flight text layer between painting and quote search",''')
change('''    it("a bad text stream cannot hide a successfully painted scan", async () => {''', '''    it.each([false, true])("keeps the PDF readable when text extraction fails (quotes: %s)", async (withQuotes) => {''')
change('''            quotes={[{ quote: "Missing passage" }]} />);''', '''            quotes={withQuotes ? [{ quote: "Missing passage" }] : undefined} />);''')
p.write_text(s)
p = Path('frontend/src/app/components/shared/views/pdfTextLayer.css')
p.write_text('''/* PDF.js reports an unrotated text layer and the viewport's main rotation. */
.pdf-text-layer { transform-origin: 0 0; }
.pdf-text-layer[data-main-rotation="90"] { transform: rotate(90deg) translateY(-100%); }
.pdf-text-layer[data-main-rotation="180"] { transform: rotate(180deg) translate(-100%, -100%); }
.pdf-text-layer[data-main-rotation="270"] { transform: rotate(270deg) translateX(-100%); }
''')
p = Path('frontend/src/app/components/shared/views/PdfCanvas.tsx')
s = p.read_text()
assert 'import "./pdfTextLayer.css";' not in s
p.write_text('import "./pdfTextLayer.css";\n' + s)
p = Path('scripts/test-pdf-first-use.mjs')
s = p.read_text()
def browser_change(old, new):
    global s
    assert s.count(old) == 1, (old, s.count(old))
    s = s.replace(old, new)
browser_change('''  if (n === 299) { page.setCropBox(20, 30, 560, 710); page.setRotation(degrees(90)); }''', '''  if (n >= 297 && n <= 299) {
    page.setCropBox(20, 30, 560, 710); page.setRotation(degrees([180, 270, 90][n - 297]));
  }''')
browser_change("const query = new URLSearchParams(location.search);", "const query = new URLSearchParams(location.search);\nconst targetPage = Number(query.get('target') || 299);")
browser_change("quotes={editing ? undefined : [{page:299,quote:'Target passage on page 299.'}]}", "quotes={editing ? undefined : [{page:targetPage,quote:'Target passage on page '+targetPage+'.'}]}")
browser_change("    if (candidate) {\n      await page.goto(`${origin}/${entry}?editor`);", '''    if (candidate) {
      // Compare the actual highlight box to raster ink, not just its own CSS.
      report.rotations = [];
      for (const [number, angle] of [[297, 180], [298, 270], [299, 90]]) {
        await page.goto(`${origin}/${entry}?target=${number}`);
        const rotated = page.locator(`[data-page-number="${number}"]`);
        await rotated.locator('canvas').waitFor();
        await rotated.locator('.pdf-text-highlight').waitFor();
        const ink = await rotated.evaluate(wrapper => {
          const canvas = wrapper.querySelector('canvas');
          const c = canvas.getBoundingClientRect();
          const r = wrapper.querySelector('.pdf-text-highlight').getBoundingClientRect();
          const x = Math.max(0, Math.floor((r.left-c.left)*canvas.width/c.width));
          const y = Math.max(0, Math.floor((r.top-c.top)*canvas.height/c.height));
          const w = Math.min(canvas.width-x, Math.ceil(r.width*canvas.width/c.width));
          const h = Math.min(canvas.height-y, Math.ceil(r.height*canvas.height/c.height));
          const data = canvas.getContext('2d').getImageData(x,y,w,h).data;
          let dark = 0;
          for(let i=0;i<data.length;i+=4) if(data[i]<100 && data[i+1]<100 && data[i+2]<100 && data[i+3]>128) dark++;
          return { dark, width:r.width, height:r.height };
        });
        assert.ok(ink.dark > 50, `rotation ${angle}: highlight must cover rendered text ink`);
        assert.equal(ink.height > ink.width, angle !== 180);
        report.rotations.push({ angle, inkPixels:ink.dark });
        await page.screenshot({path:path.join(reportDir,`candidate-rotation-${angle}.png`)});
      }
      await page.goto(`${origin}/${entry}?editor`);''')
p.write_text(s)
p = Path('docs/pdf-first-use.md')
s = p.read_text().replace('PDF.js rendering options are unchanged. No page raster or highlight is flattened.', 'PDF.js rendering options are unchanged. No page raster or highlight is flattened.\nThe text-layer rotation stylesheet follows PDF.js viewport rotation so selection\nand quote highlights align with cropped/rotated raster pages.')
p.write_text(s)
