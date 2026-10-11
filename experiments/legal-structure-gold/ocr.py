"""Physical PAGE annotations on the gold's shared corrected text."""
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

TASKS = ("recognition", "segmentation", "regions", "reading_order")
STATUSES = ("complete", "partial", "unannotated")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def points(value, minimum):
    require(isinstance(value, list) and len(value) >= minimum, "OCR geometry has too few points")
    require(all(isinstance(p, list) and len(p) == 2 and all(type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 1000 for v in p) for p in value), "OCR geometry outside original page")
    require(len({tuple(p) for p in value}) >= minimum, "OCR geometry has repeated points")
    if minimum == 3:
        area = sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(value, value[1:]+value[:1]))
        require(abs(area) > 0, "OCR polygon has zero area")


def box(polygon):
    return [min(p[0] for p in polygon), min(p[1] for p in polygon), max(p[0] for p in polygon), max(p[1] for p in polygon)]


def load(pdf, supplied, base):
    """Read declared Kraken/PPDoc artifacts; prove their pixel-to-PDF binding."""
    import fitz
    from PIL import Image
    metadata = deepcopy(supplied["ocr"])
    require(metadata["producer"]["layout_source"] in {"kraken", "ppdoc"}, "Unknown OCR producer")
    ontology = metadata["ontology"]
    require(ontology.get("owner") and re.fullmatch(r"[0-9a-f]{64}", ontology.get("sha256", "")), "OCR ontology provenance missing")
    labels = ontology["labels"]
    require(labels and len(labels) == len(set(labels)) and all(isinstance(x, str) and x for x in labels), "Invalid OCR ontology")
    require(supplied["source_sha256"] == sha(pdf), "OCR artifacts belong to another PDF")
    pages = []
    with fitz.open(pdf) as document:
        require(len(document) == len(supplied["pages"]), "OCR physical page coverage differs")
        for number, (page, item) in enumerate(zip(document, supplied["pages"]), 1):
            require(item["page"] == number, "OCR pages out of order")
            xml_path, image_path = (base / item[k] for k in ("pagexml", "image"))
            dpi = item["dpi"]
            require(type(dpi) is int and dpi > 0, "OCR image DPI missing")
            root = ET.parse(xml_path).getroot()
            bodies = [e for e in root.iter() if e.tag.rsplit("}", 1)[-1] == "Page"]
            require(len(bodies) == 1, "Expected one PAGE page")
            body = bodies[0]
            width, height = int(body.attrib["imageWidth"]), int(body.attrib["imageHeight"])
            require(body.attrib["imageFilename"].replace("\\", "/").rsplit("/", 1)[-1] == image_path.name, "PAGE belongs to another page image")
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            with Image.open(image_path) as image:
                rgb = image.convert("RGB")
                try:
                    require(rgb.size == (width, height) == (pix.width, pix.height) and rgb.tobytes() == pix.samples, "OCR image differs from original PDF pixels or transform")
                finally:
                    rgb.close()
            def coords(element, tag):
                child = next((e for e in element if e.tag.rsplit("}", 1)[-1] == tag), None)
                if child is None:
                    return []
                result = [[1000*float(v)/(width if i == 0 else height) for i,v in enumerate(pair.split(","))] for pair in child.attrib["points"].split()]
                points(result, 2 if tag == "Baseline" else 3)
                return result
            def ident(element):
                return f"p{number}-" + element.attrib["id"]
            def ordered(elements):
                def key(pair):
                    index, element = pair
                    match = re.search(r"readingOrder\s*\{[^}]*index\s*:\s*(\d+)", element.get("custom", ""))
                    return int(match[1]) if match else index
                return [e for _,e in sorted(enumerate(elements), key=key)]
            regions = ordered([e for e in body if e.tag.rsplit("}", 1)[-1].endswith("Region")])
            region_refs = [e for e in body.iter() if e.tag.rsplit("}", 1)[-1] == "RegionRefIndexed"]
            if region_refs:
                refs = [r.attrib["regionRef"] for r in sorted(region_refs, key=lambda e: int(e.attrib["index"]))]
                require(len(refs) == len(set(refs)) and set(refs) <= {r.attrib["id"] for r in regions}, "Invalid PAGE region order")
                by_id = {r.attrib["id"]: r for r in regions}
                regions = [by_id[r] for r in refs] + [r for r in regions if r.attrib["id"] not in refs]
            lines, atoms, targets = [], [], []
            for region in regions:
                ids = []
                for line in ordered([e for e in region.iter() if e.tag.rsplit("}", 1)[-1] == "TextLine"]):
                    text = next((e.text or "" for equiv in reversed(list(line)) if equiv.tag.rsplit("}", 1)[-1] == "TextEquiv" for e in equiv if e.tag.rsplit("}", 1)[-1] == "Unicode"), "")
                    require("\n" not in text and "\r" not in text, "PAGE TextLine contains multiple physical lines")
                    boundary, baseline = coords(line, "Coords"), coords(line, "Baseline")
                    require(boundary, "PAGE line polygon missing")
                    key = ident(line)
                    lines.append({"id": key, "baseline": baseline, "boundary": boundary, "members": [key] if text.strip() else []})
                    if text.strip():
                        atoms.append({"id": key, "text": text, "bbox": [v*(width if i%2 == 0 else height)/1000 for i,v in enumerate(box(boundary))]})
                    ids.append(key)
                custom = re.search(r"structure\s*\{[^}]*type\s*:\s*([^;}]+)", region.get("custom", ""))
                targets.append({"id": ident(region), "type": custom[1].strip() if custom else region.get("type", "unknown"), "polygon": coords(region, "Coords"), "line_ids": ids})
            provenance = {"pagexml_sha256": sha(xml_path), "image_sha256": sha(image_path), "dpi": dpi, "image_width": width, "image_height": height, "renderer": "PyMuPDF " + fitz.VersionBind}
            proposals = []
            if metadata["producer"]["layout_source"] == "ppdoc":
                path = base / item["ppdoc_postprocessed"]
                payload = json.loads(path.read_text(encoding="utf-8-sig"))
                require(payload.get("image_size") == [width, height], "PPDoc original page dimensions differ")
                if payload.get("image"):
                    require(payload["image"].replace("\\", "/").rsplit("/", 1)[-1] == image_path.name, "PPDoc belongs to another page image")
                detections = payload.get("detections", payload.get("boxes"))
                require(isinstance(detections, list), "PPDoc postprocessed detections missing")
                for detection in detections:
                    raw = detection.get("raw") or {}
                    bounds = detection.get("box") or detection.get("bbox") or raw.get("coordinate")
                    if isinstance(bounds, dict):
                        bounds = [bounds[k] for k in ("x0", "y0", "x1", "y1")]
                    require(isinstance(bounds, list) and len(bounds) == 4, "PPDoc box missing")
                    x0,y0,x1,y1 = [v*1000/(width if i%2 == 0 else height) for i,v in enumerate(bounds)]
                    polygon = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]
                    points(polygon, 3)
                    proposals.append({"type": detection.get("label") or raw.get("source_label") or raw.get("label") or "unknown", "polygon": polygon, "order": detection.get("order", raw.get("postprocess_order", raw.get("order")))})
                provenance["ppdoc_postprocessed_sha256"] = sha(path)
            physical = {"page": number, "lines": lines, "regions": targets, "coverage": {k: "unannotated" for k in TASKS}, "provenance": provenance}
            require(len({l["id"] for l in lines}) == len(lines) and len({r["id"] for r in targets}) == len(targets), "Duplicate PAGE object ID")
            pages.append({"index": number-1, "width": width, "height": height, "lines": atoms, "ocr": physical, "ocr_proposals": proposals})
    pages[0]["ocr_metadata"] = metadata
    cursor, chunks, nodes = 0, [], []
    for number, page in enumerate(pages, 1):
        text = "\n".join(l["text"] for l in page["lines"])
        length = len(text.encode("utf-16-le")) // 2
        nodes.append({"id": f"page-{number}", "kind": "page", "page_indexes": [number-1], "line_ids": [l["id"] for l in page["lines"]], "range": {"start": cursor, "end": cursor+length}})
        chunks.append(text); cursor += length+1
    return {"source_sha256": sha(pdf), "offset_unit": "utf16", "text": "\n".join(chunks), "nodes": nodes, "origins": []}, pages


def schema(base):
    result = deepcopy(base)
    def obj(**fields):
        return {"type": "object", "additionalProperties": False, "required": list(fields), "properties": fields}
    def array(item):
        return {"type": "array", "items": item}
    string = {"type": "string"}
    coordinate = array(array({"type": "number", "minimum": 0, "maximum": 1000}))
    result["properties"]["ocr"] = obj(
        lines=array(obj(id=string, members=array(string), baseline=coordinate, boundary=coordinate)),
        regions=array(obj(id=string, type=string, polygon=coordinate, line_ids=array(string))),
        drop_lines=array(string), drop_regions=array(string), line_order=array(string), region_order=array(string),
        coverage=obj(**{task: {"type": "string", "enum": list(STATUSES)} for task in TASKS}))
    result["required"].append("ocr")
    return result


def apply(layer, req, response, aliases, expansion, units):
    require("ocr" in response, "OCR page annotation missing")
    page = next(p for p in layer["pages"] if p["page"] == req["targets"][0])
    correction = response["ocr"]
    for line in page["lines"]:
        line["members"] = [j for i in line.get("members", [line["id"]]) for j in expansion.get(i, [i]) if j in units]
    def objects(kind, drop):
        existing = {x["id"]: x for x in page[kind]}
        changes = correction[kind]
        require(len({x["id"] for x in changes}) == len(changes), "Duplicate OCR replacement")
        for ident in correction[drop]:
            require(ident in existing, "OCR discard outside TARGET")
            del existing[ident]
        for change in changes:
            ident = change["id"]
            require(ident in existing or re.fullmatch(r"(?:o|r)_new[1-9]\d*", ident), "OCR replacement outside TARGET")
            value = deepcopy(change)
            if kind == "lines":
                members = []
                for member in value["members"]:
                    require(member in aliases, "Unknown OCR text reference")
                    members.extend(i for i in expansion.get(aliases[member], [aliases[member]]) if i in units)
                value["members"] = members
            existing[ident] = value
        order = correction["line_order" if kind == "lines" else "region_order"] or list(existing)
        require(len(order) == len(existing) and set(order) == set(existing), "OCR order coverage differs")
        page[kind] = [existing[i] for i in order]
    objects("lines", "drop_lines"); objects("regions", "drop_regions")
    page["coverage"] = deepcopy(correction["coverage"])
    validate_page(page, units, layer["ontology"]["labels"])


def validate_page(page, units, labels):
    coverage = page["coverage"]
    require(set(coverage) == set(TASKS) and all(s in STATUSES for s in coverage.values()), "Invalid OCR coverage")
    lines = {l["id"]: l for l in page["lines"]}
    require(len(lines) == len(page["lines"]), "Duplicate OCR line ID")
    used = []
    for line in lines.values():
        if line["baseline"]:
            points(line["baseline"], 2)
        if line["boundary"]:
            points(line["boundary"], 3)
        members = line.get("members", [line["id"]])
        require(all(i in units and units[i]["page"] == page["page"] for i in members), "OCR text reference outside physical page")
        used.extend(members)
        if coverage["segmentation"] == "complete":
            require(line["baseline"] and line["boundary"], "Complete segmentation needs baselines and polygons")
    require(len(used) == len(set(used)), "OCR text duplicated across physical lines")
    if coverage["recognition"] == "complete":
        require(set(used) == {i for i,u in units.items() if u["page"] == page["page"]}, "Complete OCR recognition lost printed text")
    region_ids, assigned = set(), []
    for region in page["regions"]:
        require(region["id"] not in region_ids, "Duplicate OCR region ID")
        region_ids.add(region["id"])
        if region["polygon"]:
            points(region["polygon"], 3)
        require(len(region["line_ids"]) == len(set(region["line_ids"])) and set(region["line_ids"]) <= set(lines), "OCR region contains unknown or duplicate lines")
        assigned.extend(region["line_ids"])
        if coverage["regions"] == "complete":
            require(region["polygon"] and region["type"] in labels, "Complete regions need geometry and an exact ontology label")
    if coverage["regions"] == "complete":
        require(len(assigned) == len(set(assigned)) and set(assigned) == set(lines), "Complete OCR regions lost or duplicated physical lines")


def compact(layer, units):
    result = deepcopy(layer)
    for page in result["pages"]:
        validate_page(page, units, result["ontology"]["labels"])
        for line in page["lines"]:
            if line.get("members") == [line["id"]]:
                line.pop("members")
    return result


def text(line, units):
    members = [units[i] for i in line.get("members", [line["id"]])]
    parts = []
    for index, unit in enumerate(members):
        if index:
            previous = members[index-1]
            same = previous.get("source_id") and previous.get("source_id") == unit.get("source_id")
            if same and previous.get("source_range") and unit.get("source_range"):
                parts.append(unit["original_text"][previous["source_range"][1]:unit["source_range"][0]])
            else:
                parts.append(" ")
        parts.append(unit["text"])
    return "".join(parts)
