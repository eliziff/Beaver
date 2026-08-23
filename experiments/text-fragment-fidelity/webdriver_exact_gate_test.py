#!/usr/bin/env python3
import importlib.util
from pathlib import Path


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fragment_gate", HERE / "webdriver-exact-gate.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)

page = gate.search_normalized(
    "In this Regulation les definitions suivent au présent règlement. "
    "“class A society”, in relation to a year."
)
block = "In this Regulation “ class A society ”, in relation to a year."
quote = "Regulation “ class A society ”, in relation to"
islands = gate.quote_islands([page], block, quote)
assert islands and len(islands) == 2, islands

right = "class%20A%20society%E2%80%9D%2C%20in%20relation%20to"
right_matches = gate.directive_matches([page], right)
assert len(right_matches) == 1, right_matches
assert gate.directive_matches([page], "class%20A%20society,-in%20relation%20to") == []

selected = [
    {"span": islands[0]},
    {"span": right_matches[0]},
]
assert all(gate.spans_cover(island, selected) for island in islands)
assert not gate.spans_cover(islands[0], selected[1:])

punctuated = gate.search_normalized('before words â€œtarget wordsâ€ after words')
wanted = gate.quote_islands([punctuated], 'â€œtarget wordsâ€', 'â€œtarget wordsâ€')[0]
painted = (0, wanted[1] - 1, wanted[2] + 1)
assert gate.span_stays_within_words(painted, wanted, punctuated)
assert not gate.span_stays_within_words((0, 0, wanted[2]), wanted, punctuated)

duplicate_pages = [
    gate.search_normalized('appendix A to the Sahtu Dene and Metis Agreement entered into force'),
    gate.search_normalized('(iii) the Sahtu Dene and Metis Agreement entered into force'),
]
assert gate.quote_islands(
    duplicate_pages,
    '(iii) the Sahtu Dene and Metis Agreement entered into force',
    'Sahtu Dene and Metis Agreement entered',
)[0][0] == 1

quote_proofs = [{"wordStart": 10, "wordEnd": 20}]
assert gate.range_probe_verdict(quote_proofs, [
    {"status": "matched", "wordStart": 10, "wordEnd": 15},
    {"status": "matched", "wordStart": 15, "wordEnd": 20},
]) == "range-exact"
assert gate.range_probe_verdict(quote_proofs, [
    {"status": "matched", "wordStart": 11, "wordEnd": 20},
]) == "range-partial"
assert gate.range_probe_verdict(quote_proofs, [
    {"status": "matched", "wordStart": 9, "wordEnd": 20},
]) == "range-stray"

print("strict fragment gate checks passed")
