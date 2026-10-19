"""Trainable form of Indra's published, fused Latin recognizer graph.

The upstream release supplies inference graphs, not a PyTorch trainer. Load the
actual ONNX initializers and require numerical parity before fine-tuning.
Upstream: https://github.com/datalab-to/indra (model terms remain applicable).
"""

import numpy as np
import onnx
import torch
from onnx import numpy_helper
from torch import nn
from torch.nn import functional as F


class Indra(nn.Module):
    def __init__(self, path):
        super().__init__()
        graph = onnx.load(path).graph
        values = {x.name: numpy_helper.to_array(x).copy() for x in graph.initializer}
        self.stem = nn.Conv2d(1, 128, (32, 4), stride=(32, 4))
        self.stem_bn = nn.BatchNorm1d(128)
        self.blocks = nn.ModuleList()
        self.head = nn.Conv1d(128, values['rec.head.bias'].shape[0], 1)
        for _ in range(10):
            self.blocks.append(nn.ModuleDict({
                'dw': nn.Conv1d(128, 128, 9, padding=4, groups=128),
                'expand': nn.Conv1d(128, 256, 1),
                'fc1': nn.Conv1d(256, 64, 1),
                'fc2': nn.Conv1d(64, 256, 1),
                'project': nn.Conv1d(256, 128, 1),
            }))
        with torch.no_grad():
            for name, module in [('stem', self.stem), ('head', self.head)]:
                module.weight.copy_(torch.from_numpy(values[f'rec.{name}.weight']))
                module.bias.copy_(torch.from_numpy(values[f'rec.{name}.bias']))
            for name in ['weight', 'bias', 'running_mean', 'running_var']:
                getattr(self.stem_bn, name).copy_(torch.from_numpy(values[f'rec.stem_bn.{name}']))
            for i, block in enumerate(self.blocks):
                node = next(n for n in graph.node if n.name == f'/rec/blocks.{i}/dw/Conv')
                attrs = {a.name: onnx.helper.get_attribute_value(a) for a in node.attribute}
                if attrs['strides'] != [1] or attrs['dilations'] != [1] or attrs['pads'] != [4, 4]:
                    raise ValueError('Unrecognized Indra depthwise graph')
                block['dw'].weight.copy_(torch.from_numpy(values[node.input[1]]))
                block['dw'].bias.copy_(torch.from_numpy(values[node.input[2]]))
                for name in ['expand', 'fc1', 'fc2', 'project']:
                    source = f'rec.blocks.{i}.' + ('se.' if name.startswith('fc') else '') + name
                    block[name].weight.copy_(torch.from_numpy(values[source + '.weight']))
                    block[name].bias.copy_(torch.from_numpy(values[source + '.bias']))

    def forward(self, x, widths):
        x = self.stem(x).squeeze(2)
        lengths = ((widths + 3) // 4).clamp(max=x.shape[-1])
        mask = (torch.arange(x.shape[-1], device=x.device)[None, :] < lengths[:, None])[:, None, :].to(x.dtype)
        denominator = mask.sum(-1, keepdim=True).clamp_min(1)
        x = F.hardswish(self.stem_bn(x)) * mask
        for block in self.blocks:
            z = F.hardswish(block['expand'](block['dw'](x)))
            pooled = (z * mask).sum(-1, keepdim=True) / denominator
            gate = torch.sigmoid(block['fc2'](F.relu(block['fc1'](pooled))))
            x = (x + block['project'](z * gate)) * mask
        return self.head(x).transpose(1, 2), lengths


class IndraSpatial(nn.Module):
    """Equivalent height-one convolutions expose the 2D backend kernel paths."""
    def __init__(self, source):
        super().__init__()
        self.stem = torch.nn.utils.fusion.fuse_conv_bn_eval(source.stem, source.stem_bn)

        def lift(old):
            new = nn.Conv2d(old.in_channels, old.out_channels, (1, old.kernel_size[0]),
                            stride=(1, old.stride[0]), padding=(0, old.padding[0]),
                            dilation=(1, old.dilation[0]), groups=old.groups,
                            bias=old.bias is not None)
            with torch.no_grad():
                new.weight.copy_(old.weight.unsqueeze(2))
                if old.bias is not None:
                    new.bias.copy_(old.bias)
            return new

        self.blocks = nn.ModuleList([nn.ModuleDict({name: lift(conv) for name, conv in block.items()})
                                     for block in source.blocks])
        self.head = lift(source.head)

    def forward(self, x, widths):
        x = self.stem(x)
        lengths = ((widths + 3) // 4).clamp(max=x.shape[-1])
        mask = (torch.arange(x.shape[-1], device=x.device)[None, :] < lengths[:, None])[:, None, None, :].to(x.dtype)
        denominator = mask.sum(-1, keepdim=True).clamp_min(1)
        x = F.hardswish(x) * mask
        for block in self.blocks:
            z = F.hardswish(block['expand'](block['dw'](x)))
            pooled = (z * mask).sum(-1, keepdim=True) / denominator
            gate = torch.sigmoid(block['fc2'](F.relu(block['fc1'](pooled))))
            x = (x + block['project'](z * gate)) * mask
        return self.head(x).squeeze(2).transpose(1, 2), lengths


def select_blocks(model, count):
    """Keep evenly spaced residual blocks, retaining the recognition time grid."""
    indices = np.linspace(0, len(model.blocks) - 1, count, dtype=int).tolist()
    model.blocks = nn.ModuleList([model.blocks[i] for i in indices])
    return indices


def select_channels(model, count, indices=None):
    """Physically shrink coupled residual, expansion and squeeze channels."""
    def strongest(score, size):
        return score.argsort(stable=True)[-size:].sort().values.tolist()

    if indices is None:
        score = model.head.weight.detach().abs().mean((0, 2))
        score = score / score.mean()
        for block in model.blocks:
            part = block['project'].weight.detach().abs().mean((1, 2))
            score = score + part / part.mean()
        indices = {'residual': strongest(score, count), 'blocks': []}
        for block in model.blocks:
            expanded = block['expand'].weight.detach().abs().mean((1, 2)) * block['project'].weight.detach().abs().mean((0, 2))
            squeeze = block['fc1'].weight.detach().abs().mean((1, 2)) * block['fc2'].weight.detach().abs().mean((0, 2))
            indices['blocks'].append({'expanded': strongest(expanded, count * 2),
                                      'squeeze': strongest(squeeze, count // 2)})
    residual = indices['residual']

    def conv(old, outputs, inputs=None):
        cls = nn.Conv2d if old.weight.ndim == 4 else nn.Conv1d
        depthwise = old.groups == old.in_channels and old.in_channels > 1
        inputs = list(range(old.in_channels)) if inputs is None else inputs
        new = cls(len(inputs), len(outputs), old.kernel_size, stride=old.stride,
                  padding=old.padding, dilation=old.dilation,
                  groups=len(inputs) if depthwise else 1, bias=old.bias is not None)
        with torch.no_grad():
            weight = old.weight[outputs] if depthwise else old.weight[outputs][:, inputs]
            new.weight.copy_(weight)
            if old.bias is not None:
                new.bias.copy_(old.bias[outputs])
        return new

    model.stem = conv(model.stem, residual)
    previous = model.stem_bn
    model.stem_bn = nn.BatchNorm1d(count, eps=previous.eps, momentum=previous.momentum)
    with torch.no_grad():
        for name in ['weight', 'bias', 'running_mean', 'running_var']:
            getattr(model.stem_bn, name).copy_(getattr(previous, name)[residual])
        model.stem_bn.num_batches_tracked.copy_(previous.num_batches_tracked)
    for block, kept in zip(model.blocks, indices['blocks']):
        expanded, squeeze = kept['expanded'], kept['squeeze']
        block['dw'] = conv(block['dw'], residual, residual)
        block['expand'] = conv(block['expand'], expanded, residual)
        block['fc1'] = conv(block['fc1'], squeeze, expanded)
        block['fc2'] = conv(block['fc2'], expanded, squeeze)
        block['project'] = conv(block['project'], residual, expanded)
    model.head = conv(model.head, list(range(model.head.out_channels)), residual)
    return indices


def distillation_loss(logits, teacher, lengths, temperature=2.0):
    # Padding is not a training target; long padded batches must not dilute KL.
    divergence = F.kl_div((logits / temperature).log_softmax(-1),
                          (teacher / temperature).softmax(-1), reduction='none').sum(-1)
    mask = torch.arange(logits.shape[1], device=logits.device)[None] < lengths[:, None]
    return (divergence * mask).sum() / mask.sum() * temperature ** 2


def check_parity(model, path):
    """Independent ONNX execution checks the reconstructed architecture and weights."""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])
    rng = np.random.default_rng(714)
    worst = 0.0
    model.eval()
    for width, lengths in [(64, [64, 37]), (320, [319, 173]), (768, [768, 511])]:
        x = rng.uniform(0, 1, (2, 1, 32, width)).astype(np.float32)
        widths = np.array(lengths, dtype=np.int64)
        x[1, :, :, lengths[1]:] = 0
        ids, conf, count = session.run(None, {'x': x, 'widths': widths})
        with torch.no_grad():
            logits, actual_count = model(torch.from_numpy(x), torch.from_numpy(widths))
            actual_conf, actual_ids = logits.softmax(-1).max(-1)
        np.testing.assert_array_equal(actual_ids.numpy(), ids)
        np.testing.assert_array_equal(actual_count.numpy(), count)
        np.testing.assert_allclose(actual_conf.numpy(), conf, atol=2e-5, rtol=2e-4)
        worst = max(worst, float(np.max(np.abs(actual_conf.numpy() - conf))))
    return {'cases': 3, 'ids_exact': True, 'lengths_exact': True, 'max_confidence_delta': worst}
