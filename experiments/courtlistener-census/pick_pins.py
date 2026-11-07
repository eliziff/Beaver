"""A sample's pins, taken from the whole corpus's pin sheet: no pass over the dump.

    python -I pick_pins.py PINS_ALL CLUSTERS OUT
"""
import re, sys

everything, clusters, out = sys.argv[1:4]
wanted = {line.strip() for line in open(clusters, encoding="utf-8") if line.strip()}
cluster = re.compile(r'^\{"cluster":\s*"(\d+)"')
kept = 0
with open(out, "w", encoding="utf-8", newline="\n") as sheet:
    for line in open(everything, encoding="utf-8"):
        found = cluster.match(line)
        if found and found.group(1) in wanted:
            sheet.write(line)
            kept += 1
print("pins", kept)
