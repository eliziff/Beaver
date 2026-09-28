"""Prediction-independent first-page and two later-page samples."""
import random


def sample_pages(sha256, count):
    rng = random.Random(int(sha256[:16], 16))
    if count < 1:
        raise ValueError('A PDF must contain at least one page')
    return sorted([1, *rng.sample(range(2, count + 1), min(2, count - 1))])
