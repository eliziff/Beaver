"""Offline scoring contracts: real text input, literal matching outcomes."""

from types import SimpleNamespace

import pytest

from evaluation.scoring import (
    RubricResult,
    _fuzzy_match_filename,
    _match_deliverables,
    score_rubric,
)


@pytest.fixture
def scoring_run(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    (output / "memo.md").write_text("Agent memo content.", encoding="utf-8")
    return tmp_path


@pytest.fixture
def criteria():
    return [
        {
            "id": f"C-{i:02d}",
            "title": f"Criterion {i}",
            "match_criteria": f"Guidance {i}",
            "deliverables": ["memo.md"],
        }
        for i in range(1, 4)
    ]


@pytest.mark.parametrize(
    "verdicts,score",
    [
        pytest.param(["pass", "pass", "pass"], 1.0, id="test_perfect_rubric"),
        pytest.param(["fail", "fail", "fail"], 0.0, id="test_all_fail_rubric"),
        pytest.param(["pass", "pass", "fail"], 0.0, id="test_mixed_rubric_fails_under_all_pass"),
    ],
)
def test_rubric_verdicts(scoring_run, criteria, rubric_judge, verdicts, score):
    result = score_rubric(criteria, scoring_run, rubric_judge(verdicts), "Test task", parallel=1)
    assert result.score == score
    assert result.max_score == 1.0
    assert result.criteria_results == [
        {
            "id": f"C-{i:02d}",
            "title": f"Criterion {i}",
            "verdict": verdict,
            "reasoning": f"Reason {i}",
        }
        for i, verdict in enumerate(verdicts, 1)
    ]
    assert result.deliverable_match == {"memo.md": {"resolved": "memo.md", "method": "exact"}}


def test_rubric_to_dict():
    assert RubricResult(score=0.75, max_score=1.0).to_dict() == {
        "score": 0.75,
        "max_score": 1.0,
        "criteria_results": [],
        "deliverable_match": None,
    }


def test_rubric_passes_task_desc_to_judge(scoring_run, criteria, rubric_judge):
    judge = rubric_judge(["pass"])
    score_rubric(criteria[:1], scoring_run, judge, "Draft LPA", parallel=1)
    judge.evaluate_from_file.assert_called_once_with(
        prompt_name="rubric_criterion",
        variables={
            "task_description": "Draft LPA",
            "criterion_title": "Criterion 1",
            "match_criteria": "Guidance 1",
            "agent_output": "## Agent Output: memo.md\nAgent memo content.",
        },
    )


def test_missing_output_file(scoring_run, criteria, rubric_judge):
    # A different same-extension file would be matched instead of being missing.
    (scoring_run / "output" / "memo.md").unlink()
    judge = rubric_judge(["fail"])
    result = score_rubric(criteria[:1], scoring_run, judge, "Test task", parallel=1)
    assert result.score == 0.0
    assert result.deliverable_match == {"memo.md": {"resolved": "memo.md", "method": "unmatched"}}
    assert judge.evaluate_from_file.call_args.kwargs["variables"]["agent_output"] == (
        "## Agent Output: memo.md\n(File not found: memo.md)"
    )


def test_docx_redline_option_uses_track_changes_all(
    scoring_run, criteria, rubric_judge, monkeypatch
):
    from unittest.mock import Mock

    docx = scoring_run / "output" / "memo.docx"
    docx.touch()
    for criterion in criteria[:2]:
        criterion["deliverables"] = ["memo.docx"]
    criteria[1]["evaluation_options"] = {"include_docx_redlines": True}
    run = Mock(
        side_effect=[
            SimpleNamespace(returncode=0, stdout="Accepted text", stderr=""),
            SimpleNamespace(returncode=0, stdout="Text with deletions", stderr=""),
        ]
    )
    monkeypatch.setattr("evaluation.scoring.subprocess.run", run)
    judge = rubric_judge(["pass", "pass"])
    result = score_rubric(criteria[:2], scoring_run, judge, "Test task", parallel=1)
    assert result.score == 1.0
    assert [call.args[0] for call in run.call_args_list] == [
        ["pandoc", str(docx), "-t", "markdown", "--wrap=none", "--track-changes=accept"],
        ["pandoc", str(docx), "-t", "markdown", "--wrap=none", "--track-changes=all"],
    ]
    assert [
        call.kwargs["variables"]["agent_output"] for call in judge.evaluate_from_file.call_args_list
    ] == [
        "## Agent Output: memo.docx\nAccepted text",
        "## Agent Output: memo.docx\nText with deletions",
    ]


@pytest.mark.parametrize(
    "expected,candidates,result",
    [
        pytest.param(
            "side-letter-blackhawk-municipal.docx",
            ["DRAFT-Side-Letter-Blackhawk.docx", "DRAFT-Side-Letter-Cascadia.docx"],
            ("DRAFT-Side-Letter-Blackhawk.docx", 3),
            id="test_picks_highest_overlap",
        ),
        pytest.param("report.xlsx", [], (None, 0), id="test_empty_candidates"),
        pytest.param(
            "report.docx",
            ["quarterly-report.docx"],
            ("quarterly-report.docx", 1),
            id="test_single_word_overlap_still_matches",
        ),
        pytest.param(
            "Cap-Table.xlsx", ["CAP_TABLE.xlsx"], ("CAP_TABLE.xlsx", 2), id="test_case_insensitive"
        ),
        pytest.param(
            "report.docx",
            ["annual-report.docx", "monthly-report.docx"],
            ("annual-report.docx", 1),
            id="test_tie_breaks_to_first_candidate",
        ),
        pytest.param(
            "financial-summary.xlsx",
            ["completely-unrelated.xlsx"],
            (None, 0),
            id="test_does_not_match_on_extension_alone",
        ),
        pytest.param(
            "cap-table.xlsx", ["recap-notes.xlsx"], (None, 0), id="test_partial_word_no_match"
        ),
    ],
)
def test_fuzzy_filename(expected, candidates, result):
    assert _fuzzy_match_filename(expected, candidates) == result


@pytest.mark.parametrize(
    "deliverables,files,resolved,methods",
    [
        pytest.param(
            {"memo": "memo.docx"},
            ["memo.docx", "other.pdf"],
            {"memo": "memo.docx"},
            {"memo": "exact"},
            id="test_exact_match",
        ),
        pytest.param(
            {"spreadsheet": "financial-data.xlsx"},
            ["completely_different_name.xlsx", "output.docx", "notes.txt"],
            {"spreadsheet": "completely_different_name.xlsx"},
            {"spreadsheet": "sole_extension"},
            id="test_single_file_with_extension",
        ),
        pytest.param(
            {"cap_table": "cap-table-update.xlsx"},
            ["cap-table-final.xlsx", "table-of-contents.xlsx", "output.docx"],
            {"cap_table": "cap-table-final.xlsx"},
            {"cap_table": "fuzzy:2"},
            id="test_fuzzy_does_not_match_on_single_common_word",
        ),
        pytest.param(
            {"memo": "legal-memo.docx"},
            ["spreadsheet.xlsx", "output.docx"],
            {"memo": "legal-memo.docx"},
            {"memo": "unmatched"},
            id="test_no_match_preserves_expected",
        ),
        pytest.param(
            {"memo": "legal-memo.md"},
            ["spreadsheet.xlsx", "output.md"],
            {"memo": "legal-memo.md"},
            {"memo": "unmatched"},
            id="test_output_md_excluded",
        ),
        pytest.param(
            {"data": "results.xlsx"},
            ["output.xlsx", "actual-results.xlsx"],
            {"data": "actual-results.xlsx"},
            {"data": "sole_extension"},
            id="test_output_any_extension_excluded",
        ),
        pytest.param(
            {"memo": "memo.docx", "spreadsheet": "data.xlsx"},
            ["memo.docx", "data.xlsx", "output.docx"],
            {"memo": "memo.docx", "spreadsheet": "data.xlsx"},
            {"memo": "exact", "spreadsheet": "exact"},
            id="test_multiple_deliverables",
        ),
        pytest.param(
            {"report_a": "report-a.docx", "report_b": "report-b.docx"},
            ["report-a.docx", "summary.docx", "output.docx"],
            {"report_a": "report-a.docx", "report_b": "summary.docx"},
            {"report_a": "exact", "report_b": "sole_extension"},
            id="test_used_files_not_reused",
        ),
        pytest.param(
            {"chronology": "case-chronology.xlsx"},
            ["case-chronology-summary.docx", "unrelated.pdf"],
            {"chronology": "case-chronology.xlsx"},
            {"chronology": "unmatched"},
            id="test_extension_mismatch_no_false_positive",
        ),
        pytest.param(
            {"letter": "side-letter-blackhawk-municipal.docx"},
            [
                "DRAFT-Side-Letter-Blackhawk.docx",
                "DRAFT-Side-Letter-Cascadia.docx",
                "DRAFT-Side-Letter-Gulf-Peninsula.docx",
                "output.docx",
            ],
            {"letter": "DRAFT-Side-Letter-Blackhawk.docx"},
            {"letter": "fuzzy:3"},
            id="test_fuzzy_picks_highest_overlap",
        ),
    ],
)
def test_deliverable_resolution(deliverables, files, resolved, methods):
    assert _match_deliverables(deliverables, files) == (resolved, methods)
