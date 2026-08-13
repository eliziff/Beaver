# Legal structure navigation experiments

These deterministic ideas were built during retrieval research but are not on
Beaver's current tool surface: defined-term and lexical edges, page/section and
graph summaries, the legacy outline renderer, and folded/regex find variants.
They remain runnable here without enlarging production.

```powershell
npm run test:experiments -- --run experiments/legal-structure-navigation
```

Production owns the literal cross-reference graph, structural compiler, page
addressing, and canonical `Read`/`Grep` behavior. Promotion requires a measured
product benefit and moves only the winning primitive plus its behavior test.
