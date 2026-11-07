//! What the aligner asks of a PDF itself: where its images stand. A page's images are found by walking its content stream
//! (lopdf, the parser's own PDF library), the transformation at each image giving its box, in points from the page's top
//! left corner.
use lopdf::content::Content;
use lopdf::{Dictionary, Document, Object, ObjectId};

type Matrix = [f64; 6];

fn multiply(a: &Matrix, b: &Matrix) -> Matrix {
    [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
     a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]]
}

fn number(object: &Object) -> f64 {
    object.as_float().map(f64::from).or_else(|_| object.as_i64().map(|n| n as f64)).unwrap_or(0.0)
}

fn resolved<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Object> {
    document.dereference(object).ok().map(|(_, found)| found)
}

fn dictionary<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    resolved(document, object)?.as_dict().ok()
}

fn inherited<'a>(document: &'a Document, mut page: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    for _ in 0..64 {
        if let Ok(found) = page.get(key) {
            return Some(found);
        }
        page = dictionary(document, page.get(b"Parent").ok()?)?;
    }
    None
}

fn rectangle(document: &Document, object: &Object) -> Option<[f64; 4]> {
    let items = resolved(document, object)?.as_array().ok()?;
    let values: Vec<f64> = items.iter().filter_map(|item| resolved(document, item)).map(number).collect();
    (values.len() == 4).then(|| [values[0].min(values[2]), values[1].min(values[3]), values[0].max(values[2]), values[1].max(values[3])])
}

fn walk(document: &Document, content: &[u8], resources: Option<&Dictionary>, start: Matrix, depth: usize, out: &mut Vec<[f64; 4]>) {
    let Ok(content) = Content::decode(content) else { return };
    let (mut matrix, mut stack) = (start, Vec::new());
    for operation in content.operations {
        match operation.operator.as_str() {
            "q" => stack.push(matrix),
            "Q" => matrix = stack.pop().unwrap_or(matrix),
            "cm" if operation.operands.len() == 6 => {
                let m: Vec<f64> = operation.operands.iter().map(number).collect();
                matrix = multiply(&[m[0], m[1], m[2], m[3], m[4], m[5]], &matrix);
            }
            "Do" => {
                let Some(name) = operation.operands.first().and_then(|name| name.as_name().ok()) else { continue };
                let found = resources.and_then(|r| dictionary(document, r.get(b"XObject").ok()?)).and_then(|x| resolved(document, x.get(name).ok()?));
                let Some(Object::Stream(stream)) = found else { continue };
                match stream.dict.get(b"Subtype").ok().and_then(|kind| kind.as_name().ok()) {
                    Some(b"Image") => {
                        let corners = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]].map(|[x, y]: [f64; 2]| {
                            [x * matrix[0] + y * matrix[2] + matrix[4], x * matrix[1] + y * matrix[3] + matrix[5]]
                        });
                        let (xs, ys) = (corners.map(|c| c[0]), corners.map(|c| c[1]));
                        out.push([xs.iter().copied().fold(f64::MAX, f64::min), ys.iter().copied().fold(f64::MAX, f64::min),
                                  xs.iter().copied().fold(f64::MIN, f64::max), ys.iter().copied().fold(f64::MIN, f64::max)]);
                    }
                    Some(b"Form") if depth < 8 => {
                        let form = stream.dict.get(b"Matrix").ok().and_then(|m| resolved(document, m)).and_then(|m| m.as_array().ok())
                            .filter(|m| m.len() == 6).map(|m| { let v: Vec<f64> = m.iter().map(number).collect(); [v[0], v[1], v[2], v[3], v[4], v[5]] })
                            .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
                        let inner = stream.dict.get(b"Resources").ok().and_then(|r| dictionary(document, r)).or(resources);
                        let body = stream.decompressed_content().unwrap_or_else(|_| stream.content.clone());
                        walk(document, &body, inner, multiply(&form, &matrix), depth + 1, out);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

pub struct PageImages {
    pub size: (f64, f64),
    pub boxes: Vec<[f64; 4]>,
}

fn images_on(document: &Document, id: ObjectId) -> PageImages {
    let Ok(page) = document.get_dictionary(id) else { return PageImages { size: (612.0, 792.0), boxes: Vec::new() } };
    let media = inherited(document, page, b"CropBox").or_else(|| inherited(document, page, b"MediaBox")).and_then(|m| rectangle(document, m)).unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let rotation = inherited(document, page, b"Rotate").and_then(|r| resolved(document, r)).and_then(|r| r.as_i64().ok()).unwrap_or(0).rem_euclid(360);
    let resources = inherited(document, page, b"Resources").and_then(|r| dictionary(document, r));
    let mut boxes = Vec::new();
    walk(document, &document.get_page_content(id), resources, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], 0, &mut boxes);
    let (width, height) = (media[2] - media[0], media[3] - media[1]);
    let boxes = boxes.into_iter().map(|b| {
        let (x0, y0, x1, y1) = (b[0] - media[0], b[1] - media[1], b[2] - media[0], b[3] - media[1]);
        match rotation {
            90 => [y0, x0, y1, x1],
            180 => [width - x1, y0, width - x0, y1],
            270 => [height - y1, width - x1, height - y0, width - x0],
            _ => [x0, height - y1, x1, height - y0],
        }
    }).collect();
    PageImages { size: if rotation == 90 || rotation == 270 { (height, width) } else { (width, height) }, boxes }
}

/// Each page's size and images, in page order; an unreadable PDF has none.
pub fn images(path: &std::path::Path) -> Vec<PageImages> {
    images_of(path, |_, _| true)
}

/// As `images`, walking only the pages `wanted` (a page, the page count) names: the others stand empty.
pub fn images_of(path: &std::path::Path, wanted: impl Fn(usize, usize) -> bool) -> Vec<PageImages> {
    let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
    let Ok(document) = Document::load_mem(&bytes) else { return Vec::new() };
    drop(bytes);
    let pages = document.get_pages();
    pages.values().enumerate().map(|(page, &id)| if wanted(page, pages.len()) { images_on(&document, id) } else { PageImages { size: (612.0, 792.0), boxes: Vec::new() } }).collect()
}

pub fn page_count(path: &std::path::Path) -> Option<usize> {
    let bytes = std::fs::read(path).ok()?;
    Some(Document::load_mem(&bytes).ok()?.get_pages().len())
}

/// Each page's text layer, in page order, for a PDF the corpus has not indexed.
pub fn page_texts(path: &std::path::Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
    let Ok(document) = Document::load_mem(&bytes) else { return Vec::new() };
    let pages: Vec<u32> = document.get_pages().keys().copied().collect();
    pages.iter().map(|&page| document.extract_text(&[page]).unwrap_or_default()).collect()
}

/// A page's picture: width, height and RGBA pixels, at `dpi`.
pub fn render_page(bytes: &[u8], page: usize, dpi: f32) -> Option<(usize, usize, Vec<u8>)> {
    use hayro::hayro_interpret::InterpreterSettings;
    use hayro::hayro_syntax::Pdf;
    use hayro::vello_cpu::color::palette::css::WHITE;
    use hayro::{render, RenderCache, RenderSettings};
    let document = Pdf::new(bytes.to_vec()).ok()?;
    let pages = document.pages();
    let chosen = pages.iter().nth(page)?;
    let settings = RenderSettings { x_scale: dpi / 72.0, y_scale: dpi / 72.0, bg_color: WHITE, ..Default::default() };
    let pixmap = render(chosen, &RenderCache::new(), &InterpreterSettings::default(), &settings);
    Some((pixmap.width() as usize, pixmap.height() as usize, pixmap.data_as_u8_slice().to_vec()))
}
