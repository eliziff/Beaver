import pytest

from evaluation.compare import _compute_cost, _pretty_label


@pytest.mark.parametrize(
    "model,label,cost",
    [
        pytest.param(
            "gpt-5.4-mini",
            "GPT-5.4 Mini",
            5.25,
            id="test_specific_model_variant_uses_its_own_pricing",
        ),
        pytest.param(
            "claude-haiku-4-5-20251001",
            "Haiku 4.5",
            6.0,
            id="test_dated_snapshot_uses_family_pricing",
        ),
        pytest.param(
            "GLM-5.2", "GLM 5.2 (Baseten)", 6.0, id="test_longest_hosted_model_match_wins"
        ),
    ],
)
def test_model_metadata(model, label, cost):
    assert (_pretty_label(model, None), _compute_cost(model, 1_000_000, 1_000_000)) == (label, cost)


def test_unknown_model_requires_metadata():
    with pytest.raises(ValueError, match="No model metadata configured") as error:
        _compute_cost("model-from-the-future", 100, 200)
    assert "model-from-the-future" in str(error.value)
