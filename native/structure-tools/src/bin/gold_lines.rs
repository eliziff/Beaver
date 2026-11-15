//! A PDF's lines as the gold is authored over them, from the one extraction cache the grader and the training read
//! (`legalpdf::gold_structure_inputs`: the PDF read only where its extraction is not kept): `gold_lines PDF SHA256 ROOT`
//! prints, as one JSON object, each line in reading order (its id, page, text, box and the spans its text layer sets as
//! superscript), each page's size, and the extraction's identity.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let [pdf, sha256, root] = arguments.as_slice() else {
        return Err("usage: gold_lines PDF SHA256 ROOT".into());
    };
    let extracted = legalpdf::gold_structure_inputs(std::path::Path::new(pdf), sha256, std::path::Path::new(root))?;
    let mut lines = Vec::new();
    let mut sizes = serde_json::Map::new();
    for (at, page) in extracted.pages.iter().enumerate() {
        sizes.insert((at + 1).to_string(), serde_json::json!([page.width, page.height]));
        let mut ordered: Vec<_> = page.lines.iter().collect();
        ordered.sort_by_key(|line| line.reading_order);
        lines.extend(ordered.into_iter().map(|line| serde_json::json!({
            "id": line.id, "page": at + 1, "text": line.text, "bbox": line.bbox,
            "superscripts": line.spans.iter().filter(|span| span.superscript).map(|span| [span.start, span.end]).collect::<Vec<_>>(),
        })));
    }
    println!("{}", serde_json::json!({"lines": lines, "sizes": sizes, "extraction": legalpdf::gold_inputs_identity()}));
    Ok(())
}
