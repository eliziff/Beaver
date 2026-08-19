# Legal knowledge graph experiment

This package preserves Beaver's source-label hierarchy, evidence graph, and
source-marking prototype. It was removed from the production application on
2026-08-18 because it mounted a second project API and duplicated production
project lifecycle, validation, persistence, and deletion behavior.

The experiment contains its SQLite graph store, Express router, executable
store/router tests, and the paired React marking panel under the repository's
root `experiments/legal-knowledge-graph/frontend` directory. Production does
not import the experiment.

Promotion requires one project identity/lifecycle contract shared with the
production project application, a repository-neutral graph port, explicit
authorization tests for every graph mutation, and a single frontend project
state source. No compatibility facade should be added.
