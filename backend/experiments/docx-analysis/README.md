# DOCX analysis experiment

This retained, read-only specialist surface reconstructs Word auto-numbering
and inspects body, note, header/footer, text-box, hyperlink, and revision
stories. It has no production caller. The implementation and its complete
behaviour suite therefore live here instead of enlarging Beaver's runtime.

The experiment reuses the production OOXML session/indexing kernel. The
dependency is one-way: experiments may import `src`; production and production
tests never import experiments.

Run the focused checks from `backend`:

```powershell
npx vitest run --config experiments/vitest.config.mts experiments/docx-analysis
```

Promotion requires a real product consumer. Move the required implementation
and its tests into `src` together; do not add a shim or import this directory
from production.
