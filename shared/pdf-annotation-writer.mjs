import { decodeAnnotationSet } from './pdf-annotations.mjs';

/** Standard editable annotations, with printable appearance streams; never alter page contents. A mark is its colour
 *  and place only: no author or comment for a viewer to show beside it. The engine writes them (pdfWriteAnnotations,
 *  legal-pdf-extraction-processor/src/annotate.rs) as an incremental update: the PDF's own bytes stay as they are and
 *  the annotations follow them. With `disarm`, what removeActiveContent takes out goes too. Returns the new bytes. */
export function annotatePdf(engine, bytes, set, namespace, { disarm = false } = {}) {
  const { marks } = decodeAnnotationSet(set);
  if (!marks.length && !disarm) return bytes;
  return engine.pdfWriteAnnotations(bytes, marks, namespace, disarm).bytes;
}
