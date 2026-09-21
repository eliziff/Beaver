# TypeSafe demo

Minimal call to the TypeSafe System One API (POST /v1/systemone,
jev-latest): one call sends the state and one question of each type
(Choice, Score, Noul) and prints the typed answers plus usage.

## Run

Requires Python 3.10+ and TYPESAFE_API_KEY in the environment (a user-level
Windows env var is already set on this machine).

    python experiments/typesafe-demo/demo.py

Optional custom state text can be passed as arguments.
