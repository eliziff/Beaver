"""Measure agreement with Kraken PAGE boxes; transcripts are human gold."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from prepare_browser_pages import normalized


def overlap(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return intersection, intersection / max(1e-9, area(a) + area(b) - intersection)


def area(box):
    return (box[2] - box[0]) * (box[3] - box[1])


def match(gold, predicted):
    pairs = sorted(((overlap(a, b)[1], i, j) for i, a in enumerate(gold) for j, b in enumerate(predicted)), reverse=True)
    used_gold, used_predicted, selected = set(), set(), []
    for iou, i, j in pairs:
        if iou < .5:
            break
        if i not in used_gold and j not in used_predicted:
            used_gold.add(i)
            used_predicted.add(j)
            selected.append((i, j))
    return selected


def distance(a, b):
    row = list(range(len(b) + 1))
    for i, char in enumerate(a):
        previous, row[0] = row[0], i + 1
        for j, other in enumerate(b):
            old = row[j + 1]
            row[j + 1] = min(row[j + 1] + 1, row[j] + 1, previous + (char != other))
            previous = old
    return row[-1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser-root", type=Path, required=True)
    args = parser.parse_args()
    inputs = args.browser_root / "inputs"
    manifest = json.loads((inputs / "manifest.json").read_text(encoding="utf-8"))
    pages = []
    for entry in manifest["pages"]:
        path = inputs / entry["xml"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == entry["xml_sha256"]
        root = ET.parse(path).getroot()
        page = next(node for node in root.iter() if node.tag.endswith("}Page"))
        width, height = int(page.get("imageWidth")), int(page.get("imageHeight"))
        lines = []
        for line in root.iter():
            if not line.tag.endswith("TextLine"):
                continue
            coords = next((node for node in line if node.tag.endswith("Coords")), None)
            text = next((node.text or "" for node in line.iter() if node.tag.endswith("Unicode")), "")
            if coords is None or not text.strip():
                continue
            points = [tuple(map(float, point.split(","))) for point in coords.get("points").split()]
            box = [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]
            order = re.search(r"readingOrder\s*\{index:(\d+)", line.get("custom", ""))
            if area(box) > 0:
                lines.append({"box": box, "text": normalized(text), "order": int(order.group(1)) if order else 10**9})
        pages.append((sorted(lines, key=lambda line: line["order"]), width, height))
    directory = args.browser_root / "latest/desktop/speed"
    results = {}
    for path in sorted(directory.glob("*/results.json")):
        receipt = json.loads(path.read_text(encoding="utf-8"))
        for model, entry in receipt["models"].items():
            totals = dict(gold_lines=0, predicted_lines=0, matched_lines=0, possible_merges=0, possible_splits=0, covered_lines_80=0, order_inversions=0, order_pairs=0, matched_text_edits=0, matched_text_characters=0)
            for (gold, width, height), timing, recognized in zip(pages, entry["runs"][0]["stages"], entry["layout_lines"], strict=True):
                sx, sy = round(width * .72) / width, round(height * .72) / height

                def box(line):
                    return [line["x"] / sx, line["y"] / sy, (line["x"] + line["width"]) / sx, (line["y"] + line["height"]) / sy]

                expected = [line["box"] for line in gold]
                predicted = [box(line) for line in timing["layout_boxes"]]
                selected = match(expected, predicted)
                totals["gold_lines"] += len(expected)
                totals["predicted_lines"] += len(predicted)
                totals["matched_lines"] += len(selected)
                totals["possible_merges"] += sum(sum(overlap(g, p)[0] / area(g) >= .5 for g in expected) >= 2 for p in predicted)
                totals["possible_splits"] += sum(sum(overlap(g, p)[0] / area(p) >= .5 for p in predicted) >= 2 for g in expected)
                for g in expected:
                    intervals = sorted((max(g[0], p[0]), min(g[2], p[2])) for p in predicted if min(g[3], p[3]) - max(g[1], p[1]) >= (g[3] - g[1]) * .5 and min(g[2], p[2]) > max(g[0], p[0]))
                    covered, end = 0, g[0]
                    for left, right in intervals:
                        covered += max(0, right - max(left, end))
                        end = max(end, right)
                    totals["covered_lines_80"] += covered >= (g[2] - g[0]) * .8
                reading_order = [i for i, _ in sorted(selected, key=lambda pair: pair[1])]
                totals["order_pairs"] += len(reading_order) * (len(reading_order) - 1) // 2
                totals["order_inversions"] += sum(a > b for i, a in enumerate(reading_order) for b in reading_order[i + 1:])
                for i, j in match(expected, [box(line) for line in recognized]):
                    reference = gold[i]["text"]
                    totals["matched_text_edits"] += distance(reference, normalized(recognized[j]["text"]))
                    totals["matched_text_characters"] += len(reference)
            totals["box_recall_iou_50"] = totals["matched_lines"] / totals["gold_lines"]
            totals["box_precision_iou_50"] = totals["matched_lines"] / max(1, totals["predicted_lines"])
            totals["line_coverage_80"] = totals["covered_lines_80"] / totals["gold_lines"]
            totals["matched_order_inversion_rate"] = totals["order_inversions"] / max(1, totals["order_pairs"])
            totals["matched_line_cer"] = totals["matched_text_edits"] / max(1, totals["matched_text_characters"])
            results[path.parent.name + "/" + model] = totals
    result = {"scope": "Agreement with Kraken-derived PAGE boxes, not independent geometry gold: AABB IoU>=0.5, greedy one-to-one matching; order among matched lines only; possible merges require visual review. Transcripts are human gold.", "scenarios": results}
    (directory / "layout-diagnostics.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
