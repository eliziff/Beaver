"""Measure every prepared name; retain one private sample of cases without alias data."""
import argparse
from collections import Counter
from contextlib import closing
import json
from pathlib import Path
import random
import re
import statistics
import time

from lookup import lookup
from mine import data_root, normalize, readonly, words
from shortform import core, load_model


def audit(database, output, count=40):
    started = time.monotonic()
    model = load_model()
    weak = set(model["weak_heads"])
    counts, lengths = Counter(), []
    samples = {"provider": [], "external": []}
    flags = []
    rng = random.Random(71925)
    with closing(readonly(database)) as connection:
        query = """SELECT c.id,c.identity,c.provider_id,c.citation,p.style,s.shortform,s.method,s.language,p.plaintiff,p.defendant,
                    EXISTS(SELECT 1 FROM case_alias a WHERE a.case_id=c.id) AS has_alias
          FROM case_shortform s JOIN case_record c ON c.id=s.case_id
          LEFT JOIN case_profile p ON p.case_id=s.case_id AND p.language=s.language
          ORDER BY c.id,s.language"""
        for case_id, identity, provider, citation, style, name, method, language, left, right, has_alias in connection.execute(query):
            counts[method] += 1
            if method not in ("generated", "generated_edit", "generated_attested_party", "title_generated"):
                continue
            lengths.append(len(name))
            counts["generated_over_30_chars"] += int(len(name) > 30)
            counts["generated_over_45_chars"] += int(len(name) > 45)
            tokens = words(name)
            entire_party = any(normalize(core(party)) == normalize(name) for party in (left, right) if party)
            if method == "title_generated":
                title = re.sub(r"^(?:in\s+re|re)\s+", "", style, flags=re.I)
                entire_party |= normalize(core(title)) == normalize(name)
            bad = "weak_single_word" if len(tokens) == 1 and tokens[0] in weak and not entire_party else None
            if bad:
                counts["flag_" + bad] += 1
                if len(flags) < 80:
                    flags.append({"identity": identity, "style": style, "shortform": name, "reason": bad})
            if has_alias:
                continue
            group = "provider" if provider is not None else "external"
            counts[group + "_without_alias_rows"] += 1
            row = {"identity": identity, "citation": citation, "style": style, "shortform": name,
                   "method": method, "language": language}
            sample = samples[group]
            index = rng.randrange(counts[group + "_without_alias_rows"])
            if len(sample) < count:
                sample.append(row)
            elif index < count:
                sample[index] = row
        ordered = sorted(lengths)
        assert sum(counts[key] for key in ("generated", "generated_edit", "generated_attested_party", "title_generated", "observed",
                   "observed_single", "citation_fallback")) == connection.execute("SELECT count(*) FROM case_shortform").fetchone()[0]
        assert not connection.execute("SELECT 1 FROM case_shortform WHERE shortform='' LIMIT 1").fetchone(), "empty prepared name"
        named = connection.execute("SELECT count(DISTINCT case_id) FROM case_shortform WHERE method<>'citation_fallback'").fetchone()[0]
        ids = [row[0] for row in connection.execute("SELECT identity FROM case_record ORDER BY id")]
        keys = random.Random(60281).sample(ids, min(10000, len(ids)))
        lookup_started = time.monotonic()
        for key in keys:
            lookup(connection, key, top=3)
        lookup_seconds = time.monotonic() - lookup_started
    receipt = {"scope": "every prepared case/language name", "counts": dict(counts), "named_case_identities": named,
        "generated_lengths": {"rows": len(lengths), "median": statistics.median(lengths),
            "p90": ordered[int(0.9 * (len(ordered)-1))], "maximum": max(lengths)},
        "lookup": {"queries": len(keys), "elapsed_seconds": round(lookup_seconds, 4),
                   "average_ms": round(1000 * lookup_seconds / len(keys), 4)},
        "seed": 71925, "samples_without_alias_data": samples, "flagged_examples": flags,
        "elapsed_seconds": round(time.monotonic()-started, 2)}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in receipt.items() if key not in
                      ("samples_without_alias_data", "flagged_examples")}, indent=2), flush=True)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=data_root() / "cache/case-shortforms/shortforms.sqlite")
    parser.add_argument("--output", type=Path, default=Path("benchmarks/local-data/case-shortforms/quality.json"))
    parser.add_argument("--count", type=int, default=40, help="private sample rows per source group")
    args = parser.parse_args()
    audit(args.database, args.output, args.count)
