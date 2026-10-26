"""CTC alignment for an auxiliary loss on annotated glyph positions.

The alignment is detached. Ordinary CTC still trains the complete transcript;
the auxiliary character loss gives marked glyphs additional gradient weight.
"""
import numpy as np


def aligned_positions(emissions, labels):
    """Highest-scoring valid CTC path as target indices; -1 denotes blank.

    emissions is [time, 2*len(labels)+1], already gathered for the interleaved
    blank/label states. Repeated target characters cannot skip their blank.
    """
    labels = np.asarray(labels, dtype=np.int64)
    time, states = emissions.shape
    if not time or states != 2*len(labels)+1:
        raise ValueError('Invalid CTC emission shape')
    if not len(labels):
        return np.full(time, -1, dtype=np.int64)
    tokens = np.zeros(states, dtype=np.int64)
    tokens[1::2] = labels
    skip = np.zeros(states, dtype=bool)
    skip[2:] = (tokens[2:] != 0) & (tokens[2:] != tokens[:-2])
    previous = np.full(states, -np.inf, dtype=np.float32)
    previous[:2] = emissions[0, :2]
    back = np.zeros((time, states), dtype=np.uint8)
    for t in range(1, time):
        one = np.r_[-np.inf, previous[:-1]]
        two = np.r_[-np.inf, -np.inf, previous[:-2]]
        two[~skip] = -np.inf
        choices = np.stack((previous, one, two))
        back[t] = choices.argmax(axis=0)
        previous = choices.max(axis=0) + emissions[t]
    state = states-2 + int(previous[-1] > previous[-2])
    if not np.isfinite(previous[state]):
        raise ValueError('Transcript has no valid CTC alignment')
    path = np.empty(time, dtype=np.int64)
    for t in range(time-1, -1, -1):
        path[t] = (state-1)//2 if state % 2 else -1
        if t:
            state -= int(back[t, state])
    return path


def focus_loss(log_probs, lengths, labels, weights):
    import torch
    losses, importance = [], []
    for row, (target, target_weights) in enumerate(zip(labels, weights, strict=True)):
        if not any(target_weights):
            continue
        tokens = torch.zeros(2*len(target)+1, device=log_probs.device, dtype=torch.long)
        tokens[1::2] = torch.tensor(target, device=log_probs.device)
        count = int(lengths[row])
        emissions = log_probs[row, :count].detach().index_select(1, tokens).cpu().numpy()
        path = aligned_positions(emissions, target)
        selected = np.flatnonzero((path >= 0) & (np.asarray(target_weights)[np.maximum(path, 0)] > 0))
        if len(selected):
            frames = torch.tensor(selected, device=log_probs.device)
            indices = path[selected]
            values = torch.tensor(np.asarray(target)[indices], device=log_probs.device)
            strength = torch.tensor(np.asarray(target_weights, dtype=np.float32)[indices], device=log_probs.device)
            losses.append((-log_probs[row, frames, values]*strength).sum())
            importance.append(strength.sum())
    return sum(losses)/sum(importance) if losses else log_probs.sum()*0
