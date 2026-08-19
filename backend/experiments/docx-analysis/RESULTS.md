# Results

## 2026-08-18 — retained outside production

- Commit baseline: `c4b20ab3` plus the current uncommitted refactor.
- Input: the complete synthetic numbering/story suites and the DOCX pathology
  fixtures used by the shared capability-conformance suite.
- Baseline command: `npx vitest run src/lib/__tests__/docxNumbering.test.ts src/lib/__tests__/docxStories.test.ts src/lib/__tests__/docxCapabilityConformance.test.ts`.
- Baseline result: 3 files and 63 tests passed.
- Relocated command: `npx vitest run --config experiments/vitest.config.mts experiments/docx-analysis`.
- Relocated result: 3 files and 45 tests passed, including all five available
  real-corpus parity documents.
- Shared production conformance: 20 tests passed after its experimental-only
  assertions moved here.
- Boundary check: production remains one-way and every relative import resolves.
- Finding: numbering and story analysis remain complete and runnable, but no
  production module imports either implementation.
- Decision: retained as an experiment. This relocation is not a production
  line-count reduction and does not count toward Beaver's 70k target.
