/** A download completeness check, not a substitute for the PDF parser. */
export function hasPdfEndMarker(bytes) {
  return /%%EOF[\0\t\n\f\r ]*$/u.test(new TextDecoder().decode(bytes.subarray(-1024)));
}
