//! CSV, Excel and JSON files, opened as read-only SQLite databases.
//!
//! The file is read once, into an in-memory SQLite database, and the
//! connection is then set to `query_only`. Everything that works on a SQLite
//! file works on it unchanged: the grid, the SQL editor, Text to SQL, exports
//! and the schema view. The file on disk is never written; opening it again
//! reads it again.
//!
//! - CSV and TSV become one table named after the file. The first record is
//!   the header. The delimiter is guessed from the first lines (comma,
//!   semicolon, tab or pipe) as the import dialog guesses it
//!   (`src/lib/db/csv.ts`), and text that is not UTF-8 is read as UTF-16 when
//!   it has a byte-order mark, otherwise as Windows-1252.
//! - Each worksheet of an Excel or OpenDocument workbook (.xlsx, .xlsm, .xlsb,
//!   .xls, .ods) becomes a table named after the sheet. Formulas give their
//!   last calculated value; dates become ISO 8601 text.
//! - A JSON array of objects becomes one table, a key per column. An object
//!   whose values include arrays of objects becomes a table per such array.
//!   JSON Lines (.jsonl, .ndjson) is one object per line. Nested values are
//!   kept as JSON text.
//!
//! A column is INTEGER when every value in it is a whole number, REAL when
//! every value is a number, BOOLEAN (1 and 0) when every value is a true or
//! false from the file's own type system, and TEXT otherwise. "02134" stays
//! text: read as a number it would lose its zero. Empty cells are NULL.

use super::sqlite::SqliteConn;
use super::OpenInfo;
use calamine::{Data, Range, Reader, SheetType};
use rusqlite::types::{ToSqlOutput, Value as SqlValue, ValueRef};
use rusqlite::Connection;
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::Path;

/// The whole file is held in memory twice while it loads (the text, then the
/// database), so very large files are refused rather than allowed to exhaust
/// memory and take the app down with them.
const MAX_TEXT_BYTES: u64 = 1024 * 1024 * 1024;
/// Workbooks are compressed; a 256 MB .xlsx can hold several gigabytes of cells.
const MAX_WORKBOOK_BYTES: u64 = 256 * 1024 * 1024;
/// SQLite's default SQLITE_MAX_COLUMN, which the bundled build keeps.
const MAX_COLUMNS: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Format {
    /// The delimiter, when the extension says it.
    Delimited(Option<u8>),
    Workbook,
    Json,
    JsonLines,
}

/// The format from the extension. The extensions are kept in step with
/// `DATA_FILE_EXTENSIONS` in `src/lib/db/dataFiles.ts`.
fn format_of(path: &Path) -> Option<Format> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "csv" => Format::Delimited(None),
        "tsv" | "tab" => Format::Delimited(Some(b'\t')),
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => Format::Workbook,
        "json" => Format::Json,
        "jsonl" | "ndjson" => Format::JsonLines,
        _ => return None,
    })
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Read `path` into a new in-memory database that refuses writes.
pub fn open(path: &Path) -> Result<(SqliteConn, OpenInfo), String> {
    let name = display_name(path);
    let format = format_of(path).ok_or_else(|| {
        format!("LiteDB cannot open {name}: it opens CSV, TSV, Excel, OpenDocument and JSON files.")
    })?;
    let size = std::fs::metadata(path)
        .map_err(|e| format!("Could not read {name}: {e}"))?
        .len();
    let limit = if format == Format::Workbook {
        MAX_WORKBOOK_BYTES
    } else {
        MAX_TEXT_BYTES
    };
    if size > limit {
        return Err(format!(
            "{name} is {}. LiteDB opens files of this kind up to {}.",
            human_size(size),
            human_size(limit)
        ));
    }

    let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    // Nothing here needs to survive a crash: the file is the copy that counts.
    conn.execute_batch("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;")
        .map_err(|e| e.to_string())?;

    let mut notices = Vec::new();
    let mut loader = Loader::new(&conn);
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let loaded = match format {
        Format::Delimited(delimiter) => {
            let bytes = std::fs::read(path).map_err(|e| format!("Could not read {name}: {e}"))?;
            let (text, encoding) = decode(bytes);
            if let Some(encoding) = encoding {
                notices.push(format!(
                    "The file is not UTF-8, so it was read as {encoding}. If letters look wrong, save it from Excel as CSV UTF-8."
                ));
            }
            loader.delimited(&stem(path), &text, delimiter)
        }
        Format::Workbook => loader.workbook(path),
        Format::Json | Format::JsonLines => {
            let bytes = std::fs::read(path).map_err(|e| format!("Could not read {name}: {e}"))?;
            let (text, _) = decode(bytes);
            loader.json(&stem(path), &text, format == Format::JsonLines)
        }
    };
    if let Err(e) = loaded {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e);
    }
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    if loader.tables.is_empty() {
        return Err(format!("{name} has no data to show."));
    }
    drop(loader);

    // Every later statement, from the grid, the editor or an agent, is refused
    // a write by SQLite itself, whatever the app's own checks decided.
    conn.execute_batch("PRAGMA query_only = ON")
        .map_err(|e| e.to_string())?;

    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .unwrap_or_default();
    notices.insert(
        0,
        "A read-only copy of the file as it is now. Open it again to pick up later changes.".into(),
    );
    Ok((
        SqliteConn::from_connection(conn),
        OpenInfo {
            engine: "sqlite".into(),
            server_version: version,
            read_only: true,
            notices,
            ..Default::default()
        },
    ))
}

fn human_size(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    let mb = bytes as f64 / MB;
    if mb >= 1024.0 {
        format!("{:.1} GB", mb / 1024.0)
    } else if mb >= 10.0 {
        format!("{mb:.0} MB")
    } else {
        format!("{mb:.1} MB")
    }
}

// --- Text -------------------------------------------------------------------

/// The file as text, and the encoding's name when it was not UTF-8.
///
/// A byte-order mark decides (UTF-8, UTF-16LE, UTF-16BE). Without one, valid
/// UTF-8 is UTF-8, and anything else is read as Windows-1252, which is what
/// Excel on Windows writes for "CSV" and which maps every byte to something.
fn decode(mut bytes: Vec<u8>) -> (String, Option<&'static str>) {
    if let Some((encoding, bom)) = encoding_rs::Encoding::for_bom(&bytes) {
        if encoding == encoding_rs::UTF_8 {
            bytes.drain(..bom);
            return match String::from_utf8(bytes) {
                Ok(text) => (text, None),
                Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), None),
            };
        }
        let (text, _) = encoding.decode_without_bom_handling(&bytes[bom..]);
        let named = if encoding == encoding_rs::UTF_16BE {
            "UTF-16 (big-endian)"
        } else {
            "UTF-16"
        };
        return (text.into_owned(), Some(named));
    }
    match String::from_utf8(bytes) {
        Ok(text) => (text, None),
        Err(e) => {
            let (text, _) = encoding_rs::WINDOWS_1252.decode_without_bom_handling(e.as_bytes());
            (text.into_owned(), Some("Windows-1252"))
        }
    }
}

const DELIMITERS: [u8; 4] = *b",;\t|";

/// The delimiter that splits the first lines into the most consistent number
/// of fields, as `detectDelimiter` in `src/lib/db/csv.ts` chooses it.
fn detect_delimiter(text: &str) -> u8 {
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(10)
        .collect();
    let mut best = b',';
    let mut best_score: i64 = -1;
    for delimiter in DELIMITERS {
        let counts: Vec<usize> = lines
            .iter()
            .map(|line| {
                csv::ReaderBuilder::new()
                    .has_headers(false)
                    .flexible(true)
                    .delimiter(delimiter)
                    .from_reader(line.as_bytes())
                    .records()
                    .next()
                    .and_then(|r| r.ok())
                    .map_or(0, |r| r.len())
            })
            .collect();
        let Some(&first) = counts.first() else {
            continue;
        };
        if first < 2 {
            continue;
        }
        let consistent = counts.iter().filter(|&&c| c == first).count() as i64;
        let score = consistent * 100 + first as i64;
        if score > best_score {
            best_score = score;
            best = delimiter;
        }
    }
    best
}

fn csv_reader(text: &str, delimiter: u8) -> csv::Reader<&[u8]> {
    csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(text.as_bytes())
}

/// An integer as the import dialog accepts one: digits with an optional sign,
/// no leading zero, and within i64.
fn parse_integer(s: &str) -> Option<i64> {
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if digits.len() > 1 && digits.starts_with('0') {
        return None;
    }
    s.parse().ok()
}

/// A decimal number: `1.5`, `.5`, `5.`, `-2e10`. No leading zero before the
/// point (`007.5`), and no `inf` or `NaN`, which are text in a spreadsheet.
fn parse_real(s: &str) -> Option<f64> {
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let (int_part, frac_part) = match mantissa.find('.') {
        Some(i) => (&mantissa[..i], &mantissa[i + 1..]),
        None => (mantissa, ""),
    };
    let digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    if !digits(int_part) || !digits(frac_part) || (int_part.is_empty() && frac_part.is_empty()) {
        return None;
    }
    if int_part.len() > 1 && int_part.starts_with('0') {
        return None;
    }
    if let Some(exp) = exponent {
        let exp = exp.strip_prefix(['+', '-']).unwrap_or(exp);
        if exp.is_empty() || !digits(exp) {
            return None;
        }
    }
    s.parse::<f64>().ok().filter(|f| f.is_finite())
}

/// `2,50` as 2.5, for files that use a comma as the decimal separator: the
/// semicolon-separated CSV that Excel writes where that is the convention.
/// Only digits on both sides of a single comma; anything else is not a number.
fn parse_decimal_comma(s: &str) -> Option<f64> {
    let (int_part, frac_part) = s.split_once(',')?;
    let digits = int_part.strip_prefix(['+', '-']).unwrap_or(int_part);
    if digits.is_empty()
        || frac_part.is_empty()
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || !frac_part.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    parse_real(&format!("{int_part}.{frac_part}"))
}

fn parse_number(s: &str, decimal_comma: bool) -> Option<f64> {
    parse_real(s).or_else(|| {
        if decimal_comma {
            parse_decimal_comma(s)
        } else {
            None
        }
    })
}

fn classify_text(field: &str, decimal_comma: bool) -> ColType {
    let t = field.trim();
    if t.is_empty() {
        ColType::Empty
    } else if parse_integer(t).is_some() {
        ColType::Integer
    } else if parse_number(t, decimal_comma).is_some() {
        ColType::Real
    } else {
        ColType::Text
    }
}

/// A delimited field as a cell of a column already typed.
fn text_cell(field: &str, ty: ColType, decimal_comma: bool) -> Cell<'_> {
    let t = field.trim();
    match ty {
        ColType::Integer if !t.is_empty() => parse_integer(t).map_or(Cell::Null, Cell::Int),
        ColType::Real if !t.is_empty() => {
            parse_number(t, decimal_comma).map_or(Cell::Null, Cell::Real)
        }
        ColType::Integer | ColType::Real | ColType::Empty => Cell::Null,
        _ if field.is_empty() => Cell::Null,
        _ => Cell::Text(Cow::Borrowed(field)),
    }
}

// --- Cells and columns --------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ColType {
    /// No value seen yet.
    Empty,
    Integer,
    Real,
    Boolean,
    Text,
}

impl ColType {
    fn widen(self, other: ColType) -> ColType {
        use ColType::*;
        match (self, other) {
            (Empty, t) | (t, Empty) => t,
            (a, b) if a == b => a,
            (Integer, Real) | (Real, Integer) => Real,
            _ => Text,
        }
    }

    fn sql(self) -> &'static str {
        match self {
            ColType::Integer => "INTEGER",
            ColType::Real => "REAL",
            ColType::Boolean => "BOOLEAN",
            ColType::Empty | ColType::Text => "TEXT",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Cell<'a> {
    Null,
    Int(i64),
    Real(f64),
    Bool(bool),
    Text(Cow<'a, str>),
}

impl Cell<'_> {
    fn kind(&self) -> ColType {
        match self {
            Cell::Null => ColType::Empty,
            Cell::Int(_) => ColType::Integer,
            Cell::Real(_) => ColType::Real,
            Cell::Bool(_) => ColType::Boolean,
            Cell::Text(_) => ColType::Text,
        }
    }
}

/// The shortest text that reads back as the same number, without exponent.
fn real_text(f: f64) -> String {
    f.to_string()
}

/// A value for a column of type `ty`. Only TEXT columns can hold a value of
/// another kind (the column widened to text), and get its spelling.
fn sql_value<'a>(cell: &'a Cell<'a>, ty: ColType, bool_text: [&str; 2]) -> ToSqlOutput<'a> {
    let text = ty == ColType::Text;
    match cell {
        Cell::Null => ToSqlOutput::Owned(SqlValue::Null),
        Cell::Int(i) if text => ToSqlOutput::Owned(SqlValue::Text(i.to_string())),
        Cell::Int(i) if ty == ColType::Real => ToSqlOutput::Owned(SqlValue::Real(*i as f64)),
        Cell::Int(i) => ToSqlOutput::Owned(SqlValue::Integer(*i)),
        Cell::Real(f) if text => ToSqlOutput::Owned(SqlValue::Text(real_text(*f))),
        Cell::Real(f) => ToSqlOutput::Owned(SqlValue::Real(*f)),
        Cell::Bool(b) if text => {
            ToSqlOutput::Owned(SqlValue::Text(bool_text[usize::from(!*b)].to_string()))
        }
        Cell::Bool(b) => ToSqlOutput::Owned(SqlValue::Integer(i64::from(*b))),
        Cell::Text(s) => ToSqlOutput::Borrowed(ValueRef::Text(s.as_bytes())),
    }
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Column names from a header row that may have blanks and repeats, as
/// `headerNames` in `src/lib/db/csv.ts` makes them, but never two alike:
/// SQLite compares column names without regard to case.
fn column_names(header: &[String]) -> Vec<String> {
    let mut taken = HashSet::new();
    header
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let base = match raw.trim() {
                "" => format!("column_{}", i + 1),
                t => t.to_string(),
            };
            unique(base, &mut taken)
        })
        .collect()
}

fn unique(base: String, taken: &mut HashSet<String>) -> String {
    if taken.insert(base.to_lowercase()) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}_{n}"))
        .find(|candidate| taken.insert(candidate.to_lowercase()))
        .expect("an unused name")
}

/// One table on its way in: the names and types, then the rows.
struct TablePlan {
    name: String,
    columns: Vec<String>,
    types: Vec<ColType>,
}

impl TablePlan {
    /// Drop columns with neither a header nor a value, such as the one a
    /// trailing delimiter makes or a formatted but empty spreadsheet column.
    /// Returns the indexes kept.
    fn drop_blank_columns(&mut self, header: &[String]) -> Vec<usize> {
        let keep: Vec<usize> = (0..self.columns.len())
            .filter(|&i| {
                let named = header.get(i).is_some_and(|h| !h.trim().is_empty());
                named || self.types[i] != ColType::Empty
            })
            .collect();
        // A table needs a column; a header of nothing but blanks keeps them.
        if keep.is_empty() {
            return (0..self.columns.len()).collect();
        }
        // A subset of unique names is still unique, and a blank header keeps
        // the column_N of its place in the file.
        self.columns = keep.iter().map(|&i| self.columns[i].clone()).collect();
        self.types = keep.iter().map(|&i| self.types[i]).collect();
        keep
    }
}

struct Loader<'c> {
    conn: &'c Connection,
    /// Lowercased table names already used.
    taken: HashSet<String>,
    tables: Vec<String>,
}

impl<'c> Loader<'c> {
    fn new(conn: &'c Connection) -> Self {
        Self {
            conn,
            taken: HashSet::new(),
            tables: Vec::new(),
        }
    }

    fn table_name(&mut self, raw: &str) -> String {
        let mut base = raw.trim().to_string();
        if base.is_empty() {
            base = "data".into();
        }
        // SQLite reserves these for itself and refuses to create them.
        if base.to_ascii_lowercase().starts_with("sqlite_") {
            base = format!("_{base}");
        }
        unique(base, &mut self.taken)
    }

    /// Create the table and hand back a statement that inserts one row.
    fn create(&mut self, plan: &TablePlan, label: &str) -> Result<rusqlite::Statement<'c>, String> {
        if plan.columns.len() > MAX_COLUMNS {
            return Err(format!(
                "{label} has {} columns. LiteDB opens up to {MAX_COLUMNS}.",
                plan.columns.len()
            ));
        }
        let columns: Vec<String> = plan
            .columns
            .iter()
            .zip(&plan.types)
            .map(|(name, ty)| format!("{} {}", quote_ident(name), ty.sql()))
            .collect();
        let table = quote_ident(&plan.name);
        self.conn
            .execute_batch(&format!("CREATE TABLE {table} ({})", columns.join(", ")))
            .map_err(|e| format!("Could not load {label}: {e}"))?;
        self.tables.push(plan.name.clone());
        let marks = vec!["?"; plan.columns.len()].join(", ");
        self.conn
            .prepare(&format!("INSERT INTO {table} VALUES ({marks})"))
            .map_err(|e| format!("Could not load {label}: {e}"))
    }

    // --- Delimited text ---

    fn delimited(&mut self, stem: &str, text: &str, delimiter: Option<u8>) -> Result<(), String> {
        let delimiter = delimiter.unwrap_or_else(|| detect_delimiter(text));
        // A semicolon file is one where the comma is the decimal separator.
        let decimal_comma = delimiter == b';';

        // First pass: the header, the widest row, and each column's type.
        let mut header: Option<Vec<String>> = None;
        let mut types: Vec<ColType> = Vec::new();
        for (n, record) in csv_reader(text, delimiter).records().enumerate() {
            let record = record.map_err(|e| csv_error(&e, n))?;
            if header.is_none() {
                header = Some(record.iter().map(str::to_string).collect());
                types.resize(record.len(), ColType::Empty);
                continue;
            }
            if record.len() > types.len() {
                types.resize(record.len(), ColType::Empty);
            }
            for (i, field) in record.iter().enumerate() {
                types[i] = types[i].widen(classify_text(field, decimal_comma));
            }
        }
        let Some(header) = header else {
            return Ok(());
        };
        types.resize(types.len().max(header.len()), ColType::Empty);
        let mut padded = header;
        padded.resize(types.len(), String::new());

        let mut plan = TablePlan {
            name: self.table_name(stem),
            columns: column_names(&padded),
            types,
        };
        let keep = plan.drop_blank_columns(&padded);
        let mut insert = self.create(&plan, stem)?;

        // Second pass: the rows.
        for (n, record) in csv_reader(text, delimiter).records().enumerate().skip(1) {
            let record = record.map_err(|e| csv_error(&e, n))?;
            let row: Vec<Cell> = keep
                .iter()
                .enumerate()
                .map(|(slot, &i)| {
                    text_cell(record.get(i).unwrap_or(""), plan.types[slot], decimal_comma)
                })
                .collect();
            insert_row(&mut insert, &row, &plan.types, ["true", "false"], stem)?;
        }
        Ok(())
    }

    // --- Workbooks ---

    fn workbook(&mut self, path: &Path) -> Result<(), String> {
        let name = display_name(path);
        let mut book = calamine::open_workbook_auto(path).map_err(|e| workbook_error(&name, e))?;
        let sheets: Vec<String> = book
            .sheets_metadata()
            .iter()
            .filter(|s| s.typ == SheetType::WorkSheet)
            .map(|s| s.name.clone())
            .collect();
        for sheet in sheets {
            let range = book
                .worksheet_range(&sheet)
                .map_err(|e| format!("Could not read the sheet \"{sheet}\" in {name}: {e}"))?;
            self.range(&sheet, &range)?;
        }
        Ok(())
    }

    /// One sheet's used cells as a table. The first row is the header; rows
    /// with nothing in them are skipped. A sheet with nothing in it is left out.
    fn range(&mut self, sheet: &str, range: &Range<Data>) -> Result<(), String> {
        let mut rows = range.rows();
        let Some(first) = rows.next() else {
            return Ok(());
        };
        let header: Vec<String> = first.iter().map(header_text).collect();
        let width = header.len();
        let body: Vec<&[Data]> = rows
            .filter(|r| r.iter().any(|c| !matches!(c, Data::Empty)))
            .collect();
        if body.is_empty() && header.iter().all(|h| h.trim().is_empty()) {
            return Ok(());
        }

        let mut types = vec![ColType::Empty; width];
        for row in &body {
            for (i, data) in row.iter().enumerate().take(width) {
                types[i] = types[i].widen(excel_cell(data).kind());
            }
        }
        let mut plan = TablePlan {
            name: self.table_name(sheet),
            columns: column_names(&header),
            types,
        };
        let keep = plan.drop_blank_columns(&header);
        let label = format!("the sheet \"{sheet}\"");
        let mut insert = self.create(&plan, &label)?;
        let mut cells: Vec<Cell> = Vec::with_capacity(keep.len());
        for row in body {
            cells.clear();
            cells.extend(
                keep.iter()
                    .map(|&i| row.get(i).map_or(Cell::Null, excel_cell)),
            );
            insert_row(&mut insert, &cells, &plan.types, ["TRUE", "FALSE"], &label)?;
        }
        Ok(())
    }

    // --- JSON ---

    fn json(&mut self, stem: &str, text: &str, lines: bool) -> Result<(), String> {
        let value = if lines {
            json_lines(text)?
        } else {
            match serde_json::from_str::<Node>(text) {
                Ok(value) => value,
                // A .json file that is really JSON Lines, as many exports are.
                Err(error) => json_lines(text)
                    .ok()
                    .filter(|v| matches!(v, Node::Array(items) if items.len() > 1))
                    .ok_or_else(|| format!("The file is not valid JSON: {error}."))?,
            }
        };
        match &value {
            Node::Array(items) => self.json_table(stem, items),
            Node::Object(entries) => {
                let tables: Vec<(&str, &[Node])> = entries
                    .iter()
                    .filter_map(|(key, v)| match v {
                        Node::Array(items) if items.iter().any(|n| matches!(n, Node::Object(_))) => {
                            Some((key.as_str(), items.as_slice()))
                        }
                        _ => None,
                    })
                    .collect();
                if tables.is_empty() {
                    // A single record: one row.
                    return self.json_table(stem, std::slice::from_ref(&value));
                }
                for (key, items) in tables {
                    self.json_table(key, items)?;
                }
                Ok(())
            }
            _ => Err("The JSON file holds a single value, not rows. LiteDB opens an array of objects, or an object of such arrays.".into()),
        }
    }

    fn json_table(&mut self, name: &str, items: &[Node]) -> Result<(), String> {
        // Keys in the order they first appear; anything that is not an object
        // goes in a column of its own after them.
        let mut keys: Vec<&str> = Vec::new();
        let mut slots: HashMap<&str, usize> = HashMap::new();
        let mut scalars = false;
        for item in items {
            match item {
                Node::Object(entries) => {
                    for (key, _) in entries {
                        if !slots.contains_key(key.as_str()) {
                            slots.insert(key, keys.len());
                            keys.push(key);
                        }
                    }
                }
                _ => scalars = true,
            }
        }
        let layout = JsonLayout {
            slots,
            width: keys.len() + usize::from(scalars),
            value_slot: keys.len(),
        };
        if layout.width == 0 {
            // `[]` or `[{}]`: nothing to make a column from.
            return Ok(());
        }

        let mut types = vec![ColType::Empty; layout.width];
        for item in items {
            match item {
                Node::Object(entries) => {
                    for (key, v) in entries {
                        let slot = layout.slots[key.as_str()];
                        types[slot] = types[slot].widen(json_kind(v));
                    }
                }
                other => {
                    let slot = layout.value_slot;
                    types[slot] = types[slot].widen(json_kind(other));
                }
            }
        }
        let mut header: Vec<String> = keys.iter().map(|k| k.to_string()).collect();
        if scalars {
            let mut taken: HashSet<String> = header.iter().map(|c| c.to_lowercase()).collect();
            header.push(unique("value".into(), &mut taken));
        }
        let plan = TablePlan {
            name: self.table_name(name),
            columns: column_names(&header),
            types,
        };
        let label = format!("\"{name}\"");
        let mut insert = self.create(&plan, &label)?;
        let mut row: Vec<Cell> = Vec::with_capacity(layout.width);
        for item in items {
            layout.fill(item, &mut row);
            insert_row(&mut insert, &row, &plan.types, ["true", "false"], &label)?;
        }
        Ok(())
    }
}

fn insert_row(
    insert: &mut rusqlite::Statement<'_>,
    row: &[Cell],
    types: &[ColType],
    bool_text: [&str; 2],
    label: &str,
) -> Result<(), String> {
    let values = row
        .iter()
        .zip(types)
        .map(|(cell, &ty)| sql_value(cell, ty, bool_text));
    insert
        .execute(rusqlite::params_from_iter(values))
        .map(|_| ())
        .map_err(|e| format!("Could not load {label}: {e}"))
}

fn csv_error(error: &csv::Error, record: usize) -> String {
    let line = error
        .position()
        .map(|p| p.line())
        .unwrap_or(record as u64 + 1);
    format!("The file could not be read as CSV near line {line}: {error}")
}

fn workbook_error(name: &str, error: calamine::Error) -> String {
    let text = error.to_string();
    let lower = text.to_lowercase();
    if lower.contains("password") || lower.contains("encrypt") {
        return format!(
            "{name} is protected with a password. Remove the password in Excel and open it again."
        );
    }
    // Zip and CFB are the containers .xlsx and .xls live in: a file that is
    // neither is not a workbook at all, or it is cut short.
    if lower.contains("zip") || lower.contains("cfb") || lower.contains("invalid") {
        return format!(
            "{name} is not a workbook LiteDB can read, or it is damaged. Open it in Excel and save it again as .xlsx."
        );
    }
    format!("Could not read {name} as a workbook: {text}")
}

/// Where each key of a JSON table's objects goes in a row.
struct JsonLayout<'a> {
    slots: HashMap<&'a str, usize>,
    width: usize,
    /// The column for items that are not objects.
    value_slot: usize,
}

impl JsonLayout<'_> {
    fn fill<'n>(&self, item: &'n Node, row: &mut Vec<Cell<'n>>) {
        row.clear();
        row.resize(self.width, Cell::Null);
        match item {
            // A key given twice keeps its last value, as JSON parsers do.
            Node::Object(entries) => {
                for (key, v) in entries {
                    row[self.slots[key.as_str()]] = json_cell(v);
                }
            }
            other => row[self.value_slot] = json_cell(other),
        }
    }
}

/// A JSON value with object keys in the file's order. serde_json's own Value
/// sorts them unless a crate-wide feature is on, and a table's columns should
/// come in the order the file gives them.
#[derive(Debug, Clone, PartialEq)]
enum Node {
    Null,
    Bool(bool),
    Int(i64),
    /// A whole number past i64, kept as its digits.
    Big(String),
    Real(f64),
    Str(String),
    Array(Vec<Node>),
    Object(Vec<(String, Node)>),
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(NodeVisitor)
    }
}

struct NodeVisitor;

impl<'de> Visitor<'de> for NodeVisitor {
    type Value = Node;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_unit<E>(self) -> Result<Node, E> {
        Ok(Node::Null)
    }
    fn visit_none<E>(self) -> Result<Node, E> {
        Ok(Node::Null)
    }
    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Node, D::Error> {
        Node::deserialize(d)
    }
    fn visit_bool<E>(self, v: bool) -> Result<Node, E> {
        Ok(Node::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<Node, E> {
        Ok(Node::Int(v))
    }
    fn visit_u64<E>(self, v: u64) -> Result<Node, E> {
        Ok(i64::try_from(v).map_or_else(|_| Node::Big(v.to_string()), Node::Int))
    }
    fn visit_f64<E>(self, v: f64) -> Result<Node, E> {
        Ok(Node::Real(v))
    }
    fn visit_str<E>(self, v: &str) -> Result<Node, E> {
        Ok(Node::Str(v.to_owned()))
    }
    fn visit_string<E>(self, v: String) -> Result<Node, E> {
        Ok(Node::Str(v))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
        let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(4096));
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Node::Array(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
        let mut entries = Vec::with_capacity(map.size_hint().unwrap_or(0).min(4096));
        while let Some(entry) = map.next_entry::<String, Node>()? {
            entries.push(entry);
        }
        Ok(Node::Object(entries))
    }
}

/// Compact JSON text, keys in their order.
fn write_json(node: &Node, out: &mut String) {
    match node {
        Node::Null => out.push_str("null"),
        Node::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Node::Int(i) => out.push_str(&i.to_string()),
        Node::Big(digits) => out.push_str(digits),
        Node::Real(f) => out.push_str(&serde_json::to_string(f).unwrap_or_else(|_| "null".into())),
        Node::Str(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Node::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Node::Object(entries) => {
            out.push('{');
            for (i, (key, value)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                write_json(value, out);
            }
            out.push('}');
        }
    }
}

fn json_lines(text: &str) -> Result<Node, String> {
    let mut items = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Node>(line)
            .map_err(|e| format!("Line {} is not valid JSON: {e}.", n + 1))?;
        items.push(value);
    }
    Ok(Node::Array(items))
}

fn json_kind(node: &Node) -> ColType {
    match node {
        Node::Null => ColType::Empty,
        Node::Bool(_) => ColType::Boolean,
        Node::Int(_) => ColType::Integer,
        Node::Real(_) => ColType::Real,
        Node::Big(_) | Node::Str(_) | Node::Array(_) | Node::Object(_) => ColType::Text,
    }
}

fn json_cell(node: &Node) -> Cell<'_> {
    match node {
        Node::Null => Cell::Null,
        Node::Bool(b) => Cell::Bool(*b),
        Node::Int(i) => Cell::Int(*i),
        Node::Real(f) => Cell::Real(*f),
        // Past i64: text keeps every digit, a REAL would round it.
        Node::Big(digits) => Cell::Text(Cow::Borrowed(digits)),
        Node::Str(s) => Cell::Text(Cow::Borrowed(s)),
        nested => {
            let mut text = String::new();
            write_json(nested, &mut text);
            Cell::Text(Cow::Owned(text))
        }
    }
}

/// Largest whole number an f64 holds exactly, so 3.0 can be the integer 3.
const MAX_EXACT_F64: f64 = 9_007_199_254_740_992.0;

fn excel_cell(data: &Data) -> Cell<'_> {
    match data {
        Data::Empty => Cell::Null,
        Data::Int(i) => Cell::Int(*i),
        // Excel keeps every number as a float; 3 is stored as 3.0.
        Data::Float(f) if f.fract() == 0.0 && f.abs() < MAX_EXACT_F64 => Cell::Int(*f as i64),
        Data::Float(f) if f.is_finite() => Cell::Real(*f),
        Data::Float(_) => Cell::Null,
        Data::String(s) if s.is_empty() => Cell::Null,
        Data::String(s) => Cell::Text(Cow::Borrowed(s)),
        Data::Bool(b) => Cell::Bool(*b),
        Data::DateTime(dt) => Cell::Text(Cow::Owned(excel_datetime(dt))),
        Data::DateTimeIso(s) => Cell::Text(iso_datetime(s)),
        Data::DurationIso(s) => Cell::Text(Cow::Borrowed(s)),
        Data::Error(e) => Cell::Text(Cow::Owned(e.to_string())),
    }
}

/// OpenDocument writes dates as `2025-10-01T00:00:00`. Spelled the way Excel
/// dates are here: `2025-10-01`, or `2025-10-01 14:30:00` with a time.
fn iso_datetime(s: &str) -> Cow<'_, str> {
    match s.split_once('T') {
        Some((date, "00:00:00")) => Cow::Borrowed(date),
        Some((date, time)) if date.len() == 10 => Cow::Owned(format!("{date} {time}")),
        _ => Cow::Borrowed(s),
    }
}

/// ISO 8601: `2025-10-13`, `2025-10-13 12:59:02`, a time of day alone as
/// `12:59:02`, and a duration as hours past 24 if need be, `36:00:00`.
fn excel_datetime(dt: &calamine::ExcelDateTime) -> String {
    let value = dt.as_f64();
    if dt.is_duration() {
        let total_ms = (value * 86_400_000.0).round() as i64;
        let sign = if total_ms < 0 { "-" } else { "" };
        let ms = total_ms.unsigned_abs();
        let (h, m, s, frac) = (ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000);
        return if frac > 0 {
            format!("{sign}{h}:{m:02}:{s:02}.{frac:03}")
        } else {
            format!("{sign}{h}:{m:02}:{s:02}")
        };
    }
    let (y, mo, d, h, mi, s, ms) = dt.to_ymd_hms_milli();
    let time = if ms > 0 {
        format!("{h:02}:{mi:02}:{s:02}.{ms:03}")
    } else {
        format!("{h:02}:{mi:02}:{s:02}")
    };
    if (0.0..1.0).contains(&value) {
        // A time with no date: Excel stores it as a fraction of day zero.
        return time;
    }
    let date = format!("{y:04}-{mo:02}-{d:02}");
    if h == 0 && mi == 0 && s == 0 && ms == 0 {
        date
    } else {
        format!("{date} {time}")
    }
}

fn header_text(data: &Data) -> String {
    match excel_cell(data) {
        Cell::Null => String::new(),
        Cell::Int(i) => i.to_string(),
        Cell::Real(f) => real_text(f),
        Cell::Bool(b) => if b { "TRUE" } else { "FALSE" }.into(),
        Cell::Text(s) => s.into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;
    use crate::db::RunOptions;
    use serde_json::json;
    use std::sync::atomic::AtomicBool;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "litedb-datafile-{}-{}",
            std::process::id(),
            name.replace('.', "-")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn open_bytes(name: &str, bytes: &[u8]) -> Result<(SqliteConn, OpenInfo), String> {
        open(&temp_file(name, bytes))
    }

    fn open_err(name: &str, bytes: &[u8]) -> String {
        match open_bytes(name, bytes) {
            Ok(_) => panic!("{name} should not open"),
            Err(e) => e,
        }
    }

    fn query(conn: &SqliteConn, sql: &str) -> Vec<Vec<serde_json::Value>> {
        let guard = conn.conn.lock().unwrap();
        let response = sqlite::run(
            &guard,
            &[sql.to_string()],
            &RunOptions::default(),
            &AtomicBool::new(false),
        );
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        response.results.into_iter().next().unwrap().rows
    }

    fn columns(conn: &SqliteConn, table: &str) -> Vec<(String, String)> {
        query(
            conn,
            &format!("SELECT name, type FROM pragma_table_info('{table}') ORDER BY cid"),
        )
        .into_iter()
        .map(|r| {
            (
                r[0].as_str().unwrap().to_string(),
                r[1].as_str().unwrap().to_string(),
            )
        })
        .collect()
    }

    fn tables(conn: &SqliteConn) -> Vec<String> {
        query(
            conn,
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid",
        )
        .into_iter()
        .map(|r| r[0].as_str().unwrap().to_string())
        .collect()
    }

    #[test]
    fn csv_becomes_a_typed_table_named_after_the_file() {
        let (conn, info) = open_bytes(
            "sales 2024.csv",
            b"id,zip,price,name,when\r\n1,02134,9.5,\"Smith, Jo\",2024-01-02\r\n2,10001,10,\"Line\nbreak \"\"q\"\"\",\r\n",
        )
        .unwrap();
        assert!(info.read_only);
        assert_eq!(info.engine, "sqlite");
        assert_eq!(tables(&conn), vec!["sales 2024"]);
        assert_eq!(
            columns(&conn, "sales 2024"),
            vec![
                ("id".into(), "INTEGER".into()),
                ("zip".into(), "TEXT".into()),
                ("price".into(), "REAL".into()),
                ("name".into(), "TEXT".into()),
                ("when".into(), "TEXT".into()),
            ]
        );
        let rows = query(&conn, "SELECT * FROM \"sales 2024\" ORDER BY id");
        assert_eq!(
            rows,
            vec![
                vec![
                    json!(1),
                    json!("02134"),
                    json!(9.5),
                    json!("Smith, Jo"),
                    json!("2024-01-02")
                ],
                vec![
                    json!(2),
                    json!("10001"),
                    json!(10.0),
                    json!("Line\nbreak \"q\""),
                    json!(null)
                ],
            ]
        );
    }

    #[test]
    fn the_copy_refuses_writes() {
        let (conn, _) = open_bytes("t.csv", b"a\n1\n").unwrap();
        let guard = conn.conn.lock().unwrap();
        for sql in [
            "INSERT INTO t VALUES (2)",
            "UPDATE t SET a = 3",
            "DELETE FROM t",
            "CREATE TABLE x (y)",
            "DROP TABLE t",
        ] {
            let response = sqlite::run(
                &guard,
                &[sql.to_string()],
                &RunOptions::default(),
                &AtomicBool::new(false),
            );
            assert!(!response.errors.is_empty(), "{sql} should be refused");
        }
        drop(guard);
        assert_eq!(query(&conn, "SELECT count(*) FROM t"), vec![vec![json!(1)]]);
    }

    #[test]
    fn delimiter_is_detected_and_tsv_is_tab() {
        let (conn, _) = open_bytes("semi.csv", b"a;b\n1;x\n2;y\n").unwrap();
        assert_eq!(columns(&conn, "semi").len(), 2);
        // A semicolon file uses the decimal comma; a comma file cannot.
        let (conn, _) =
            open_bytes("prix.csv", b"produit;prix;code\nCafe;2,50;1,2,3\nThe;3;4\n").unwrap();
        assert_eq!(columns(&conn, "prix")[1].1, "REAL");
        assert_eq!(columns(&conn, "prix")[2].1, "TEXT");
        assert_eq!(
            query(&conn, "SELECT prix, code FROM prix"),
            vec![
                vec![json!(2.5), json!("1,2,3")],
                vec![json!(3.0), json!("4")]
            ]
        );
        let (conn, _) = open_bytes("t.tsv", b"a\tb,c\n1\tx,y\n").unwrap();
        assert_eq!(
            query(&conn, "SELECT * FROM t"),
            vec![vec![json!(1), json!("x,y")]]
        );
    }

    #[test]
    fn ragged_rows_blank_and_repeated_headers() {
        let (conn, _) = open_bytes("r.csv", b"a,,A,a\n1,2\n\n3,4,5,6,7\n").unwrap();
        assert_eq!(
            columns(&conn, "r")
                .into_iter()
                .map(|c| c.0)
                .collect::<Vec<_>>(),
            vec!["a", "column_2", "A_2", "a_3", "column_5"]
        );
        assert_eq!(
            query(&conn, "SELECT * FROM r"),
            vec![
                vec![json!(1), json!(2), json!(null), json!(null), json!(null)],
                vec![json!(3), json!(4), json!(5), json!(6), json!(7)],
            ]
        );
    }

    #[test]
    fn a_trailing_delimiter_adds_no_column() {
        let (conn, _) = open_bytes("trail.csv", b"a,b,\n1,2,\n").unwrap();
        assert_eq!(columns(&conn, "trail").len(), 2);
    }

    #[test]
    fn encodings() {
        let (conn, info) = open_bytes("bom.csv", b"\xEF\xBB\xBFname\nJos\xC3\xA9\n").unwrap();
        assert_eq!(columns(&conn, "bom")[0].0, "name");
        assert_eq!(query(&conn, "SELECT * FROM bom"), vec![vec![json!("José")]]);
        assert_eq!(info.notices.len(), 1);

        let (conn, info) = open_bytes("latin.csv", b"name\nJos\xE9\n").unwrap();
        assert_eq!(
            query(&conn, "SELECT * FROM latin"),
            vec![vec![json!("José")]]
        );
        assert!(info.notices.iter().any(|n| n.contains("Windows-1252")));

        let mut utf16 = vec![0xFF, 0xFE];
        for unit in "a\tb\n1\tJosé\n".encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        let (conn, _) = open_bytes("wide.tsv", &utf16).unwrap();
        assert_eq!(
            query(&conn, "SELECT * FROM wide"),
            vec![vec![json!(1), json!("José")]]
        );
    }

    #[test]
    fn number_rules_follow_the_import_dialog() {
        for (s, int) in [
            ("0", true),
            ("-12", true),
            ("+7", true),
            ("007", false),
            ("1.0", false),
            ("", false),
            ("9223372036854775808", false),
        ] {
            assert_eq!(parse_integer(s).is_some(), int, "{s}");
        }
        for (s, real) in [
            ("1.5", true),
            (".5", true),
            ("5.", true),
            ("-2e10", true),
            ("0.25", true),
            ("007.5", false),
            ("1e", false),
            ("inf", false),
            ("NaN", false),
            (".", false),
            ("1,5", false),
        ] {
            assert_eq!(parse_real(s).is_some(), real, "{s}");
        }
    }

    #[test]
    fn empty_and_header_only_files() {
        assert!(open_err("empty.csv", b"").contains("no data"));
        assert!(open_err("blank.csv", b"\n\n").contains("no data"));
        let (conn, _) = open_bytes("head.csv", b"a,b\n").unwrap();
        assert_eq!(columns(&conn, "head").len(), 2);
        assert!(query(&conn, "SELECT * FROM head").is_empty());
    }

    #[test]
    fn reserved_and_empty_table_names() {
        let (conn, _) = open_bytes("sqlite_stat1.csv", b"a\n1\n").unwrap();
        assert_eq!(tables(&conn), vec!["_sqlite_stat1"]);
        let conn = Connection::open_in_memory().unwrap();
        let mut loader = Loader::new(&conn);
        assert_eq!(loader.table_name("  "), "data");
        assert_eq!(loader.table_name("Data"), "Data_2");
    }

    #[test]
    fn unsupported_extension_is_refused() {
        let err = open_err("notes.txt", b"a\n1\n");
        assert!(err.contains("CSV"), "{err}");
    }

    #[test]
    fn json_array_of_objects() {
        let (conn, _) = open_bytes(
            "people.json",
            br#"[{"id":1,"name":"Ann","ok":true,"tags":["a"],"score":1.5},{"id":2,"name":null,"ok":false,"extra":"x","score":2},{"id":18446744073709551615}]"#,
        )
        .unwrap();
        assert_eq!(
            columns(&conn, "people"),
            vec![
                ("id".into(), "TEXT".into()),
                ("name".into(), "TEXT".into()),
                ("ok".into(), "BOOLEAN".into()),
                ("tags".into(), "TEXT".into()),
                ("score".into(), "REAL".into()),
                ("extra".into(), "TEXT".into()),
            ]
        );
        assert_eq!(
            query(&conn, "SELECT * FROM people"),
            vec![
                vec![
                    json!("1"),
                    json!("Ann"),
                    json!(1),
                    json!("[\"a\"]"),
                    json!(1.5),
                    json!(null)
                ],
                vec![
                    json!("2"),
                    json!(null),
                    json!(0),
                    json!(null),
                    json!(2.0),
                    json!("x")
                ],
                vec![
                    json!("18446744073709551615"),
                    json!(null),
                    json!(null),
                    json!(null),
                    json!(null),
                    json!(null)
                ],
            ]
        );
    }

    #[test]
    fn json_object_of_arrays_and_single_records() {
        let (conn, _) = open_bytes(
            "api.json",
            br#"{"page":1,"users":[{"id":1}],"orders":[{"id":5,"total":9.99}],"tags":["x"]}"#,
        )
        .unwrap();
        assert_eq!(tables(&conn), vec!["users", "orders"]);

        let (conn, _) = open_bytes("one.json", br#"{"name":"x","n":2}"#).unwrap();
        assert_eq!(
            query(&conn, "SELECT * FROM one"),
            vec![vec![json!("x"), json!(2)]]
        );

        let (conn, _) = open_bytes("nums.json", b"[1, 2.5, \"a\", {\"value\": 3}]").unwrap();
        assert_eq!(
            columns(&conn, "nums")
                .into_iter()
                .map(|c| c.0)
                .collect::<Vec<_>>(),
            vec!["value", "value_2"]
        );

        assert!(open_err("scalar.json", b"42").contains("single value"));
        assert!(open_err("bad.json", b"{\"a\":").contains("not valid JSON"));
        assert!(open_err("none.json", b"[]").contains("no data"));
    }

    #[test]
    fn json_lines() {
        let body = b"{\"a\":1}\n\n{\"a\":2,\"b\":\"x\"}\n";
        let (conn, _) = open_bytes("events.jsonl", body).unwrap();
        assert_eq!(
            query(&conn, "SELECT * FROM events"),
            vec![vec![json!(1), json!(null)], vec![json!(2), json!("x")]]
        );
        // Saved as .json, read as lines all the same.
        let (conn, _) = open_bytes("events.json", body).unwrap();
        assert_eq!(
            query(&conn, "SELECT count(*) FROM events"),
            vec![vec![json!(2)]]
        );
        let err = open_err("broken.ndjson", b"{\"a\":1}\n{oops}\n");
        assert!(err.contains("Line 2"), "{err}");
    }

    fn sheet(cells: &[&[Data]]) -> Range<Data> {
        let rows = cells.len() as u32;
        let cols = cells.iter().map(|r| r.len()).max().unwrap_or(0) as u32;
        let mut range = Range::new((2, 1), (2 + rows - 1, 1 + cols - 1));
        for (r, row) in cells.iter().enumerate() {
            for (c, value) in row.iter().enumerate() {
                range.set_value((2 + r as u32, 1 + c as u32), value.clone());
            }
        }
        range
    }

    fn load_sheets(sheets: &[(&str, Range<Data>)]) -> SqliteConn {
        let conn = Connection::open_in_memory().unwrap();
        let mut loader = Loader::new(&conn);
        for (name, range) in sheets {
            loader.range(name, range).unwrap();
        }
        drop(loader);
        SqliteConn::from_connection(conn)
    }

    #[test]
    fn worksheets_become_typed_tables() {
        use calamine::{CellErrorType, ExcelDateTime, ExcelDateTimeType};
        let date = Data::DateTime(ExcelDateTime::new(
            45943.0,
            ExcelDateTimeType::DateTime,
            false,
        ));
        let stamp = Data::DateTime(ExcelDateTime::new(
            45943.541,
            ExcelDateTimeType::DateTime,
            false,
        ));
        let time = Data::DateTime(ExcelDateTime::new(0.5, ExcelDateTimeType::DateTime, false));
        let span = Data::DateTime(ExcelDateTime::new(1.5, ExcelDateTimeType::TimeDelta, false));
        let s = |v: &str| Data::String(v.into());
        let conn = load_sheets(&[
            (
                "Orders",
                sheet(&[
                    &[
                        s("id"),
                        s("qty"),
                        s("paid"),
                        s("when"),
                        s("note"),
                        Data::Float(2024.0),
                        Data::Empty,
                    ],
                    &[
                        Data::Float(1.0),
                        Data::Float(2.5),
                        Data::Bool(true),
                        date.clone(),
                        Data::Error(CellErrorType::Div0),
                        s("a"),
                        Data::Empty,
                    ],
                    &[
                        Data::Empty,
                        Data::Empty,
                        Data::Empty,
                        Data::Empty,
                        Data::Empty,
                        Data::Empty,
                        Data::Empty,
                    ],
                    &[
                        Data::Int(2),
                        Data::Int(3),
                        Data::Bool(false),
                        stamp,
                        s("ok"),
                        Data::Empty,
                        Data::Empty,
                    ],
                    &[
                        Data::Float(3.0),
                        Data::Empty,
                        s("maybe"),
                        time,
                        span,
                        Data::Empty,
                        Data::Empty,
                    ],
                ]),
            ),
            ("Empty", Range::empty()),
            ("orders", sheet(&[&[s("x")], &[Data::Int(1)]])),
        ]);
        assert_eq!(tables(&conn), vec!["Orders", "orders_2"]);
        assert_eq!(
            columns(&conn, "Orders"),
            vec![
                ("id".into(), "INTEGER".into()),
                ("qty".into(), "REAL".into()),
                ("paid".into(), "TEXT".into()),
                ("when".into(), "TEXT".into()),
                ("note".into(), "TEXT".into()),
                ("2024".into(), "TEXT".into()),
            ]
        );
        assert_eq!(
            query(&conn, "SELECT * FROM Orders"),
            vec![
                vec![
                    json!(1),
                    json!(2.5),
                    json!("TRUE"),
                    json!("2025-10-13"),
                    json!("#DIV/0!"),
                    json!("a")
                ],
                vec![
                    json!(2),
                    json!(3.0),
                    json!("FALSE"),
                    json!("2025-10-13 12:59:02.400"),
                    json!("ok"),
                    json!(null)
                ],
                vec![
                    json!(3),
                    json!(null),
                    json!("maybe"),
                    json!("12:00:00"),
                    json!("36:00:00"),
                    json!(null)
                ],
            ]
        );
    }

    #[test]
    fn opendocument_dates_read_like_excel_dates() {
        assert_eq!(iso_datetime("2025-10-01T00:00:00"), "2025-10-01");
        assert_eq!(iso_datetime("2025-10-03T14:30:00"), "2025-10-03 14:30:00");
        assert_eq!(iso_datetime("2025-10-03"), "2025-10-03");
        assert_eq!(iso_datetime("14:30:00"), "14:30:00");
    }

    #[test]
    fn an_all_boolean_column_is_boolean() {
        let conn = load_sheets(&[(
            "Flags",
            sheet(&[
                &[Data::String("on".into())],
                &[Data::Bool(true)],
                &[Data::Bool(false)],
            ]),
        )]);
        assert_eq!(columns(&conn, "Flags")[0].1, "BOOLEAN");
        assert_eq!(
            query(&conn, "SELECT \"on\" FROM Flags"),
            vec![vec![json!(1)], vec![json!(0)]]
        );
    }

    /// A real workbook, written by openpyxl: dates, booleans, integers stored
    /// as floats, an empty sheet and a hidden one.
    #[test]
    fn a_real_xlsx_opens() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/db/testdata/orders.xlsx");
        let (conn, info) = open(&path).unwrap();
        assert!(info.read_only);
        assert_eq!(tables(&conn), vec!["Orders", "People"]);
        assert_eq!(
            columns(&conn, "Orders"),
            vec![
                ("id".into(), "INTEGER".into()),
                ("customer".into(), "TEXT".into()),
                ("total".into(), "REAL".into()),
                ("paid".into(), "BOOLEAN".into()),
                ("ordered".into(), "TEXT".into()),
                ("zip".into(), "TEXT".into()),
            ]
        );
        assert_eq!(
            query(&conn, "SELECT * FROM Orders ORDER BY id"),
            vec![
                vec![
                    json!(1),
                    json!("Ann"),
                    json!(9.5),
                    json!(1),
                    json!("2025-10-13"),
                    json!("02134")
                ],
                vec![
                    json!(2),
                    json!("Bob, Jr."),
                    json!(12.0),
                    json!(0),
                    json!("2025-10-13 12:30:00"),
                    json!("10001")
                ],
                vec![
                    json!(3),
                    json!(null),
                    json!(7.25),
                    json!(1),
                    json!(null),
                    json!(null)
                ],
            ]
        );
        assert_eq!(
            query(&conn, "SELECT * FROM People"),
            vec![vec![json!("Cleo"), json!(41)]]
        );
    }

    #[test]
    fn a_file_that_is_not_a_workbook_is_refused() {
        let err = open_err("fake.xlsx", b"not a zip");
        assert!(err.contains("fake.xlsx is not a workbook"), "{err}");
    }

    #[test]
    fn too_many_columns_is_refused_with_a_reason() {
        let header: Vec<String> = (0..MAX_COLUMNS + 1).map(|i| format!("c{i}")).collect();
        let body = format!("{}\n", header.join(","));
        let err = open_err("wide.csv", body.as_bytes());
        assert!(err.contains("2001 columns"), "{err}");
    }

    #[test]
    fn extensions_are_recognised_case_insensitively() {
        for name in ["a.CSV", "a.Xlsx", "a.ods", "a.ndjson", "a.TSV"] {
            assert!(format_of(Path::new(name)).is_some(), "{name}");
        }
        for name in ["a.db", "a.sqlite", "a", "a.txt", "a.parquet"] {
            assert!(format_of(Path::new(name)).is_none(), "{name}");
        }
    }
}
