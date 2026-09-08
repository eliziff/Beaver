"""Discovery contracts must not depend on which benchmark tier is checked out."""

import json

import pytest

from utils import describe_task, list_tasks, sweep


@pytest.fixture
def tasks(tmp_path, monkeypatch):
    for module in (describe_task, list_tasks, sweep):
        monkeypatch.setattr(module, "BENCH_ROOT", tmp_path)
    for task_id, title in [
        ("test-area/workflow/scenario-01", "First — café"),
        ("test-area/workflow/scenario-02", "Second"),
        ("other-area/flat", "Unrelated"),
    ]:
        task = tmp_path / "tasks" / task_id
        task.mkdir(parents=True)
        (task / "task.json").write_text(
            json.dumps(
                {
                    "title": title,
                    "instructions": "Analyze the documents.",
                    "criteria": [{"id": "C-01", "title": "Finding", "match_criteria": "Supported"}],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    documents = tmp_path / "tasks/test-area/workflow/scenario-01/documents"
    documents.mkdir()
    (documents / "sample.txt").write_text("Synthetic source", encoding="utf-8")
    return tmp_path / "tasks"


def test_list_tasks_discovers_nested_tasks(tasks):
    assert [
        (task["id"], task["title"], task["criteria"], task["documents"])
        for task in list_tasks.discover_tasks()
    ] == [
        ("other-area/flat", "Unrelated", 1, 0),
        ("test-area/workflow/scenario-01", "First — café", 1, 1),
        ("test-area/workflow/scenario-02", "Second", 1, 0),
    ]


def test_sweep_discovers_nested_workflow(tasks):
    assert sweep.discover_tasks("test-area/workflow") == [
        "test-area/workflow/scenario-01",
        "test-area/workflow/scenario-02",
    ]


def test_describe_resolves_nested_task(tasks):
    assert (
        describe_task.resolve_task_dir("test-area/workflow/scenario-01")
        == tasks / "test-area/workflow/scenario-01"
    )
