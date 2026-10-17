"""The canonical gold package of the records runner: one source's shared text, page geometry and
record annotation layers, each owned by the task that writes it."""
from copy import deepcopy
import hashlib
import json

VERSION = "legal-gold-package.v2"


def require(ok, message):
    if not ok:
        raise ValueError(message)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def text_identity(value):
    """Bind annotation work to the shared text, source anchors and page geometry."""
    if "lines" not in value:
        return None
    fields = ("lines", "source_text", "pages", "reading_order", "manuscript_order",
              "manuscript_separators", "manuscript_edits", "manuscript_suffix")
    facts = {key: value.get(key) for key in fields}
    if "manuscript_spans" in value: facts["manuscript_spans"] = value["manuscript_spans"]
    return hashlib.sha256(encoded(facts)).hexdigest()


def annotation_update(original, candidate, *, owned_paths, expected_source_sha256, expected_text_sha256):
    """Validate a complete annotation candidate without permitting unrelated changes."""
    require(original.get("schema_version") == candidate.get("schema_version") == VERSION,
            "Annotation updates require canonical gold")
    require(original["source_sha256"] == candidate["source_sha256"] == expected_source_sha256,
            "Annotation source changed")
    require(text_identity(original) == text_identity(candidate) == expected_text_sha256,
            "Text or source anchors changed; transcription changes require dependent annotations to be revalidated")
    paths = [tuple(path) for path in owned_paths]
    require(paths and len(set(paths)) == len(paths) and all(path and path[0] in
            {"layers", "records", "views", "form_observations"} and all(isinstance(key, str) and key for key in path)
            for path in paths), "Invalid annotation ownership")
    require(all(not (len(a) < len(b) and b[:len(a)] == a) for a in paths for b in paths),
            "Annotation ownership paths overlap")
    untouched = deepcopy(candidate)
    for path in paths:
        before, after = original, untouched
        for key in path[:-1]:
            require(isinstance(before, dict) and isinstance(after, dict) and key in before and key in after,
                    "Annotation ownership path missing")
            before, after = before[key], after[key]
        require(isinstance(before, dict) and isinstance(after, dict), "Annotation ownership must name an object field")
        if path[-1] in before:
            after[path[-1]] = deepcopy(before[path[-1]])
        else:
            after.pop(path[-1], None)
    require(untouched == original, "Annotation task changed fields it does not own")
    def owns(path):
        return any(tuple(path[:len(owned)]) == owned for owned in paths)
    def text_spans(part):
        if isinstance(part, dict):
            spans = part.get("spans")
            return isinstance(spans, list) and any(isinstance(span, dict) and "line_id" in span for span in spans) or any(
                text_spans(child) for child in part.values())
        return isinstance(part, list) and any(text_spans(child) for child in part)
    bound = any("source_anchors" in value["layers"] for value in (original, candidate))
    record_layers = ("document_classification", "information_extraction", "chronology", "exhibit_association")
    record_ids = set()
    for value in (original, candidate):
        record_ids.update(value["records"]); record_ids.update(value["views"])
        for key in record_layers: record_ids.update(value["layers"].get(key, {}))
    for rid in record_ids:
        changed = any(original[key].get(rid) != candidate[key].get(rid) for key in ("records", "views")) or any(
            original["layers"].get(key, {}).get(rid) != candidate["layers"].get(key, {}).get(rid) for key in record_layers)
        spans_changed = any(text_spans(value["records"].get(rid)) or any(
            text_spans(value["layers"].get(key, {}).get(rid)) for key in record_layers)
            for value in (original, candidate))
        if changed and (bound or spans_changed):
            require(owns(("layers", "source_anchors", "records", rid)) and "source_anchors" in candidate["layers"],
                    "Record changes must own and regenerate the affected source anchors")
    if original.get("form_observations") != candidate.get("form_observations") and (bound or any(
            text_spans(value.get("form_observations")) for value in (original, candidate))):
        require(owns(("layers", "source_anchors", "forms")) and "source_anchors" in candidate["layers"],
                "Form changes must own and regenerate their source anchors")
    validate(candidate)
    return candidate


def validate(value):
    """Validate the record annotations and their source anchors against the shared source."""
    require(value.get("schema_version") == VERSION, "Expected canonical legal gold package")
    layers = value["layers"]
    pages = [page["page"] for page in value["pages"]]
    require(all(type(page) is int and page > 0 for page in pages) and len(pages) == len(set(pages)),
            "Invalid physical page coverage")
    if "lines" not in value:
        require(not any(key in value for key in ("source_text", "reading_order", "manuscript_order",
                "manuscript_separators", "manuscript_edits", "manuscript_suffix", "manuscript_spans")),
                "Text fields require an annotated shared line table")
        require("legal_structure" not in layers and "ocr" not in layers,
                "Structure and OCR annotations require shared text")
    if "source_anchors" in value["layers"]:
        import anchors
        anchors.validate(value)
    for rid, record in value["records"].items():
        if "owner_source_sha256" not in record:
            require(record_gold(value, rid)["record_id"] == rid and
                    value["views"][rid]["source"]["source_sha256"] == value["source_sha256"],
                    "Record owner differs from its source")
    return value


def pack_records(source_sha256, records, pages=(), forms=(), provenance=None):
    """Import record facts without claiming unannotated text, structure or OCR."""
    records, pages = list(records), list(pages)
    if not pages:
        counts = {item["source"]["source_pages"] for item in records
                  if item["source"]["source_sha256"] == source_sha256}
        require(len(counts) == 1, "Record-only import needs physical source pages")
        count = counts.pop()
        require(type(count) is int and count > 0, "Invalid physical source page count")
        pages = [{"page": number} for number in range(1, count + 1)]
    result = {"schema_version": VERSION, "source_sha256": source_sha256,
        "pages": deepcopy(pages), "metadata": {},
        "layers": {key: {} for key in ("document_classification", "information_extraction",
                                       "chronology", "exhibit_association")},
        "records": {}, "views": {}, "provenance": deepcopy(provenance or {})}
    result = attach_records(result, records, forms)
    for item in records:
        if item["source"]["source_sha256"] == source_sha256:
            rid = item["gold"]["record_id"]
            require(record_gold(result, rid) == item["gold"] and
                    result["views"][rid] == {key: item[key] for key in ("source", "split")},
                    "Record facts changed during factoring")
    return validate(result)


def attach_records(value, records=(), forms=()):
    """Import complete record annotations, preserving text, OCR and structure."""
    require(value.get("schema_version") == VERSION, "Expected canonical legal gold package")
    result = deepcopy(value)
    layers = result["layers"]
    seen = set()
    for item in records:
        record = item["gold"]
        rid = record["record_id"]
        primary = item["source"]["source_sha256"]
        require(rid not in seen, "Repeated record identity")
        seen.add(rid)
        if primary != value["source_sha256"]:
            import anchors
            require(value["source_sha256"] in anchors.record_sources(item["source"]), "Record source differs")
            result["records"][rid] = {"owner_source_sha256": primary}
            continue
        result["records"][rid] = {key: deepcopy(part) for key, part in record.items() if key not in {"document_segments", "events", "exhibits"}}
        for kind in ("document_classification", "information_extraction"):
            layers[kind].pop(rid, None)
        segments = record.get("document_segments")
        if segments is not None:
            layers["document_classification"][rid] = [{key: deepcopy(part) for key, part in segment.items() if key != "standard_information"} for segment in segments]
            # An imported segment without an ID keeps a positional storage key, not an invented annotation.
            layers["information_extraction"][rid] = {segment.get("segment_id", f"/document_segments/{index}"): deepcopy(segment["standard_information"])
                for index, segment in enumerate(segments) if "standard_information" in segment}
        layers["chronology"][rid] = deepcopy(record["events"])
        layers["exhibit_association"][rid] = deepcopy(record["exhibits"])
        result["views"][rid] = {"source": deepcopy(item["source"]), "split": deepcopy(item["split"])}
    result["form_observations"] = deepcopy(list(forms))
    return result


def reading_order(value):
    require("lines" in value, "Shared text is not annotated for this Gold source")
    return value.get("reading_order", [line["id"] for line in value["lines"]])


def record_gold(value, rid):
    require("owner_source_sha256" not in value["records"][rid], "Record belongs to another source; resolve its owner_source_sha256")
    record = deepcopy(value["records"][rid])
    layers = value["layers"]
    record.update(events=deepcopy(layers["chronology"][rid]), exhibits=deepcopy(layers["exhibit_association"][rid]))
    if rid in layers["document_classification"]:
        record["document_segments"] = deepcopy(layers["document_classification"][rid])
        for index, segment in enumerate(record["document_segments"]):
            fields = layers["information_extraction"][rid]
            key = segment.get("segment_id", f"/document_segments/{index}")
            if key in fields:
                segment["standard_information"] = deepcopy(fields[key])
    return record


