import hashlib
from pathlib import Path
from run import split

assert hashlib.sha256(Path(__file__).with_name("deterministic_splitter.py").read_bytes()).hexdigest() == "6fd2abf4d7e9d4eaeba779832bfa149001b893355f4e27a0d7efc5722198154e"
cases = [
    ('Jane Doe, "A Title; With a Subtitle" (2020) 1 Queen\'s LJ 10; commentary; R v Oakes, [1986] 1 SCR 103.', 4),
    ('Johnson, supra note 243 at para 19 citing Lyons, supra note 243 at page 339.', 2),
    ('Groia v Law Society, 2018 SCC 27, [2018] 1 SCR 772 at paras 64–67.', 1),
    ('🦫 R v First, 2020 SCC 1 aff’d R v Second, 2021 SCC 2.', 2),
]
for text, count in cases:
    result = split(text)
    assert len(result["parts"]) == count, result
    pieces = [(part["start"], part["text"]) for part in result["parts"]]
    pieces += [(start, value) for start, _, value in result["delimiters"]]
    assert "".join(value for _, value in sorted(pieces)) == text
    encoded = text.encode("utf-16-le")
    for part in result["parts"]:
        assert encoded[part["start"] * 2:part["end"] * 2].decode("utf-16-le") == part["text"]
print("Pinned upstream free-mode splitter: four parity cases passed")
