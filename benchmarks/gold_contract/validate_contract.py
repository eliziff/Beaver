"""Validate the metric-to-gold contract and optional aggregate claims.

Usage:
    python benchmarks/gold_contract/validate_contract.py
    python benchmarks/gold_contract/validate_contract.py aggregate.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


CONTRACT_PATH = Path(__file__).with_name("metric_gold_contract.json")
DISPOSITIONS = {
    "VALID_CASESET_ACCURACY",
    "VALID_REFERENCE_AGREEMENT",
    "VALID_INVARIANT",
    "DESCRIPTIVE_ONLY",
    "NOT_SCOREABLE",
}
ALLOWED_CLAIMS = {
    "VALID_CASESET_ACCURACY": {"case_set_accuracy", "descriptive"},
    "VALID_REFERENCE_AGREEMENT": {"reference_agreement", "descriptive"},
    "VALID_INVARIANT": {"invariant", "descriptive"},
    "DESCRIPTIVE_ONLY": {"descriptive"},
    "NOT_SCOREABLE": {"descriptive"},
}
REQUIRED_CONTRACT_FIELDS = {
    "id",
    "state",
    "metric_paths",
    "gold_authority",
    "gold_creation",
    "admissible_statuses",
    "version_hashes",
    "independence_and_leakage",
    "scorer",
    "failure_semantics",
    "uncertainty",
    "interpretation",
    "disposition",
    "accuracy_claim_allowed",
    "aggregate_label",
    "required_validation",
}
REQUIRED_EVIDENCE = {
    "gold_sha256",
    "scorer_sha256",
    "corpus_manifest_sha256",
    "admissible_statuses",
    "duplicate_fingerprint_count",
    "derivative_family_collision_count",
    "pstream_policy",
    "sampling_design",
}


class ContractError(ValueError):
    pass


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_contract(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if data.get("schema_version") != "mike.metric-gold-contract.v1":
        raise ContractError("unexpected contract schema_version")
    seen_ids: set[str] = set()
    index: dict[str, dict[str, Any]] = {}
    for contract in data.get("contracts", []):
        missing = REQUIRED_CONTRACT_FIELDS - set(contract)
        if missing:
            raise ContractError(f"{contract.get('id', '<unknown>')}: missing {sorted(missing)}")
        contract_id = contract["id"]
        if contract_id in seen_ids:
            raise ContractError(f"duplicate contract id: {contract_id}")
        seen_ids.add(contract_id)
        disposition = contract["disposition"]
        if disposition not in DISPOSITIONS:
            raise ContractError(f"{contract_id}: invalid disposition {disposition}")
        if bool(contract["accuracy_claim_allowed"]) != (
            disposition == "VALID_CASESET_ACCURACY"
        ):
            raise ContractError(f"{contract_id}: inconsistent accuracy_claim_allowed")
        if disposition == "NOT_SCOREABLE" and contract["aggregate_label"] != "NOT SCOREABLE":
            raise ContractError(f"{contract_id}: NOT_SCOREABLE must use literal aggregate label")
        if not contract["required_validation"]:
            raise ContractError(f"{contract_id}: required_validation must not be empty")
        for metric, spec in contract["metric_paths"].items():
            if metric in index:
                raise ContractError(f"duplicate metric path: {metric}")
            if not spec.get("definition") or not spec.get("unit"):
                raise ContractError(f"{contract_id}: incomplete metric definition: {metric}")
            index[metric] = contract
    if not index:
        raise ContractError("contract contains no metrics")
    return index


def _lookup(metric: str, index: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    if metric in index:
        return index[metric]
    wildcard_matches = [
        (path, contract)
        for path, contract in index.items()
        if path.endswith("*") and metric.startswith(path[:-1])
    ]
    if not wildcard_matches:
        return None
    return max(wildcard_matches, key=lambda item: len(item[0]))[1]


def validate_aggregate(data: dict[str, Any], index: dict[str, dict[str, Any]]) -> None:
    evidence = data.get("evidence")
    if not isinstance(evidence, dict):
        raise ContractError("aggregate: evidence object is required")
    missing = REQUIRED_EVIDENCE - set(evidence)
    if missing:
        raise ContractError(f"aggregate: missing evidence {sorted(missing)}")
    if evidence["duplicate_fingerprint_count"] != 0:
        raise ContractError("aggregate: duplicate_fingerprint_count must be zero")
    if evidence["derivative_family_collision_count"] != 0:
        raise ContractError("aggregate: derivative_family_collision_count must be zero")
    if evidence["pstream_policy"] != "one_least_edited_upstream_per_work_family":
        raise ContractError("aggregate: invalid pstream_policy")
    for item in data.get("metrics", []):
        metric = item.get("metric")
        claim = item.get("claim")
        contract = _lookup(str(metric), index)
        if contract is None:
            raise ContractError(f"aggregate: unknown metric {metric}")
        if claim not in ALLOWED_CLAIMS[contract["disposition"]]:
            raise ContractError(
                f"aggregate: {metric} disposition {contract['disposition']} "
                f"does not permit claim {claim}"
            )
        if contract["disposition"] == "NOT_SCOREABLE" and item.get("label") != "NOT SCOREABLE":
            raise ContractError(f"aggregate: {metric} must be labelled NOT SCOREABLE")
        if claim == "case_set_accuracy":
            if set(evidence["admissible_statuses"]) != set(contract["admissible_statuses"]):
                raise ContractError(f"aggregate: {metric} status policy does not match contract")
            if not item.get("validation_evidence"):
                raise ContractError(f"aggregate: {metric} requires validation_evidence")


def main(argv: list[str]) -> int:
    try:
        contract = load_json(CONTRACT_PATH)
        index = validate_contract(contract)
        if len(argv) > 1:
            validate_aggregate(load_json(Path(argv[1])), index)
    except (OSError, json.JSONDecodeError, ContractError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"OK: {len(index)} metric paths across {len(contract['contracts'])} contracts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
