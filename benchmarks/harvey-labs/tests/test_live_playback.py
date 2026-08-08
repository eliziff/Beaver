import json

from utils.live_playback import collect_runs


def test_collect_runs_tracks_live_events(tmp_path):
    run = tmp_path / "area" / "task" / "arm" / "run-1"
    run.mkdir(parents=True)
    (run / "raw-sse.txt").write_text("\n".join([
        'data: {"type":"tool_call_start","name":"Read","input":{"file_path":"source.docx"}}',
        'data: {"type":"doc_created","filename":"answer.docx"}',
    ]), encoding="utf-8")
    (run / "run-state.json").write_text(json.dumps({
        "status": "running", "run_id": "area/task/arm/run-1", "task": "area/task", "arm": "arm"
    }), encoding="utf-8")

    runs = collect_runs(tmp_path)

    assert runs[0]["status"] == "running"
    assert runs[0]["stats"]["tools"] == 1
    assert runs[0]["stats"]["documents"] == 1
    assert runs[0]["events"][0]["scope"] == {"file_path": "source.docx"}
    assert runs[0]["events"][-1] == {"kind": "document", "name": "answer.docx"}
