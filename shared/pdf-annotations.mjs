/** Coordinates are normalized to the rotated, visible crop box; they never contain CSS pixels. */
export const ANNOTATION_SCHEMA = 'beaver.pdf-annotations.v1';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, n) => typeof v === 'string' && v.length <= n;
export const validRect = r => Array.isArray(r) && r.length === 4 &&
  r.every(v => Number.isFinite(v) && v >= 0 && v <= 1) && r[2] > r[0] && r[3] > r[1];
export function decodeAnnotationSet(value) {
  const bad = () => { throw new Error('Invalid PDF annotations.'); };
  if (!object(value) || value.schemaVersion !== ANNOTATION_SCHEMA ||
      !/^[a-f0-9]{64}$/.test(value.sourceSha256 ?? '') ||
      !Array.isArray(value.marks) || value.marks.length > 10_000) return bad();
  const ids = new Set(); let count = 0;
  const marks = value.marks.map(mark => {
    if (!object(mark) || !text(mark.id, 200) || !mark.id.trim() || ids.has(mark.id) ||
        !['highlight', 'margin'].includes(mark.kind) || !['automatic', 'manual'].includes(mark.origin) ||
        !text(mark.label, 500) || !text(mark.excerpt, 2_000) ||
        !Array.isArray(mark.rgb) || mark.rgb.length !== 3 ||
        !mark.rgb.every(v => Number.isFinite(v) && v >= 0 && v <= 1) ||
        !Number.isFinite(mark.opacity) || mark.opacity <= 0 || mark.opacity > 1 ||
        !Array.isArray(mark.fragments) || !mark.fragments.length || mark.fragments.length > 2_000) return bad();
    ids.add(mark.id); const pages = new Set();
    const fragments = mark.fragments.map(fragment => {
      if (!object(fragment) || !Number.isSafeInteger(fragment.pageNumber) ||
          fragment.pageNumber < 1 || fragment.pageNumber > 2_000 || pages.has(fragment.pageNumber) ||
          !Array.isArray(fragment.rects) || !fragment.rects.length ||
          (count += fragment.rects.length) > 50_000 || !fragment.rects.every(validRect)) return bad();
      pages.add(fragment.pageNumber);
      return { pageNumber: fragment.pageNumber, rects: fragment.rects.map(r => [...r]) };
    });
    return { id: mark.id, kind: mark.kind, origin: mark.origin, label: mark.label, excerpt: mark.excerpt,
      rgb: [...mark.rgb], opacity: mark.opacity, fragments: fragments.sort((a,b) => a.pageNumber-b.pageNumber) };
  });
  return { schemaVersion: ANNOTATION_SCHEMA, sourceSha256: value.sourceSha256, marks };
}
export function emptyAnnotationSet(sourceSha256) {
  return decodeAnnotationSet({ schemaVersion: ANNOTATION_SCHEMA, sourceSha256, marks: [] });
}
/** Missing means not edited; an empty saved set means the user deliberately removed every mark. */
export function annotationSetForSource(sets, role, sourceSha256) {
  if (!sets || !Object.hasOwn(sets, role)) return undefined;
  const value = decodeAnnotationSet(sets[role]);
  if (value.sourceSha256 !== sourceSha256)
    throw new Error('This PDF changed. Return to Sources to review highlights for the replacement PDF before building.');
  return value;
}
export function markContains(mark, pageNumber, x, y) {
  return mark.fragments.some(f => f.pageNumber===pageNumber &&
    f.rects.some(([x0,y0,x1,y1]) => x>=x0 && x<=x1 && y>=y0 && y<=y1));
}
export function rectToPdfQuad(rect,crop,rotation) {
  if(!validRect(rect) || ![crop.x,crop.y,crop.width,crop.height].every(Number.isFinite) ||
      crop.width<=0 || crop.height<=0) throw new Error('Invalid PDF geometry.');
  const angle=((rotation%360)+360)%360;
  if(![0,90,180,270].includes(angle)) throw new Error('Unsupported PDF rotation.');
  const point=(u,v) => {
    const [x,y]=angle===90 ? [v,u] : angle===180 ? [1-u,v] : angle===270 ? [1-v,1-u] : [u,1-v];
    return [crop.x+x*crop.width,crop.y+y*crop.height];
  };
  return [...point(rect[0],rect[1]),...point(rect[2],rect[1]),...point(rect[0],rect[3]),...point(rect[2],rect[3])];
}
export function quadBounds(quads) {
  const xs=quads.flatMap(q=>[q[0],q[2],q[4],q[6]]),ys=quads.flatMap(q=>[q[1],q[3],q[5],q[7]]);
  return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
}
