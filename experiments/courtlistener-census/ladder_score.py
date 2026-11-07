"""Score each reader tier against hand labels: which keys each tier gets wrong, per tier.

    python -I ladder_score.py REFERENCE_JSON JOURNAL

REFERENCE_JSON {"labels": {key: "S" | "N"}}; the journal's agents are labelled "<model>-<effort>:<batch>".
A miss is structure read as presentation/none/unclear, or non-structure read as structure.
"""
import json
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding="utf-8")
ref = json.load(open(sys.argv[1], encoding="utf-8"))["labels"]
tiers, starts = defaultdict(dict), {}
for line in open(sys.argv[2], encoding="utf-8"):
    e = json.loads(line)
    if e.get("type") == "started":
        starts[e["agentId"]] = e["label"].split(":")[0]
    elif e.get("type") == "result" and isinstance(e.get("result"), dict):
        for lab in e["result"]["labels"]:
            tiers[starts[e["agentId"]]][lab["key"]] = lab
order = ["haiku-default", "sonnet-low", "sonnet-medium", "sonnet-high", "opus-low"]
for t in [t for t in order if t in tiers] + [t for t in tiers if t not in order]:
    got = tiers[t]
    missing = [k for k in ref if k not in got]
    misses = []
    for k, want in ref.items():
        if k in got:
            v = got[k]["verdict"]
            if (want == "S") != (v == "structure"):
                misses.append((k, want, v, got[k]["meaning"]))
    print(f"\n{t}: {len(ref) - len(missing)} of {len(ref)} reference keys labelled, {len(misses)} wrong, {len(missing)} not labelled")
    for k, want, v, m in misses:
        print(f"   {'S' if want == 'S' else 'N'} read as {v:12} {k[:60]}  | {m[:90]}")
