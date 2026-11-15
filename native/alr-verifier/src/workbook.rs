//! A workbook written from its rows and formats with rust_xlsxwriter: each sheet's cells with their formats, links and
//! rich text, its column widths, hidden columns and frozen header, and the document's title and identifier. Its strings
//! are shared and its package compressed.

use std::collections::BTreeMap;
use std::io::{Cursor, Write};

use rust_xlsxwriter::{Color, DocProperties, FontScheme, Format, FormatAlign, FormatUnderline, Url, XlsxError};

/// The most an Excel cell holds, in UTF-16 units: a longer value is cut there, and says so.
const CELL_LIMIT: usize = 32_767;
const CUT: &str = " […] (cut here: an Excel cell holds 32,767 characters)";

/// A workbook to write: what a field leaves out (None) it does not have.
pub struct Workbook {
    /// The document's title.
    pub title: &'static str,
    /// The document's identifier (Dublin Core's dc:identifier).
    pub identifier: Option<String>,
    pub sheets: Vec<Sheet>,
    /// The cells' formats by name; a cell without one has the workbook's default.
    pub formats: BTreeMap<&'static str, CellFormat>,
}

pub struct Sheet {
    pub name: &'static str,
    /// The header row first.
    pub rows: Vec<Vec<Cell>>,
    /// Each column's width in characters, from the first.
    pub widths: Vec<f64>,
    /// The columns from this one (from 0) on are hidden.
    pub hidden_from: Option<u16>,
    /// The empty grid right of the last column is hidden.
    pub hide_unused: bool,
    /// The first row stays in view.
    pub frozen_header: bool,
}

pub struct Cell {
    pub value: Value,
    /// Its format's name in the workbook's formats.
    pub format: Option<&'static str>,
    /// A web address (http or https) the cell links to; any other is not linked.
    pub link: Option<String>,
    /// The text in runs of their own fonts, in place of the value.
    pub runs: Option<Vec<Run>>,
}

pub enum Value {
    Number(f64),
    Text(String),
}

pub struct Run {
    pub text: String,
    pub font: Font,
}

/// Calibri, 11 pt in the theme's text colour unless it says otherwise.
#[derive(Clone)]
pub struct Font {
    pub size: Option<f64>,
    /// RRGGBB.
    pub color: Option<&'static str>,
    pub bold: bool,
    pub underline: bool,
    /// Calibri as the theme's body font, which follows the theme.
    pub theme: bool,
}

pub struct CellFormat {
    pub font: Font,
    /// A solid fill, RRGGBB.
    pub fill: Option<&'static str>,
    pub align: Option<Align>,
    pub wrap: bool,
}

#[derive(Clone, Copy)]
pub enum Align {
    /// At the cell's top.
    Top,
    /// In its middle, across and down.
    Center,
}
fn rgb(hex: &str) -> Result<Color, String> {
    u32::from_str_radix(hex, 16).map(Color::RGB).map_err(|_| format!("not a colour: {hex}"))
}

fn font(font: &Font, mut format: Format) -> Result<Format, String> {
    if let Some(size) = font.size { format = format.set_font_size(size); }
    if let Some(color) = font.color { format = format.set_font_color(rgb(color)?); }
    if font.bold { format = format.set_bold(); }
    if font.underline { format = format.set_underline(FormatUnderline::Single); }
    Ok(if font.theme { format } else { format.set_font_scheme(FontScheme::None) })
}

fn cell_format(cell: &CellFormat) -> Result<Format, String> {
    let mut format = font(&cell.font, Format::new())?;
    if let Some(fill) = cell.fill { format = format.set_background_color(rgb(fill)?); }
    format = match cell.align {
        Some(Align::Top) => format.set_align(FormatAlign::Top),
        Some(Align::Center) => format.set_align(FormatAlign::Center).set_align(FormatAlign::VerticalCenter),
        None => format,
    };
    Ok(if cell.wrap { format.set_text_wrap() } else { format })
}

/// What XML cannot hold is left out (control characters, U+FFFE, U+FFFF): one makes the whole workbook unreadable.
fn xml_text(text: &str) -> String {
    text.chars().filter(|c| !matches!(c, '\0'..='\x08' | '\x0B' | '\x0C' | '\x0E'..='\x1F' | '\u{FFFE}' | '\u{FFFF}')).collect()
}

/// Runs within an Excel cell: past its limit, cut where it is reached, the cut said at the end.
fn within_cell<T>(runs: Vec<(String, T)>) -> Vec<(String, T)> {
    if runs.iter().map(|(text, _)| text.encode_utf16().count()).sum::<usize>() <= CELL_LIMIT { return runs; }
    let mut room = CELL_LIMIT - CUT.encode_utf16().count();
    let mut kept: Vec<(String, T)> = runs.into_iter().filter_map(|(text, font)| {
        let cut: String = text.chars().take_while(|c| room >= c.len_utf16() && { room -= c.len_utf16(); true }).collect();
        (!cut.is_empty()).then_some((cut, font))
    }).collect();
    if let Some((text, _)) = kept.last_mut() { text.push_str(CUT); }
    kept
}

fn failed(error: XlsxError) -> String { error.to_string() }

/// The workbook's package.
pub fn write(workbook: &Workbook) -> Result<Vec<u8>, String> {
    let formats = workbook.formats.iter().map(|(name, format)| Ok((*name, cell_format(format)?)))
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let default = Format::new();
    let mut book = rust_xlsxwriter::Workbook::new();
    let mut relinked = Vec::new();
    book.set_properties(&DocProperties::new().set_title(workbook.title).set_author("Beaver"));
    for sheet in &workbook.sheets {
        let worksheet = book.add_worksheet();
        worksheet.set_name(sheet.name).map_err(failed)?;
        // A width set in pixels, Calibri 11's 7 to a character, is stored as given (rust_xlsxwriter's characters add
        // Excel's 5 pixels of padding).
        let pixels = |width: f64| (width * 7.0).round() as u32;
        for (column, width) in sheet.widths.iter().enumerate() {
            worksheet.set_column_width_pixels(column as u16, pixels(*width)).map_err(failed)?;
        }
        let width = sheet.rows.iter().map(Vec::len).max().unwrap_or(0).max(1) as u16;
        if let Some(from) = sheet.hidden_from {
            for column in from..sheet.widths.len() as u16 { worksheet.set_column_hidden(column).map_err(failed)?; }
        }
        if sheet.hide_unused && width < 16_384 {
            worksheet.set_column_range_width_pixels(width, 16_383, pixels(13.0)).map_err(failed)?;
            worksheet.set_column_range_hidden(width, 16_383).map_err(failed)?;
        }
        // The header frozen, the cursor on the first row under it.
        if sheet.frozen_header {
            worksheet.set_freeze_panes(1, 0).map_err(failed)?.set_selection(1, 0, 1, 0).map_err(failed)?;
        }
        for (row, cells) in sheet.rows.iter().enumerate() {
            let row = row as u32;
            for (column, cell) in cells.iter().enumerate() {
                let column = column as u16;
                let format = match cell.format {
                    Some(name) => formats.get(name).ok_or_else(|| format!("no format {name}"))?,
                    None => &default,
                };
                // The link first, then what the cell shows over the text it wrote.
                if let Some(link) = cell.link.as_deref().filter(|link| link.get(..7).is_some_and(|scheme| scheme.eq_ignore_ascii_case("http://"))
                    || link.get(..8).is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))) {
                    let link = xml_text(link);
                    // rust_xlsxwriter takes a link as escaped only where it holds one of the escapes it makes itself, and
                    // escapes every other link's "%" again: an escaped link ("%2F") is written back as given.
                    let marks = ["%20", "%25", "%22", "%60", "%3c", "%3e", "%5b", "%5d", "%5e", "%7b", "%7d"];
                    if link.contains('%') && !marks.iter().any(|mark| link.to_ascii_lowercase().contains(mark)) {
                        relinked.push((url_escaped(&link, true), url_escaped(&link, false)));
                    }
                    match worksheet.write_url_with_format(row, column, Url::new(link), format) {
                        // Excel opens no workbook with a link past 2,080 characters: the cell keeps its text.
                        Ok(_) | Err(XlsxError::MaxUrlLengthExceeded) => {}
                        Err(error) => return Err(failed(error)),
                    }
                }
                match (&cell.value, &cell.runs) {
                    (_, Some(runs)) if !runs.is_empty() => {
                        let runs = within_cell(runs.iter().map(|run| (xml_text(&run.text), &run.font)).collect());
                        let fonts = runs.iter().map(|(_, run)| font(run, Format::new()))
                            .collect::<Result<Vec<_>, String>>()?;
                        let segments: Vec<(&Format, &str)> = fonts.iter().zip(&runs).map(|(font, (text, _))| (font, text.as_str())).collect();
                        worksheet.write_rich_string_with_format(row, column, &segments, format).map_err(failed)?;
                    }
                    (Value::Number(number), _) => { worksheet.write_number_with_format(row, column, *number, format).map_err(failed)?; }
                    (Value::Text(text), _) => {
                        let text = within_cell(vec![(xml_text(text), ())]).pop().map(|(text, _)| text).unwrap_or_default();
                        worksheet.write_string_with_format(row, column, text, format).map_err(failed)?;
                    }
                }
            }
        }
    }
    let package = book.save_to_buffer().map_err(failed)?;
    if workbook.identifier.is_none() && relinked.is_empty() { return Ok(package); }
    finished(&package, workbook.identifier.as_deref(), &relinked)
}

/// A link as rust_xlsxwriter escapes one it takes as unescaped (its escape_url), its "%" too or not.
fn url_escaped(link: &str, percent: bool) -> String {
    link.chars().fold(String::new(), |mut out, c| {
        match c {
            '%' if percent => out.push_str("%25"),
            '"' => out.push_str("%22"), ' ' => out.push_str("%20"), '<' => out.push_str("%3c"), '>' => out.push_str("%3e"),
            '[' => out.push_str("%5b"), ']' => out.push_str("%5d"), '^' => out.push_str("%5e"), '`' => out.push_str("%60"),
            '{' => out.push_str("%7b"), '}' => out.push_str("%7d"),
            c => out.push(c),
        }
        out
    })
}

/// The package as rust_xlsxwriter cannot write it: the identifier in its core properties, and each link it escaped
/// twice (`relinked`, as it wrote it and as given) as given.
fn finished(package: &[u8], identifier: Option<&str>, relinked: &[(String, String)]) -> Result<Vec<u8>, String> {
    let unreadable = |error: zip::result::ZipError| error.to_string();
    let attribute = |text: &str| text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let mut archive = zip::ZipArchive::new(Cursor::new(package)).map_err(unreadable)?;
    let mut written = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(unreadable)?;
        let name = entry.name().map_err(unreadable)?.into_owned();
        let core = name == "docProps/core.xml" && identifier.is_some();
        let links = name.starts_with("xl/worksheets/_rels/") && !relinked.is_empty();
        if !core && !links { written.raw_copy_file(entry).map_err(unreadable)?; continue; }
        drop(entry);
        let mut text = String::new();
        std::io::Read::read_to_string(&mut archive.by_index(index).map_err(unreadable)?, &mut text).map_err(|error| error.to_string())?;
        if let (true, Some(identifier)) = (core, identifier) {
            let escaped = xml_text(identifier).replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
            text = text.replacen("</cp:coreProperties>", &format!("<dc:identifier>{escaped}</dc:identifier></cp:coreProperties>"), 1);
        }
        for (twice, given) in relinked.iter().filter(|_| links) {
            text = text.replace(&format!("Target=\"{}\"", attribute(twice)), &format!("Target=\"{}\"", attribute(given)));
        }
        written.start_file(name, zip::write::SimpleFileOptions::default()).map_err(unreadable)?;
        written.write_all(text.as_bytes()).map_err(|error| error.to_string())?;
    }
    Ok(written.finish().map_err(unreadable)?.into_inner())
}
