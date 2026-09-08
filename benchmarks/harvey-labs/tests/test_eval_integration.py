"""Evaluation regressions not covered by the shared rubric strategy suite."""

import json

from evaluation.run_eval import evaluate_run


def test_doc_coverage_uses_total_documents(rubric_run, rubric_judge):
    """Read producer metrics, not the obsolete total_vdr_files field."""
    (rubric_run.run_dir / "metrics.json").write_text(
        json.dumps(
            {
                "total_documents": 10,
                "documents_read": 7,
                "documents_skipped": 3,
                "documents_read_list": ["sample.txt"],
                "documents_skipped_list": ["unread.txt"],
                "total_vdr_files": 999,
            }
        ),
        encoding="utf-8",
    )
    scores = evaluate_run("test-run", rubric_run.task, rubric_judge(["pass"] * 4))
    assert scores["doc_coverage"] == {
        "total_documents": 10,
        "documents_read": 7,
        "documents_skipped": 3,
        "documents_read_list": ["sample.txt"],
        "documents_skipped_list": ["unread.txt"],
    }
    assert scores["cost"] == {"input_tokens": 0, "output_tokens": 0, "wall_clock_seconds": 0}


def test_missing_output_still_scores(rubric_run, rubric_judge):
    (rubric_run.run_dir / "output" / "memo.md").unlink()
    judge = rubric_judge(["fail"] * 4)
    scores = evaluate_run("test-run", rubric_run.task, judge)
    assert (scores["score"], scores["n_criteria"], scores["n_passed"]) == (0.0, 4, 0)
    assert [
        call.kwargs["variables"]["agent_output"] for call in judge.evaluate_from_file.call_args_list
    ] == [
        "## Agent Output: memo.md\n(File not found: memo.md)",
    ] * 4
    assert json.loads((rubric_run.run_dir / "scores.json").read_text(encoding="utf-8")) == scores
