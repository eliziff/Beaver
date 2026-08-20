# Experiments

Standalone and corpus-scale experiments live here. Backend-coupled experiments
live in `backend/experiments`, where they can use the backend toolchain without
entering the production build.

The dependency direction is one-way: experiments may use production
primitives; production may never import experiments. Keep each experiment's
code, checks, and run instructions together. Raw `results/` and `receipts/` are
local artifacts; preserve durable conclusions in that experiment's
`RESULTS.md` with the commit, input/corpus, command, metric, and decision.

`npm run check:source-boundaries` verifies that boundary, keeps deployment
choices out of feature code, and catches stale relative imports after moves.
