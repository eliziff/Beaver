//! Whether two folders' workbooks of the same names show the same thing: each sheet's name, order and hidden state;
//! each cell's value and type, rich-text runs, style (font, fill, alignment and wrap, number format) and link; the
//! column widths and hidden columns, row heights, frozen panes and selection, autofilter and sheet view; and the
//! document's title and identifier. calamine reads the sheets, values, styles and links; the rest is read from the
//! package's XML. Each difference is printed, then how many there were.
//!
//!   workbook-equivalence OLD_DIR NEW_DIR
//!
//! Read as equal: an empty string and an empty cell (Excel keeps no empty string), a link's target and its location
//! as one address, the order of a font's properties, and `tabSelected` (the first sheet is selected either way).

use calamine::{open_workbook_from_rs, Data, Reader, Xlsx};
use quick_xml::events::{BytesStart, Event};
use quick_xml::XmlVersion;
use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::path::Path;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
/// What a workbook shows, each thing under a name of its own ("Sheet!B4 value", "Sheet cols 7").
type Shown = BTreeMap<String, String>;

fn part(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<String> {
    let mut text = String::new();
    archive.by_name(name).ok()?.read_to_string(&mut text).ok()?;
    Some(text)
}

fn attributes(element: &BytesStart) -> BTreeMap<String, String> {
    element.attributes().flatten().map(|attribute| (attribute.key.as_ref().to_owned(),
        attribute.normalized_value(XmlVersion::Implicit1_0).map(|value| value.into_owned()).unwrap_or_default())).collect()
}

fn name(element: &BytesStart) -> String { element.local_name().as_ref().to_owned() }

/// Each string's runs: its text and its font's properties, in their order of reading.
fn runs(reader: &mut quick_xml::Reader<&[u8]>, end: &str) -> String {
    let (mut runs, mut font, mut text, mut in_text) = (Vec::new(), Vec::<String>::new(), String::new(), false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) if in_rpr(&element) => font.clear(),
            Ok(Event::Start(element)) if name(&element) == "t" => in_text = true,
            Ok(Event::Empty(element)) if !matches!(name(&element).as_str(), "t" | "r") => {
                let values = attributes(&element).into_iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>();
                font.push(format!("{}[{}]", name(&element), values.join(",")));
            }
            Ok(Event::Text(value)) if in_text => text.push_str(&value.xml_content(XmlVersion::Implicit1_0)),
            Ok(Event::GeneralRef(reference)) if in_text => {
                let reference = reference.into_inner();
                text.push_str(&quick_xml::escape::unescape(&format!("&{reference};")).map(|value| value.into_owned()).unwrap_or_default());
            }
            Ok(Event::End(element)) => match element.local_name().as_ref() {
                "t" => {
                    in_text = false;
                    font.sort();
                    runs.push(format!("{{{}}}{text:?}", font.join(" ")));
                    font.clear();
                    text.clear();
                }
                closing if closing == end => break,
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    runs.join(" + ")
}

fn in_rpr(element: &BytesStart) -> bool { name(element) == "rPr" }

/// What calamine does not read: each cell's runs, the columns, rows, panes, selection, autofilter and sheet view of
/// each sheet (by its order), and the title and identifier.
fn package(bytes: &[u8], sheets: &[String], shown: &mut Shown) -> Result<()> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    let shared: Vec<String> = part(&mut archive, "xl/sharedStrings.xml").map(|xml| {
        let mut reader = quick_xml::Reader::from_str(&xml);
        let mut strings = Vec::new();
        loop {
            match reader.read_event() {
                Ok(Event::Start(element)) if name(&element) == "si" => strings.push(runs(&mut reader, "si")),
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
        strings
    }).unwrap_or_default();
    for (index, sheet) in sheets.iter().enumerate() {
        let Some(xml) = part(&mut archive, &format!("xl/worksheets/sheet{}.xml", index + 1)) else { continue };
        let mut reader = quick_xml::Reader::from_str(&xml);
        let mut cell = (String::new(), String::new());
        loop {
            let event = reader.read_event();
            match event {
                Ok(Event::Start(ref element)) | Ok(Event::Empty(ref element)) => {
                    let found = attributes(element);
                    let get = |key: &str| found.get(key).cloned().unwrap_or_default();
                    match name(element).as_str() {
                        "c" => cell = (get("r"), get("t")),
                        "v" if cell.1 == "s" => {
                            if let Ok(Event::Text(value)) = reader.read_event() {
                                let at: usize = value.xml_content(XmlVersion::Implicit1_0).trim().parse()?;
                                shown.insert(format!("{sheet}!{} runs", cell.0), shared.get(at).cloned().unwrap_or_default());
                            }
                        }
                        "is" => { shown.insert(format!("{sheet}!{} runs", cell.0), runs(&mut reader, "is")); }
                        "col" => {
                            let (min, max): (u32, u32) = (get("min").parse()?, get("max").parse()?);
                            let width: f64 = get("width").parse().unwrap_or(0.0);
                            for column in min..=max {
                                shown.insert(format!("{sheet} col {column:05}"),
                                    format!("width {width} hidden {}", found.get("hidden").is_some_and(|value| value == "1")));
                            }
                        }
                        "row" => if let Some(height) = found.get("ht") {
                            shown.insert(format!("{sheet} row {:07} height", get("r").parse::<u32>()?), height.clone());
                        },
                        "pane" | "selection" | "autoFilter" => { shown.insert(format!("{sheet} {}", name(element)), format!("{found:?}")); }
                        "sheetView" => {
                            let mut view = found.clone();
                            view.remove("tabSelected");
                            shown.insert(format!("{sheet} sheetView"), format!("{view:?}"));
                        }
                        _ => {}
                    }
                }
                Ok(Event::Eof) => break,
                Err(error) => return Err(error.into()),
                _ => {}
            }
        }
    }
    if let Some(core) = part(&mut archive, "docProps/core.xml") {
        let mut reader = quick_xml::Reader::from_str(&core);
        let mut field = None;
        loop {
            match reader.read_event() {
                Ok(Event::Start(element)) => field = Some(element.name().as_ref().to_owned()),
                Ok(Event::Text(value)) => if let Some(field) = field.as_ref().filter(|field| *field == "dc:title" || *field == "dc:identifier") {
                    shown.insert(format!("document {field}"), value.xml_content(XmlVersion::Implicit1_0).into_owned());
                },
                Ok(Event::End(_)) => field = None,
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
    }
    Ok(())
}

fn cell(row: u32, column: u32) -> String {
    let mut letters = String::new();
    let mut n = column + 1;
    while n > 0 { letters.insert(0, (b'A' + ((n - 1) % 26) as u8) as char); n = (n - 1) / 26; }
    format!("{letters}{}", row + 1)
}

fn shown(bytes: &[u8]) -> Result<Shown> {
    let mut book: Xlsx<_> = open_workbook_from_rs(Cursor::new(bytes))?;
    let mut shown = Shown::new();
    let sheets: Vec<String> = book.sheets_metadata().iter().map(|sheet| sheet.name.clone()).collect();
    for (order, sheet) in book.sheets_metadata().iter().enumerate() {
        shown.insert(format!("sheet {order}"), format!("{} {:?}", sheet.name, sheet.visible));
    }
    for sheet in &sheets {
        let range = book.worksheet_range(sheet)?;
        let (top, left) = range.start().unwrap_or((0, 0));
        for (row, column, value) in range.used_cells() {
            let at = cell(top + row as u32, left + column as u32);
            // Excel keeps no empty string: an empty one is an empty cell.
            if !matches!(value, Data::String(text) if text.is_empty()) {
                shown.insert(format!("{sheet}!{at} value"), format!("{value:?}"));
            }
        }
        for (row, column, style) in book.worksheet_style(sheet)?.cells() {
            shown.insert(format!("{sheet}!{} style", cell(row, column)), format!("font {:?} fill {:?} alignment {:?} number {:?}",
                style.font, style.fill, style.alignment, style.number_format));
        }
        for link in book.hyperlinks_by_sheet_name(sheet)? {
            let address = match (&link.target, &link.location) {
                (Some(target), Some(location)) => format!("{target}#{location}"),
                (target, location) => target.clone().or(location.clone()).unwrap_or_default(),
            };
            shown.insert(format!("{sheet}!{:?} link", link.range), address);
        }
    }
    package(bytes, &sheets, &mut shown)?;
    Ok(shown)
}

fn main() -> Result<()> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let [old, new] = arguments.as_slice() else { return Err("workbook-equivalence OLD_DIR NEW_DIR".into()) };
    let (mut workbooks, mut differences) = (0, 0);
    let mut names: Vec<_> = std::fs::read_dir(old)?.flatten().map(|entry| entry.file_name())
        .filter(|name| name.to_string_lossy().ends_with(".xlsx")).collect();
    names.sort();
    for file in names {
        workbooks += 1;
        let label = file.to_string_lossy().into_owned();
        let Ok(new_bytes) = std::fs::read(Path::new(new).join(&file)) else {
            println!("MISSING {label}");
            differences += 1;
            continue;
        };
        let (before, after) = (shown(&std::fs::read(Path::new(old).join(&file))?)?, shown(&new_bytes)?);
        let mut found = 0;
        for key in before.keys().chain(after.keys().filter(|key| !before.contains_key(*key))) {
            if before.get(key) != after.get(key) {
                found += 1;
                if found <= 20 { println!("DIFF {label} {key}: {:?} -> {:?}", before.get(key), after.get(key)); }
            }
        }
        println!("{label}: {} things, {found} differences", before.len());
        differences += found;
    }
    println!("{workbooks} workbooks, {differences} differences");
    Ok(())
}
