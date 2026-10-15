"""Validate frozen source-family partitions without opening source or gold artifacts."""
import hashlib
import json


def validate_partitions(manifest):
    def require(condition, message):
        if not condition:
            raise ValueError(message)

    owners = {}
    family_ids = set()
    for family in manifest["families"]:
        members = family["members"]
        require(isinstance(members, list) and members and
                all(isinstance(source, str) for source in members), "Invalid source family membership")
        require(len(members) == len(set(members)), "Repeated source within one family")
        identity = hashlib.sha256(json.dumps(sorted(members), sort_keys=True,
            separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
        require(family["id"] == identity and identity not in family_ids,
                "Invalid or repeated canonical family identity")
        family_ids.add(identity)
        for source in members:
            require(source not in owners, "One source belongs to multiple families")
            owners[source] = identity

    # Families retain their full catalogue closure, including unselected intermediates.
    # Edges wholly outside retained families are legitimate catalogue evidence.
    for edge in manifest["family_evidence"]:
        members = edge["members"]
        require(isinstance(members, list) and len(set(members)) >= 2,
                "Invalid family evidence membership")
        touched = {owners[source] for source in members if source in owners}
        if touched:
            require(len(touched) == 1 and all(source in owners for source in members),
                    "Family evidence crosses or escapes retained family closure")

    splits = {}
    selected = set()
    for member in manifest["members"]:
        source, family, split = member["sha256"], member["family_id"], member["split"]
        require(source not in selected, "Duplicate selected source, including across partitions")
        selected.add(source)
        require(owners.get(source) == family, "Selected source differs from its canonical family")
        require(split in ("train", "development", "test"), "Unknown family partition")
        require(splits.setdefault(family, split) == split, "One source family crosses partitions")
    require(set(splits) == family_ids, "Retained family has no selected source")

    exposed = manifest["exposed_sources"]
    require(isinstance(exposed, list) and all(isinstance(source, str) for source in exposed)
            and len(exposed) == len(set(exposed)), "Invalid reviewed exposed-source identities")
    for source in exposed:
        if source in owners:
            require(splits[owners[source]] == "development",
                    "An exposed source's connected family is outside development")
