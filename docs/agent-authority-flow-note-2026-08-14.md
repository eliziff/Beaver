# Untrusted-source tool effects
**Date found:** 2026-08-14
Beaver already plans to stop source text from authorizing tools or crossing matter boundaries (master plan P2.4).
CaMeL and FIDES add one useful implementation idea: enforce that rule in code before a tool runs, not through prompting.
Beaver already tags tools as `read`, `write`, `interactive`, or `external`; the main dispatcher does not use those tags for authorization.
If prompt injection becomes a real problem, test whether obvious external, cross-matter, and durable-write calls can be gated there.
Do not add CaMeL, FIDES, classifiers, token-level taint tracking, or a general policy framework.
Current value: minor security implementation note, not a new product capability or present priority.
