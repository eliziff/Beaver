"""One line table, independent annotation layers, and reproducible consumer views."""
from copy import deepcopy
from datetime import datetime, timezone
import difflib
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import ocr

VERSION = "legal-gold-package.v2"
PAGE_NS = "http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15"
DEFAULTS = {"schema_version": "legal-structure-gold.v3", "offset_unit": "utf16",
            "source_character_unit": "unicode_scalar", "coordinates": "visible-page-top-left-1000"}
CORE = {"structure", "source_trace", "reading_order", "blocks", "joins", "continuations", "resumes", "operations", "provenance", "source_sha256", "ocr"}


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
    return hashlib.sha256(encoded({key: value.get(key) for key in fields})).hexdigest()


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


def correct_text(value, edits, *, expected_source_sha256, expected_text_sha256):
    """Apply exact scalar edits; preserve witnesses and reject ambiguous annotation remapping."""
    from gold import changed_offset
    require(value.get("schema_version") == VERSION and "lines" in value,
            "Transcription correction requires canonical shared text")
    require(value["source_sha256"] == expected_source_sha256 and text_identity(value) == expected_text_sha256,
            "Transcription input changed")
    validate(value)
    before = line_table(value)
    changes = {}
    require(isinstance(edits, list) and edits, "Transcription needs exact edits")
    for edit in edits:
        require(isinstance(edit, dict) and set(edit) == {"line_id", "start", "end", "old", "text"},
                "Invalid transcription edit")
        ident, start, end = edit["line_id"], edit["start"], edit["end"]
        require(ident in before and type(start) is int and type(end) is int and
                0 <= start <= end <= len(before[ident]["text"]) and isinstance(edit["text"], str) and
                edit["old"] == before[ident]["text"][start:end] and edit["old"] != edit["text"],
                "Transcription edit does not match its exact source text")
        changes.setdefault(ident, []).append(edit)
    result = deepcopy(value)
    after = {line["id"]: line for line in result["lines"]}
    for ident, ordered in changes.items():
        ordered.sort(key=lambda edit: (edit["start"], edit["end"]))
        require(all(a["end"] <= b["start"] and a["start"] != b["start"] for a,b in zip(ordered, ordered[1:])),
                "Transcription edits overlap")
        source = before[ident].get("source_id") or ident
        if source not in result["source_text"]:
            result["source_text"][source] = before[ident]["original_text"]
        for edit in reversed(ordered):
            text = after[ident]["text"]
            after[ident]["text"] = text[:edit["start"]] + edit["text"] + text[edit["end"]:]
        require(after[ident]["text"].strip(), "Transcription cannot erase a retained line")

    def interval(ident, start, end):
        ordered = changes.get(ident, [])
        for edit in ordered:
            a,b = edit["start"], edit["end"]
            require(not (a < start < b or a < end < b or a == b and a in (start, end)),
                    "Transcription crosses an annotation boundary; revise that annotation explicitly")
        start, end = changed_offset(start, ordered), changed_offset(end, ordered, True)
        require(start < end, "Transcription erases an annotation; revise that annotation explicitly")
        return start,end

    def remap(part, *, evidence=False):
        if isinstance(part, list):
            return [remap(item, evidence=evidence) for item in part]
        if isinstance(part, dict):
            if set(part) == {"line_id", "start", "end"} and part["line_id"] in changes:
                ident = part["line_id"]
                start,end = interval(ident, part["start"], part["end"])
                if evidence:
                    require(before[ident]["text"][part["start"]:part["end"]] == after[ident]["text"][start:end],
                            "Transcription changes record evidence; revalidate the extracted fact explicitly")
                return {**part, "start": start, "end": end}
            return {key: remap(item, evidence=evidence) for key,item in part.items()}
        return part

    for ident in changes:
        line = after[ident]
        for key in ("spans", "words"):
            for span in line.get(key, []):
                span["start"],span["end"] = interval(ident, span["start"], span["end"])
                if "text" in span: span["text"] = line["text"][span["start"]:span["end"]]
        for edit in result["manuscript_edits"].get(ident, []):
            start,end,_ = edit
            require(all(end < change["start"] or start > change["end"] for change in changes[ident]),
                    "Transcription overlaps manuscript normalization; revise it explicitly")
            edit[0],edit[1] = changed_offset(start, changes[ident]), changed_offset(end, changes[ident], True)
    if "legal_structure" in result["layers"]:
        result["layers"]["legal_structure"] = remap(result["layers"]["legal_structure"])

    def locators(part):
        if isinstance(part, list):
            for item in part: locators(item)
        elif isinstance(part, dict):
            locator = part.get("source_locator")
            if isinstance(locator, dict) and locator.get("spans"):
                require(locator.get("source_sha256"), "Precise record evidence needs its source identity")
                if locator["source_sha256"] == result["source_sha256"]:
                    locator["spans"] = remap(locator["spans"], evidence=True)
            for key,item in part.items():
                if key != "source_locator": locators(item)
    locators(result["records"])
    for name in ("document_classification", "information_extraction", "chronology", "exhibit_association"):
        locators(result["layers"].get(name, {}))
    if "source_anchors" in result["layers"]:
        import anchors
        layer = remap(result["layers"]["source_anchors"], evidence=True)
        layer["text_sha256"] = anchors.text_identity(result)
        for rid, anchored in layer["records"].items():
            if anchored["owner_source_sha256"] == result["source_sha256"]:
                item = {"gold": record_gold(result, rid), **result["views"][rid]}
                anchored["inputs_sha256"] = hashlib.sha256(encoded(item)).hexdigest()
        result["layers"]["source_anchors"] = layer
    result["metadata"]["manuscript_sha256"] = hashlib.sha256(manuscript_text(result).encode()).hexdigest()
    validate(result)
    return result


def validate(value):
    """Validate the current annotations directly against their shared source table."""
    require(value.get("schema_version") == VERSION, "Expected canonical legal gold package")
    layers = value["layers"]
    pages = [page["page"] for page in value["pages"]]
    require(all(type(page) is int and page > 0 for page in pages) and len(pages) == len(set(pages)),
            "Invalid physical page coverage")
    if "lines" not in value:
        require(not any(key in value for key in ("source_text", "reading_order", "manuscript_order",
                "manuscript_separators", "manuscript_edits", "manuscript_suffix")),
                "Text fields require an annotated shared line table")
        require("legal_structure" not in layers and "ocr" not in layers,
                "Structure and OCR annotations require shared text")
    units = line_table(value) if "lines" in value else {}
    def spans(item):
        if isinstance(item, dict):
            if "line_id" in item:
                require(item["line_id"] in units and type(item.get("start")) is int and type(item.get("end")) is int and
                        0 <= item["start"] < item["end"] <= len(units[item["line_id"]]["text"]),
                        "Structural span outside corrected source")
            for part in item.values(): spans(part)
        elif isinstance(item, list):
            for part in item: spans(part)
    if "legal_structure" in layers:
        from worker import gold
        state = structure_state(value)
        spans(layers["legal_structure"])
        gold.complete(state)
        gold.ownership(state)
    if "ocr" in value["layers"]:
        layer = value["layers"]["ocr"]
        pages = layer["pages"]
        require(len(pages) == len(value["pages"]) and {page["page"] for page in pages} ==
                {page["page"] for page in value["pages"]}, "OCR physical page coverage differs")
        for page in pages:
            ocr.validate_page(page, units, layer["ontology"]["labels"])
    if "source_anchors" in value["layers"]:
        import anchors
        anchors.validate(value)
    for rid, record in value["records"].items():
        if "owner_source_sha256" not in record:
            require(record_gold(value, rid)["record_id"] == rid and
                    value["views"][rid]["source"]["source_sha256"] == value["source_sha256"],
                    "Record owner differs from its source")
    return value


def u16slice(text, start, end):
    return text.encode("utf-16-le")[2*start:2*end].decode("utf-16-le")


def utf16(text):
    return len(text.encode("utf-16-le")) // 2


def unproject(item, lines):
    if isinstance(item, dict):
        if "line_id" in item and "range" in item:
            line = lines[item["line_id"]]
            a, b = (item["range"][key] - line["range"]["start"] for key in ("start", "end"))
            require(0 <= a <= b <= utf16(line["text"]), "Annotation outside printed line")
            return {"line_id": line["id"], "start": len(u16slice(line["text"], 0, a)),
                    "end": len(u16slice(line["text"], 0, b))}
        return {key: unproject(part, lines) for key, part in item.items()}
    if isinstance(item, list):
        return [unproject(part, lines) for part in item]
    return item


def pack(value, records=(), pages=(), forms=()):
    """Factor completed parser gold; association facts keep their own layer owners."""
    require(value.get("schema_version") == DEFAULTS["schema_version"], "Expected completed structure gold")
    structure = value["structure"]
    printed, manuscript = structure["text"], structure["rendered_text"]
    original_lines = {line["id"]: line for line in value["source_trace"]}
    annotations = unproject(structure["annotations"], original_lines)
    for annotation in annotations:
        annotation.pop("document_id", None)
        if annotation.get("fragment_ids") == [annotation["id"]]:
            annotation.pop("fragment_ids")
        if annotation.get("spans") == [{"line_id": ident, "start": 0, "end": len(original_lines[ident]["text"])} for ident in annotation["line_ids"]]:
            annotation.pop("spans")
    lines = []
    source_text = {}
    for original in value["source_trace"]:
        line = deepcopy(original)
        witness = line.pop("original_text")
        if witness != line["text"] or line.get("source_range") not in (None, [0, len(witness)]):
            ident = line.get("source_id") or line["id"]
            require(ident not in source_text or source_text[ident] == witness, "Source witness differs")
            source_text[ident] = witness
        if line.get("source_id") == line["id"]:
            line.pop("source_id")
        if line.get("source_range") == [0, len(witness)]:
            line.pop("source_range")
        lines.append(line)
    by_id = {line["id"]: line for line in lines}
    require(len(by_id) == len(lines) == len(value["reading_order"]) and set(by_id) == set(value["reading_order"]), "Line coverage differs")
    manuscript_order = sorted(value["reading_order"], key=lambda ident: (by_id[ident]["rendered_range"]["start"], by_id[ident]["rendered_range"]["end"]))
    separators, manuscript_edits = {}, {}
    end = 0
    for index, ident in enumerate(manuscript_order):
        line = by_id[ident]
        begin, stop = (line["rendered_range"][key] for key in ("start", "end"))
        require(begin >= end and stop >= begin, "Manuscript line anchors overlap")
        logical = u16slice(manuscript, begin, stop)
        if logical != line["text"]:
            manuscript_edits[ident] = [[a,b,logical[c:d]] for op,a,b,c,d in difflib.SequenceMatcher(None,line["text"],logical,autojunk=False).get_opcodes() if op != "equal"]
        separator = u16slice(manuscript, end, begin)
        if separator != ("" if index == 0 else " "):
            separators[ident] = separator
        end = stop
    for line in lines:
        line.pop("range")
        line.pop("rendered_range")
    geometry = {page["page"]: deepcopy(page) for page in pages}
    physical_pages = [node["page_indexes"][0]+1 for node in structure["nodes"] if node["kind"] == "page"]
    require(len(set(physical_pages)) == len(physical_pages) and set(geometry) <= set(physical_pages), "Physical page coverage differs")
    layers = {"legal_structure": {"annotations": annotations,
        **{key: deepcopy(value[key]) for key in ("blocks", "joins", "continuations", "resumes")}},
        "document_classification": {}, "information_extraction": {}, "chronology": {}, "exhibit_association": {}}
    if "ocr" in value:
        layers["ocr"] = ocr.compact(value["ocr"], original_lines)
    result = {"schema_version": VERSION,
        "metadata": {key: deepcopy(part) for key, part in value.items() if key not in CORE and (key not in DEFAULTS or DEFAULTS[key] != part)},
        "source_sha256": value["source_sha256"], "pages": [geometry.get(number, {"page": number}) for number in physical_pages],
        "lines": lines, "source_text": source_text,
        "manuscript_separators": separators, "manuscript_edits": manuscript_edits,
        "manuscript_suffix": u16slice(manuscript, end, len(manuscript.encode("utf-16-le"))//2),
        "layers": layers, "records": {}, "views": {}, "provenance": deepcopy(value["provenance"])}
    result = attach_records(result, records, forms)
    if value["reading_order"] != [line["id"] for line in lines]: result["reading_order"] = deepcopy(value["reading_order"])
    if manuscript_order != value["reading_order"]: result["manuscript_order"] = manuscript_order
    require(printed_text(result) == printed and manuscript_text(result) == manuscript, "Text view changed during factoring")
    require(list(line_table(result).values()) == value["source_trace"], "Line anchors changed during factoring")
    return result


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


def line_table(value):
    require(value.get("schema_version") == VERSION, "Expected canonical legal gold package")
    require("lines" in value, "Shared text is not annotated for this Gold source")
    result = {}
    for original in value["lines"]:
        line = deepcopy(original)
        line.setdefault("source_id", line["id"])
        line["original_text"] = value["source_text"].get(line["source_id"] or line["id"], line["text"])
        line.setdefault("source_range", [0, len(line["original_text"])])
        require(line["id"] not in result, "Duplicate line ID")
        result[line["id"]] = line
    order = reading_order(value)
    require(len(result) == len(order) and set(result) == set(order), "Reading-order coverage differs")
    cursor = 0
    seen = set()
    for page in value["pages"]:
        require(page["page"] not in seen, "Duplicate physical page")
        seen.add(page["page"])
        ids = [ident for ident in order if result[ident]["page"] == page["page"]]
        for ident in ids:
            line = result[ident]
            line["range"] = {"start": cursor, "end": cursor+utf16(line["text"])}
            cursor += utf16(line["text"])+1
        if not ids: cursor += 1
    require({line["page"] for line in result.values()} <= seen, "Line has no physical page")
    manuscript_order = value.get("manuscript_order", order)
    require(len(manuscript_order) == len(result) and set(manuscript_order) == set(result), "Manuscript-order coverage differs")
    cursor = 0
    for index, ident in enumerate(manuscript_order):
        cursor += utf16(value["manuscript_separators"].get(ident, "" if index == 0 else " "))
        length = utf16(logical_text(value, result[ident]))
        result[ident]["rendered_range"] = {"start": cursor, "end": cursor+length}
        cursor += length
    return result


def reading_order(value):
    require("lines" in value, "Shared text is not annotated for this Gold source")
    return value.get("reading_order", [line["id"] for line in value["lines"]])


def logical_text(value, line):
    text = line["text"]
    for start,end,replacement in reversed(value["manuscript_edits"].get(line["id"],[])):
        text = text[:start] + replacement + text[end:]
    return text


def printed_text(value):
    lines = line_table(value)
    return "\n".join("\n".join(lines[ident]["text"] for ident in reading_order(value) if lines[ident]["page"] == page["page"])
        for page in value["pages"])


def manuscript_text(value):
    lines = line_table(value)
    order = value.get("manuscript_order",reading_order(value))
    return "".join(value["manuscript_separators"].get(ident, "" if index == 0 else " ") + logical_text(value, lines[ident])
        for index, ident in enumerate(order)) + value["manuscript_suffix"]


def structure_state(value):
    """Authoritative answers for scoring; no graph builder or export history."""
    require("legal_structure" in value["layers"], "Legal structure is not annotated for this Gold source")
    layers = value["layers"]["legal_structure"]
    lines = line_table(value)
    annotations = deepcopy(layers["annotations"])
    for annotation in annotations:
        annotation.setdefault("spans", [{"line_id": ident, "start": 0, "end": len(lines[ident]["text"])} for ident in annotation["line_ids"]])
    return {"lines": list(lines.values()), "reading_order": reading_order(value), "groups": deepcopy(layers["blocks"]),
            "annotations": annotations, **{key: deepcopy(layers[key]) for key in ("joins", "continuations", "resumes")}}


def parser_view(value):
    """Derive a disposable graph from fixed annotations, independent of authoring history."""
    require("legal_structure" in value["layers"], "Legal structure is not annotated for this Gold source")
    from worker import gold
    lines = line_table(value)
    fragments = {}
    fragment_ids = set(lines)
    for ident, line in lines.items():
        parts = []; offset = 0
        for index, text in enumerate(line["text"].split("\n")):
            child = ident if index == 0 else gold.stable_id("printed", [ident, index])
            require(index == 0 or child not in fragment_ids, "Export fragment identity collision")
            fragment_ids.add(child)
            stop = offset + utf16(text)
            parts.append((child, offset, stop)); offset = stop + 1
        fragments[ident] = parts
    pages = []
    cursor = 0
    for page in value["pages"]:
        ids = [ident for ident in reading_order(value) if lines[ident]["page"] == page["page"]]
        length = utf16("\n".join(lines[ident]["text"] for ident in ids))
        pages.append({"id": f"page-{page['page']}", "kind": "page", "page_indexes": [page["page"]-1],
                      "origin_id": "legal-gold", "line_ids": [child for ident in ids for child,_,_ in fragments[ident]],
                      "range": {"start": cursor, "end": cursor+length}})
        cursor += length+1
    basis = {"schema_version": "legalpdf.document-structure.v1", "document_id": value["source_sha256"],
             "provider": "legal-gold", "scope": {"kind": "complete"}, "origins": [{"id": "legal-gold"}],
             "diagnostics": [], "source_sha256": value["source_sha256"], "offset_unit": "utf16",
             "text": printed_text(value), "nodes": pages}
    state = {**structure_state(value), "native_nodes": [], "removed_nodes": [], "operations": []}
    _, result = gold.materialize(basis, state, deepcopy(value["provenance"]))
    structure = result["structure"]
    def project(item):
        if isinstance(item, dict):
            if "line_id" in item and "range" in item and "rendered_range" in item:
                line = lines[item["line_id"]]
                logical = logical_text(value, line)
                changes = [{"start": a, "end": b, "text": text} for a,b,text in value["manuscript_edits"].get(line["id"], [])]
                extent = {}
                for key in ("start", "end"):
                    point = len(u16slice(line["text"], 0, item["range"][key]-line["range"]["start"]))
                    offset = gold.changed_offset(point, changes, key == "end")
                    extent[key] = line["rendered_range"]["start"] + utf16(logical[:offset])
                return {**item, "rendered_range": extent}
            return {key: project(part) for key, part in item.items()}
        if isinstance(item, list): return [project(part) for part in item]
        return item
    structure = project(structure)
    for node in structure["nodes"]:
        if node["kind"] == "page":
            node["rendered_ranges"] = [lines[ident]["rendered_range"] for ident in node["line_ids"]]
        elif "rendered_range" in node and node.get("line_ids"):
            node["rendered_range"] = {"start": min(lines[ident]["rendered_range"]["start"] for ident in node["line_ids"]),
                                      "end": max(lines[ident]["rendered_range"]["end"] for ident in node["line_ids"])}
    if any(len(parts) > 1 for parts in fragments.values()):
        # Native graph pages name newline-delimited fragments. Gold keeps its legal
        # units intact; only this disposable view expands memberships and span refs.
        rendered = {}
        for ident, parts in fragments.items():
            for child,start,end in parts:
                extent = {"start": lines[ident]["range"]["start"]+start, "end": lines[ident]["range"]["start"]+end}
                rendered[child] = project({"line_id": ident, "range": extent, "rendered_range": {}})["rendered_range"]
        def expand(item):
            if isinstance(item, list):
                return [piece for value in item for piece in (expand(value) if isinstance(value, dict) and
                    "line_id" in value and "range" in value else [expand(value)])]
            if isinstance(item, dict):
                if "line_id" in item and "range" in item:
                    ident = item["line_id"]; result = []
                    for child,start,end in fragments[ident]:
                        a = max(item["range"]["start"], lines[ident]["range"]["start"]+start)
                        b = min(item["range"]["end"], lines[ident]["range"]["start"]+end)
                        if a >= b: continue
                        piece = project({**item, "range": {"start": a, "end": b}})
                        piece["line_id"] = child
                        if "line_ids" in piece: piece["line_ids"] = [child]
                        result.append(piece)
                    return result
                return {key: [child for ident in value for child,_,_ in fragments[ident]] if key in
                        {"line_ids", "owned_line_ids"} else expand(value) for key,value in item.items()}
            return item
        structure = expand(structure)
        for node in structure["nodes"]:
            if node["kind"] == "page": node["rendered_ranges"] = [rendered[ident] for ident in node["line_ids"]]
    structure.update(text=printed_text(value), rendered_text=manuscript_text(value))
    structure["text_sha256"] = hashlib.sha256(structure["text"].encode()).hexdigest()
    structure["revision"] = hashlib.sha256(structure["rendered_text"].encode()).hexdigest()
    return structure


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


def ocr_pages(value, pdf):
    """Original-page targets preserve source units, furniture and printed errors."""
    require("lines" in value, "OCR targets are unavailable: shared text is not annotated for this Gold source")
    require(hashlib.sha256(Path(pdf).read_bytes()).hexdigest() == value["source_sha256"], "OCR PDF source differs")
    lines = line_table(value)
    pages = {page["page"]: page for page in value["pages"]}
    physical = {p["page"]: p for p in value["layers"].get("ocr", {}).get("pages", [])}
    require(not physical or set(physical) == set(pages), "OCR physical page coverage differs")
    result = []
    for number in pages:
        require(number in pages, "Physical page geometry missing")
        page_lines = [lines[ident] for ident in reading_order(value) if lines[ident]["page"] == number]
        extra = {}
        if physical:
            target = physical[number]
            ocr.validate_page(target, lines, value["layers"]["ocr"]["ontology"]["labels"])
            page_lines = [{**deepcopy(line), "page": number, "text": ocr.text(line, lines), "box": ocr.box(line["boundary"]) if line["boundary"] else []} for line in target["lines"]]
            extra = {"regions": deepcopy(target["regions"]), "coverage": deepcopy(target["coverage"]),
                     "training_eligible": {task: target["coverage"][task] == "complete" for task in ocr.TASKS},
                     "ontology": value["layers"]["ocr"]["ontology"]["sha256"]}
        require(all(line["page"] == number for line in page_lines), "OCR line belongs to another physical page")
        result.append({"source_sha256": value["source_sha256"], "pdf_page": number,
            "image_filename": f"page-{number:06}.png", "text": "\n".join(line["text"] for line in page_lines),
            "lines": page_lines, **pages[number], "source_view": "original",
            "transcription_status": "automated_page_annotation", "segmentation_training_eligible": bool(physical) and extra["training_eligible"]["segmentation"] and extra["training_eligible"]["regions"], **extra})
    return result


def pixel_box(line, width, height):
    box = line.get("box", [])
    require(len(box) == 4 and 0 <= box[0] < box[2] <= 1000 and 0 <= box[1] < box[3] <= 1000, "Line geometry missing or invalid")
    result = [round(point*(width if i%2==0 else height)/1000) for i,point in enumerate(box)]
    require(result[0] < result[2] and result[1] < result[3], "Line geometry collapses at export resolution")
    return result


def pixel_coordinates(points, width, height, minimum):
    rounded = [(round(x*width/1000), round(y*height/1000)) for x,y in points]
    if len(set(rounded)) < minimum:
        return None
    if minimum == 3 and not sum(x*y2-x2*y for (x,y),(x2,y2) in zip(rounded, rounded[1:]+rounded[:1])):
        return None
    return " ".join(f"{x},{y}" for x,y in rounded)


def export_files(out, source):
    """Files owned by this source's last export, for removing stale targets."""
    result = {}
    records = out/"records.jsonl"
    if records.is_file():
        result[records] = hashlib.sha256(records.read_bytes()).hexdigest()
        for row in map(json.loads, records.read_text(encoding="utf-8").splitlines()):
            require(row["source_sha256"] == source, "Export destination belongs to another source")
            name = f"page-{row['pdf_page']:06}.png"
            require(row["image_filename"] == name, "Invalid previous export image locator")
            for suffix,key in ((".png","image_sha256"),(".txt","text_sha256"),(".xml","pagexml_sha256")):
                if key in row: result[(out/name).with_suffix(suffix)] = row[key]
    lines = out/"lines.jsonl"
    if lines.is_file():
        result[lines] = hashlib.sha256(lines.read_bytes()).hexdigest()
        for row in map(json.loads, lines.read_text(encoding="utf-8").splitlines()):
            require(row["source_sha256"] == source, "Line export belongs to another source")
            for key in ("image", "transcription"):
                path = out/row[key]
                require(not Path(row[key]).is_absolute() and path.resolve().is_relative_to(out.resolve()), "Line export locator escapes destination")
                result[path] = row["image_sha256" if key == "image" else "text_sha256"]
    return result


def export_ocr(value, pdf, out, dpi=300, pagexml=False, line_crops=False):
    """Render exact source images and explicit recognition targets; no inferred baselines."""
    import fitz
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    rows = ocr_pages(value, pdf)
    previous = export_files(out, value["source_sha256"])
    require(all(not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() == digest for path,digest in previous.items()), "Previous export artifact changed")
    crops = []
    if line_crops:
        from PIL import Image
        (out/"lines").mkdir(exist_ok=True)
    exported_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    gold_facts_sha256 = hashlib.sha256(encoded(value)).hexdigest()
    ET.register_namespace("", PAGE_NS)
    tag = lambda name: "{" + PAGE_NS + "}" + name
    with fitz.open(pdf) as document:
        require(len(document) == len(rows), "Physical page coverage differs")
        for row in rows:
            page = document[row["pdf_page"]-1]
            require(abs(page.rect.width-row["width_points"]) < .01 and abs(page.rect.height-row["height_points"]) < .01 and page.rotation == row["rotation"], "Page transform differs")
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            pix.save(out/row["image_filename"])
            if row.get("training_eligible", {}).get("recognition", True):
                (out/Path(row["image_filename"]).with_suffix(".txt")).write_bytes(row["text"].encode())
                row["text_sha256"] = hashlib.sha256(row["text"].encode()).hexdigest()
            row.update(image_width=pix.width, image_height=pix.height, dpi=dpi,
                       image_sha256=hashlib.sha256((out/row["image_filename"]).read_bytes()).hexdigest(),
                       gold_facts_sha256=gold_facts_sha256,
                       renderer="PyMuPDF "+fitz.VersionBind, exported_at=exported_at)
            recognition = row.get("training_eligible", {}).get("recognition", True)
            row["segmentation_training_eligible"] = pagexml and row["segmentation_training_eligible"]
            text_lines = {line["id"] for line in row["lines"] if line["text"].strip()}
            row["recognition_line_count"] = len(text_lines)
            if line_crops:
                excluded = {}
                before = len(crops)
                with Image.frombytes("RGB", (pix.width, pix.height), pix.samples) as image:
                    for index, line in enumerate(row["lines"]):
                        if line["id"] not in text_lines:
                            continue
                        try:
                            require(recognition, "Recognition coverage is incomplete")
                            require("\n" not in line["text"] and "\r" not in line["text"], "Line crop target contains multiple lines")
                            box = pixel_box(line, pix.width, pix.height)
                        except ValueError as exc:
                            excluded[line["id"]] = str(exc)
                            continue
                        stem = f"{value['source_sha256']}-{row['pdf_page']:06}-{index:06}"
                        crop_path, text_path = out/"lines"/(stem+".png"), out/"lines"/(stem+".gt.txt")
                        with image.crop(box) as crop:
                            crop.save(crop_path)
                        text_path.write_bytes(line["text"].encode())
                        crops.append({"source_sha256": value["source_sha256"], "pdf_page": row["pdf_page"],
                            "line_id": line["id"], "reading_order_index": index, "box_pixels": box,
                            "image": crop_path.relative_to(out).as_posix(), "transcription": text_path.relative_to(out).as_posix(),
                            "image_sha256": hashlib.sha256(crop_path.read_bytes()).hexdigest(),
                            "text_sha256": hashlib.sha256(text_path.read_bytes()).hexdigest(),
                            "page_image_sha256": row["image_sha256"]})
                row.update(line_crop_count=len(crops)-before, line_crop_exclusions=excluded,
                           line_crop_recognition_eligible=recognition and bool(text_lines) and not excluded)
            line_order_eligible = False
            regions_eligible = False
            baselines_eligible = False
            if pagexml and "regions" in row:
                indexed = {line["id"]: (index,line) for index,line in enumerate(row["lines"])}
                ordered_members = [[ident for ident in sorted(region["line_ids"], key=lambda i: indexed[i][0])] for region in row["regions"]]
                boundaries = {ident: pixel_coordinates(line["boundary"], pix.width, pix.height, 3) for ident,(_,line) in indexed.items()}
                baselines = {ident: pixel_coordinates(line["baseline"], pix.width, pix.height, 2) for ident,(_,line) in indexed.items()}
                polygons = {region["id"]: pixel_coordinates(region["polygon"], pix.width, pix.height, 3) for region in row["regions"]}
                membership = [ident for members in ordered_members for ident in members]
                geometry = all(polygons.values()) and all(boundaries.values()) and all(baselines.values())
                regions_eligible = row["training_eligible"]["regions"] and all(polygons.values())
                baselines_eligible = row["training_eligible"]["segmentation"] and all(boundaries.values()) and all(baselines.values()) and sorted(membership) == sorted(indexed)
                line_order_eligible = row["training_eligible"]["reading_order"] and geometry and membership == list(indexed)
                row["segmentation_training_eligible"] = row["segmentation_training_eligible"] and geometry
            if pagexml:
                # Kraken's default PAGE recognition loader consumes baseline-bearing lines.
                row.update(pagexml_region_order_eligible=regions_eligible and row["training_eligible"]["reading_order"] if "regions" in row else False,
                           pagexml_baseline_training_eligible=baselines_eligible,
                           pagexml_region_training_eligible=regions_eligible,
                           pagexml_reading_order_eligible=line_order_eligible, pagexml_recognition_eligible=False,
                           pagexml_line_count=0, pagexml_baseline_count=0, pagexml_region_count=0,
                           pagexml_recognition_line_count=0)
                row["pagexml_recognition_exclusions"] = {ident: "PAGE geometry or membership is incomplete" for ident in sorted(text_lines)}
            if pagexml and ("coverage" not in row or regions_eligible or line_order_eligible):
                root = ET.Element(tag("PcGts"))
                metadata = ET.SubElement(root, tag("Metadata"))
                ET.SubElement(metadata, tag("Creator")).text = VERSION
                ET.SubElement(metadata, tag("Created")).text = exported_at
                ET.SubElement(metadata, tag("LastChange")).text = exported_at
                ET.SubElement(metadata, tag("Comments")).text = ("Physical OCR annotations; ontology sha256 " + row["ontology"] + "; coverage " + json.dumps(row["coverage"], sort_keys=True) if "regions" in row else "Recognition gold with source-unit box wrappers. No baseline annotations.")
                body = ET.SubElement(root, tag("Page"), imageFilename=row["image_filename"], imageWidth=str(pix.width), imageHeight=str(pix.height))
                order = ET.SubElement(ET.SubElement(body, tag("ReadingOrder")), tag("OrderedGroup"), id="reading-order")
                if "regions" in row:
                    for index, region in enumerate(row["regions"]):
                        element = ET.SubElement(body, tag("TextRegion"), id=region["id"], custom=f"structure {{type:{region['type']};}} readingOrder {{index:{index};}}")
                        ET.SubElement(element, tag("Coords"), points=polygons[region["id"]])
                        row["pagexml_region_count"] += 1
                        for ident in ordered_members[index]:
                            position, line = indexed[ident]
                            if not boundaries[ident]: continue
                            target = ET.SubElement(element, tag("TextLine"), id=ident, custom=f"readingOrder {{index:{position};}}")
                            ET.SubElement(target, tag("Coords"), points=boundaries[ident])
                            row["pagexml_line_count"] += 1
                            if baselines[ident]:
                                ET.SubElement(target, tag("Baseline"), points=baselines[ident])
                                row["pagexml_baseline_count"] += 1
                            if recognition:
                                ET.SubElement(ET.SubElement(target, tag("TextEquiv")), tag("Unicode")).text = line["text"]
                            if ident in text_lines:
                                if recognition and "\n" not in line["text"] and "\r" not in line["text"] and baselines[ident]:
                                    row["pagexml_recognition_line_count"] += 1
                                    row["pagexml_recognition_exclusions"].pop(ident, None)
                                else:
                                    row["pagexml_recognition_exclusions"][ident] = ("Recognition coverage is incomplete" if not recognition else
                                        "Line target contains multiple lines" if "\n" in line["text"] or "\r" in line["text"] else
                                        "Baseline is unavailable to the PAGE recognition consumer")
                        ET.SubElement(order, tag("RegionRefIndexed"), index=str(index), regionRef=region["id"])
                for index, line in enumerate([] if "regions" in row else row["lines"]):
                    try:
                        x0,y0,x1,y1 = pixel_box(line, pix.width, pix.height)
                    except ValueError as exc:
                        if line["id"] in text_lines: row["pagexml_recognition_exclusions"][line["id"]] = str(exc)
                        continue
                    region = ET.SubElement(body, tag("TextRegion"), id="region-"+line["id"])
                    row["pagexml_region_count"] += 1
                    points = f"{x0},{y0} {x1},{y0} {x1},{y1} {x0},{y1}"
                    ET.SubElement(region, tag("Coords"), points=points)
                    target = ET.SubElement(region, tag("TextLine"), id=line["id"], custom=f"readingOrder {{index:{index};}}")
                    ET.SubElement(target, tag("Coords"), points=points)
                    ET.SubElement(ET.SubElement(target, tag("TextEquiv")), tag("Unicode")).text = line["text"]
                    row["pagexml_line_count"] += 1
                    if line["id"] in text_lines: row["pagexml_recognition_exclusions"][line["id"]] = "Source-unit wrapper has no baseline for the PAGE recognition consumer"
                    ET.SubElement(order, tag("RegionRefIndexed"), index=str(index), regionRef=region.attrib["id"])
                row["pagexml_recognition_eligible"] = recognition and bool(text_lines) and not row["pagexml_recognition_exclusions"]
                ET.ElementTree(root).write(out/Path(row["image_filename"]).with_suffix(".xml"), encoding="utf-8", xml_declaration=True)
                row["pagexml_sha256"] = hashlib.sha256((out/Path(row["image_filename"]).with_suffix(".xml")).read_bytes()).hexdigest()
    manifest = [{key: part for key, part in row.items() if key not in {"lines", "text", "regions"}} for row in rows]
    (out/"records.jsonl").write_bytes(b"".join(encoded(row)+b"\n" for row in manifest))
    if line_crops:
        (out/"lines.jsonl").write_bytes(b"".join(encoded(row)+b"\n" for row in crops))
    elif out/"lines.jsonl" in previous:
        (out/"lines.jsonl").unlink()
    current = export_files(out, value["source_sha256"])
    for path in previous.keys()-current.keys():
        path.unlink(missing_ok=True)
    return {"pages": len(rows), "source_sha256": value["source_sha256"], "segmentation_training_eligible": all(r["segmentation_training_eligible"] for r in rows),
            **({"line_crops": len(crops)} if line_crops else {})}
