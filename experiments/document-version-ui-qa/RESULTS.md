# Results

Status: **passed** on 2026-09-04 against the current document-versioning
worktree, Chrome 152.0.7977.75, and the isolated runtime at
`.tmp/version-ui-final-20260904`. The browser workflow completed in 8.00 seconds.

ChromeDriver created a Markdown document through the public API, produced three
versions, opened it through real Library clicks, keyboard-previewed Version 1,
and restored it through the confirmation UI. Restore created exactly one new
current version; a full reload retained all four versions and the restored
bytes. The run had no severe browser-console entries and deleted only its exact
test document, confirmed by a subsequent 404.

All five screenshots were inspected at their original 1440×900 resolution.
Current, historical-preview, confirmation, restored, and reloaded states were
visible and unobstructed; keyboard focus was visible on the preview and confirm
controls. Raw screenshots and `RESULTS.json` remain under ignored `results/`.
