"""Source-qualified evidence spans for existing record and form annotations."""
from collections import defaultdict
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import unicodedata


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def record_sources(source):
    """Original PDF membership from the record's existing source manifest."""
    primary = source["source_sha256"]
    result = {}
    for sha, file in [(primary, source["source_file"]),
                      *((row.get("sha256"), row.get("file")) for row in source.get("sources", []))]:
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha) or not file:
            raise ValueError("Record source lacks an explicit PDF identity")
        member = result.setdefault(sha, {"files": [], "primary": sha == primary})
        if file not in member["files"]:
            member["files"].append(file)
    return result


def _numbers(value):
    if isinstance(value, int) and not isinstance(value, bool):
        return [value] if value > 0 else []
    if isinstance(value, list):
        return value if all(type(n) is int and n > 0 for n in value) else []
    if isinstance(value, str):
        match = re.search(r"\bpages?\s*:?\s*(\d+(?:\s*[-\u2013\u2014,]\s*\d+)*)", value, re.I)
        if match:
            result = []
            for part in match[1].split(","):
                bounds = re.split(r"\s*[-\u2013\u2014]\s*", part.strip())
                lo, hi = int(bounds[0]), int(bounds[-1])
                if not 0 < lo <= hi < lo + 10000:
                    return []
                result.extend(range(lo, hi + 1))
            return result
    return []


class _PageMap:
    def __init__(self, source, split):
        self.primary = source["source_sha256"]
        self.members = record_sources(source)
        aliases = defaultdict(set)
        for sha, member in self.members.items():
            for file in member["files"]:
                aliases[file].add(sha)
                aliases[Path(file).name].add(sha)
        self.outputs = {"affidavit.pdf": [(self.primary, n) for n in split["affidavit_pages"]]}
        self.source_pages = defaultdict(set)
        self.context_pages = {"affidavit.pdf": {n: {(self.primary, n)} for n in split["affidavit_pages"]}}
        for n in split["affidavit_pages"]:
            self.source_pages[n].add((self.primary, n))
        for exhibit in split["exhibits"]:
            pages = []
            if exhibit.get("source_files"):
                for part in exhibit["source_files"]:
                    identities = aliases.get(part["file"], set())
                    sha = next(iter(identities)) if len(identities) == 1 else None
                    pages.extend((sha, n) for n in part["pages"])
            else:
                pages = [(self.primary, n) for n in exhibit.get("source_pages", [])]
            self.outputs[exhibit["file"]] = pages
            original = exhibit.get("source_pages", [])
            if len(original) == len(pages):
                local = defaultdict(set)
                for number, target in zip(original, pages):
                    local[number].add(target)
                    self.source_pages[number].add(target)
                self.context_pages[exhibit["file"]] = local
        self.primary_pages = source["source_pages"]

    def resolve(self, locator, output_file=None, default_pages=()):
        locator = locator if isinstance(locator, dict) else {"source_pages": _numbers(locator)}
        source = _numbers(locator.get("source_page", locator.get("source_pages"))) or list(default_pages)
        output = _numbers(locator.get("output_page", locator.get("output_pages")))
        explicit_source = locator.get("source_sha256")
        if explicit_source is not None and explicit_source not in self.members:
            return [], "unknown_source_pdf"
        targets = []
        for number in source:
            if explicit_source is not None:
                targets.append((explicit_source, number))
                continue
            choices = self.context_pages.get(output_file, self.source_pages).get(number, set())
            if not choices and 0 < number <= self.primary_pages:
                choices = {(self.primary, number)}
            if len(choices) != 1 or next(iter(choices))[0] is None:
                return [], "ambiguous_source_page"
            targets.append(next(iter(choices)))
        if output and output_file in self.outputs:
            pages = self.outputs[output_file]
            if any(n > len(pages) or pages[n-1][0] is None for n in output):
                return [], "unmapped_output_page"
            selected = [pages[n-1] for n in output]
            if targets and targets != selected:
                return [], "conflicting_page_locators"
            targets = selected
        return list(dict.fromkeys(targets)), None if targets else "missing_page_locator"


_TYPOGRAPHY = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
                           "\u2010": "-", "\u2011": "-", "\u2013": "-", "\u2014": "-"})


def _normalized(text, positions):
    result, mapped = [], []
    for character, position in zip(text, positions):
        for part in unicodedata.normalize("NFKC", character).translate(_TYPOGRAPHY).casefold():
            part = " " if part.isspace() else part
            if part == " " and result and result[-1] == " ":
                continue
            result.append(part)
            mapped.append(position)
    return "".join(result), mapped


def text_identity(value):
    if "lines" not in value:
        return None
    lines = {line["id"]: line for line in value["lines"]}
    return _hash([(ident, lines[ident]["page"], lines[ident]["text"])
                  for ident in value.get("reading_order", list(lines))])


def printed_text(value, spans, pages):
    """Validate explicit evidence against corrected text in its recorded reading order."""
    if "lines" not in value:
        raise ValueError("Exact text evidence is unavailable: shared text is not annotated")
    lines = {line["id"]: line for line in value["lines"]}
    order = {ident: n for n, ident in enumerate(value.get("reading_order", list(lines)))}
    if not isinstance(spans, list) or not spans:
        raise ValueError("Explicit evidence needs nonempty text spans")
    result, previous = [], (-1, 0)
    for span in spans:
        if not isinstance(span, dict) or set(span) != {"line_id", "start", "end"}:
            raise ValueError("Invalid explicit evidence span")
        line = lines.get(span["line_id"])
        start, end = span["start"], span["end"]
        if line is None or line["page"] not in pages or type(start) is not int or type(end) is not int or not 0 <= start < end <= len(line["text"]):
            raise ValueError("Explicit evidence is outside corrected text or selected pages")
        position = (order[line["id"]], start)
        if position < previous:
            raise ValueError("Explicit evidence overlaps or reverses reading order")
        previous = (position[0], end)
        result.append(line["text"][start:end])
    return "\n".join(result)


def _field_covers(annotation, spans):
    attrs = annotation.get("attributes", {})
    return annotation["kind"] == "field" and bool(attrs.get("label")) and all(
        any(part["line_id"] == span["line_id"] and part["start"] <= span["start"] < span["end"] <= part["end"]
            for part in attrs.get("value", [])) for span in spans)


class _Surface:
    def __init__(self, value):
        self.value = value
        self.source = value["source_sha256"]
        self.pages = {page["page"] for page in value["pages"]}
        self.has_text = "lines" in value
        lines = {line["id"]: line for line in value.get("lines", [])}
        self.lines = [lines[i] for i in value.get("reading_order", list(lines))]
        self.annotations = value["layers"].get("legal_structure", {}).get("annotations", [])
        self.cache = {}

    def text(self, pages):
        key = tuple(sorted(pages))
        if key not in self.cache:
            text, positions, previous = [], [], None
            for line in self.lines:
                if line["page"] not in pages:
                    continue
                previous_range = previous.get("source_range") if previous else None
                current_range = line.get("source_range")
                adjacent = previous and previous_range and current_range and previous.get("source_id") is not None and previous.get("source_id") == line.get("source_id") and previous_range[1] == current_range[0]
                if previous and not adjacent:
                    text.append("\n")
                    positions.append(None)
                text.extend(line["text"])
                positions.extend((line["id"], n) for n in range(len(line["text"])))
                previous = line
            raw = "".join(text)
            self.cache[key] = (raw, positions, *_normalized(raw, positions))
        return self.cache[key]

    def anchor(self, mapped, reason=None, text=None, owner=None, require_field=False, locator=None):
        pages = sorted({page for sha, page in mapped if sha == self.source})
        if mapped and not pages or not mapped and owner not in (None, self.source):
            return None
        if not set(pages) <= self.pages:
            return {"status": "unresolved", "reason": "page_outside_gold"}
        if not pages:
            return {"status": "unresolved", "reason": reason or "missing_page_locator"}
        result = {"pages": pages, "status": "page_only"}
        if not self.has_text:
            return {**result, "reason": "shared_text_unavailable"}
        if isinstance(locator, dict) and "spans" in locator:
            if locator.get("source_sha256") != self.source:
                raise ValueError("Explicit evidence must identify its source PDF")
            printed = printed_text(self.value, locator["spans"], pages)
            if "as_printed" in locator and locator["as_printed"] != printed:
                raise ValueError("Explicit evidence transcription differs from its text spans")
            return {**result, "status": "anchored", "spans": deepcopy(locator["spans"]), "method": "model_annotation"}
        if text is None:
            return result
        if not isinstance(text, (str, int, float)) or isinstance(text, bool):
            return {**result, "reason": "non_literal_value"}
        needle = str(text).strip()
        if not needle:
            return {**result, "reason": "empty_value"}
        raw, positions, normalized, normalized_positions = self.text(pages)
        normalized_needle = _normalized(needle, [None] * len(needle))[0].strip()
        found = []
        for haystack, query, mapping, method in ((raw, needle, positions, "exact"),
                                                 (normalized, normalized_needle, normalized_positions, "normalized")):
            matches, start = [], 0
            while query and (at := haystack.find(query, start)) >= 0:
                end = at + len(query)
                boundary = not (query[0].isalnum() and at and haystack[at-1].isalnum() or
                                query[-1].isalnum() and end < len(haystack) and haystack[end].isalnum())
                whole_characters = not (at and mapping[at] == mapping[at-1] or
                                        end < len(mapping) and mapping[end-1] == mapping[end])
                if boundary and whole_characters:
                    matches.append((at, end))
                start = at + 1
            if len(matches) > 1:
                return {**result, "reason": "ambiguous_text"}
            if matches:
                spans = []
                for position in mapping[slice(*matches[0])]:
                    if position is None:
                        continue
                    ident, offset = position
                    if spans and spans[-1]["line_id"] == ident and offset <= spans[-1]["end"]:
                        spans[-1]["end"] = max(spans[-1]["end"], offset + 1)
                    else:
                        spans.append({"line_id": ident, "start": offset, "end": offset + 1})
                found.append({**result, "status": "anchored", "spans": spans, "method": method})
        if not found:
            return {**result, "reason": "text_not_found"}
        if any(match["spans"] != found[0]["spans"] for match in found[1:]):
            return {**result, "reason": "ambiguous_text"}
        answer = found[0]
        if require_field:
            fields = [a["id"] for a in self.annotations if _field_covers(a, answer["spans"])]
            if len(fields) != 1:
                return {**result, "reason": "ambiguous_field_context" if fields else "missing_field_context"}
            answer["field_annotation_id"] = fields[0]
        return answer


def _pointer(value):
    return str(value).replace("~", "~0").replace("/", "~1")


def _pointer_parts(path):
    if not isinstance(path, str) or not path.startswith("/") or re.search(r"~(?![01])", path):
        raise ValueError("Invalid source anchor target pointer")
    return [part.replace("~1", "/").replace("~0", "~") for part in path[1:].split("/")]


def _resolve_pointer(value, path):
    for part in _pointer_parts(path):
        if isinstance(value, list) and re.fullmatch(r"0|[1-9][0-9]*", part) and int(part) < len(value):
            value = value[int(part)]
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            raise ValueError("Source anchor target no longer exists")
    return value


def validate_record(binding, item):
    """Evidence locations depend on both the record facts and its PDF/page mapping."""
    if binding.get("inputs_sha256") != _hash({key: item[key] for key in ("gold", "source", "split")}):
        raise ValueError("Source anchor record facts or page mapping changed; refresh source anchors")
    for path in binding["targets"]:
        _resolve_pointer(item["gold"], path)


def record_anchors(value, item):
    """Resolve only evidence belonging to this PDF; record values stay with their owner."""
    source, split, record = item["source"], item["split"], item["gold"]
    mapping, surface = _PageMap(source, split), _Surface(value)
    owner, targets = source["source_sha256"], {}

    def add(path, locator, output=None, pages=(), text=None, require_field=False):
        resolved, reason = mapping.resolve(locator, output, pages)
        if isinstance(locator, dict) and "spans" in locator and reason:
            raise ValueError("Explicit evidence has invalid page mapping: " + reason)
        anchor = surface.anchor(resolved, reason, text, owner, require_field, locator)
        if anchor is not None:
            targets[path] = anchor

    def leaves(part, path, locator, output, pages, inherited_explicit=False):
        if isinstance(part, dict) and "source_locator" in part:
            locator, inherited_explicit = part["source_locator"], False
        if not inherited_explicit and isinstance(locator, dict) and "spans" in locator:
            add(path, locator, output, pages)
            inherited_explicit = True
        if isinstance(part, dict):
            for key, child in part.items():
                if key not in {"source_locator", "value_status", "price_value_status"}:
                    leaves(child, path + "/" + _pointer(key), locator, output, pages, inherited_explicit)
        elif isinstance(part, list):
            for n, child in enumerate(part):
                leaves(child, path + "/" + str(n), locator, output, pages, inherited_explicit)
        elif not inherited_explicit:
            add(path, locator, output, pages, part, require_field=True)

    for n, segment in enumerate(record.get("document_segments", [])):
        path = f"/document_segments/{n}"
        output = segment.get("output_file")
        pages = segment["source_pages"]
        add(path, {"source_pages": pages, "output_pages": segment.get("output_pages", [])}, output)
        for m, information in enumerate(segment.get("standard_information", [])):
            field_path = f"{path}/standard_information/{m}/value"
            if information["field"].endswith(("_count", "_status")):
                add(field_path, information.get("source_locator", {}), output, pages)
                if field_path in targets:
                    targets[field_path]["reason"] = "derived_value"
            else:
                leaves(information["value"], field_path, information.get("source_locator", {}), output, pages)
    affidavit = split["affidavit_pages"]
    for n, event in enumerate(record.get("events", [])):
        locator = event.get("source_locator", {"source_pages": event.get("source_pages", affidavit)})
        add(f"/events/{n}/quote", locator, "affidavit.pdf", pages=affidavit, text=event.get("quote"))
    for n, exhibit in enumerate(record.get("exhibits", [])):
        output = exhibit["file"]
        output_pages = list(range(1, len(mapping.outputs.get(output, [])) + 1))
        locator = {"output_pages": output_pages}
        add(f"/exhibits/{n}", locator, output)
        for field in ("date", "author", "recipients"):
            if field in exhibit:
                leaves(exhibit[field], f"/exhibits/{n}/{field}", locator, output, ())
        for m, reference in enumerate(exhibit.get("references", [])):
            add(f"/exhibits/{n}/references/{m}/quote", {}, "affidavit.pdf", pages=affidavit, text=reference.get("quote"))
    return {"owner_source_sha256": owner,
            "inputs_sha256": _hash({key: item[key] for key in ("gold", "source", "split")}),
            "targets": targets}


def enrich(value, items, forms=()):
    """Explicitly attach existing annotations and bind their evidence to corrected text."""
    import package
    items, forms = list(items), list(forms)
    result = package.attach_records(value, items, forms)
    layer = result["layers"].get("source_anchors", {})
    records = deepcopy(layer.get("records", {})) if layer.get("text_sha256") == text_identity(result) else {}
    for item in items:
        if result["source_sha256"] not in record_sources(item["source"]):
            raise ValueError("Record does not contain this source")
        records[item["gold"]["record_id"]] = record_anchors(result, item)
    surface, form_anchors = _Surface(result), {}
    for n, observation in enumerate(forms):
        if observation.get("source_sha256") != result["source_sha256"]:
            raise ValueError("Form observation belongs to another source")
        pages = _numbers(observation.get("locator"))
        form_anchors[f"/form_observations/{n}"] = surface.anchor([(surface.source, p) for p in pages])
    result["layers"]["source_anchors"] = {"source_sha256": result["source_sha256"],
        "text_sha256": text_identity(result), "records": records, "forms": form_anchors}
    validate(result)
    return result


def validate(value):
    layer = value["layers"].get("source_anchors")
    if layer is None:
        return
    if layer["source_sha256"] != value["source_sha256"] or layer["text_sha256"] != text_identity(value):
        raise ValueError("Source anchors refer to different source text")
    lines = {line["id"]: line for line in value.get("lines", [])}
    pages = {page["page"] for page in value["pages"]}
    fields = {a["id"]: a for a in value["layers"].get("legal_structure", {}).get("annotations", [])}
    annotations = list(layer["forms"].values())
    for path in layer["forms"]:
        parts = _pointer_parts(path)
        if len(parts) != 2 or parts[0] != "form_observations":
            raise ValueError("Source form anchor target differs")
        observation = _resolve_pointer(value, path)
        if observation.get("source_sha256") != value["source_sha256"]:
            raise ValueError("Source form anchor owner differs")
    for rid, record in layer["records"].items():
        if rid not in value["records"] or not re.fullmatch(r"[0-9a-f]{64}", record["owner_source_sha256"]):
            raise ValueError("Source anchor record owner is missing")
        if record["owner_source_sha256"] != value["records"][rid].get("owner_source_sha256", value["source_sha256"]):
            raise ValueError("Source anchor record owner differs")
        if record["owner_source_sha256"] == value["source_sha256"]:
            import package
            validate_record(record, {"gold": package.record_gold(value, rid), **value["views"][rid]})
        else:
            # Companion target existence belongs to the external record owner.
            if not re.fullmatch(r"[0-9a-f]{64}", record.get("inputs_sha256", "")):
                raise ValueError("Source anchor record inputs are missing")
            for path in record["targets"]:
                _pointer_parts(path)
        annotations.extend(record["targets"].values())
        for path, anchor in record["targets"].items():
            metadata = "/standard_information/" in path or re.match(r"/exhibits/\d+/(?:date|author|recipients)(?:/|$)", path)
            if metadata and anchor["status"] == "anchored" and "field_annotation_id" not in anchor and anchor.get("method") != "model_annotation":
                raise ValueError("Normalized information anchor lacks printed field context")
    for anchor in annotations:
        locations = anchor.get("pages", [])
        if anchor["status"] not in {"anchored", "page_only", "unresolved"} or not all(type(p) is int for p in locations) or not set(locations) <= pages:
            raise ValueError("Invalid source anchor coverage")
        if anchor["status"] != "unresolved" and not locations:
            raise ValueError("Resolved evidence has no source pages")
        if anchor["status"] == "anchored" and not anchor.get("spans"):
            raise ValueError("Anchored evidence has no text spans")
        if anchor.get("method") == "model_annotation":
            if anchor["status"] != "anchored":
                raise ValueError("Explicit evidence is not anchored")
            printed_text(value, anchor["spans"], locations)
        if "field_annotation_id" in anchor:
            field = fields.get(anchor["field_annotation_id"])
            if anchor["status"] != "anchored" or field is None or not _field_covers(field, anchor["spans"]):
                raise ValueError("Source anchor printed field context changed")
        for span in anchor.get("spans", []):
            line = lines.get(span["line_id"])
            if line is None or line["page"] not in anchor.get("pages", []) or type(span["start"]) is not int or type(span["end"]) is not int or not 0 <= span["start"] < span["end"] <= len(line["text"]):
                raise ValueError("Source anchor is outside corrected text")
