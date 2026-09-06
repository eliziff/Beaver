# PDF viewer geometry and rendering

2026-09-05: ChromeDriver, headless Chrome, 1440 x 1000, Vite development server.
The fixture contains 300 text pages with alternating letter/legal dimensions and
90-degree rotation every tenth page. It uses the production PdfView directly.

Observed run (synthetic text, local bytes; not a scan/download benchmark):
- Exact geometry for all 300 pages: 608.5 ms after mount.
- First visible canvas: 648.2 ms after mount.
- Jump to page 201: 16.4 ms until its canvas appeared.
- Three canvases retained after the jump.
- Document scroll height (451,612 px), all page dimensions and scroll position
  remained unchanged while the destination and adjacent pages painted.
- Zoom to 125% and resize to 700 x 900 passed. Screenshots visually inspected.
- Browser reported only the fixture's missing favicon, no application errors.

Reproduce: from frontend run `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3011`,
then from the repository root run `python frontend/experiments/pdf-viewer/check.py`.
ChromeDriver and Chrome must be available. Raw metrics and screenshots are ignored
under `results/`. No metered APIs or downloaded PDF corpus are used.

The previous renderer appended a page only after rasterization and rasterized the
whole document sequentially. The new renderer reserves exact geometry before any
canvas is appended and prioritizes the viewport with one viewport of prefetch and
an additional viewport of retention. Geometry is reused on zoom/resize; file bytes
continue to use the existing application cache.
