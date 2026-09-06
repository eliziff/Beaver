from pathlib import Path
p = Path('frontend/src/app/components/shared/views/PdfCanvas.tsx')
s = p.read_text()
old = '''                const anchor = pageAt(pages, offset);
                const fraction = (offset - pages[anchor].top) / pages[anchor].height;'''
new = '''                let anchor = pageAt(pages, offset);
                // An unresolved page at the top is only an estimate. Prefer an
                // already readable page in view, including a citation below it.
                if (pages[anchor].wrapper.dataset.geometryReady !== "true") {
                    const end = offset + (scroll?.clientHeight || 800);
                    for (let index = anchor + 1; index < pages.length && pages[index].top < end; index++) {
                        if (pages[index].wrapper.dataset.geometryReady === "true") { anchor = index; break; }
                    }
                }
                const fraction = (offset - pages[anchor].top) / pages[anchor].height;'''
assert s.count(old) == 1
s = s.replace(old, new)
old = 'style={{ scrollbarGutter: "stable" }}'
assert s.count(old) == 1
s = s.replace(old, 'style={{ scrollbarGutter: "stable", isolation: "isolate" }}')
p.write_text(s)
p = Path('frontend/src/app/components/shared/views/PdfView.test.tsx')
s = p.read_text()
old = '''        const top = selected().getBoundingClientRect().top;
        await act(async () => release());'''
new = '''        // The viewport can include the bottom of an unresolved preceding page.
        // Keep the readable target fixed, not a fractional point in that estimate.
        const scroll = container.querySelector<HTMLElement>(".overflow-auto")!;
        Object.defineProperty(scroll, "clientHeight", { value: 800 });
        scroll.scrollTop += selected().getBoundingClientRect().top - 200;
        const top = selected().getBoundingClientRect().top;
        expect(top).toBeCloseTo(200);
        await act(async () => release());'''
assert s.count(old) == 1
p.write_text(s.replace(old, new))
