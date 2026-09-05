# Research workspace browser QA

ChromeDriver exercised the production app at `http://127.0.0.1:3000` with real clicks and screenshots. `stable-full-7` passed source search, file creation, panel layout controls, nested source/highlight labels, circle editing, drag/reorder, source and passage notes, passage capture, saved-source search, capture rules, collapsed receipts, exports, responsive sizing, keyboard resizing, persistence, deletion, and cleanup with no recorded failures.

The final targeted run passed after the compact rule modal fix. Its modal measured 358 px high (previously 714 px). A broad query stored 155 passages from the selected case; the collapsed source mounted no passage controls, while expansion mounted 310 label/delete controls. The temporary research file was deleted in teardown.

Evidence:

- `stable-full-7/RESULTS.json`
- `final-targeted/RESULTS.json`
- `final-targeted/02-compact-new-rule.png`
- `final-targeted/03-closed-source-lazy.png`
- `final-targeted/04-open-source-rendered.png`
