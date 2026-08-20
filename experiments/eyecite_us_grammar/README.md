# Eyecite US grammar integration

This experiment ports US citation grammar coverage from eyecite 2.7.8 and
reporters-db 3.2.66 into Beaver's single portable authored grammar corpus.
Eyecite and reporters-db are authoring/differential oracles only; neither is a
runtime dependency.

All long runs should execute at Windows `BelowNormal` process priority. Raw
oracle output stays under ignored `results/`; durable findings belong in
`RESULTS.md`.
