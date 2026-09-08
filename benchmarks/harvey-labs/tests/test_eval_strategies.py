"""Evaluation outcomes and persisted records, using one fresh synthetic run."""

import json
from datetime import datetime

import pytest

from evaluation.run_eval import evaluate_run
from harness.run import load_task


@pytest.fixture
def evaluate(rubric_run, rubric_judge):
    def run(verdicts=("pass", "pass", "pass", "pass")):
        judge = rubric_judge(verdicts)
        return evaluate_run("test-run", rubric_run.task, judge), judge

    return run


class TestRubricEvaluation:
    def test_rubric_returns_expected_keys(self, evaluate):
        scores, _ = evaluate()
        assert set(scores) == {
            "run_id",
            "task",
            "score",
            "max_score",
            "summary",
            "criteria_results",
            "judge_model",
            "judge_effort",
            "scored_at",
            "all_pass",
            "n_passed",
            "n_criteria",
            "deliverable_match",
            "cost",
            "doc_coverage",
        }
        assert (scores["judge_model"], scores["judge_effort"]) == ("mock-judge", None)
        assert datetime.fromisoformat(scores["scored_at"]).utcoffset().total_seconds() == 0

    @pytest.mark.parametrize(
        "verdicts,expected",
        [
            pytest.param(["pass"] * 4, (1.0, 1.0, True, 4, 4), id="test_rubric_perfect_score"),
            pytest.param(["fail"] * 4, (0.0, 1.0, False, 0, 4), id="test_rubric_zero_score"),
            pytest.param(
                ["pass", "pass", "fail", "fail"],
                (0.0, 1.0, False, 2, 4),
                id="test_rubric_partial_pass_fails_task",
            ),
        ],
    )
    def test_rubric_score(self, evaluate, verdicts, expected):
        scores, _ = evaluate(verdicts)
        assert (
            scores["score"],
            scores["max_score"],
            scores["all_pass"],
            scores["n_passed"],
            scores["n_criteria"],
        ) == expected

    def test_rubric_criteria_results_structure(self, evaluate):
        scores, _ = evaluate(["pass", "fail", "pass", "fail"])
        assert scores["criteria_results"] == [
            {"id": "C-01", "title": "Criterion 1", "verdict": "pass", "reasoning": "Reason 1"},
            {"id": "C-02", "title": "Criterion 2", "verdict": "fail", "reasoning": "Reason 2"},
            {"id": "C-03", "title": "Criterion 3", "verdict": "pass", "reasoning": "Reason 3"},
            {"id": "C-04", "title": "Criterion 4", "verdict": "fail", "reasoning": "Reason 4"},
        ]

    def test_rubric_summary_readable(self, evaluate):
        scores, _ = evaluate()
        assert "4/4" in scores["summary"]
        assert "ALL-PASS" in scores["summary"]
        assert "FAIL" not in scores["summary"]

    def test_rubric_scores_json_written(self, evaluate, rubric_run):
        scores, _ = evaluate()
        assert (
            json.loads((rubric_run.run_dir / "scores.json").read_text(encoding="utf-8")) == scores
        )
        assert (scores["run_id"], scores["task"]) == ("test-run", "test-practice/test-task")

    def test_rubric_cost_from_metrics(self, evaluate):
        scores, _ = evaluate()
        assert scores["cost"] == {
            "input_tokens": 30000,
            "output_tokens": 5000,
            "wall_clock_seconds": 90,
        }

    def test_rubric_judge_called_per_criterion(self, evaluate):
        _, judge = evaluate()
        assert sorted(
            call.kwargs["variables"]["criterion_title"]
            for call in judge.evaluate_from_file.call_args_list
        ) == [
            "Criterion 1",
            "Criterion 2",
            "Criterion 3",
            "Criterion 4",
        ]

    def test_rubric_judge_receives_correct_prompt(self, evaluate):
        _, judge = evaluate()
        assert [call.kwargs["prompt_name"] for call in judge.evaluate_from_file.call_args_list] == [
            "rubric_criterion",
            "rubric_criterion",
            "rubric_criterion",
            "rubric_criterion",
        ]

    def test_rubric_judge_receives_correct_variables(self, evaluate):
        _, judge = evaluate()
        variables = sorted(
            (call.kwargs["variables"] for call in judge.evaluate_from_file.call_args_list),
            key=lambda item: item["criterion_title"],
        )
        assert variables == [
            {
                "task_description": "Test Task — café",
                "criterion_title": f"Criterion {i}",
                "match_criteria": f"Guidance {i}",
                "agent_output": "## Agent Output: memo.md\n# Memo\n\nEvidence — café.",
            }
            for i in range(1, 5)
        ]


class TestMultiDeliverable:
    def test_multi_deliverable_scoring(self, rubric_run, rubric_judge):
        config = rubric_run.config
        config["criteria"] = config["criteria"][:2]
        config["criteria"][1]["deliverables"] = ["checklist.md"]
        (rubric_run.task_dir / "task.json").write_text(json.dumps(config), encoding="utf-8")
        (rubric_run.run_dir / "output" / "checklist.md").write_text(
            "Checklist only.", encoding="utf-8"
        )
        judge = rubric_judge(["pass", "pass"])
        scores = evaluate_run("test-run", rubric_run.task, judge)
        assert (scores["score"], scores["n_criteria"], scores["n_passed"]) == (1.0, 2, 2)
        assert {
            call.kwargs["variables"]["criterion_title"]: call.kwargs["variables"]["agent_output"]
            for call in judge.evaluate_from_file.call_args_list
        } == {
            "Criterion 1": "## Agent Output: memo.md\n# Memo\n\nEvidence — café.",
            "Criterion 2": "## Agent Output: checklist.md\nChecklist only.",
        }


class TestValidation:
    def test_invalid_task_name_format_raises(self, rubric_run, rubric_judge):
        judge = rubric_judge([])
        with pytest.raises(ValueError, match="practice-area/task-slug"):
            evaluate_run("test-run", "bad-task-name", judge)
        judge.evaluate_from_file.assert_not_called()
        assert not (rubric_run.run_dir / "scores.json").exists()

    def test_missing_task_json_raises(self, rubric_run, rubric_judge):
        (rubric_run.task_dir / "task.json").unlink()
        judge = rubric_judge([])
        with pytest.raises(FileNotFoundError, match="task.json not found"):
            evaluate_run("test-run", rubric_run.task, judge)
        judge.evaluate_from_file.assert_not_called()
        assert not (rubric_run.run_dir / "scores.json").exists()

    def test_missing_criteria_key_raises(self, rubric_run, rubric_judge):
        del rubric_run.config["criteria"]
        (rubric_run.task_dir / "task.json").write_text(
            json.dumps(rubric_run.config), encoding="utf-8"
        )
        judge = rubric_judge([])
        with pytest.raises(ValueError, match="missing required key 'criteria'"):
            evaluate_run("test-run", rubric_run.task, judge)
        judge.evaluate_from_file.assert_not_called()
        assert not (rubric_run.run_dir / "scores.json").exists()


class TestTaskLoading:
    def test_load_synthetic_task(self, rubric_run):
        assert load_task(rubric_run.task) == {
            "name": "test-practice/test-task",
            "task_dir": str(rubric_run.task_dir),
            "docs_dir": str(rubric_run.task_dir / "documents"),
            "instructions": "Analyze the sample documents and produce a detailed memo.",
            "config": rubric_run.config,
        }

    def test_single_part_name_rejected(self, rubric_run):
        with pytest.raises(ValueError, match="practice-area/task-slug") as error:
            load_task("red-flag-review")
        assert "red-flag-review" in str(error.value)

    def test_nonexistent_task_raises(self, rubric_run):
        with pytest.raises(FileNotFoundError, match="task.json not found") as error:
            load_task("fake-practice/nonexistent-task")
        assert "fake-practice/nonexistent-task" in str(error.value).replace("\\", "/")
