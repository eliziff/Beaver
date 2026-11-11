//! A workbook's grid (xlsx, xlsm, xls): each sheet with visible content as a Markdown table under "## Sheet: name",
//! with a column for each column holding visible content, and the cells each table was rendered from. A cell reads
//! as its display text, with its formula and its cached value, or its type and value where the display is not the
//! value itself. calamine reads the values, formulas, merged regions and number formats; ooxml-numfmt writes a
//! number in its format; ryu-js writes a number as JavaScript prints it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Cursor, Read};

use calamine::{open_workbook_from_rs, CellErrorType, Data, Dimensions, Reader, Xls, XlsError, Xlsx, XlsxError};
use legal_structure::{trim_javascript_whitespace, utf16_len, AuthoritativeTableCell, ScalarRange};
use ooxml_numfmt::{DateSystem, FormatOptions, NumberFormat};

const MAX_SHEETS: usize = 256;
const MAX_CELLS: usize = 500_000;
const MAX_MERGE_CHECKS: usize = 10_000_000;
const MAX_INPUT_BYTES: usize = 100 * 1024 * 1024;
const MAX_COMPRESSED_BYTES: usize = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES: usize = 10_000;
const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
/// The largest integer a JavaScript number holds exactly: a package entry's size above it is not a size.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A workbook's text and the cells it was rendered from, in UTF-16 offsets of the text.
pub struct Grid {
    pub text: String,
    pub cells: Vec<AuthoritativeTableCell>,
}

pub fn read(bytes: &[u8], file_type: &str) -> Result<Grid, String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return Err("Spreadsheet input exceeds the read limit".into());
    }
    // The bytes decide the reader, as the file's name does not: a ZIP package is OOXML, anything else BIFF.
    let package = bytes.starts_with(b"PK");
    if package || matches!(file_type.trim().to_lowercase().as_str(), "xlsx" | "xlsm") {
        bound_package(bytes)?;
    }
    let workbook = if package { read_xlsx(bytes)? } else { read_xls(bytes)? };
    render(&workbook)
}

/// The package's bounds: its size, its number of entries and the size they expand to.
fn bound_package(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_COMPRESSED_BYTES {
        return Err("Compressed document exceeds the read limit".into());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(unreadable)?;
    let mut sizes = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(unreadable)?;
        if !entry.is_dir() {
            sizes.push(entry.size());
        }
    }
    if sizes.len() > MAX_PACKAGE_ENTRIES {
        return Err("Spreadsheet contains too many package entries".into());
    }
    if sizes.iter().any(|size| *size > MAX_SAFE_INTEGER) {
        return Err("Spreadsheet has invalid ZIP size metadata".into());
    }
    if sizes.iter().sum::<u64>() > MAX_EXPANDED_BYTES {
        return Err("Spreadsheet expands beyond the read limit".into());
    }
    Ok(())
}

fn unreadable(error: impl std::fmt::Display) -> String {
    format!("Spreadsheet could not be read: {error}")
}

fn too_complex() -> String {
    "Spreadsheet is too complex to render safely".into()
}

struct Workbook {
    date_system: DateSystem,
    sheets: Vec<Sheet>,
}

struct Sheet {
    name: String,
    /// The sheet's cells by (row, column), zero-based: every cell the sheet records, a blank one too.
    cells: HashMap<(u32, u32), Cell>,
    merges: Vec<Dimensions>,
}

struct Cell {
    value: Value,
    /// The formula, without its leading "=".
    formula: Option<String>,
    /// The number format's code; none is General.
    format: Option<String>,
}

enum Value {
    Number(f64),
    Text(String),
    Bool(bool),
    Error(CellErrorType),
    /// A blank cell, or a formula's result the workbook does not hold.
    Missing,
}

impl From<Data> for Value {
    fn from(data: Data) -> Self {
        match data {
            Data::Int(value) => Value::Number(value as f64),
            Data::Float(value) => Value::Number(value),
            Data::DateTime(value) => Value::Number(value.as_f64()),
            Data::String(value) | Data::DateTimeIso(value) | Data::DurationIso(value) => Value::Text(value),
            Data::Bool(value) => Value::Bool(value),
            Data::Error(value) => Value::Error(value),
            Data::Empty => Value::Missing,
        }
    }
}

/// The workbook's cells counted against the bounds, sheet by sheet: a sheet's cells and merged regions, and the
/// cells times the regions, the checks a covered cell costs.
#[derive(Default)]
struct Budget {
    cells: usize,
}

impl Budget {
    fn admits(&self, cells: usize, merges: usize) -> bool {
        self.cells + cells + merges <= MAX_CELLS && (cells + merges).saturating_mul(merges) <= MAX_MERGE_CHECKS
    }

    fn spend(&mut self, sheet: &Sheet) -> Result<(), String> {
        if !self.admits(sheet.cells.len(), sheet.merges.len()) {
            return Err(too_complex());
        }
        self.cells += sheet.cells.len() + sheet.merges.len();
        Ok(())
    }
}

fn sheet_names(names: Vec<String>) -> Result<Vec<String>, String> {
    if names.len() > MAX_SHEETS {
        return Err("Spreadsheet contains too many sheets".into());
    }
    Ok(names)
}

fn date_system(is_1904: bool) -> DateSystem {
    if is_1904 {
        DateSystem::Date1904
    } else {
        DateSystem::Date1900
    }
}

/// A formula as the grid writes it: Excel's "_xlfn." prefix of a newer function dropped.
fn formula(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.is_empty()).map(|text| text.replace("_xlfn.", ""))
}

fn read_xlsx(bytes: &[u8]) -> Result<Workbook, String> {
    let mut book: Xlsx<_> = open_workbook_from_rs(Cursor::new(bytes)).map_err(unreadable)?;
    let names = sheet_names(book.sheet_names())?;
    let mut budget = Budget::default();
    let mut sheets = Vec::with_capacity(names.len());
    for name in names {
        // A chart or dialog sheet has no cells.
        let merges = match book.merge_cells_by_sheet_name(&name) {
            Ok(merges) => merges,
            Err(XlsxError::WorksheetNotFound(_)) => Vec::new(),
            Err(error) => return Err(unreadable(error)),
        };
        let mut cells = HashMap::new();
        match book.worksheet_cells_reader(&name) {
            Ok(mut reader) => {
                while let Some(record) = reader.next_cell_with_formula().map_err(unreadable)? {
                    let value = Value::from(Data::from(record.value));
                    cells.insert(record.pos, Cell { value, formula: formula(record.formula), format: None });
                    if !budget.admits(cells.len(), merges.len()) {
                        return Err(too_complex());
                    }
                }
            }
            Err(XlsxError::NotAWorksheet(_) | XlsxError::WorksheetNotFound(_)) => {}
            Err(error) => return Err(unreadable(error)),
        }
        if !cells.is_empty() {
            let mut reader = book.worksheet_cells_reader(&name).map_err(unreadable)?;
            while let Some((row, column, style)) = reader.next_style_id().map_err(unreadable)? {
                if let Some(cell) = cells.get_mut(&(row, column)) {
                    let format = reader.styles().get(style).and_then(|style| style.number_format.as_ref());
                    cell.format = format.and_then(|f| number_format(f.format_id.unwrap_or(0), &f.format_code));
                }
            }
        }
        let sheet = Sheet { name, cells, merges };
        budget.spend(&sheet)?;
        sheets.push(sheet);
    }
    Ok(Workbook { date_system: date_system(book.has_1904_epoch()), sheets })
}

/// A cell's number format as SheetJS resolves its id: the workbook's own code for it, else the built-in one,
/// else the format Excel shows for a built-in id it does not define.
fn number_format(id: u32, code: &str) -> Option<String> {
    match code {
        "General" if id != 0 => implicit_format(id).map(str::to_owned),
        "General" => None,
        // calamine writes id 14 as the standard's code; Excel and SheetJS show it as m/d/yy.
        "mm-dd-yy" if id == 14 => Some("m/d/yy".into()),
        code => Some(code.to_owned()),
    }
}

/// SheetJS's codes for the built-in ids that are not in the standard's table (its SSFImplicit, and id 56).
fn implicit_format(id: u32) -> Option<&'static str> {
    Some(match id {
        5 | 63 => r##""$"#,##0_);\("$"#,##0\)"##,
        6 | 64 => r##""$"#,##0_);[Red]\("$"#,##0\)"##,
        7 | 65 => r##""$"#,##0.00_);\("$"#,##0.00\)"##,
        8 | 66 => r##""$"#,##0.00_);[Red]\("$"#,##0.00\)"##,
        27..=31 | 36 | 50..=55 | 57 | 58 | 71 | 72 => "m/d/yy",
        32..=35 | 77 => "h:mm:ss",
        56 => "\"上午/下午 \"hh\"時\"mm\"分\"ss\"秒 \"",
        59 => "0",
        60 => "0.00",
        61 => "#,##0",
        62 => "#,##0.00",
        67 => "0%",
        68 => "0.00%",
        69 => "# ?/?",
        70 => "# ??/??",
        73 => "d-mmm-yy",
        74 => "d-mmm",
        75 => "mmm-yy",
        76 => "h:mm",
        78 => "m/d/yy h:mm",
        79 => "mm:ss",
        80 => "[h]:mm:ss",
        81 => "mmss.0",
        _ => return None,
    })
}

/// Each sheet's number formats by cell, in the workbook's order of sheets, read from its BIFF records: each cell's XF
/// names a format, the workbook's own code for it (FORMAT) or a built-in one. calamine reads the values but keeps
/// no XLS format.
fn xls_formats(bytes: &[u8]) -> Result<Vec<HashMap<(u32, u32), Option<String>>>, std::io::Error> {
    let (mut stream, mut file) = (Vec::new(), cfb::CompoundFile::open(Cursor::new(bytes))?);
    file.open_stream(if file.exists("/Workbook") { "/Workbook" } else { "/Book" })?.read_to_end(&mut stream)?;
    let stream = &stream;
    let records = |from: usize| {
        let mut at = from;
        std::iter::from_fn(move || {
            let head = stream.get(at..at + 4)?;
            let (kind, length) = (u16::from_le_bytes([head[0], head[1]]), usize::from(u16::from_le_bytes([head[2], head[3]])));
            let data = stream.get(at + 4..at + 4 + length)?;
            at += 4 + length;
            Some((kind, data))
        })
    };
    let u16_at = |data: &[u8], at: usize| data.get(at..at + 2).map_or(0, |b| u16::from_le_bytes([b[0], b[1]]));
    let (mut codes, mut xfs, mut sheets, mut biff8) = (HashMap::new(), Vec::new(), Vec::new(), true);
    for (kind, data) in records(0) {
        match kind {
            0x0809 => biff8 = u16_at(data, 0) == 0x0600,
            // FORMAT: its id and its code, an XLUnicodeString in BIFF8, else a byte string.
            0x041E => {
                let code = if biff8 {
                    let (count, wide) = (usize::from(u16_at(data, 2)), data.get(4).is_some_and(|f| f & 1 == 1));
                    if wide { String::from_utf16_lossy(&data[5..].chunks_exact(2).take(count).map(|b| u16::from_le_bytes([b[0], b[1]])).collect::<Vec<_>>()) }
                    else { data[5..].iter().take(count).map(|b| char::from(*b)).collect() }
                } else { data.get(3..).unwrap_or_default().iter().take(usize::from(*data.get(2).unwrap_or(&0))).map(|b| char::from(*b)).collect() };
                codes.insert(u16_at(data, 0), code);
            }
            0x00E0 => xfs.push(u16_at(data, 2)),
            0x0085 => sheets.push(data.get(0..4).map_or(0, |b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])) as usize),
            0x000A => break,
            _ => {}
        }
    }
    let format = |xf: u16| xfs.get(usize::from(xf)).and_then(|id| {
        let code = codes.get(id).map(String::as_str).or_else(|| builtin_format(u32::from(*id))).unwrap_or("General");
        number_format(u32::from(*id), code)
    });
    Ok(sheets.into_iter().map(|start| {
        let mut cells = HashMap::new();
        // The sheet's own BOF, then its cells; a nested substream (an embedded chart) is skipped.
        let mut depth = 0usize;
        for (kind, data) in records(start) {
            match kind {
                0x0809 => { depth += 1; continue; }
                0x000A if depth > 1 => { depth -= 1; continue; }
                0x000A => break,
                _ if depth > 1 => continue,
                // FORMULA, NUMBER, LABEL, RSTRING, BOOLERR, RK, LABELSST: row, column, XF.
                0x0006 | 0x0203 | 0x0204 | 0x00D6 | 0x0205 | 0x027E | 0x00FD => {
                    cells.insert((u32::from(u16_at(data, 0)), u32::from(u16_at(data, 2))), format(u16_at(data, 4)));
                }
                // MULRK: a row, its first column, then an XF and a number for each cell.
                0x00BD => for (offset, rk) in data.get(4..data.len().saturating_sub(2)).unwrap_or_default().chunks_exact(6).enumerate() {
                    cells.insert((u32::from(u16_at(data, 0)), u32::from(u16_at(data, 2)) + offset as u32), format(u16_at(rk, 0)));
                },
                _ => {}
            }
        }
        cells
    }).collect())
}

/// The standard's built-in number formats (ECMA-376 18.8.30), by id.
fn builtin_format(id: u32) -> Option<&'static str> {
    Some(match id {
        0 => "General", 1 => "0", 2 => "0.00", 3 => "#,##0", 4 => "#,##0.00", 9 => "0%", 10 => "0.00%", 11 => "0.00E+00",
        12 => "# ?/?", 13 => "# ??/??", 14 => "mm-dd-yy", 15 => "d-mmm-yy", 16 => "d-mmm", 17 => "mmm-yy", 18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM", 20 => "h:mm", 21 => "h:mm:ss", 22 => "m/d/yy h:mm", 37 => "#,##0 ;(#,##0)", 38 => "#,##0 ;[Red](#,##0)",
        39 => "#,##0.00;(#,##0.00)", 40 => "#,##0.00;[Red](#,##0.00)", 41 => r#"_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)"#,
        42 => r#"_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)"#, 43 => r#"_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)"#,
        44 => r#"_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)"#, 45 => "mm:ss", 46 => "[h]:mm:ss", 47 => "mmss.0",
        48 => "##0.0E+0", 49 => "@",
        _ => return None,
    })
}

fn read_xls(bytes: &[u8]) -> Result<Workbook, String> {
    let mut book: Xls<_> = open_workbook_from_rs(Cursor::new(bytes)).map_err(unreadable)?;
    let names = sheet_names(book.sheet_names())?;
    let styles = xls_formats(bytes).map_err(unreadable)?;
    let mut budget = Budget::default();
    let mut sheets = Vec::with_capacity(names.len());
    for (index, name) in names.into_iter().enumerate() {
        // A chart or macro sheet has no cells.
        let merges = match book.merge_cells_by_sheet_name(&name) {
            Ok(merges) => merges,
            Err(XlsError::WorksheetNotFound(_)) => Vec::new(),
            Err(error) => return Err(unreadable(error)),
        };
        let styles = styles.get(index);
        let mut cells = HashMap::new();
        match book.worksheet_range(&name) {
            Ok(range) => {
                let (top, left) = range.start().unwrap_or_default();
                for (row, column, data) in range.used_cells() {
                    let position = (top + row as u32, left + column as u32);
                    let format = styles.and_then(|s| s.get(&position)).cloned().flatten().or_else(|| match data {
                        Data::DateTime(value) if value.is_duration() => Some("[h]:mm:ss".to_owned()),
                        Data::DateTime(_) => Some("m/d/yy".to_owned()),
                        _ => None,
                    });
                    cells.insert(position, Cell { value: Value::from(data.clone()), formula: None, format });
                }
            }
            Err(XlsError::WorksheetNotFound(_)) => {}
            Err(error) => return Err(unreadable(error)),
        }
        match book.worksheet_formula(&name) {
            Ok(range) => {
                let (top, left) = range.start().unwrap_or_default();
                for (row, column, text) in range.used_cells() {
                    let position = (top + row as u32, left + column as u32);
                    let cell = cells.entry(position).or_insert(Cell { value: Value::Missing, formula: None, format: None });
                    cell.formula = formula(Some(text.clone()));
                }
            }
            Err(XlsError::WorksheetNotFound(_)) => {}
            Err(error) => return Err(unreadable(error)),
        }
        let sheet = Sheet { name, cells, merges };
        budget.spend(&sheet)?;
        sheets.push(sheet);
    }
    Ok(Workbook { date_system: date_system(book.has_1904_epoch()), sheets })
}

/// The sheets with visible content, joined by a blank line; each table numbered among those rendered.
fn render(workbook: &Workbook) -> Result<Grid, String> {
    let mut formats = Formats::new(workbook.date_system);
    let mut text = String::new();
    let mut units = 0;
    let mut cells = Vec::new();
    let mut table = 0;
    for sheet in &workbook.sheets {
        let Some((sheet_text, sheet_cells)) = render_sheet(table + 1, sheet, &mut formats) else {
            continue;
        };
        table += 1;
        if !text.is_empty() {
            text.push_str("\n\n");
            units += 2;
        }
        let shift = units;
        text.push_str(&sheet_text);
        units += utf16_len(&sheet_text);
        cells.extend(sheet_cells.into_iter().map(|mut cell| {
            cell.start += shift;
            cell.end += shift;
            for range in &mut cell.ranges {
                range.start += shift;
                range.end += shift;
            }
            cell
        }));
    }
    if text.len() > MAX_OUTPUT_BYTES {
        return Err("Spreadsheet projection output exceeds the read limit".into());
    }
    // The text starts with "## Sheet:" and ends with " |", so trimming it moves no offset.
    Ok(Grid { text, cells })
}

/// One sheet's table, its cells in UTF-16 offsets of the table; none when the sheet shows nothing.
fn render_sheet(table: usize, sheet: &Sheet, formats: &mut Formats) -> Option<(String, Vec<AuthoritativeTableCell>)> {
    // A merged region by its top-left cell, the anchor; of two regions at one anchor, the later.
    let anchors: HashMap<(u32, u32), Dimensions> = sheet.merges.iter().map(|merge| (merge.start, *merge)).collect();
    let positions: BTreeSet<(u32, u32)> = sheet.cells.keys().chain(anchors.keys()).copied().collect();

    // Only cells with visible text, and their columns: formatting alone and empty columns add nothing.
    let mut rows: BTreeMap<u32, BTreeMap<u32, (String, String)>> = BTreeMap::new();
    let mut columns = BTreeSet::new();
    for position in positions {
        let (row, column) = position;
        let covered = anchors.iter().any(|(anchor, merge)| {
            *anchor != position && (merge.start.0..=merge.end.0).contains(&row) && (merge.start.1..=merge.end.1).contains(&column)
        });
        if covered {
            continue;
        }
        let value = sheet.cells.get(&position).map(|cell| cell_text(cell, formats)).unwrap_or_default();
        let text = match anchors.get(&position) {
            Some(merge) if value.is_empty() => format!("⟨merged {}⟩", range_name(merge)),
            Some(merge) => format!("{value} ⟨merged {}⟩", range_name(merge)),
            None => value.clone(),
        };
        if text.is_empty() {
            continue;
        }
        rows.entry(row).or_default().insert(column, (text, value));
        columns.insert(column);
    }
    if rows.is_empty() {
        return None;
    }

    let columns: Vec<u32> = columns.into_iter().collect();
    let letters: Vec<String> = columns.iter().map(|column| column_name(*column)).collect();
    let mut lines = vec![
        format!("## Sheet: {}", sheet.name),
        String::new(),
        format!("| Row | {} |", letters.join(" | ")),
        format!("| --- | {} |", vec!["---"; columns.len()].join(" | ")),
    ];
    let mut cells = Vec::new();
    let mut cursor = utf16_len(&lines.join("\n")) + 1;
    for (row, row_cells) in rows {
        let mut line = format!("| {} | ", row + 1);
        let mut line_units = utf16_len(&line);
        for (index, column) in columns.iter().enumerate() {
            if let Some((text, value)) = row_cells.get(column) {
                let start = cursor + line_units;
                line.push_str(text);
                line_units += utf16_len(text);
                let end = cursor + line_units;
                let merge = anchors.get(&(row, *column));
                cells.push(AuthoritativeTableCell {
                    table,
                    table_name: Some(sheet.name.clone()),
                    row: row as usize + 1,
                    column: *column as usize + 1,
                    row_span: merge.filter(|merge| merge.end.0 > merge.start.0).map(|merge| (merge.end.0 - merge.start.0) as usize + 1),
                    column_span: merge.filter(|merge| merge.end.1 > merge.start.1).map(|merge| (merge.end.1 - merge.start.1) as usize + 1),
                    address: Some(cell_name((row, *column))),
                    display_value: Some(value.clone()),
                    ranges: vec![ScalarRange { start, end }],
                    start,
                    end,
                });
            }
            let separator = if index == columns.len() - 1 { " |" } else { " | " };
            line.push_str(separator);
            line_units += separator.len();
        }
        lines.push(line);
        cursor += line_units + 1;
    }
    Some((lines.join("\n"), cells))
}

/// A cell as the grid shows it: a formula with its type and cached value, a value whose display is not its text
/// with its type and value, a text that reads as a formula marked as text; on one line, its pipes escaped.
fn cell_text(cell: &Cell, formats: &mut Formats) -> String {
    let (kind, value, json) = match &cell.value {
        Value::Number(number) => ("n", Some(js_number(*number)), json_number(*number)),
        Value::Text(text) => ("s", Some(text.clone()), serde_json::Value::from(text.as_str()).to_string()),
        Value::Bool(flag) => ("b", Some(flag.to_string()), flag.to_string()),
        Value::Error(error) => {
            let code = error_code(error).0.to_string();
            ("e", Some(code.clone()), code)
        }
        // A blank cell shows nothing; a formula whose result the workbook does not hold is a number with no value.
        Value::Missing => ("n", None, "null".to_owned()),
    };
    let display = formats.display(&cell.value, cell.format.as_deref()).filter(|shown| !shown.is_empty());
    let display = display.or(value).unwrap_or_default();
    let text = match &cell.formula {
        Some(formula) => format!("={formula} ⟨{kind}; cached:{json}⟩"),
        None if !display.is_empty() && kind != "s" => format!("{display} ⟨{kind}:{json}⟩"),
        None if display.starts_with('=') => format!("{display} ⟨s⟩"),
        None => display,
    };
    let text = text.replace("\r\n", " ").replace('\n', " ").replace('|', "\\|");
    trim_javascript_whitespace(&text).to_owned()
}

/// The number formats a workbook's cells use, each parsed once.
struct Formats {
    options: FormatOptions,
    parsed: HashMap<String, Option<NumberFormat>>,
}

impl Formats {
    fn new(date_system: DateSystem) -> Self {
        Formats { options: FormatOptions { date_system, ..FormatOptions::default() }, parsed: HashMap::new() }
    }

    /// A value's display text in its number format (a true value shows as TRUE, an error as its code's text); none
    /// for a missing value or a format that does not parse.
    fn display(&mut self, value: &Value, code: Option<&str>) -> Option<String> {
        let code = code.unwrap_or("General");
        if !self.parsed.contains_key(code) {
            self.parsed.insert(code.to_owned(), NumberFormat::parse(code).ok());
        }
        let format = self.parsed.get(code)?.as_ref();
        match value {
            Value::Number(number) => format?.try_format(*number, &self.options).ok(),
            Value::Text(text) => format?.try_format_text(text, &self.options).ok(),
            Value::Bool(flag) => format?.try_format_text(if *flag { "TRUE" } else { "FALSE" }, &self.options).ok(),
            Value::Error(error) => Some(error_code(error).1.to_owned()),
            Value::Missing => None,
        }
    }
}

/// An error's code as Excel stores it, and its text.
fn error_code(error: &CellErrorType) -> (u8, &'static str) {
    match error {
        CellErrorType::Null => (0x00, "#NULL!"),
        CellErrorType::Div0 => (0x07, "#DIV/0!"),
        CellErrorType::Value => (0x0F, "#VALUE!"),
        CellErrorType::Ref => (0x17, "#REF!"),
        CellErrorType::Name => (0x1D, "#NAME?"),
        CellErrorType::Num => (0x24, "#NUM!"),
        CellErrorType::NA => (0x2A, "#N/A"),
        CellErrorType::GettingData => (0x2B, "#GETTING_DATA"),
    }
}

/// A number as JavaScript's String() writes it.
fn js_number(number: f64) -> String {
    ryu_js::Buffer::new().format(number).to_owned()
}

/// A number as JSON.stringify writes it: a number that is not finite is null.
fn json_number(number: f64) -> String {
    if number.is_finite() {
        js_number(number)
    } else {
        "null".to_owned()
    }
}

/// A column's letters: 0 is A, 26 is AA.
fn column_name(column: u32) -> String {
    let mut name = Vec::new();
    let mut rest = column + 1;
    while rest > 0 {
        name.push(char::from(b'A' + ((rest - 1) % 26) as u8));
        rest = (rest - 1) / 26;
    }
    name.iter().rev().collect()
}

fn cell_name((row, column): (u32, u32)) -> String {
    format!("{}{}", column_name(column), row + 1)
}

/// A region's name: "A1:B2", or one cell's name where it is one cell.
fn range_name(merge: &Dimensions) -> String {
    let (start, end) = (cell_name(merge.start), cell_name(merge.end));
    if start == end {
        start
    } else {
        format!("{start}:{end}")
    }
}
