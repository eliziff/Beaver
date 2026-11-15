"""2:4 structured sparsity for docparse.py's fit on Ampere's sparse tensor cores (`sparse24.cpp`, cuSPARSELt; the Windows
builds of torch carry neither the library nor these kernels, so this builds them).

`linear(module, x)`: x · Wᵀ + b with W pruned 2:4 along its inputs (the two of each four largest in magnitude kept), the
product on the sparse tensor cores; the backward dense, through to every weight (the straight-through estimator: the
pruning is redone from the dense weights each step, so a pruned weight can grow back). A custom op, so it compiles
inside the step's graph. The checkpoint keeps the weights as pruned (`prune`), so the exported model is the one fitted.
"""
import math
import os
from pathlib import Path

import torch

CUSPARSELT = Path(os.environ.get("CUSPARSELT_HOME", r"C:\Users\elias\tools\cusparselt\libcusparse_lt-windows-x86_64-0.8.1.1_cuda12-archive"))
CUDA = Path(os.environ.get("CUDA_HOME", r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6"))
for folder in (CUSPARSELT / "bin", CUDA / "bin"):
    if folder.exists() and hasattr(os, "add_dll_directory"):
        os.add_dll_directory(str(folder))

from torch.utils.cpp_extension import load  # noqa: E402

ext = load("sparse24", [str(Path(__file__).with_name("sparse24.cpp"))],
           extra_include_paths=[str(CUSPARSELT / "include"), str(CUDA / "include")],
           extra_ldflags=[f"/LIBPATH:{CUSPARSELT / 'lib'}", "cusparseLt.lib", f"/LIBPATH:{CUDA / 'lib' / 'x64'}", "cudart.lib",
                          f"/LIBPATH:{Path(torch.__file__).parent / 'lib'}", "c10_cuda.lib", "torch_cuda.lib"],
           verbose=False)


def mask24(w):
    """W's 2:4 mask along its inputs: in each four consecutive inputs, the two largest in magnitude."""
    out, inputs = w.shape
    groups = w.detach().abs().reshape(out, inputs // 4, 4)
    keep = groups.topk(2, dim=-1).indices
    return torch.zeros_like(groups, dtype=torch.bool).scatter_(-1, keep, True).reshape(out, inputs)


def prune(w):
    """W as the fit uses it: pruned 2:4 (what the checkpoint keeps)."""
    return w * mask24(w)


def suits(w):
    """Whether W's shape suits the library's kernels (both sides multiples of 64)."""
    return w.dim() == 2 and w.shape[0] % 64 == 0 and w.shape[1] % 64 == 0


def rows_of(n):
    """The rows a product of n is run at: n rounded up to a sixteenth of its octave (at most 6% padding), so the few
    shapes a fit sees each get their own plan and kernel search once (`sparse24.cpp`), not one each pack."""
    step = max(16, 2 ** max(0, math.floor(math.log2(max(n, 1)))) // 16)
    return max(16, math.ceil(n / step) * step)


PRUNED = {}  # each weight's pruned bf16 copy and compressed forms, by its storage, kept while its version stands
REFRESH = 32  # the versions of a weight (16 optimizer steps) its 2:4 mask is held for
CANONICAL = 64  # the row count a weight is compressed for (any count then reads it; `check` tries another)


def pruned(w, rows=None):
    """W pruned 2:4 in bf16 and (with `rows`) compressed for products of that many rows: made once a version of W (an
    optimizer step changes it), not at every call. The mask's top-k over every weight, at each layer's every call forward
    and backward, was a tenth of a step's device time."""
    key = w.data_ptr()
    held = PRUNED.get(key)
    if held is None or held["version"] != w._version or held["shape"] != tuple(w.shape):
        # The mask itself chosen again only every `REFRESH` versions of W (an optimizer step is two), as 2:4 training
        # holds a mask for stretches; between, the step's W through the mask it has (one product, no top-k).
        if held is not None and held["shape"] == tuple(w.shape) and 0 <= w._version - held["masked_at"] < REFRESH:
            mask, masked_at = held["mask"], held["masked_at"]
        else:
            mask, masked_at = mask24(w), w._version
        held = PRUNED[key] = {"version": w._version, "shape": tuple(w.shape), "mask": mask, "masked_at": masked_at,
                              "weight": (w.detach() * mask).to(torch.bfloat16).contiguous()}
    # One compressed form a version, made for a canonical row count and used at every count: the compression is of W
    # alone (the structured operand), checked against the dense product at another count (`check`).
    if rows is not None and "compressed" not in held:
        held["compressed"] = ext.compress(held["weight"], CANONICAL)
    return held["compressed"] if rows is not None else held["weight"]


def refresh(weights):
    """Every sparse weight's pruned and compressed forms made now, after the optimizer's step and outside the step's
    graph: inside it they are only read (a CUDA graph's capture keeps no allocation that is not its output)."""
    for w in weights:
        pruned(w, CANONICAL)


@torch.library.custom_op("docparse::spmm24", mutates_args=())
def spmm24(x: torch.Tensor, w: torch.Tensor) -> torch.Tensor:
    """x (n × in) · prune(W)ᵀ (W out × in), bf16, on the sparse tensor cores; the rows padded (`rows_of`)."""
    n = x.shape[0]
    rows = rows_of(n)
    xp = torch.nn.functional.pad(x, (0, 0, 0, rows - n)) if rows != n else x
    return ext.matmul(pruned(w, rows), xp.to(torch.bfloat16).contiguous(), w.shape[0])[:n]


@spmm24.register_fake
def _(x, w):
    return x.new_empty((x.shape[0], w.shape[0]), dtype=torch.bfloat16)


@torch.library.custom_op("docparse::pruned_mm", mutates_args=())
def pruned_mm(g: torch.Tensor, w: torch.Tensor) -> torch.Tensor:
    """g · prune(W) (the inputs' gradient), with W's pruned copy from `pruned`. Its own op, so the compiled backward
    calls it as it is: traced, the cache's lookup ran once at tracing and the graph pruned W again (a top-k) each step."""
    return g.to(torch.bfloat16) @ pruned(w)


@pruned_mm.register_fake
def _(g, w):
    return g.new_empty((g.shape[0], w.shape[1]), dtype=torch.bfloat16)


def _setup(ctx, inputs, output):
    ctx.save_for_backward(*inputs)


def _backward(ctx, grad):
    x, w = ctx.saved_tensors
    g = grad.to(torch.bfloat16)
    # Dense: the inputs' gradient through the pruned weights, the weights' through to all of them (straight-through).
    return torch.ops.docparse.pruned_mm(g, w), (g.t() @ x.to(torch.bfloat16)).to(w.dtype)


spmm24.register_autograd(_backward, setup_context=_setup)


def linear(module, x):
    """`module` (an nn.Linear) applied with its weight 2:4 sparse."""
    shape = x.shape
    y = torch.ops.docparse.spmm24(x.reshape(-1, shape[-1]).to(torch.bfloat16).contiguous(), module.weight)
    if module.bias is not None:
        y = y + module.bias.to(y.dtype)
    return y.reshape(*shape[:-1], module.weight.shape[0])


def check():
    """The sparse product against the dense one on the pruned weights: their largest difference, relative."""
    # One compressed form read at every row count only where the library sizes it alike at each (else no sparse layers).
    for out, inputs in ((768, 256), (1024, 256), (256, 1024), (256, 256)):
        sizes = {ext.compressed_size(out, inputs, n) for n in (CANONICAL, 1024, 49152)}
        if len(sizes) != 1:
            raise RuntimeError(f"compressed size varies with the row count at {out}x{inputs}: {sorted(sizes)}")
    x = torch.randn(1000, 256, device="cuda", dtype=torch.bfloat16)
    w = torch.randn(1024, 256, device="cuda", dtype=torch.float32)
    got = torch.ops.docparse.spmm24(x, w).float()
    ref = (x.float() @ prune(w).t())
    return float((got - ref).abs().max() / ref.abs().max())
