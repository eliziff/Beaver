"""Source-reviewable base-name targets, separate from complete declarations."""
from mine import normalize
from shortform import TOKEN
from training_data import component_match


def decompose(record, label):
    parties = (record["left"], record["right"])
    anchored = lambda text: [i for i, party in enumerate(parties)
                             if party and component_match(text, party)]
    original_sides = anchored(label)
    base, qualifiers = label, []
    if not original_sides:
        courts = {normalize(value) for value in record["courts"]}
        years = set(record["years"])
        for _ in range(2):
            tokens = list(TOKEN.finditer(base))
            if len(tokens) < 2:
                break
            size = next((n for n in range(min(4, len(tokens) - 1), 0, -1)
                         if normalize("".join(t.group() for t in tokens[-n:])) in courts), None)
            kind = "court"
            if size is None and normalize(tokens[-1].group()) in years:
                size, kind = 1, "year"
            if size is None:
                break
            qualifiers.append({"kind": kind, "text": base[tokens[-size].start():]})
            base = base[:tokens[-size].start()].rstrip(" ([,;-\u2013\u2014")
        if len(anchored(base)) != 1:
            base, qualifiers = label, []
    sides = anchored(base)
    return {"original": label, "base": base, "qualifiers": list(reversed(qualifiers)),
            "sides": sides, "status": "metadata_qualified" if qualifiers else
            "party_anchored" if sides else "unresolved_source_label"}


def project(record):
    """Preserve witnesses and all supported alternatives; never change raw gold."""
    aliases, declarations = {}, []
    for original_norm, alias in record["aliases"].items():
        value = decompose(record, alias["text"])
        declarations.append({**value, "original_normalized": original_norm,
                             "document_ids": alias["document_ids"]})
        norm = normalize(value["base"])
        target = aliases.setdefault(norm, {"text": value["base"], "document_ids": set(),
                                            "original_normalized": []})
        target["document_ids"].update(map(tuple, alias["document_ids"]))
        target["original_normalized"].append(original_norm)
    for alias in aliases.values():
        alias["document_ids"] = sorted(alias["document_ids"])
        alias["votes"] = len(alias["document_ids"])
    maximum = max(alias["votes"] for alias in aliases.values())
    return {**record, "aliases": aliases,
            "modal": sorted(norm for norm, alias in aliases.items() if alias["votes"] == maximum),
            "max_votes": maximum, "authored_aliases": record["aliases"],
            "base_declarations": declarations}


def qualify(record):
    """Keep source evidence, but fit and score only eligible base-name targets."""
    from evidence import base_name_flag
    from operations import align_base

    projected = project(record)
    eligible, flagged = {}, []
    for declaration in projected["base_declarations"]:
        text = declaration["base"]
        alignment = align_base(record, text)
        flag = base_name_flag(text, (record["left"], record["right"]))
        if not flag and alignment["family"] == "unresolved_transformation_or_input":
            flag = "unresolved_base_or_input"
        item = {**declaration, "flag": flag, "alignment": alignment}
        if flag:
            flagged.append(item)
            continue
        norm = normalize(text)
        alias = eligible.setdefault(norm, {"text": text, "document_ids": set(), "original_normalized": []})
        alias["document_ids"].update(map(tuple, declaration["document_ids"]))
        alias["original_normalized"].append(declaration["original_normalized"])
    for alias in eligible.values():
        alias["document_ids"] = sorted(alias["document_ids"])
        alias["votes"] = len(alias["document_ids"])
    maximum = max((alias["votes"] for alias in eligible.values()), default=0)
    return {**projected, "projected_aliases": projected["aliases"], "aliases": eligible,
            "modal": sorted(norm for norm, alias in eligible.items() if alias["votes"] == maximum),
            "max_votes": maximum, "flagged_declarations": flagged,
            "target_status": "eligible" if eligible and not flagged else "mixed" if eligible else "no_eligible_base"}
