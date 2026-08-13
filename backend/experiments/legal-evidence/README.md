# Legal evidence experiments

This package preserves the alternative grounding and verification modes that
were developed during Beaver's legal-grounding research. It is intentionally
outside `src`: normal builds and the production test suite cannot import it.

Run it from `backend` with:

```powershell
npm run test:experiment:legal-evidence
```

The production implementation is
`src/lib/chat/legalEvidence.ts`. Experiments may import production
helpers, but production code must never import this directory.
