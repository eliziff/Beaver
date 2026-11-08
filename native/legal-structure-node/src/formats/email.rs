//! An email's text: its From, To, Cc, Bcc, Date and Subject headers, its text (the plain text, else the HTML as
//! text), a list of the attachments the file does not include, and what could not be decoded and why. A file with none
//! of an email's headers is read as plain text.
//!
//! mail-parser reads the MIME structure: the parts, their transfer encodings and parameters, encoded words, nested
//! messages. On it the reader keeps the selection the backend's reader (postal-mime) made: every inline text/plain and
//! text/html part in order, the parts of a multipart/alternative read as one, a forwarded inline message shown by its
//! header block and then its own text, every other leaf part an attachment; a body read line by line with its line
//! breaks as newlines unless base64 carries them; a charset found by its WHATWG label, windows-1252 when it has none.

use super::slides::{is_js_space, js_trim};
use mail_parser::{Address, DateTime, Encoding, HeaderForm, MessageParser, MessagePart, MessageRef, PartFlags, PartId};
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

const MAX_EMAIL_BYTES: usize = 100 * 1024 * 1024;
const MAX_PART_BYTES: usize = 8 * 1024 * 1024;
const MAX_HEADERS_BYTES: usize = 256 * 1024;
const MAX_DEPTH: usize = 8;
// A forwarded message was parsed on its own, under postal-mime's own limits.
const FORWARDED_MAX_HEADERS_BYTES: usize = 2 * 1024 * 1024;
const FORWARDED_MAX_DEPTH: usize = 256;
const DISPLAY_HEADERS: [(&str, &str); 6] =
    [("from", "From"), ("to", "To"), ("cc", "Cc"), ("bcc", "Bcc"), ("date", "Date"), ("subject", "Subject")];
const EMAIL_MARKERS: [&str; 6] = ["from", "date", "subject", "message-id", "received", "mime-version"];
const SAFE_TRANSFER_ENCODINGS: [&str; 6] = ["", "7bit", "8bit", "binary", "base64", "quoted-printable"];

/// The text of an .eml file. It never fails: what cannot be read is said in the text.
pub fn text(bytes: &[u8]) -> String {
    let email = parse(bytes);
    let mut parts = Vec::new();
    let headers = DISPLAY_HEADERS
        .iter()
        .filter_map(|(key, label)| {
            let value = email.headers.iter().find(|(name, _)| name == key).map(|(_, value)| value)?;
            (!value.is_empty()).then(|| format!("{label}: {value}"))
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !headers.is_empty() {
        parts.push(headers);
    }
    if !email.body.is_empty() {
        parts.push(email.body);
    }
    if !email.attachments.is_empty() {
        let listed = email
            .attachments
            .iter()
            .map(|attachment| format!("{} ({}, {} bytes)", attachment.filename, attachment.content_type, attachment.bytes))
            .collect::<Vec<_>>()
            .join("; ");
        parts.push(format!("[Attachments not included in this file: {listed}]"));
    }
    if !email.abstentions.is_empty() {
        let listed = email
            .abstentions
            .iter()
            .map(|(reason, detail)| format!("{reason} ({detail})"))
            .collect::<Vec<_>>()
            .join("; ");
        parts.push(format!("[Not decoded: {listed}]"));
    }
    parts.join("\n\n")
}

struct Email {
    /// Each header's first value, encoded words decoded (only the displayed headers are decoded).
    headers: Vec<(String, String)>,
    body: String,
    attachments: Vec<Listed>,
    abstentions: Vec<(&'static str, String)>,
}

struct Listed {
    filename: String,
    content_type: String,
    bytes: usize,
}

fn abstain(abstentions: &mut Vec<(&'static str, String)>, reason: &'static str, detail: String) {
    if !abstentions.iter().any(|(known, known_detail)| *known == reason && *known_detail == detail) {
        abstentions.push((reason, detail));
    }
}

fn failed(reason: &'static str, detail: &str) -> Email {
    Email { headers: Vec::new(), body: String::new(), attachments: Vec::new(), abstentions: vec![(reason, detail.into())] }
}

fn parse(bytes: &[u8]) -> Email {
    if bytes.len() > MAX_EMAIL_BYTES {
        return failed("part_too_large", &format!("email of {} bytes", bytes.len()));
    }
    let mut abstentions = static_abstentions(bytes);
    let message = match read_email(bytes) {
        Ok(message) => message,
        Err(Failure::Nesting) => return failed("nesting_too_deep", &format!("MIME nesting beyond {MAX_DEPTH} levels")),
        Err(Failure::Unreadable) => return failed("no_text_part", "the message could not be decoded safely"),
    };

    let mut headers: Vec<(String, String)> = Vec::new();
    for (key, value) in &message.headers {
        if !headers.iter().any(|(known, _)| known == key) {
            let shown = DISPLAY_HEADERS.iter().any(|(name, _)| name == key);
            headers.push((key.clone(), if shown { decode_words(value) } else { value.clone() }));
        }
    }
    if !headers.iter().any(|(key, _)| EMAIL_MARKERS.contains(&key.as_str())) {
        return Email {
            headers,
            body: js_trim(&String::from_utf8_lossy(bytes)).to_owned(),
            attachments: Vec::new(),
            abstentions: vec![("not_an_email", "no From/Date/Subject/Message-ID/Received header".into())],
        };
    }

    let mut body = match (&message.text, &message.html) {
        (Some(text), _) => js_trim(text).to_owned(),
        (None, Some(html)) => html_to_text(html),
        (None, None) => String::new(),
    };
    if body.len() > MAX_PART_BYTES {
        abstain(&mut abstentions, "part_too_large", format!("text part of {} bytes", body.len()));
        body.clear();
    }
    let attachments: Vec<Listed> = message
        .attachments
        .iter()
        .map(|attachment| {
            if attachment.bytes > MAX_PART_BYTES {
                abstain(&mut abstentions, "part_too_large",
                    format!("{} part of {} bytes", attachment.content_type, attachment.bytes));
            }
            Listed {
                filename: attachment.filename.clone().unwrap_or_else(|| "(unnamed attachment)".into()),
                content_type: if attachment.content_type.is_empty() {
                    "application/octet-stream".into()
                } else {
                    attachment.content_type.clone()
                },
                bytes: attachment.bytes,
            }
        })
        .collect();
    if body.is_empty()
        && attachments.is_empty()
        && !abstentions.iter().any(|(reason, _)| *reason == "encrypted" || *reason == "part_too_large")
    {
        abstain(&mut abstentions, "no_text_part", "the message carried no decodable text part".into());
    }
    Email { headers, body, attachments, abstentions }
}

/// What stops the message from being read: MIME nested too deep, or anything else postal-mime gave up on (a header
/// block past its limit, a forwarded message's date it could not format).
enum Failure {
    Nesting,
    Unreadable,
}

/// A message as read: its header fields in order (names in lower case, values unfolded), its text and HTML, and its
/// attachments, with what a message that forwards it needs of it.
#[derive(Default)]
struct Message {
    headers: Vec<(String, String)>,
    text: Option<String>,
    html: Option<String>,
    attachments: Vec<Attachment>,
    entries: Vec<(PartId, Texts)>,
}

struct Attachment {
    filename: Option<String>,
    content_type: String,
    bytes: usize,
}

/// The texts read under one key: a text part, or the parts of one multipart/alternative.
#[derive(Default)]
struct Texts {
    plain: Vec<Text>,
    html: Vec<Text>,
}

#[derive(Clone)]
enum Text {
    Part(String),
    /// A forwarded message, shown by its header block.
    Forwarded(Forwarded),
}

/// What a forwarded message's header block shows.
#[derive(Clone)]
struct Forwarded {
    headers: Vec<(String, String)>,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Plain,
    Html,
}

fn read_email(bytes: &[u8]) -> Result<Message, Failure> {
    let headers = header_fields(bytes, MAX_HEADERS_BYTES)?;
    let Some(parsed) = MessageParser::new().parse(bytes) else {
        return Ok(Message { headers, ..Message::default() });
    };
    read_message(parsed.root(), headers, MAX_DEPTH, MAX_HEADERS_BYTES)
}

fn read_message(message: MessageRef, headers: Vec<(String, String)>, max_depth: usize, max_headers: usize)
    -> Result<Message, Failure> {
    for part in message.parts() {
        if part.parent().is_none() {
            continue;
        }
        let depth = std::iter::successors(part.parent(), |parent| parent.parent()).count();
        if depth > max_depth {
            return Err(Failure::Nesting);
        }
        if header_bytes(part.raw_headers()) > max_headers {
            return Err(Failure::Unreadable);
        }
    }
    // A delivery or feedback report keeps its messages as attachments.
    let report = message.parts().any(|part| {
        matches!(mime_type(&part).as_str(), "message/delivery-status" | "message/feedback-report")
    });
    let mut walk = Walk { report, ..Walk::default() };
    walk.part(message.root_part(), None)?;
    let text = if walk.kinds.contains(&Kind::Plain) { walk.joined(Kind::Plain)? } else { None };
    let html = if walk.kinds.contains(&Kind::Html) { walk.joined(Kind::Html)? } else { None };
    Ok(Message { headers, text, html, attachments: walk.attachments, entries: walk.entries })
}

#[derive(Default)]
struct Walk {
    report: bool,
    entries: Vec<(PartId, Texts)>,
    keys: HashMap<PartId, usize>,
    kinds: Vec<Kind>,
    attachments: Vec<Attachment>,
}

impl Walk {
    fn texts(&mut self, key: PartId) -> &mut Texts {
        let index = *self.keys.entry(key).or_insert_with(|| {
            self.entries.push((key, Texts::default()));
            self.entries.len() - 1
        });
        &mut self.entries[index].1
    }

    fn push(&mut self, key: PartId, kind: Kind, text: Text) {
        let texts = self.texts(key);
        match kind {
            Kind::Plain => texts.plain.push(text),
            Kind::Html => texts.html.push(text),
        }
        if !self.kinds.contains(&kind) {
            self.kinds.push(kind);
        }
    }

    fn part(&mut self, part: MessagePart, alternative: Option<PartId>) -> Result<(), Failure> {
        let mime = mime_type(&part);
        if mime.starts_with("multipart/") {
            let alternative = if mime == "multipart/alternative" { Some(part.id()) } else { alternative };
            for child in part.children() {
                self.part(child, alternative)?;
            }
            return Ok(());
        }
        let disposition = part.content_disposition().map(|value| value.ctype().to_lowercase()).unwrap_or_default();
        if mime == "message/rfc822" && (disposition.is_empty() || disposition == "inline") && !self.report {
            let forwarded = match part.nested() {
                Some(nested) => {
                    let headers = header_fields(nested.root_part().raw_headers(), FORWARDED_MAX_HEADERS_BYTES)?;
                    read_message(nested, headers, FORWARDED_MAX_DEPTH, FORWARDED_MAX_HEADERS_BYTES)?
                }
                None => Message::default(),
            };
            let shown = Text::Forwarded(Forwarded { headers: forwarded.headers.clone() });
            self.texts(part.id());
            if forwarded.text.is_some() || forwarded.html.is_none() {
                self.push(part.id(), Kind::Plain, shown.clone());
            }
            if forwarded.html.is_some() {
                self.push(part.id(), Kind::Html, shown);
            }
            for (key, texts) in forwarded.entries {
                self.keys.insert(key, self.entries.len());
                self.entries.push((key, texts));
            }
            self.attachments.extend(forwarded.attachments);
        } else if (mime == "text/plain" || mime == "text/html") && disposition != "attachment" {
            let kind = if mime == "text/html" { Kind::Html } else { Kind::Plain };
            self.push(alternative.unwrap_or(part.id()), kind, Text::Part(text_content(&part)));
        } else {
            let bytes = if mime == "text/calendar" || mime == "application/ics" {
                let text = text_content(&part).replace("\r\n", "\n");
                format!("{}\n", text.trim_end_matches('\n')).len()
            } else {
                content(&part).len()
            };
            let filename = part.attachment_name().filter(|name| !name.is_empty()).map(str::to_owned);
            self.attachments.push(Attachment { filename, content_type: mime, bytes });
        }
        Ok(())
    }

    /// The texts of one kind, joined by newlines: each key's own texts of that kind, else its texts of the other
    /// kind converted. `None` when they join to nothing.
    fn joined(&self, kind: Kind) -> Result<Option<String>, Failure> {
        let mut out = Vec::new();
        for (_, texts) in &self.entries {
            let (own, other) = match kind {
                Kind::Plain => (&texts.plain, &texts.html),
                Kind::Html => (&texts.html, &texts.plain),
            };
            let converted = own.is_empty();
            for text in if converted { other } else { own } {
                out.push(match text {
                    Text::Part(value) if converted => match kind {
                        Kind::Plain => mail_parser::html_to_text(value),
                        Kind::Html => text_to_html(value),
                    },
                    Text::Part(value) => value.clone(),
                    Text::Forwarded(forwarded) => match kind {
                        Kind::Plain => forwarded.text_header()?,
                        Kind::Html => forwarded.html_header()?,
                    },
                });
            }
        }
        let joined = out.join("\n");
        Ok((!joined.is_empty()).then_some(joined))
    }
}

/// A part's media type in lower case; text/plain when it declares none (message/rfc822 in a multipart/digest).
fn mime_type(part: &MessagePart) -> String {
    match part.content_type() {
        Some(content_type) => {
            let main = content_type.ctype().to_lowercase();
            match content_type.subtype() {
                Some(subtype) => format!("{main}/{}", subtype.to_lowercase()),
                None => main,
            }
        }
        None if part.parent().is_some_and(|parent| mime_type(&parent) == "multipart/digest") => "message/rfc822".into(),
        None => "text/plain".into(),
    }
}

/// A part's body with its transfer encoding undone. A body that is not base64 is read by lines, each line break a
/// newline; quoted-printable is then decoded.
fn content(part: &MessagePart) -> Vec<u8> {
    match part.encoding() {
        Encoding::Base64 => part.decoded().into_owned(),
        Encoding::QuotedPrintable => Encoding::QuotedPrintable.decode(&body_lines(part)).into_owned(),
        Encoding::None => body_lines(part),
    }
}

/// The body's lines, each ended by a newline, the carriage returns before each line break dropped.
fn body_lines(part: &MessagePart) -> Vec<u8> {
    let raw = part.raw_body();
    let mut out = Vec::with_capacity(raw.len() + 1);
    if raw.is_empty() {
        return out;
    }
    // A part a delimiter ends stops before the delimiter's line break; one that runs to the end of its message keeps
    // its last line break, which ends a line rather than starting an empty one.
    let runs_to_end = part.parent().is_none() || part.flags().contains(PartFlags::MISSING_DELIMITER);
    let raw = if runs_to_end { raw.strip_suffix(b"\n").unwrap_or(raw) } else { raw };
    for line in raw.split(|&byte| byte == b'\n') {
        let end = line.iter().rposition(|&byte| byte != b'\r').map_or(0, |at| at + 1);
        out.extend_from_slice(&line[..end]);
        out.push(b'\n');
    }
    out
}

/// A text part's text: its content in its charset, format=flowed unwrapped.
fn text_content(part: &MessagePart) -> String {
    let content_type = part.content_type();
    let attribute = |name: &str| content_type.as_ref().and_then(|value| value.attribute(name));
    let text = decode_charset(&content(part), attribute("charset"));
    if attribute("format").is_some_and(|format| format.eq_ignore_ascii_case("flowed")) {
        let delete_space = attribute("delsp").is_some_and(|value| value.eq_ignore_ascii_case("yes"));
        return unflow(&text, delete_space);
    }
    text
}

/// Bytes in the encoding a charset label names (UTF-8 when there is none, windows-1252 when no encoding has that
/// label), a byte order mark of that encoding dropped.
fn decode_charset(bytes: &[u8], label: Option<&str>) -> String {
    let label = js_trim(label.filter(|label| !label.is_empty()).unwrap_or("utf8")).to_lowercase();
    let encoding = encoding_rs::Encoding::for_label_no_replacement(label.as_bytes()).unwrap_or(encoding_rs::WINDOWS_1252);
    encoding.decode_with_bom_removal(bytes).0.into_owned()
}

/// format=flowed text with its soft line breaks (a line ending in a space) joined and its space-stuffing removed.
fn unflow(text: &str, delete_space: bool) -> String {
    let mut lines = text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line));
    let mut out = lines.next().unwrap_or_default().to_owned();
    for line in lines {
        if out.ends_with(' ') && out != "-- " && !out.ends_with("\n-- ") {
            if delete_space {
                out.pop();
            }
        } else {
            out.push('\n');
        }
        out.push_str(line);
    }
    let mut unstuffed = String::with_capacity(out.len());
    let mut line_start = true;
    for c in out.chars() {
        if !(line_start && c == ' ') {
            unstuffed.push(c);
        }
        line_start = matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    }
    unstuffed
}

/// A header block's bytes as postal-mime counted them: each line without its line break, to the first empty line.
fn header_bytes(block: &[u8]) -> usize {
    header_lines(block).map(<[u8]>::len).sum()
}

fn header_lines(block: &[u8]) -> impl Iterator<Item = &[u8]> {
    block
        .split(|&byte| byte == b'\n')
        .map(|line| &line[..line.iter().rposition(|&byte| byte != b'\r').map_or(0, |at| at + 1)])
        .take_while(|line| !line.is_empty())
}

/// A header block's fields in order, as postal-mime read them: continuation lines joined to their field, whitespace
/// runs as single spaces, the name in lower case before the first colon and the value after it, both trimmed.
fn header_fields(block: &[u8], max_bytes: usize) -> Result<Vec<(String, String)>, Failure> {
    let mut size = 0;
    let mut fields: Vec<String> = Vec::new();
    for line in header_lines(block) {
        size += line.len();
        if size > max_bytes {
            return Err(Failure::Unreadable);
        }
        let line = encoding_rs::UTF_8.decode_with_bom_removal(line).0;
        match fields.last_mut() {
            Some(field) if line.starts_with(is_js_space) => {
                field.push('\n');
                field.push_str(&line);
            }
            _ => fields.push(line.into_owned()),
        }
    }
    Ok(fields
        .iter()
        .map(|field| {
            let field = collapse_whitespace(field);
            match field.split_once(':') {
                Some((name, value)) => (js_trim(name).to_lowercase(), js_trim(value).to_owned()),
                None => (js_trim(&field).to_lowercase(), String::new()),
            }
        })
        .collect())
}

/// Each run of JavaScript whitespace as one space.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

/// A header value with its encoded words decoded.
fn decode_words(value: &str) -> String {
    HeaderForm::Text.parse(value.as_bytes()).value().as_text().unwrap_or_default().to_owned()
}

/// What the raw headers declare that cannot be decoded, wherever they stand in the message: a transfer encoding other
/// than the MIME ones, an encrypted body, a charset no encoding has as its label.
fn static_abstentions(bytes: &[u8]) -> Vec<(&'static str, String)> {
    static TRANSFER_ENCODING: LazyLock<regex::bytes::Regex> = LazyLock::new(|| raw_header("content-transfer-encoding"));
    static CONTENT_TYPE: LazyLock<regex::bytes::Regex> = LazyLock::new(|| raw_header("content-type"));
    let mut abstentions = Vec::new();
    for value in raw_header_values(&TRANSFER_ENCODING, bytes) {
        let encoding = value.to_lowercase();
        if !SAFE_TRANSFER_ENCODINGS.contains(&encoding.as_str()) {
            abstain(&mut abstentions, "unsupported_encoding", encoding);
        }
    }
    for value in raw_header_values(&CONTENT_TYPE, bytes) {
        let media_type = js_trim(value.split(';').next().unwrap_or_default()).to_lowercase();
        if media_type == "application/pkcs7-mime" || media_type == "application/pgp-encrypted" {
            abstain(&mut abstentions, "encrypted", media_type);
        }
        let Some(charset) = charset_parameter(&value) else { continue };
        if encoding_rs::Encoding::for_label_no_replacement(charset.as_bytes()).is_none() {
            abstain(&mut abstentions, "unsupported_charset", charset.to_lowercase());
        }
    }
    abstentions
}

/// A header's values across the message's bytes read as Latin-1: a line starting with the header's name (any case),
/// its continuation lines unfolded, trimmed.
fn raw_header(name: &str) -> regex::bytes::Regex {
    let space = r"[\t\n\x0B\x0C\r \xA0]";
    regex::bytes::Regex::new(&format!(r"(?imR-u)^{name}{space}*:{space}*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)"))
        .expect("the raw header pattern compiles")
}

fn raw_header_values(pattern: &regex::bytes::Regex, bytes: &[u8]) -> Vec<String> {
    static FOLD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n[ \t]+").expect("the fold pattern compiles"));
    pattern
        .captures_iter(bytes)
        .filter_map(|captures| captures.get(1))
        .map(|value| {
            let latin1: String = value.as_bytes().iter().map(|&byte| char::from(byte)).collect();
            js_trim(&FOLD.replace_all(&latin1, " ")).to_owned()
        })
        .collect()
}

/// The first `charset=` parameter's value (a word boundary before it, any case, an opening quote skipped): the run of
/// characters up to a semicolon, a quote or whitespace.
fn charset_parameter(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    for start in 0..chars.len() {
        let matches_name = chars.len() >= start + 7
            && chars[start..start + 7].iter().zip("charset".chars()).all(|(c, n)| c.eq_ignore_ascii_case(&n));
        if !matches_name || (start > 0 && is_word(chars[start - 1])) {
            continue;
        }
        let mut at = start + 7;
        while at < chars.len() && is_js_space(chars[at]) {
            at += 1;
        }
        if chars.get(at) != Some(&'=') {
            continue;
        }
        at += 1;
        while at < chars.len() && is_js_space(chars[at]) {
            at += 1;
        }
        if matches!(chars.get(at), Some('"' | '\'')) {
            at += 1;
        }
        let end = (at..chars.len())
            .find(|&index| matches!(chars[index], ';' | '"' | '\'') || is_js_space(chars[index]))
            .unwrap_or(chars.len());
        if end > at {
            return Some(chars[at..end].iter().collect());
        }
    }
    None
}

/// The backend's HTML-to-text: scripts and styles removed, line breaks and block ends as newlines, other tags
/// removed, six entities decoded, trailing spaces before newlines dropped, at most one blank line in a row, trimmed.
fn html_to_text(html: &str) -> String {
    const JS_SPACE: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
    static STEPS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
        [
            (r"(?i)<(?:script(?:[^0-9A-Za-z_][\s\S]*?)?</script>|style(?:[^0-9A-Za-z_][\s\S]*?)?</style>)".to_owned(), ""),
            (format!(r"(?i)<br{JS_SPACE}*/?>"), "\n"),
            (r"(?i)</(?:p|div|tr|li|h[1-6])>".to_owned(), "\n"),
            (r"<[^>]+>".to_owned(), ""),
            (r"(?i)&nbsp;".to_owned(), " "),
            (r"(?i)&lt;".to_owned(), "<"),
            (r"(?i)&gt;".to_owned(), ">"),
            (r"(?i)&quot;".to_owned(), "\""),
            (r"(?i)&#0?39;|&apos;".to_owned(), "'"),
            (r"(?i)&amp;".to_owned(), "&"),
            (r"[ \t]+\n".to_owned(), "\n"),
            (r"\n{3,}".to_owned(), "\n\n"),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (Regex::new(&pattern).expect("the HTML pattern compiles"), replacement))
        .collect()
    });
    let mut text = html.to_owned();
    for (pattern, replacement) in STEPS.iter() {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    js_trim(&text).to_owned()
}

/// postal-mime's text-to-HTML: escaped, newlines as `<br />`, in a div.
fn text_to_html(text: &str) -> String {
    format!("<div>{}</div>", escape_html(text).replace('\n', "<br />"))
}

/// Trimmed, with `<>"'?&` as hex character references.
fn escape_html(text: &str) -> String {
    let mut out = String::new();
    for c in js_trim(text).chars() {
        if matches!(c, '<' | '>' | '"' | '\'' | '?' | '&') {
            out.push_str(&format!("&#x{:02X};", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

/// A mailbox, or a group with its mailboxes, as postal-mime's address parser gave it.
enum Addressee {
    Mailbox(Option<String>, Option<String>),
    Group(Option<String>, Vec<(Option<String>, Option<String>)>),
}

fn addressees(value: &str) -> Vec<Addressee> {
    let parsed = HeaderForm::Addresses.parse(value.as_bytes());
    let Some(list) = parsed.value().as_address() else { return Vec::new() };
    let owned = |text: Option<&str>| text.map(str::to_owned);
    list.iter()
        .map(|address| match address {
            Address::Mailbox(mailbox) => Addressee::Mailbox(owned(mailbox.name()), owned(mailbox.address())),
            Address::Group(group) => Addressee::Group(
                owned(group.name()),
                group.mailboxes().map(|mailbox| (owned(mailbox.name()), owned(mailbox.address()))).collect(),
            ),
        })
        .collect()
}

/// A forwarded message's date: none, one JavaScript could not format (which failed the parse), or a time.
enum ForwardedDate {
    None,
    Invalid,
    At(DateTime),
}

impl Forwarded {
    fn first(&self, key: &str) -> Option<&str> {
        self.headers.iter().find(|(name, _)| name == key).map(|(_, value)| value.as_str())
    }

    fn from(&self) -> Option<(Option<String>, Option<String>)> {
        let value = self.first("from").filter(|value| !value.is_empty())?;
        match addressees(value).into_iter().next()? {
            Addressee::Mailbox(name, address) => Some((name, address)),
            Addressee::Group(name, _) => Some((name, None)),
        }
    }

    fn subject(&self) -> Option<String> {
        let value = self.first("subject").filter(|value| !value.is_empty())?;
        Some(decode_words(value)).filter(|subject| !subject.is_empty())
    }

    fn date(&self) -> ForwardedDate {
        match self.first("date") {
            None | Some("") => ForwardedDate::None,
            Some(value) => {
                let parsed = HeaderForm::Date.parse(value.as_bytes());
                match parsed.value().as_datetime().filter(DateTime::is_valid) {
                    Some(date) => ForwardedDate::At(DateTime::from_timestamp(date.to_timestamp())),
                    None => ForwardedDate::Invalid,
                }
            }
        }
    }

    fn addressees(&self, key: &str) -> Vec<Addressee> {
        self.headers
            .iter()
            .filter(|(name, value)| name == key && !value.is_empty())
            .flat_map(|(_, value)| addressees(value))
            .collect()
    }

    /// postal-mime's plain-text header block: aligned rows between dashed lines.
    fn text_header(&self) -> Result<String, Failure> {
        let mut rows: Vec<(&str, String)> = Vec::new();
        if let Some((name, address)) = self.from() {
            rows.push(("From", text_address(&name, &address)));
        }
        if let Some(subject) = self.subject() {
            rows.push(("Subject", subject));
        }
        match self.date() {
            ForwardedDate::None => {}
            ForwardedDate::Invalid => return Err(Failure::Unreadable),
            ForwardedDate::At(date) => rows.push(("Date", format!("{}/{}/{}, {:02}:{:02}:{:02}",
                date.month, date.day, date.year, date.hour, date.minute, date.second))),
        }
        for (key, label) in [("to", "To"), ("cc", "Cc"), ("bcc", "Bcc")] {
            let list = self.addressees(key);
            if !list.is_empty() {
                rows.push((label, text_addresses(&list)));
            }
        }
        let widest = rows.iter().map(|(key, _)| key.len()).max().unwrap_or(0);
        let lines: Vec<String> = rows
            .iter()
            .flat_map(|(key, value)| {
                let pad = " ".repeat(widest - key.len());
                let prefix = format!("{key}: {pad}");
                let continued = format!("{} {pad}", " ".repeat(key.len() + 1));
                fold_lines(value)
                    .split('\n')
                    .map(|line| js_trim(line.strip_suffix('\r').unwrap_or(line)).to_owned())
                    .enumerate()
                    .map(|(index, line)| format!("{}{line}", if index == 0 { &prefix } else { &continued }))
                    .collect::<Vec<_>>()
            })
            .collect();
        let marker = "-".repeat(lines.iter().map(|line| line.chars().count()).max().unwrap_or(0));
        Ok(format!("\n{marker}\n{}\n{marker}\n", lines.join("\n")))
    }

    /// postal-mime's HTML header block.
    fn html_header(&self) -> Result<String, Failure> {
        let mut rows = Vec::new();
        if let Some((name, address)) = self.from() {
            rows.push(format!(
                "<div class=\"postal-email-header-key\">From</div><div class=\"postal-email-header-value\">{}</div>",
                html_address(&name, &address)?
            ));
        }
        if let Some(subject) = self.subject() {
            rows.push(format!("<div class=\"postal-email-header-key\">Subject</div><div class=\"postal-email-header-value \
                postal-email-header-subject\">{}</div>", escape_html(&subject)));
        }
        match self.date() {
            ForwardedDate::None => {}
            ForwardedDate::Invalid => return Err(Failure::Unreadable),
            ForwardedDate::At(date) => {
                let iso = format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
                    date.year, date.month, date.day, date.hour, date.minute, date.second);
                let shown = format!("{}/{}/{}, {:02}:{:02}:{:02}",
                    date.month, date.day, date.year, date.hour, date.minute, date.second);
                rows.push(format!("<div class=\"postal-email-header-key\">Date</div><div class=\"postal-email-header-value \
                    postal-email-header-date\" data-date=\"{}\">{}</div>", escape_html(&iso), escape_html(&shown)));
            }
        }
        for (key, label) in [("to", "To"), ("cc", "Cc"), ("bcc", "Bcc")] {
            let list = self.addressees(key);
            if !list.is_empty() {
                rows.push(format!("<div class=\"postal-email-header-key\">{label}</div><div \
                    class=\"postal-email-header-value\">{}</div>", html_addresses(&list)?));
            }
        }
        let (open, close) = if rows.is_empty() { ("", "") } else { ("<div class=\"postal-email-header-row\">", "</div>") };
        Ok(format!("<div class=\"postal-email-header\">{open}{}{close}</div>",
            rows.join("</div>\n<div class=\"postal-email-header-row\">")))
    }
}

/// `Name <address>`, or the address alone; JavaScript wrote a missing address as "undefined" after a name.
fn text_address(name: &Option<String>, address: &Option<String>) -> String {
    match name.as_deref().filter(|name| !name.is_empty()) {
        Some(name) => format!("{name} <{}>", address.as_deref().unwrap_or("undefined")),
        None => address.clone().unwrap_or_default(),
    }
}

fn text_addresses(list: &[Addressee]) -> String {
    let mut out = String::new();
    for (index, addressee) in list.iter().enumerate() {
        if index > 0 {
            out.push_str(", ");
        }
        match addressee {
            Addressee::Mailbox(name, address) => out.push_str(&text_address(name, address)),
            Addressee::Group(name, members) => {
                out.push_str(&format!("{}:", name.as_deref().unwrap_or_default()));
                for (member, (name, address)) in members.iter().enumerate() {
                    if member > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(&text_address(name, address));
                }
                out.push(';');
            }
        }
    }
    out
}

/// A mailto link; a mailbox without an address failed postal-mime's formatting.
fn html_address(name: &Option<String>, address: &Option<String>) -> Result<String, Failure> {
    let address = address.as_deref().ok_or(Failure::Unreadable)?;
    let shown = match name.as_deref().filter(|name| !name.is_empty()) {
        Some(name) => name.to_owned(),
        None => format!("<{address}>"),
    };
    Ok(format!("<a href=\"mailto:{}\" class=\"postal-email-address\">{}</a>", escape_html(address), escape_html(&shown)))
}

fn html_addresses(list: &[Addressee]) -> Result<String, Failure> {
    let mut parts = Vec::new();
    for (index, addressee) in list.iter().enumerate() {
        if index > 0 {
            parts.push("<span class=\"postal-email-address-separator\">, </span>".to_owned());
        }
        match addressee {
            Addressee::Mailbox(name, address) => parts.push(html_address(name, address)?),
            Addressee::Group(name, members) => {
                parts.push(format!("<span class=\"postal-email-address-group\">{}:</span>",
                    escape_html(name.as_deref().unwrap_or_default())));
                for (member, (name, address)) in members.iter().enumerate() {
                    if member > 0 {
                        parts.push("<span class=\"postal-email-address-separator\">, </span>".to_owned());
                    }
                    parts.push(html_address(name, address)?);
                }
                parts.push("<span class=\"postal-email-address-group\">;</span>".to_owned());
            }
        }
    }
    Ok(parts.join(" "))
}

/// postal-mime's line folding for header rows (80 characters, breaking after whitespace), lines joined by CRLF.
fn fold_lines(text: &str) -> String {
    const WIDTH: usize = 80;
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut at = 0;
    while at < chars.len() {
        let mut line: Vec<char> = chars[at..(at + WIDTH).min(chars.len())].to_vec();
        if line.len() < WIDTH {
            out.extend(line);
            break;
        }
        if let Some(index) = line.iter().position(|&c| c == '\n' || c == '\r') {
            let end = if line[index] == '\r' && line.get(index + 1) == Some(&'\n') { index + 2 } else { index + 1 };
            out.extend(&line[..end]);
            at += end;
            continue;
        }
        let word_start = line.iter().rposition(|&c| is_js_space(c)).map(|index| index + 1);
        match word_start {
            Some(end) => line.truncate(end),
            None => {
                let rest = &chars[at + line.len()..];
                let word = rest.iter().take_while(|&&c| !is_js_space(c)).count();
                if word > 0 {
                    let space = rest[word..].iter().take_while(|&&c| is_js_space(c)).count();
                    line.extend_from_slice(&rest[..word + space]);
                }
            }
        }
        out.extend(&line);
        at += line.len();
        if at < chars.len() {
            out.push_str("\r\n");
        }
    }
    out
}
