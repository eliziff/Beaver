"""Triton kernels for docparse.py's fit (torch.library triton ops, so they compile inside the whole step's graph).

pair_spatial: a relation head's spatial term over the pairs (i, j) of lines (`RelationHead.r` over `measures`): each
pair's 18 measures of its two boxes, the 64 hidden units of the head's small network and its score, computed in
registers; the backward recomputes them and sums the network's gradients a block of pairs at a time. Neither the
pairs' measures nor their hidden units are ever written to the device's memory (millions of pairs a pack).
"""
import torch
import triton
import triton.language as tl
from torch.library import triton_op, wrap_triton

# The sizes as the host reads them, and as the kernels do (Triton reads a global only as a `tl.constexpr` instance).
HIDDEN_N, MEASURES_N, PADDED_N, BLOCK_N, ROW_N = 64, 18, 32, 64, 256
HIDDEN = tl.constexpr(HIDDEN_N)  # the spatial network's width (`RelationHead.r`)
MEASURES = tl.constexpr(MEASURES_N)  # Δ(a, b), Δ(a, a∪b), Δ(b, a∪b): six measures each (`docparse.measures`)
PADDED = tl.constexpr(PADDED_N)  # the measures padded to a tensor-core product's depth
BLOCK = tl.constexpr(BLOCK_N)  # pairs a program's block


@triton.jit
def _delta(x0, y0, x1, y1, u0, v0, u1, v1):
    """Δ(a, b) as `docparse.measures` reads it: the centres' offsets each way scaled by the boxes' sizes, the log ratios
    of width and height."""
    wa, ha = tl.maximum(x1 - x0, 1e-3), tl.maximum(y1 - y0, 1e-3)
    wb, hb = tl.maximum(u1 - u0, 1e-3), tl.maximum(v1 - v0, 1e-3)
    xa, ya, xb, yb = (x0 + x1) / 2, (y0 + y1) / 2, (u0 + u1) / 2, (v0 + v1) / 2
    return (xa - xb) / wa, (ya - yb) / ha, tl.log(wa / wb), tl.log(ha / hb), (xb - xa) / wb, (yb - ya) / hb


@triton.jit
def _clip(m):
    return tl.minimum(tl.maximum(m, -20.0), 20.0)


@triton.jit
def _measures(boxes, i, j, mask):
    """The 18 measures of each pair (i, j), clipped to ±20, as `docparse.measures` (a, b, their union)."""
    a0, a1 = tl.load(boxes + i * 4 + 0, mask=mask, other=0.0), tl.load(boxes + i * 4 + 1, mask=mask, other=0.0)
    a2, a3 = tl.load(boxes + i * 4 + 2, mask=mask, other=1.0), tl.load(boxes + i * 4 + 3, mask=mask, other=1.0)
    b0, b1 = tl.load(boxes + j * 4 + 0, mask=mask, other=0.0), tl.load(boxes + j * 4 + 1, mask=mask, other=0.0)
    b2, b3 = tl.load(boxes + j * 4 + 2, mask=mask, other=1.0), tl.load(boxes + j * 4 + 3, mask=mask, other=1.0)
    u0, u1, u2, u3 = tl.minimum(a0, b0), tl.minimum(a1, b1), tl.maximum(a2, b2), tl.maximum(a3, b3)
    m0, m1, m2, m3, m4, m5 = _delta(a0, a1, a2, a3, b0, b1, b2, b3)
    m6, m7, m8, m9, m10, m11 = _delta(a0, a1, a2, a3, u0, u1, u2, u3)
    m12, m13, m14, m15, m16, m17 = _delta(b0, b1, b2, b3, u0, u1, u2, u3)
    return (_clip(m0), _clip(m1), _clip(m2), _clip(m3), _clip(m4), _clip(m5), _clip(m6), _clip(m7), _clip(m8), _clip(m9), _clip(m10),
            _clip(m11), _clip(m12), _clip(m13), _clip(m14), _clip(m15), _clip(m16), _clip(m17))


@triton.jit
def _matrix(ms):
    """The pairs' measures as a (BLOCK, PADDED) matrix, the columns past the 18th nought (a tensor-core product's K)."""
    cols = tl.arange(0, PADDED)
    m = tl.zeros((BLOCK, PADDED), dtype=tl.float32)
    for k in tl.static_range(MEASURES):
        m += tl.where(cols[None, :] == k, ms[k][:, None], 0.0)
    return m


@triton.jit
def _first(w1):
    """The first layer's weights transposed, (PADDED, HIDDEN): row k the measure k's column of W1 (64 × 18, row-major)."""
    rows, units = tl.arange(0, PADDED), tl.arange(0, HIDDEN)
    return tl.load(w1 + units[None, :] * MEASURES + rows[:, None], mask=rows[:, None] < MEASURES, other=0.0)


@triton.jit
def _forward(boxes, pi, pj, w1, b1, w2, b2, out, pairs, programs):
    """Persistent: each program steps through the blocks pid, pid + programs, ...; the hidden layer one tensor-core
    product a block (3 × TF32, near fp32), its ReLU and the score in registers."""
    units = tl.arange(0, HIDDEN)
    wt, bias, second, last = _first(w1), tl.load(b1 + units), tl.load(w2 + units), tl.load(b2)
    for block in range(tl.program_id(0), tl.cdiv(pairs, BLOCK), programs):
        at = block * BLOCK + tl.arange(0, BLOCK)
        mask = at < pairs
        i, j = tl.load(pi + at, mask=mask, other=0), tl.load(pj + at, mask=mask, other=0)
        m = _matrix(_measures(boxes, i, j, mask))
        hidden = tl.maximum(tl.dot(m, wt, input_precision="tf32x3") + bias[None, :], 0.0)
        tl.store(out + at, tl.sum(hidden * second[None, :], axis=1) + last, mask=mask)


@triton.jit
def _backward(boxes, pi, pj, w1, b1, w2, grad, partial, pairs, programs):
    """Persistent as `_forward`: each program's sums of the network's gradients over its blocks, kept in registers and
    written once, (PADDED + 3) × HIDDEN values: dW1ᵀ by measure (one tensor-core product a block, Mᵀ · dh), db1, dw2,
    and db2 in the last row's first place. Summed over the programs outside."""
    units = tl.arange(0, HIDDEN)
    wt, bias, second = _first(w1), tl.load(b1 + units), tl.load(w2 + units)
    d_w1 = tl.zeros((PADDED, HIDDEN), dtype=tl.float32)
    d_b1 = tl.zeros((HIDDEN,), dtype=tl.float32)
    d_w2 = tl.zeros((HIDDEN,), dtype=tl.float32)
    d_b2 = tl.zeros((BLOCK,), dtype=tl.float32)
    for block in range(tl.program_id(0), tl.cdiv(pairs, BLOCK), programs):
        at = block * BLOCK + tl.arange(0, BLOCK)
        mask = at < pairs
        i, j = tl.load(pi + at, mask=mask, other=0), tl.load(pj + at, mask=mask, other=0)
        m = _matrix(_measures(boxes, i, j, mask))
        pre = tl.dot(m, wt, input_precision="tf32x3") + bias[None, :]
        g = tl.load(grad + at, mask=mask, other=0.0)
        d_w2 += tl.sum(g[:, None] * tl.maximum(pre, 0.0), axis=0)
        d_b2 += g
        dh = tl.where(pre > 0, g[:, None] * second[None, :], 0.0)
        d_w1 += tl.dot(tl.trans(m), dh, input_precision="tf32x3")
        d_b1 += tl.sum(dh, axis=0)
    row = partial + tl.program_id(0) * (PADDED + 3) * HIDDEN
    rows = tl.arange(0, PADDED)
    tl.store(row + rows[:, None] * HIDDEN + units[None, :], d_w1)
    tl.store(row + PADDED * HIDDEN + units, d_b1)
    tl.store(row + (PADDED + 1) * HIDDEN + units, d_w2)
    tl.store(row + (PADDED + 2) * HIDDEN + units, tl.where(units == 0, tl.sum(d_b2, axis=0), 0.0))


def _programs(pairs, device):
    """The persistent kernels' programs: four a multiprocessor, no more than the blocks."""
    return max(1, min(triton.cdiv(pairs, BLOCK_N), 8 * torch.cuda.get_device_properties(device).multi_processor_count))


@triton_op("docparse::pair_spatial", mutates_args={})
def pair_spatial(boxes: torch.Tensor, pi: torch.Tensor, pj: torch.Tensor, w1: torch.Tensor, b1: torch.Tensor, w2: torch.Tensor,
                 b2: torch.Tensor) -> torch.Tensor:
    pairs = pi.shape[0]
    out = torch.empty(pairs, device=boxes.device, dtype=torch.float32)
    if pairs:
        programs = _programs(pairs, boxes.device)
        wrap_triton(_forward)[(programs,)](boxes, pi, pj, w1, b1, w2, b2, out, pairs, programs)
    return out


@triton_op("docparse::pair_spatial_backward", mutates_args={})
def pair_spatial_backward(boxes: torch.Tensor, pi: torch.Tensor, pj: torch.Tensor, w1: torch.Tensor, b1: torch.Tensor, w2: torch.Tensor,
                          grad: torch.Tensor) -> torch.Tensor:
    pairs = pi.shape[0]
    programs = _programs(pairs, boxes.device)
    partial = torch.zeros((programs, PADDED_N + 3, HIDDEN_N), device=boxes.device, dtype=torch.float32)
    if pairs:
        wrap_triton(_backward)[(programs,)](boxes, pi, pj, w1, b1, w2, grad, partial, pairs, programs)
    return partial.sum(0)

def _setup(ctx, inputs, output):
    boxes, pi, pj, w1, b1, w2, b2 = inputs
    ctx.save_for_backward(boxes, pi, pj, w1, b1, w2)


def _grad(ctx, grad):
    boxes, pi, pj, w1, b1, w2 = ctx.saved_tensors
    sums = pair_spatial_backward(boxes, pi, pj, w1, b1, w2, grad.float().contiguous())
    d_w1 = sums[:MEASURES_N].t().contiguous()
    return None, None, None, d_w1, sums[PADDED_N], sums[PADDED_N + 1], sums[PADDED_N + 2, :1]


pair_spatial.register_autograd(_grad, setup_context=_setup)


def spatial(head, boxes, i, j):
    """A relation head's spatial term over the pairs (i, j) of `boxes`' lines, its network read from `head.r`."""
    first, last = head.r[0], head.r[2]
    return torch.ops.docparse.pair_spatial(boxes.float().contiguous(), i.contiguous(), j.contiguous(), first.weight.float().contiguous(),
                                           first.bias.float().contiguous(), last.weight.float().reshape(-1).contiguous(),
                                           last.bias.float().contiguous())

ROW = tl.constexpr(ROW_N)  # pair scores a row's program reads at a time


@triton.jit
def _row_forward(logits, starts, target, weight, loss, lse, rows):
    """Each row's softmax cross-entropy over its contiguous pairs (`starts`): its log-sum-exp in one pass (a running
    maximum and sum), its loss (log-sum-exp less its gold pair's score) times its weight."""
    row = tl.program_id(0)
    a, b = tl.load(starts + row), tl.load(starts + row + 1)
    top = tl.full((), -1e30, tl.float32)
    total = tl.full((), 0.0, tl.float32)
    for s in range(a, b, ROW):
        at = s + tl.arange(0, ROW)
        x = tl.load(logits + at, mask=at < b, other=-1e30)
        new = tl.maximum(top, tl.max(x, axis=0))
        total = total * tl.exp(top - new) + tl.sum(tl.where(at < b, tl.exp(x - new), 0.0), axis=0)
        top = new
    norm = tl.log(tl.maximum(total, 1e-30)) + top
    gold = tl.load(target + row)
    w = tl.load(weight + row)
    picked = tl.load(logits + tl.maximum(gold, 0), mask=b > a, other=0.0)
    tl.store(loss + row, tl.where((b > a) & (gold >= 0), (norm - picked) * w, 0.0))
    tl.store(lse + row, norm)


@triton.jit
def _row_backward(logits, starts, target, weight, lse, grad, out, rows):
    """Each row's pairs' gradient: (softmax − its gold one-hot) × its weight × the loss's gradient."""
    row = tl.program_id(0)
    a, b = tl.load(starts + row), tl.load(starts + row + 1)
    gold, norm = tl.load(target + row), tl.load(lse + row)
    scale = tl.where(gold >= 0, tl.load(weight + row) * tl.load(grad), 0.0)
    for s in range(a, b, ROW):
        at = s + tl.arange(0, ROW)
        x = tl.load(logits + at, mask=at < b, other=0.0)
        g = (tl.exp(x - norm) - tl.where(at == gold, 1.0, 0.0)) * scale
        tl.store(out + at, g, mask=at < b)


@triton_op("docparse::row_ce", mutates_args={})
def row_ce(logits: torch.Tensor, starts: torch.Tensor, target: torch.Tensor, weight: torch.Tensor) -> torch.Tensor:
    rows = target.shape[0]
    loss = torch.empty(rows, device=logits.device, dtype=torch.float32)
    lse = torch.empty(rows, device=logits.device, dtype=torch.float32)
    if rows:
        wrap_triton(_row_forward)[(rows,)](logits, starts, target, weight, loss, lse, rows)
    # The loss first, then each row's log-sum-exp (for the backward).
    return torch.cat([loss.sum()[None], lse])


@triton_op("docparse::row_ce_backward", mutates_args={})
def row_ce_backward(logits: torch.Tensor, starts: torch.Tensor, target: torch.Tensor, weight: torch.Tensor, lse: torch.Tensor,
                    grad: torch.Tensor) -> torch.Tensor:
    out = torch.zeros_like(logits)
    rows = target.shape[0]
    if rows:
        wrap_triton(_row_backward)[(rows,)](logits, starts, target, weight, lse, grad, out, rows)
    return out


def _row_setup(ctx, inputs, output):
    logits, starts, target, weight = inputs
    ctx.save_for_backward(logits, starts, target, weight, output[1:])


def _row_grad(ctx, grad):
    logits, starts, target, weight, lse = ctx.saved_tensors
    return row_ce_backward(logits, starts, target, weight, lse, grad[:1].contiguous()), None, None, None


row_ce.register_autograd(_row_grad, setup_context=_row_setup)


def row_loss(logits, i, target, w):
    """`docparse.row_loss` in one pass a row: each row's pairs a contiguous run (the pairs sorted by row), the loss the
    weighted sum of the rows' cross-entropies."""
    rows = target.shape[0]
    starts = torch.searchsorted(i.contiguous(), torch.arange(rows + 1, device=i.device, dtype=i.dtype))
    return torch.ops.docparse.row_ce(logits.float().contiguous(), starts.long(), target.long().contiguous(), w.float().contiguous())[0]
