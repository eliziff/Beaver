# Document version UI QA

Runs the public version API and Library UI through a real ChromeDriver session. Use an isolated Beaver data directory; the script creates one uniquely named Markdown document and deletes that exact document with its current CAS fields.

```powershell
python experiments/document-version-ui-qa/run.py --url http://127.0.0.1:3000 --output experiments/document-version-ui-qa/results
```

The gate proves an upload and checkpoint produce three versions, preview is read-only, restoring Version 1 creates exactly one new current version, and a full reload preserves that four-version history. Screenshots, `RESULTS.json`, failure HTML, and browser logs stay in ignored `results/`.

UI contracts: primary-nav `Library`; `View <filename>`; `Document versions`; `Preview Version N: …`; and `Restore Version N as a new current version`. API contracts: `/api/single-documents`, `/versions`, `/versions/checkpoint`, `/versions/:id/restore`, and CAS-protected document deletion.
