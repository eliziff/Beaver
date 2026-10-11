"""Score existing record annotations without treating unannotated scope as negatives."""
from collections import Counter, defaultdict
import hashlib
import json
import unicodedata

from anchors import _PageMap


_MISSING = object()


def _normal(value):
    if isinstance(value, str):
        return " ".join(unicodedata.normalize("NFC", value).split())
    if isinstance(value, list):
        return [_normal(part) for part in value]
    if isinstance(value, dict):
        return {key: _normal(part) for key, part in value.items() if key != "source_locator"}
    return value


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _equal(left, right):
    return right is not _MISSING and _json(_normal(left)) == _json(_normal(right))


def _rows(value, key):
    rows = value.get(key, [])
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError(f"{key} must be an array of objects")
    return rows


def _index(rows, key):
    result = defaultdict(list)
    for index, row in enumerate(rows):
        ident = row.get(key)
        if ident is not None:
            if not isinstance(ident, str) or not ident:
                raise ValueError(f"{key} must be a nonempty string")
            result[ident].append(index)
    return result


def _pages(mapping, locator, output_file):
    if not isinstance(locator, dict):
        return None
    for key in ("source_page", "source_pages", "output_page", "output_pages"):
        if key in locator:
            numbers = locator[key] if isinstance(locator[key], list) else [locator[key]]
            if not numbers or any(type(number) is not int or number <= 0 for number in numbers):
                return None
    if "source_sha256" in locator:
        sha = locator["source_sha256"]
        numbers = locator.get("source_pages", [locator["source_page"]] if "source_page" in locator else [])
        if sha not in mapping.members or not numbers:
            return None
        pages = [(sha, number) for number in numbers]
        if "output_page" in locator or "output_pages" in locator:
            output, error = mapping.resolve({key: locator[key] for key in ("output_page", "output_pages") if key in locator}, output_file)
            if error or pages != output:
                return None
    else:
        pages, error = mapping.resolve(locator, output_file)
        if error:
            return None
    return sorted(set(pages))


def _regions(mapping, value, output_file):
    """Keep rectangles in their recorded units; qualify each page through the split."""
    key, page_key = ("source_regions", "source_page") if "source_regions" in value else ("output_regions", "output_page")
    rows = value.get(key)
    if isinstance(rows, dict):
        if any(not page.isdecimal() or not isinstance(rects, list) for page, rects in rows.items()):
            return None
        rows = [{page_key: int(page), "rect": rect} for page, rects in rows.items() for rect in rects]
    if not isinstance(rows, list):
        return None
    regions = []
    for row in rows:
        if not isinstance(row, dict):
            return None
        if key == "source_regions" and "source_sha256" in value:
            row = {**row, "source_sha256": value["source_sha256"]}
        pages = _pages(mapping, row, output_file)
        rect = row.get("rect")
        if not pages or len(pages) != 1 or not isinstance(rect, list) or len(rect) != 4 or any(type(n) not in (int, float) for n in rect):
            return None
        regions.append([*pages[0], rect])
    return sorted(regions, key=_json)


def _location(mapping, value, output_file, coordinate_system=None):
    if not isinstance(value, dict):
        return None
    output_file = value.get("output_file", output_file)
    pages = _pages(mapping, value, output_file)
    if pages is None:
        return None
    result = {"pages": pages}
    if "spans" in value:
        spans = value["spans"]
        sources = {sha for sha, _ in pages}
        if not isinstance(spans, list) or not spans or len(sources) != 1:
            return None
        previous = {}
        qualified = []
        for span in spans:
            if (not isinstance(span, dict) or set(span) != {"line_id", "start", "end"} or
                    not isinstance(span["line_id"], str) or not span["line_id"] or
                    type(span["start"]) is not int or type(span["end"]) is not int or
                    not 0 <= span["start"] < span["end"] or
                    span["start"] < previous.get(span["line_id"], 0)):
                return None
            previous[span["line_id"]] = span["end"]
            qualified.append([next(iter(sources)), span["line_id"], span["start"], span["end"]])
        result["spans"] = qualified
    if "source_regions" in value or "output_regions" in value:
        regions = _regions(mapping, value, output_file)
        if regions is None:
            return None
        result["regions"] = regions
    for key in ("cell_rects", "rect"):
        if key in value:
            result[key] = value[key]
    if any(key in result for key in ("regions", "cell_rects", "rect")):
        coordinates = value.get("coordinate_system", coordinate_system)
        if coordinates is not None:
            result["coordinate_system"] = coordinates
    return result


def _location_equal(reference, candidate):
    return candidate is not None and all(key in candidate and
                                         (_json(value) == _json(candidate[key]) if key == "spans" else _equal(value, candidate[key]))
                                         for key, value in reference.items())


def _locators(value, path=()):
    """Nested table-row locators are location evidence, not extracted field values."""
    if isinstance(value, dict):
        if "source_locator" in value:
            yield path, value["source_locator"]
        for key, part in value.items():
            if key != "source_locator":
                yield from _locators(part, path + (key,))
    elif isinstance(value, list):
        for index, part in enumerate(value):
            yield from _locators(part, path + (index,))


def compare(reference_item, predicted_record):
    """Compare document_segments against {gold, source, split} from one record.

    Segment IDs or unique physical extents establish correspondence, never labels
    or extracted values. Metrics cover explicitly annotated answers only. Extra
    segments/fields and unresolvable Gold locations remain reported but unscored.
    Values retain JSON types, list order, case, punctuation and every date/phone
    digit; only Unicode NFC and whitespace are normalized. Locations use original
    PDF identities; supplied corrected-line spans use exact Unicode scalar bounds,
    and regions/cells retain their recorded coordinate units. Page-only Gold does
    not require a candidate to invent precise evidence.
    """
    gold = reference_item["gold"]
    if not isinstance(predicted_record, dict):
        raise ValueError("Record prediction must be an object")
    mapping = _PageMap(reference_item["source"], reference_item["split"])
    reference = _rows(gold, "document_segments")
    predicted = _rows(predicted_record, "document_segments")
    for rows in (reference, predicted):
        _index(rows, "segment_id")
    locations = [[_location(mapping, row, row.get("output_file")) for row in rows]
                 for rows in (reference, predicted)]
    pairs, used = {}, set()
    alignment = Counter()
    for method in ("segment_id", "source_extent"):
        groups = []
        for side, rows in enumerate((reference, predicted)):
            group = defaultdict(list)
            for index, row in enumerate(rows):
                if index in (pairs if side == 0 else used):
                    continue
                key = row.get("segment_id") if method == "segment_id" else locations[side][index]
                if key is not None:
                    group[_json(key)].append(index)
            groups.append(group)
        for key in groups[0].keys() & groups[1].keys():
            if len(groups[0][key]) == len(groups[1][key]) == 1:
                left, right = groups[0][key][0], groups[1][key][0]
                pairs[left] = right
                used.add(right)
                alignment[method] += 1
    counts = {name: Counter(expected=0, predicted=0, correct=0) for name in
              ("document_type", "form_id", "role", "segment_location", "information_value",
               "information_status", "information_location")}
    coverage = Counter(reference_segments=len(reference), predicted_segments=len(predicted),
                       matched_segments=len(pairs), unmatched_reference_segments=len(reference) - len(pairs),
                       unscored_predicted_segments=len(predicted) - len(used))

    def add(name, expected, actual=_MISSING, equal=None):
        counts[name]["expected"] += 1
        counts[name]["predicted"] += actual is not _MISSING
        counts[name]["correct"] += (equal if equal is not None else _equal(expected, actual))

    def add_location(name, expected, actual, output, predicted_output, coordinates=None, predicted_coordinates=None):
        expected_location = _location(mapping, expected, output, coordinates)
        if expected_location is None:
            coverage["unresolved_reference_locations"] += 1
            return
        actual_location = _location(mapping, actual, predicted_output, predicted_coordinates) if actual is not _MISSING else None
        add(name, expected_location, actual, _location_equal(expected_location, actual_location))
        if actual is not _MISSING and actual_location is None:
            coverage["unresolved_predicted_locations"] += 1

    for index, segment in enumerate(reference):
        candidate = predicted[pairs[index]] if index in pairs else {}
        for name in ("document_type", "form_id", "role"):
            if name in segment:
                add(name, segment[name], candidate.get(name, _MISSING))
        add_location("segment_location", segment, candidate if candidate else _MISSING,
                     segment.get("output_file"), candidate.get("output_file"))
        fields, candidate_fields = _rows(segment, "standard_information"), _rows(candidate, "standard_information")
        field_indices, candidate_indices = _index(fields, "field"), _index(candidate_fields, "field")
        if len(field_indices) != len(fields) or any(len(indices) != 1 for indices in field_indices.values()):
            raise ValueError("Gold standard_information must have unique field names")
        if len(candidate_indices) != len(candidate_fields):
            raise ValueError("Predicted standard_information must have unique field names")
        coverage["segments_with_information"] += bool(fields)
        coverage["unscored_predicted_fields"] += sum(len(indices) for name, indices in candidate_indices.items() if name not in field_indices)
        for name, indices in field_indices.items():
            field = fields[indices[0]]
            matching = candidate_indices.get(name, [])
            predicted_field = candidate_fields[matching[0]] if len(matching) == 1 else {}
            if "value" in field:
                add("information_value", field["value"], predicted_field.get("value", _MISSING))
            for key in ("value_status", "status"):
                if key in field:
                    add("information_status", field[key], predicted_field.get(key, _MISSING))
            candidate_locators = dict(_locators(predicted_field))
            for path, locator in _locators(field):
                add_location("information_location", locator, candidate_locators.get(path, _MISSING),
                             segment.get("output_file"), candidate.get("output_file"),
                             segment.get("coordinate_system"), candidate.get("coordinate_system"))
    metrics = {}
    for name, count in counts.items():
        expected, provided, correct = count["expected"], count["predicted"], count["correct"]
        metrics[name] = {**count, "precision": correct / provided if provided else None,
                         "recall": correct / expected if expected else None,
                         "f1": 2 * correct / (expected + provided) if expected + provided else None}
    return {"record_id": gold["record_id"], "reference_sha256": {
                key: hashlib.sha256(_json(reference_item[key]).encode()).hexdigest() for key in ("gold", "source", "split")},
            "metrics": metrics, "coverage": dict(coverage), "alignment": dict(alignment),
            "scope": "Annotated segments and fields only; unmatched predictions are unscored, not negative ground truth."}
