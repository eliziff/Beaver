# Book of Authorities ordering

Research checked on 2026-07-27.

## Finding

For a Canadian **Book of Authorities**, the defensible general default is:

1. group authorities by source type; and
2. alphabetize within each group.

This is not a universal filing rule. A court-specific profile must override the
default when that court expressly requires something else. If a user manually
assembles a book, preserve the order they chose.

Do not confuse:

- alphabetical or numerical **tab labels** with the order of the authorities;
- an alphabetical **Table of Authorities in a factum** with a separate Book of
  Authorities; or
- Alberta's current hyperlink-table practice with the conventional assembled
  Book used elsewhere.

## Evidence

- Two complete Books published on a federal government project record group
  sources and alphabetize within their groups:
  [Book 129326E](https://iaac-aeic.gc.ca/050/documents/p80054/129326E.pdf) and
  [Book 132538E](https://iaac-aeic.gc.ca/050/documents/p80054/132538E.pdf).
- A filed Supreme Court of Canada respondent factum assigns its own Book tabs
  alphabetically within source groups: *Amos* is Tab 1, *Barrie* Tab 2,
  *Citadel* Tab 3, through *Westmount* Tab 24. The paragraph references are not
  in that sequence, so this is not first-appearance order:
  [Castonguay respondent factum](https://scc-csc.ca/pdf/case-documents/34816/FM020_Respondent_Her-Majesty-the-Queen-in-Right-of-the-Province-of-Ontario-as-Represented-by-the-Minister-of-the-Environment.pdf).
- Another filed SCC reply uses Base Controls as Tab 1, then secondary sources
  Gillese, Halsbury, Oosterhoff, and Waters as Tabs 2–5. Their cited paragraph
  numbers are 7, 4, 14, 6, and 15, again disproving first-appearance order:
  [Valard reply factum](https://www.scc-csc.ca/pdf/case-documents/37272/FM015_Appellant_Valard-Construction-Ltd_Reply.pdf).
- A recent filed SCC respondent factum assigns Attorney General's Reference,
  Evans, and R v Fegan to Tabs 1–3:
  [SCC file 41320 respondent factum](https://www.scc-csc.ca/pdf/case-documents/41320/FM020_Respondent_His-Majesty-The-King.pdf).
- The Law Society of British Columbia Tribunal publishes a Book explicitly
  titled “In Alphabetical Order, by Case Title”:
  [Tribunal Book of Authorities](https://www.lsbctribunal.ca/getmedia/505a8daa-2f28-434b-8831-2d6506c59b23/tribunal_book_of_authorities_2022.pdf).
- Ontario's Court of Appeal permits numerical or alphabetical tabs and requires
  a contents table, but does not prescribe source order:
  [Ontario civil appeal practice direction](https://www.ontariocourts.ca/coa/how-to-proceed-court/practice-directions-guidelines/practice-direction-civil/).
- The Supreme Court of Canada's current guide requires one tab per authority
  and matching contents/bookmarks, but does not prescribe source order:
  [SCC filing guide](https://www.scc-csc.ca/filing-depot/guide/).
- Alberta now generally replaces a separate Book with a hyperlinked Table of
  Authorities and expressly prefers that table in first-reference order. That
  is a jurisdiction-specific exception and a different delivery model:
  [Alberta Court of Appeal guidance](https://www.albertacourts.ca/docs/default-source/ca/finding-and-providing-authorities.pdf?sfvrsn=a3952e82_5).

## Beaver decision

- Automatic Book default: cases, legislation, secondary sources, then other
  sources; alphabetical within each group.
- Automatic tab labels: numerical unless the user selects lettered tabs.
- Manual Book: preserve the user's order.
- Court profile: override only from an explicit current rule or direction.
- A future “Order” control, if exposed, should say:
  - **Alphabetical within source type (standard Book)**; or
  - **First cited in the document**.

The generator already followed this default. A focused regression test now
locks it down.
