import { createRoot } from "react-dom/client";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { PdfView } from "../../src/app/components/shared/views/PdfView";
import "../../src/app/globals.css";

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let index = 1; index <= 300; index++) {
    const page = pdf.addPage(index % 2 ? [612, 792] : [612, 1008]);
    if (index % 10 === 0) page.setRotation(degrees(90));
    page.drawText(`Page ${index} - PDF viewer performance`, { x: 40, y: 720, size: 20, font });
    for (let line = 0; line < 30; line++) {
        page.drawText(`Line ${line + 1}: The viewer must keep geometry stable while scrolling.`, {
            x: 40, y: 680 - line * 19, size: 11, font,
        });
    }
}
const bytes = await pdf.save();
const metrics = { start: performance.now(), geometryMs: 0, firstCanvasMs: 0 };
Object.assign(window, { pdfMetrics: metrics });
const observer = new MutationObserver(() => {
    if (!metrics.geometryMs && document.querySelectorAll("[data-page-number]").length === 300)
        metrics.geometryMs = performance.now() - metrics.start;
    if (!metrics.firstCanvasMs && document.querySelector("canvas"))
        metrics.firstCanvasMs = performance.now() - metrics.start;
});
observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
createRoot(document.getElementById("root")!).render(
    <div style={{ height: "90vh", width: "80vw", margin: "5vh auto", display: "flex" }}>
        <PdfView doc={null} bytes={bytes} />
    </div>,
);
