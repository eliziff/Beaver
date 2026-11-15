//! A PDF's pages as the engine draws them (legal-pdf-core's renderer), for a model reading them beside the lines the
//! engine extracted: `page_images PDF DIRECTORY LONG_SIDE DPI_CAP` writes each page to DIRECTORY/page-NNNNNN-DPI.png,
//! its long side LONG_SIDE pixels at most DPI_CAP dpi, and prints the files in page order as one JSON array.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let [pdf, directory, long_side, dpi_cap] = arguments.as_slice() else {
        return Err("usage: page_images PDF DIRECTORY LONG_SIDE DPI_CAP".into());
    };
    let directory = std::path::Path::new(directory);
    std::fs::create_dir_all(directory)?;
    let mut files = Vec::new();
    for (index, (dpi, png)) in legalpdf::page_images(&std::fs::read(pdf)?, long_side.parse()?, dpi_cap.parse()?)?.into_iter().enumerate() {
        let file = directory.join(format!("page-{:06}-{dpi}.png", index + 1));
        std::fs::write(&file, png)?;
        files.push(file);
    }
    println!("{}", serde_json::to_string(&files)?);
    Ok(())
}
