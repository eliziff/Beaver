# Legal knowledge graph experiment

Beaver's source-label hierarchy, evidence graph, and source-marking prototype
were removed from the production application on 2026-08-18 because they mounted
a second project API and duplicated production project lifecycle, validation,
persistence, deletion, and frontend state. The unconsumed prototype and its
tests were deleted on 2026-08-28; this result is the durable record.

Promotion requires one project identity/lifecycle contract shared with the
production project application, a repository-neutral graph port, explicit
authorization tests for every graph mutation, and a single frontend project
state source. No compatibility facade should be added.
