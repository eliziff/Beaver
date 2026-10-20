"""Equivalent activation graphs supported by the pinned ORT WebGPU runtime."""

import copy

import onnx
from onnx import helper


def webgpu_activations(model):
    """Lower HardSwish explicitly; ORT 1.22 also decomposes it during optimization."""
    nodes = []
    changed = 0
    for node in model.graph.node:
        if node.op_type != 'HardSwish':
            nodes.append(copy.deepcopy(node))
            continue
        gate = node.output[0] + '_gpu_gate'
        nodes.extend([
            helper.make_node('HardSigmoid', [node.input[0]], [gate], alpha=1 / 6, beta=.5),
            helper.make_node('Mul', [node.input[0], gate], list(node.output)),
        ])
        changed += 1
    del model.graph.node[:]
    model.graph.node.extend(nodes)
    onnx.checker.check_model(model)
    return changed


def webgpu_softplus(model):
    """Stable softplus avoids CPU fallback and FP16 exponential overflow."""
    nodes = []
    changed = 0
    for node in model.graph.node:
        if node.op_type != 'Softplus':
            nodes.append(copy.deepcopy(node))
            continue
        name = node.output[0] + '_gpu_softplus'
        nodes.extend([
            helper.make_node('Constant', [], [name + '_one'], value=helper.make_tensor(name + '_one', onnx.TensorProto.FLOAT, [], [1.])),
            helper.make_node('Relu', [node.input[0]], [name + '_positive']),
            helper.make_node('Abs', [node.input[0]], [name + '_abs']),
            helper.make_node('Neg', [name + '_abs'], [name + '_negative']),
            helper.make_node('Exp', [name + '_negative'], [name + '_exp']),
            helper.make_node('Add', [name + '_exp', name + '_one'], [name + '_sum']),
            helper.make_node('Log', [name + '_sum'], [name + '_log']),
            helper.make_node('Add', [name + '_positive', name + '_log'], list(node.output)),
        ])
        changed += 1
    del model.graph.node[:]
    model.graph.node.extend(nodes)
    onnx.checker.check_model(model)
    return changed
