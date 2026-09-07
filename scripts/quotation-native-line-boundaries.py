from pathlib import Path
p = Path('native/legal-structure-node/src/lib.rs')
s = p.read_text()
def replace(old, new):
    global s
    assert s.count(old) == 1, old
    s = s.replace(old, new)
replace('        lines: Vec<String>,\n    }\n', '        lines: Vec<String>,\n        paragraph: Option<String>,\n    }\n')
a = s.index('    // A citation\'s printed [29]')
b = s.index('    pub struct PdfPassagePagesTask', a)
s = s[:a] + '''    // Printed paragraph numbers are addresses, not structural ordinal positions.
    // Split on the actual native lines: a prose node can contain several numbered
    // paragraphs, and one printed paragraph can contain several prose nodes.
    fn printed_paragraph_plan<'a>(
        lines: &[(&'a str, &'a str)],
        paragraphs: &[Vec<String>],
        locator: &str,
    ) -> Option<(legalpdf::PdfLookupStatus, HashSet<&'a str>)> {
        use legalpdf::PdfLookupStatus as Status;
        let labels = lines.iter().enumerate().filter_map(|(index, (_, text))| {
            let (number, rest) = text.trim_start().strip_prefix('[')?.split_once(']')?;
            if (!rest.is_empty() && !rest.starts_with(char::is_whitespace)) ||
                !number.chars().all(|c| c.is_ascii_digit()) { return None; }
            Some((number.parse::<usize>().ok()?, index))
        }).collect::<Vec<_>>();
        if labels.is_empty() { return None; }
        let range = legal_pdf_support::numeric_range("paragraph", locator)
            .or_else(|| legal_pdf_support::parse_ordinal("paragraph", locator).map(|n| (n, n)));
        let Some((from, to)) = range.filter(|(a, b)| a <= b && b - a < 100) else {
            return Some((Status::Invalid, HashSet::new()));
        };
        let mut selected = HashSet::new();
        for number in from..=to {
            let hits = labels.iter().filter(|(label, _)| *label == number).collect::<Vec<_>>();
            if hits.len() != 1 {
                return Some((if hits.is_empty() { Status::NotFound } else { Status::Ambiguous }, HashSet::new()));
            }
            let start = hits[0].1;
            if let Some((_, end)) = labels.iter().find(|(_, index)| *index > start) {
                selected.extend(lines[start..*end].iter().map(|(id, _)| *id));
            } else {
                // At EOF use the native owner, not unbounded end matter.
                let owner = paragraphs.iter().find(|ids| ids.iter().any(|id| id == lines[start].0));
                selected.extend(lines[start..].iter().filter(|(id, _)|
                    owner.is_some_and(|ids| ids.iter().any(|value| value == id))).map(|(id, _)| *id));
            }
        }
        Some((Status::Found, selected))
    }

''' + s[b:]
replace('        plans: Option<Vec<PassagePlan>>,', '        plans: Option<Vec<PassagePlan>>,\n        paragraphs: Vec<Vec<String>>,')
replace('            let targets = self\n                .plans', '''            let prose_ids = self.paragraphs.iter().flatten().map(String::as_str).collect::<HashSet<_>>();
            let prose_lines = pdf.pages.iter().flat_map(|page| page.lines.iter())
                .filter(|line| prose_ids.contains(line.id.as_str()))
                .map(|line| (line.id.as_str(), line.text.as_str())).collect::<Vec<_>>();
            let targets = self
                .plans''')
a = s.index('                    let selected = plan')
b = s.index('                    let selected_pages', a)
s = s[:a] + '''                    let printed = plan.paragraph.as_ref().and_then(|locator|
                        printed_paragraph_plan(&prose_lines, &self.paragraphs, locator));
                    let structural = printed.is_none();
                    let (status, selected) = printed.unwrap_or_else(|| (plan.status,
                        plan.lines.iter().map(String::as_str).collect::<HashSet<_>>()));
''' + s[b:]
replace('                            plan.pages.contains(&page.number)', '                            (structural && plan.pages.contains(&page.number))')
replace('serde_json::json!({ "id": plan.id, "status": plan.status, "pages": pages })', 'serde_json::json!({ "id": plan.id, "status": status, "pages": pages })')
replace('''                if target.locator_kind == "paragraph" {
                    if let Some((status, lines, pages)) = printed_paragraph_plan(document, &target.locator) {
                        return PassagePlan { id: target.id, page: false, status, pages, lines };
                    }
                }
''', '')
replace('''                    status: lookup.status,
                    pages,
                    lines,
''', '''                    status: lookup.status,
                    pages,
                    lines,
                    paragraph: (target.locator_kind == "paragraph").then_some(target.locator),
''')
replace('            plans: Some(plans),', '''            plans: Some(plans),
            paragraphs: document.structure().nodes.iter().filter(|node|
                matches!(node.kind, legal_structure::NodeKind::Prose | legal_structure::NodeKind::Heading))
                .map(|node| node.line_ids.clone()).collect(),''')
p.write_text(s)
