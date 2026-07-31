"""C4 ensemble / marginal-value study + H7 decision-quality half.

Research plan workstream C4 (docs/legal-grounding-research-plan-2026-07-30.md
~227-260) and C3's untested disjunct; queued as priority 3 of
docs/legal-grounding-restart-plan-2026-07-31.md.

ZERO model calls. Everything here is analysis over banked receipts and
local indexes.

Two label lanes, kept separate per the C4 protocol:

  EXPERT  RegLab response labels (grounded / misgrounded / ungrounded),
          claim features from
          misgrounding-corpus/us_sources/claim_features.jsonl, citator-
          derived columns joined from citations.jsonl. Labels are
          response-level and propagated WEAKLY to member claims, so the
          cluster unit is the response.
  CHECKER Receipt lane, from c4-build-matrix.ts. Labels are the model
          checker's own holistic verdict, which H17 measured at a 0-13%
          flip rate on identical inputs. Cluster unit is the cell.

Everything reported is EXPLORATORY per the C4 sample-size gate (n=8
expert-annotated misgrounded responses). Exploratory verdicts never
retire and never adopt a witness.

Statistics:
  * rank-AUC (ties 0.5), the same estimator the two existing solo
    harnesses use, so solo numbers are directly comparable;
  * 95% CIs from a CLUSTER bootstrap over the label-carrying unit,
    computed from THAT comparison's n, never a borrowed band;
  * in-concert = rank-sum over percentile-ranked witnesses, the frozen
    (unfitted) combiner the protocol registers first. Rank transforms
    are label-free, so the frozen combiner leaks nothing;
  * marginal value = paired bootstrap on the DELTA, both leave-one-out
    of the full ensemble and best-subset-add;
  * redundancy = Spearman rho plus an asymmetric pairwise-add matrix;
  * a fitted logistic combiner under leave-one-cluster-out CV, used
    ONLY as a measuring instrument for redundancy (never a shipping
    artifact), and only where the positive count can carry it.

    python -X utf8 scripts/c4_ensemble_study.py [--boot 2000]
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import itertools
import json
import os
import statistics
import sys
from pathlib import Path

import numpy as np

LOCAL = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
ARCHIVE = LOCAL / "OpenLegalData" / "experiments" / "legal-grounding" / "2026-07-30"
CORPUS = LOCAL / "OpenLegalData" / "misgrounding-corpus"
MATRIX = ARCHIVE / "c4-claim-matrix-20260731c.jsonl"

# Stage 7's frozen operating point (experiment log "Threshold freeze
# (2026-07-30, pre-run)"). Reproduced here as data, not re-derived.
FROZEN = {
    "novel_content_fraction": 0.666667,
    "unattested_trigram_share": 0.823529,
    "prompt_only_share": 0.333333,
}
FROZEN_MIN_CONTENT_WORDS = 12

# Witness columns, with the direction each was REGISTERED in (higher =
# more overreach-shaped). Directions are frozen from the registration,
# never chosen from the data.
LINT_WITNESSES = [
    "novel_content_fraction",
    "unattested_trigram_share",
    "prompt_only_share",
    "prompt_alien_cooccurrence",
    "novel_abstraction_terms",
    "novel_absolutes",
    "modality_upgrade",
    "entity_count",
]


def read_jsonl(path: Path):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


# ------------------------------------------------------------------ stats


def auc(neg: np.ndarray, pos: np.ndarray) -> float:
    """Rank-AUC, ties 0.5. P(score(positive) > score(negative))."""
    if neg.size == 0 or pos.size == 0:
        return float("nan")
    order = np.argsort(np.concatenate([neg, pos]), kind="mergesort")
    ranks = np.empty(order.size, dtype=float)
    values = np.concatenate([neg, pos])[order]
    i = 0
    while i < order.size:
        j = i
        while j + 1 < order.size and values[j + 1] == values[i]:
            j += 1
        ranks[order[i : j + 1]] = (i + j) / 2 + 1
        i = j + 1
    pos_ranks = ranks[neg.size :].sum()
    return float(
        (pos_ranks - pos.size * (pos.size + 1) / 2) / (pos.size * neg.size)
    )


def auc_scored(scores: np.ndarray, labels: np.ndarray) -> float:
    return auc(scores[labels == 0], scores[labels == 1])


def percentile_ranks(values: np.ndarray) -> np.ndarray:
    """Average-rank percentile transform. Label-free."""
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(values.size, dtype=float)
    i = 0
    while i < values.size:
        j = i
        while j + 1 < values.size and values[order[j + 1]] == values[order[i]]:
            j += 1
        ranks[order[i : j + 1]] = (i + j) / 2
        i = j + 1
    return ranks / max(1, values.size - 1)


def rank_cache(matrix: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    return {name: percentile_ranks(values) for name, values in matrix.items()}


def rank_sum(ranks: dict[str, np.ndarray], subset: tuple[str, ...]) -> np.ndarray:
    if not subset:
        return np.zeros(len(next(iter(ranks.values()))))
    total = ranks[subset[0]].copy()
    for name in subset[1:]:
        total = total + ranks[name]
    return total


class Bootstrap:
    """Cluster bootstrap: resample the label-carrying unit, with a fixed
    seed so every band in the log is reproducible from this script."""

    def __init__(self, clusters: np.ndarray, boot: int, seed: int = 20260731):
        self.groups = collections.defaultdict(list)
        for index, key in enumerate(clusters):
            self.groups[key].append(index)
        self.keys = list(self.groups)
        rng = np.random.default_rng(seed)
        self.draws = [
            np.concatenate(
                [
                    self.groups[self.keys[k]]
                    for k in rng.integers(0, len(self.keys), len(self.keys))
                ]
            )
            for _ in range(boot)
        ]

    def band(self, statistic, *arrays) -> tuple[float, float, int]:
        """95% percentile band of `statistic(*resampled arrays)`.
        Returns (lo, hi, usable draws)."""
        values = []
        for draw in self.draws:
            value = statistic(*(array[draw] for array in arrays))
            if value == value:  # not NaN
                values.append(value)
        if not values:
            return float("nan"), float("nan"), 0
        return (
            float(np.percentile(values, 2.5)),
            float(np.percentile(values, 97.5)),
            len(values),
        )


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra, rb = percentile_ranks(a), percentile_ranks(b)
    if ra.std() == 0 or rb.std() == 0:
        return float("nan")
    return float(np.corrcoef(ra, rb)[0, 1])


def logistic_cv_auc(ranks, subset, labels, clusters, folds=10) -> float:
    """Leave-cluster-group-out CV AUC of an L2 logistic combiner.
    A measuring instrument for redundancy analysis, never shipped."""
    if not subset:
        return float("nan")
    X = np.column_stack([ranks[n] for n in subset])
    X = np.column_stack([np.ones(X.shape[0]), X])
    keys = sorted(set(clusters))
    rng = np.random.default_rng(20260731)
    assign = {k: int(i) for k, i in zip(keys, rng.integers(0, folds, len(keys)))}
    fold_of = np.array([assign[c] for c in clusters])
    scores = np.zeros(labels.size)
    for fold in range(folds):
        train, test = fold_of != fold, fold_of == fold
        if not test.any() or labels[train].sum() == 0 or (1 - labels[train]).sum() == 0:
            scores[test] = 0.0
            continue
        beta = np.zeros(X.shape[1])
        for _ in range(50):
            eta = X[train] @ beta
            p = 1 / (1 + np.exp(-np.clip(eta, -30, 30)))
            W = np.clip(p * (1 - p), 1e-6, None)
            H = X[train].T @ (X[train] * W[:, None]) + 1e-3 * np.eye(X.shape[1])
            g = X[train].T @ (labels[train] - p) - 1e-3 * beta
            step = np.linalg.solve(H, g)
            beta += step
            if np.abs(step).max() < 1e-8:
                break
        scores[test] = X[test] @ beta
    return auc_scored(scores, labels)


# ------------------------------------------------------------------ lanes


def load_expert():
    """RegLab expert lane, with citator-derived columns joined."""
    claims = {
        (row["row_key"], row["sentence_index"]): row
        for row in read_jsonl(CORPUS / "reglab_claims.jsonl")
    }
    resolution = {}
    court = {}
    for row in read_jsonl(CORPUS / "us_sources" / "citations.jsonl"):
        resolution[row["citation"]] = bool(row.get("cases"))
        levels = []
        for case in row.get("cases") or []:
            name = case.get("court") or ""
            if name == "Supreme Court of the United States":
                levels.append(5)
            elif name.startswith("United States Court of Appeals"):
                levels.append(4)
            elif name.startswith("United States District Court"):
                levels.append(3)
            # state courts: typed refusal, no federal/state ordering is settled
        court[row["citation"]] = max(levels) if levels else None

    rows = []
    for row in read_jsonl(CORPUS / "us_sources" / "claim_features.jsonl"):
        source = claims.get((row["row_key"], row["sentence_index"]))
        cites = (source or {}).get("citations") or []
        levels = [court.get(c) for c in cites if court.get(c) is not None]
        row = dict(row)
        row["text"] = (source or {}).get("claim", "")
        row["citator"] = {
            "n_citations": len(cites),
            "resolved_share": (
                sum(1 for c in cites if resolution.get(c)) / len(cites)
                if cites
                else 0.0
            ),
            "max_court_level": max(levels) if levels else None,
            "n_sources": row.get("n_sources", 0),
            "citation_inherited": 1 if row.get("citation_inherited") else 0,
        }
        rows.append(row)
    return rows


def load_checker():
    return list(read_jsonl(MATRIX))


def fired(features: dict, content_words: int) -> list[str]:
    """The shipped lint's frozen Stage 7 firing rule, replayed offline."""
    if content_words < FROZEN_MIN_CONTENT_WORDS:
        return []
    out = []
    for name, threshold in FROZEN.items():
        value = features.get(name)
        if value is not None and value > threshold:
            out.append(name)
    return out


# ------------------------------------------------------------------ report

REPORT: list[str] = []


def say(line: str = "") -> None:
    REPORT.append(line)
    print(line)


def study(
    title: str,
    matrix: dict[str, np.ndarray],
    labels: np.ndarray,
    clusters: np.ndarray,
    boot: int,
    fit: bool,
) -> dict:
    names = [n for n in matrix if matrix[n].std() > 0]
    dropped = [n for n in matrix if n not in names]
    ranks = rank_cache({n: matrix[n] for n in names})
    bootstrap = Bootstrap(clusters, boot)
    n_pos, n_neg = int(labels.sum()), int((1 - labels).sum())
    n_clusters = len(set(clusters))
    pos_clusters = len({c for c, y in zip(clusters, labels) if y == 1})
    say(f"\n### {title}")
    say(
        f"n = {labels.size} rows ({n_pos} positive / {n_neg} negative) in "
        f"{n_clusters} clusters ({pos_clusters} carry a positive). "
        f"Bootstrap: {boot} cluster resamples."
    )
    if dropped:
        say(f"zero-variance witnesses dropped from this set: {', '.join(dropped)}")

    say("")
    say(f"{'witness':30s} {'AUC':>6s} {'95% CI':>16s} {'pos mean':>9s} {'neg mean':>9s}")
    solo = {}
    for name in names:
        area = auc_scored(matrix[name], labels)
        lo, hi, _ = bootstrap.band(auc_scored, matrix[name], labels)
        solo[name] = area
        say(
            f"{name:30s} {area:6.3f} [{lo:6.3f},{hi:6.3f}] "
            f"{matrix[name][labels == 1].mean():9.3f} "
            f"{matrix[name][labels == 0].mean():9.3f}"
        )

    full = tuple(names)
    full_auc = auc_scored(rank_sum(ranks, full), labels)
    lo, hi, _ = bootstrap.band(
        lambda s, y: auc_scored(s, y), rank_sum(ranks, full), labels
    )
    say("")
    say(
        f"frozen rank-sum over all {len(full)} witnesses: AUC {full_auc:.3f} "
        f"[{lo:.3f},{hi:.3f}]"
    )

    # exhaustive best subset under the frozen combiner
    subsets = [
        s
        for k in range(1, len(names) + 1)
        for s in itertools.combinations(names, k)
    ]
    subset_auc = {s: auc_scored(rank_sum(ranks, s), labels) for s in subsets}
    best = max(subset_auc, key=subset_auc.get)
    say(
        f"best rank-sum subset (in-sample, {len(subsets)} searched): "
        f"AUC {subset_auc[best]:.3f} = {{{', '.join(best)}}}"
    )

    say("")
    say(
        f"{'witness':30s} {'dAUC remove':>12s} {'95% CI':>16s} "
        f"{'dAUC add-to-best':>17s} {'95% CI':>16s}"
    )
    marginal = {}

    # paired bootstrap on the DELTA: recompute both arms on the SAME
    # resample so the band is on the difference, not on two AUCs.
    def paired(scores_a, scores_b, y):
        return auc_scored(scores_a, y) - auc_scored(scores_b, y)

    for name in names:
        without = tuple(n for n in full if n != name)
        removed = full_auc - auc_scored(rank_sum(ranks, without), labels)
        r_lo, r_hi, _ = bootstrap.band(
            paired, rank_sum(ranks, full), rank_sum(ranks, without), labels
        )

        pool = [s for s in subsets if name not in s]
        best_without = max(pool, key=subset_auc.get) if pool else ()
        with_name = tuple(sorted(set(best_without) | {name}, key=names.index))
        added = subset_auc[with_name] - (
            subset_auc[best_without] if best_without else 0.5
        )
        a_lo, a_hi, _ = bootstrap.band(
            paired,
            rank_sum(ranks, with_name),
            rank_sum(ranks, best_without),
            labels,
        )
        marginal[name] = {
            "remove": removed,
            "remove_ci": [r_lo, r_hi],
            "add": added,
            "add_ci": [a_lo, a_hi],
            "best_subset_without": list(best_without),
        }
        say(
            f"{name:30s} {removed:+12.3f} [{r_lo:+6.3f},{r_hi:+6.3f}] "
            f"{added:+17.3f} [{a_lo:+6.3f},{a_hi:+6.3f}]"
        )

    redundancy = {}
    for row_name in names:
        for col_name in names:
            if row_name == col_name:
                continue
            pair = tuple(sorted({row_name, col_name}, key=names.index))
            redundancy[f"{row_name}|{col_name}"] = {
                "rho": spearman(matrix[row_name], matrix[col_name]),
                "delta": subset_auc[pair] - subset_auc[(row_name,)],
            }
    shown = sorted(names, key=lambda n: -abs(solo[n] - 0.5))[:6]
    say("")
    say(
        "redundancy, top 6 witnesses by |AUC-0.5| — cell = Spearman rho / "
        "dAUC of adding COLUMN to ROW alone. Full matrix in the receipt."
    )
    say(f"{'':22s}" + "".join(f"{n[:12]:>14s}" for n in shown))
    for row_name in shown:
        cells = []
        for col_name in shown:
            if row_name == col_name:
                cells.append(f"{'-':>14s}")
                continue
            entry = redundancy[f"{row_name}|{col_name}"]
            cells.append(f"{entry['rho']:+.2f}/{entry['delta']:+.3f}".rjust(14))
        say(f"{row_name[:21]:22s}" + "".join(cells))

    fitted = None
    if fit and n_pos >= 30:
        fitted = logistic_cv_auc(ranks, full, labels, clusters)
        say("")
        say(
            f"fitted L2 logistic combiner, leave-cluster-group-out CV: "
            f"AUC {fitted:.3f} (instrument only — never a shipping artifact)"
        )
    elif fit:
        say("")
        say(
            f"fitted combiner NOT run: {n_pos} positives cannot support a "
            f"{len(full)}-parameter fit even under CV."
        )

    return {
        "title": title,
        "n": int(labels.size),
        "positives": n_pos,
        "clusters": n_clusters,
        "positive_clusters": pos_clusters,
        "solo": solo,
        "rank_sum_all": full_auc,
        "best_subset": {"witnesses": list(best), "auc": subset_auc[best]},
        "marginal": marginal,
        "redundancy": redundancy,
        "fitted_cv_auc": fitted,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--boot", type=int, default=2000)
    parser.add_argument(
        "--out", default=str(ARCHIVE / "c4-h7-study-20260731.json")
    )
    args = parser.parse_args()
    results: dict = {"boot": args.boot}

    say("# C4 ensemble / marginal-value study + H7 decision-quality half")
    say("# EXPLORATORY — checker-derived and weakly-propagated labels only.")

    # ---------------------------------------------------------- EXPERT lane
    say("\n## Lane 1 — RegLab expert labels (weak, response-level)")
    expert = load_expert()
    responses: dict[str, str] = {}
    for row in expert:
        responses[row["row_key"]] = row["label"]
    say(
        f"claims {len(expert)} over {len(responses)} responses "
        f"({collections.Counter(responses.values())})"
    )
    say(
        "The response is the unit the expert labelled; claim rows inherit it. "
        "All bands below are cluster-bootstrapped over responses."
    )

    def expert_matrix(rows):
        matrix = {n: np.array([r["features"].get(n, 0.0) for r in rows]) for n in LINT_WITNESSES}
        matrix["attested_trigram_share"] = np.array(
            [r["features"].get("attested_trigram_share", 0.0) for r in rows]
        )
        for name in ("n_citations", "resolved_share", "n_sources", "citation_inherited"):
            matrix[f"cit_{name}"] = np.array(
                [float(r["citator"][name]) for r in rows]
            )
        matrix["cit_max_court_level"] = np.array(
            [
                float(r["citator"]["max_court_level"])
                if r["citator"]["max_court_level"] is not None
                else 0.0
                for r in rows
            ]
        )
        return matrix

    # exact-duplicate check before anything else
    m_all = expert_matrix(expert)
    dupes = []
    for a, b in itertools.combinations(sorted(m_all), 2):
        if np.allclose(m_all[a] + m_all[b], 1.0, atol=1e-9):
            dupes.append((a, b, "affine complement (a + b == 1)"))
        elif np.allclose(m_all[a], m_all[b]):
            dupes.append((a, b, "identical"))
    say("")
    # Drop the DERIVED member of an exact pair, keeping the registered
    # witness: attested_trigram_share is 1 - unattested by construction,
    # and H13 registers the unattested share.
    derived = {"attested_trigram_share"}
    drop = {(b if b in derived or a not in derived else a) for a, b, _ in dupes}
    for a, b, kind in dupes:
        say(
            f"EXACT REDUNDANCY: {a} and {b} — {kind}. "
            f"Dropped {b if b in drop else a} from the ensemble."
        )
    results["exact_redundancy"] = [list(d) for d in dupes]

    for label_set, negatives, name in (
        (("misgrounded",), ("grounded",), "misgrounded vs grounded"),
        (
            ("misgrounded", "ungrounded"),
            ("grounded",),
            "misgrounded + ungrounded vs grounded",
        ),
    ):
        rows = [r for r in expert if r["label"] in label_set + negatives]
        labels = np.array([1 if r["label"] in label_set else 0 for r in rows])
        clusters = np.array([r["row_key"] for r in rows])
        matrix = {k: v for k, v in expert_matrix(rows).items() if k not in drop}
        results[f"expert_claim_{name}"] = study(
            f"EXPERT lane, claim rows, positive = {name}",
            matrix,
            labels,
            clusters,
            args.boot,
            fit=True,
        )

    # response-level max-pool: the honest unit for expert labels
    by_response: dict[str, list] = collections.defaultdict(list)
    for row in expert:
        by_response[row["row_key"]].append(row)
    pooled_rows = []
    for key, group in by_response.items():
        merged = {"row_key": key, "label": group[0]["label"], "features": {}, "citator": {}}
        for name in LINT_WITNESSES + ["attested_trigram_share"]:
            merged["features"][name] = max(
                r["features"].get(name, 0.0) for r in group
            )
        for name in ("n_citations", "resolved_share", "n_sources", "citation_inherited"):
            merged["citator"][name] = max(float(r["citator"][name]) for r in group)
        levels = [
            r["citator"]["max_court_level"]
            for r in group
            if r["citator"]["max_court_level"] is not None
        ]
        merged["citator"]["max_court_level"] = max(levels) if levels else None
        pooled_rows.append(merged)
    for label_set, negatives, name in (
        (("misgrounded",), ("grounded",), "misgrounded vs grounded"),
        (
            ("misgrounded", "ungrounded"),
            ("grounded",),
            "misgrounded + ungrounded vs grounded",
        ),
    ):
        rows = [r for r in pooled_rows if r["label"] in label_set + negatives]
        labels = np.array([1 if r["label"] in label_set else 0 for r in rows])
        clusters = np.array([r["row_key"] for r in rows])
        matrix = {k: v for k, v in expert_matrix(rows).items() if k not in drop}
        results[f"expert_response_{name}"] = study(
            f"EXPERT lane, response rows (max-pooled), positive = {name}",
            matrix,
            labels,
            clusters,
            args.boot,
            fit=True,
        )

    # ---------------------------------------------------------- CHECKER lane
    say("\n\n## Lane 2 — checker-derived labels (receipt matrix)")
    checker = [r for r in load_checker() if not r["lint_in_loop"]]
    say(
        f"claim rows {len(checker)} after dropping Stage 7 lint_gated "
        f"(post-revision text, lint was in the loop)"
    )
    live = [r for r in checker if not r["deterministic_support"]]
    say(
        f"non-deterministic (lint-eligible) claim rows: {len(live)} in "
        f"{len({r['cell_key'] for r in live})} cells"
    )

    def checker_matrix(rows):
        matrix = {
            n: np.array([float(r["features"].get(n, 0.0)) for r in rows])
            for n in LINT_WITNESSES
        }
        # attested_trigram_share is 1 - unattested by construction and is
        # omitted here for the same reason it is dropped in lane 1.
        matrix["cit_citer_count"] = np.array(
            [float(r["citator"]["citer_count"] or 0) for r in rows]
        )
        matrix["cit_court_level"] = np.array(
            [float(r["citator"]["cited_court_level"] or 0) for r in rows]
        )
        matrix["cit_profile_usable"] = np.array(
            [float(r["citator"]["profile_usable"] or 0) for r in rows]
        )
        # The premise-correction witness the Stage 7 verdict registered for
        # C4 by name and nobody ever added: premise corrections are
        # novel-content BY DESIGN (they contradict the prompt using the
        # source's own distinctions), so the novel-content witnesses cannot
        # tell them from overreach without it.
        # Only where EVERY cell in the set is from a typed-role era; a
        # mixed set would make the column a stage proxy.
        if all(r.get("kinds") for r in rows):
            matrix["role_premise_correction"] = np.array(
                [float(r["kinds"].get("premise_correction", 0)) for r in rows]
            )
            matrix["role_conclusion"] = np.array(
                [float(r["kinds"].get("conclusion", 0)) for r in rows]
            )
        return matrix

    # C2 claim-level propagation, reproducing the existing solo harness
    c2 = [r for r in live if r["c2_label"] is not None]
    say("")
    say(
        f"C2 propagation reproduced: {len(c2)} claims "
        f"({sum(1 for r in c2 if r['c2_label'] == 'accepted')} accepted / "
        f"{sum(1 for r in c2 if r['c2_label'] == 'rejected')} rejected)"
    )
    sizes = collections.Counter(
        (r["c2_label"], min(r["claims_in_cell"], 4)) for r in c2
    )
    say(
        "STRUCTURAL CONFOUND in the C2 label — claims-per-cell by label "
        f"(4 = 4+): {dict(sorted(sizes.items()))}. The rule only calls a "
        "claim 'rejected' inside a ONE-claim cell, so every rejected claim "
        "is drawn from a different cell-shape population than the accepted "
        "ones. Any witness correlated with claim count or answer length "
        "inherits that."
    )
    labels = np.array([1 if r["c2_label"] == "rejected" else 0 for r in c2])
    clusters = np.array([r["cell_key"] for r in c2])
    results["checker_c2_claims"] = study(
        "CHECKER lane, claim rows, C2 propagation (positive = rejected)",
        checker_matrix(c2),
        labels,
        clusters,
        args.boot,
        fit=True,
    )

    # The same comparison with the confound removed: one-claim cells only,
    # so accepted and rejected claims come from the same cell shape.
    matched = [r for r in c2 if r["claims_in_cell"] == 1]
    results["checker_c2_claims_matched"] = study(
        "CHECKER lane, C2 propagation restricted to ONE-claim cells "
        "(confound removed)",
        checker_matrix(matched),
        np.array([1 if r["c2_label"] == "rejected" else 0 for r in matched]),
        np.array([r["cell_key"] for r in matched]),
        args.boot,
        fit=True,
    )

    # cell-level max-pool: the honest unit, the checker judges the cell
    cells: dict[str, list] = collections.defaultdict(list)
    for row in live:
        cells[row["cell_key"]].append(row)
    cell_rows = []
    for key, group in cells.items():
        merged = {
            "cell_key": key,
            "cell_reject": group[0]["cell_reject"],
            "stage": group[0]["stage"],
            "source_class": group[0]["source_class"],
            "jurisdiction": group[0]["jurisdiction"],
            "features": {},
            "citator": {},
            "claims": group,
            "kinds": collections.Counter(
                r["claim_kind"] for r in group if r["claim_kind"]
            ),
            "target_token_f1": group[0]["target_token_f1"],
        }
        for name in LINT_WITNESSES + ["attested_trigram_share"]:
            merged["features"][name] = max(
                float(r["features"].get(name, 0.0)) for r in group
            )
        merged["citator"] = {
            "citer_count": max(float(r["citator"]["citer_count"] or 0) for r in group),
            "cited_court_level": max(
                float(r["citator"]["cited_court_level"] or 0) for r in group
            ),
            "profile_usable": max(
                float(r["citator"]["profile_usable"] or 0) for r in group
            ),
        }
        cell_rows.append(merged)

    labels = np.array([r["cell_reject"] for r in cell_rows])
    clusters = np.array([r["cell_key"] for r in cell_rows])
    results["checker_cells"] = study(
        "CHECKER lane, cell rows (max-pooled witnesses) — the honest unit",
        checker_matrix(cell_rows),
        labels,
        clusters,
        args.boot,
        fit=True,
    )

    # Stage 9's banked conclusion-claim alienness spectrum, the C4 matrix
    # growth the log recorded on 424/515 cells and never analysed. The
    # three components sum to 1 by construction, so only two are free;
    # they enter alongside the recomputed max-pooled lint witnesses.
    say("")
    spectrum_rows = [
        r
        for r in cell_rows
        if r["stage"] == "stage9-h19h20" and r["claims"][0]["conclusion_alienness"]
    ]
    say(
        f"Stage 9 banked conclusion-claim alienness spectra usable at cell "
        f"level: {len(spectrum_rows)} cells"
    )
    if len(spectrum_rows) >= 100:
        matrix = checker_matrix(spectrum_rows)
        for part in ("unattested", "boilerplate", "attestedRare", "trigrams"):
            matrix[f"concl_{part}"] = np.array(
                [
                    float(r["claims"][0]["conclusion_alienness"][part])
                    for r in spectrum_rows
                ]
            )
        results["checker_stage9_spectrum"] = study(
            "CHECKER lane, Stage 9 cells with the banked conclusion-alienness "
            "spectrum (the C4 input registered five times, never analysed)",
            matrix,
            np.array([r["cell_reject"] for r in spectrum_rows]),
            np.array([r["cell_key"] for r in spectrum_rows]),
            args.boot,
            fit=True,
        )

    for source_class in ("case", "legislation"):
        sub = [r for r in cell_rows if r["source_class"] == source_class]
        if len(sub) < 40:
            continue
        results[f"checker_cells_{source_class}"] = study(
            f"CHECKER lane, cell rows, source_class = {source_class}",
            checker_matrix(sub),
            np.array([r["cell_reject"] for r in sub]),
            np.array([r["cell_key"] for r in sub]),
            args.boot,
            fit=True,
        )

    # ------------------------------------------------------------------ H7
    say("\n\n## H7 — the decision-quality disjunct (C3 gate, never measured)")
    say(
        "C3's gate was 'no audited-pair regression, checker-call reduction OR "
        "decision-quality gain'. Stage 7 measured the economic disjunct only. "
        "Decision quality = does the deterministic lint predict the checker's "
        "own reject verdict? Measured on receipts where the lint was NEVER in "
        "the loop, so the archived claim text is what the composer wrote."
    )
    h7: dict = {}
    beds = [
        ("stage9-h19h20", [r for r in cell_rows if r["stage"] == "stage9-h19h20"]),
        (
            "stage7-h7 tiered_check control",
            [
                r
                for r in cell_rows
                if r["stage"] == "stage7-h7"
                and all(c["arm"] == "tiered_check" for c in r["claims"])
            ],
        ),
        ("all lint-free stages pooled", cell_rows),
    ]
    say("")
    say(
        f"{'bed':34s} {'cells':>6s} {'rej':>5s} {'fired':>6s} {'TP':>4s} "
        f"{'prec':>6s} {'rec':>6s} {'lift':>6s} {'AUC(max)':>9s} {'95% CI':>16s}"
    )
    for name, rows in beds:
        if not rows:
            continue
        y = np.array([r["cell_reject"] for r in rows])
        flags = np.array(
            [
                1
                if any(
                    fired(c["features"], c["claim_content_words"]) for c in r["claims"]
                )
                else 0
                for r in rows
            ]
        )
        tp = int(((flags == 1) & (y == 1)).sum())
        fp = int(((flags == 1) & (y == 0)).sum())
        base = y.mean()
        precision = tp / (tp + fp) if (tp + fp) else float("nan")
        recall = tp / max(1, int(y.sum()))
        # continuous ceiling: best single max-pooled lint witness
        best_auc, best_name, band = -1.0, None, (float("nan"), float("nan"))
        bootstrap = Bootstrap(np.array([r["cell_key"] for r in rows]), args.boot)
        for witness in FROZEN:
            values = np.array([float(r["features"][witness]) for r in rows])
            area = auc_scored(values, y)
            if area > best_auc:
                best_auc, best_name = area, witness
                lo, hi, _ = bootstrap.band(auc_scored, values, y)
                band = (lo, hi)
        say(
            f"{name:34s} {len(rows):6d} {int(y.sum()):5d} {int(flags.sum()):6d} "
            f"{tp:4d} {precision:6.3f} {recall:6.3f} "
            f"{(precision / base if base and precision == precision else float('nan')):6.2f} "
            f"{best_auc:9.3f} [{band[0]:6.3f},{band[1]:6.3f}]"
        )
        h7[name] = {
            "cells": len(rows),
            "rejects": int(y.sum()),
            "base_rate": float(base),
            "fired": int(flags.sum()),
            "tp": tp,
            "fp": fp,
            "precision": precision,
            "recall": recall,
            "best_frozen_witness": best_name,
            "best_frozen_witness_auc": best_auc,
            "best_frozen_witness_ci": list(band),
        }
    say("")
    say(
        "'lift' = precision / base rate. A gate with lift 1.00 selects claims "
        "the checker rejects at exactly the population rate: zero decision "
        "value. 'AUC(max)' is the CEILING the frozen thresholds are giving up "
        "— the best single max-pooled frozen witness scored continuously."
    )

    # Where does the gate's apparent signal come from? Stratify by the two
    # populations the lint was supposed to help with: adversarial items
    # (built to induce misgrounding) and cells carrying a typed premise
    # correction (novel-content BY DESIGN — the Stage 7 decode).
    def gate_stats(rows):
        if not rows:
            return None
        y = np.array([r["cell_reject"] for r in rows])
        flags = np.array(
            [
                1
                if any(
                    fired(c["features"], c["claim_content_words"]) for c in r["claims"]
                )
                else 0
                for r in rows
            ]
        )
        tp = int(((flags == 1) & (y == 1)).sum())
        base = float(y.mean())
        precision = tp / int(flags.sum()) if flags.sum() else float("nan")
        return {
            "cells": len(rows),
            "base_rate": base,
            "flag_rate": float(flags.mean()),
            "precision": precision,
            "lift": precision / base if base else float("nan"),
            "recall": tp / max(1, int(y.sum())),
        }

    say("")
    say("gate stratified by the populations it was built for:")
    say(
        f"{'stratum':44s} {'cells':>6s} {'base':>6s} {'flag':>6s} "
        f"{'prec':>6s} {'lift':>6s} {'rec':>6s}"
    )
    strat = {}
    typed_era = [r for r in cell_rows if r["kinds"]]
    for name, rows in (
        ("ordinary items", [r for r in cell_rows if not r["claims"][0]["adversarial"]]),
        ("adversarial items", [r for r in cell_rows if r["claims"][0]["adversarial"]]),
        (
            "typed era, no premise correction",
            [r for r in typed_era if not r["kinds"].get("premise_correction")],
        ),
        (
            "typed era, cell has a premise correction",
            [r for r in typed_era if r["kinds"].get("premise_correction")],
        ),
    ):
        stats = gate_stats(rows)
        if not stats:
            continue
        strat[name] = stats
        say(
            f"{name:44s} {stats['cells']:6d} {stats['base_rate']:6.3f} "
            f"{stats['flag_rate']:6.3f} {stats['precision']:6.3f} "
            f"{stats['lift']:6.2f} {stats['recall']:6.3f}"
        )
    h7["stratified"] = strat

    # The checker-independent half: does lint firing track a GOLD-derived
    # quality axis? target_token_f1 is scored against the benchmark target,
    # so it cannot inherit the checker's 0-13% flip rate. If flagged cells
    # the checker ACCEPTED score worse on gold than unflagged accepted
    # cells, the lint is carrying decision information the checker missed;
    # if they score the same, it is not.
    say("")
    say("gold-derived control (target_token_f1, checker-independent):")
    say(
        f"{'stratum':40s} {'cells':>6s} {'mean F1':>8s} {'median':>8s} "
        f"{'AUC(flag->low F1)':>18s} {'95% CI':>16s}"
    )
    gold: dict = {}
    strata = [
        ("accepted cells (holistic supported)", [r for r in cell_rows if not r["cell_reject"]]),
        ("rejected cells", [r for r in cell_rows if r["cell_reject"]]),
        ("all lint-free cells", cell_rows),
    ]
    for name, rows in strata:
        rows = [r for r in rows if r["target_token_f1"] is not None]
        if len(rows) < 40:
            continue
        flags = np.array(
            [
                1
                if any(
                    fired(c["features"], c["claim_content_words"]) for c in r["claims"]
                )
                else 0
                for r in rows
            ]
        )
        f1 = np.array([float(r["target_token_f1"]) for r in rows])
        if flags.sum() == 0 or flags.sum() == flags.size:
            continue
        # AUC of "flagged" as a predictor of LOW gold F1 (score = -F1)
        area = auc_scored(-f1, flags)
        bootstrap = Bootstrap(np.array([r["cell_key"] for r in rows]), args.boot)
        lo, hi, _ = bootstrap.band(auc_scored, -f1, flags)
        say(
            f"{name + ' — flagged':40s} {int(flags.sum()):6d} "
            f"{f1[flags == 1].mean():8.3f} {float(np.median(f1[flags == 1])):8.3f} "
            f"{area:18.3f} [{lo:6.3f},{hi:6.3f}]"
        )
        say(
            f"{name + ' — unflagged':40s} {int((1 - flags).sum()):6d} "
            f"{f1[flags == 0].mean():8.3f} {float(np.median(f1[flags == 0])):8.3f}"
        )
        gold[name] = {
            "flagged": int(flags.sum()),
            "unflagged": int((1 - flags).sum()),
            "mean_f1_flagged": float(f1[flags == 1].mean()),
            "mean_f1_unflagged": float(f1[flags == 0].mean()),
            "auc_flag_predicts_low_f1": area,
            "ci": [lo, hi],
        }
    h7["gold_control"] = gold

    # lint-flagged-but-accepted: the audit sample
    flagged_accepted = []
    for row in cell_rows:
        for claim in row["claims"]:
            names_fired = fired(claim["features"], claim["claim_content_words"])
            if names_fired and row["cell_reject"] == 0:
                flagged_accepted.append(
                    {
                        "stage": claim["stage"],
                        "case_id": claim["case_id"],
                        "arm": claim["arm"],
                        "model": claim["model"],
                        "fired": names_fired,
                        "values": {k: claim["features"][k] for k in FROZEN},
                        "content_words": claim["claim_content_words"],
                        "claim_kind": claim["claim_kind"],
                        "adversarial": claim["adversarial"],
                        "target_token_f1": claim["target_token_f1"],
                    }
                )
    say("")
    say(
        f"lint-flagged-but-accepted claims: {len(flagged_accepted)} "
        f"(these are the cells a human audit would be pointed at). "
        f"Full list in the receipt."
    )
    for item in flagged_accepted[:12]:
        say(
            f"  {item['stage']:20s} {item['case_id']:22s} {item['arm']:18s} "
            f"{','.join(item['fired'])}"
        )
    h7["flagged_accepted"] = flagged_accepted
    results["h7"] = h7

    out = Path(args.out)
    body = json.dumps(results, indent=2, default=float)
    out.write_text(body + "\n", encoding="utf-8")
    report = out.with_suffix(".txt")
    report.write_text("\n".join(REPORT) + "\n", encoding="utf-8")
    print()
    for path in (out, report):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        print(f"{path}  sha256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
