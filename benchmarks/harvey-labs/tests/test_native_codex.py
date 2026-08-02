"""Pure receipt/parser checks for the stock Codex adapter."""

from pathlib import Path

from harness.native_codex import DEFAULT_IMAGE, _events, _last_usage, _mount


def test_native_codex_mounts_are_explicit_and_pinned():
    assert DEFAULT_IMAGE == "lab-codex-native:0.146.0"
    assert _mount(Path("C:/task/documents"), "/workspace/documents", readonly=True).endswith(
        ",readonly"
    )
    assert not _mount(Path("C:/task/output"), "/workspace/output").endswith(
        ",readonly"
    )


def test_native_codex_usage_uses_completed_jsonl_event():
    events = _events(
        '{"type":"thread.started","thread_id":"t"}\n'
        '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":80,"output_tokens":9}}\n'
    )
    assert _last_usage(events) == {
        "input_tokens": 120,
        "cached_input_tokens": 80,
        "output_tokens": 9,
    }
