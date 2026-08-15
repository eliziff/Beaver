# Deterministic library analysis experiments

These seven analyses were removed from Beaver's production assistant surface on
2026-08-14 because their model-facing workflows had no proven product caller.
Their deterministic engines remain production primitives where other verified
features use them. This adapter keeps the proposed analyses directly executable
over supplied documents without letting production code or tests import an
experiment.

Nothing in this directory is promoted. Promotion requires a concrete product
workflow and a behavioural test for that workflow; it does not require a
compatibility shim for the former `library_*` tool names.
