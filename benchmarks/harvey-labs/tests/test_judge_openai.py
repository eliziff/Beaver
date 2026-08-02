from types import SimpleNamespace

from evaluation.judge import Judge


def test_openai_judge_retries_without_unsupported_temperature():
    calls = []

    class Responses:
        def create(self, **kwargs):
            calls.append(kwargs)
            if "temperature" in kwargs:
                raise RuntimeError("Unsupported parameter: 'temperature'")
            return SimpleNamespace(
                output_text='{"verdict":"pass","reasoning":"supported"}'
            )

    judge = object.__new__(Judge)
    judge.model = "gpt-test"
    judge.client = SimpleNamespace(responses=Responses())
    result = judge._evaluate_openai("prompt", temperature=0.0, _retries=2)

    assert result == {"verdict": "pass", "reasoning": "supported"}
    assert len(calls) == 2
    assert calls[0]["temperature"] == 0.0
    assert "temperature" not in calls[1]
