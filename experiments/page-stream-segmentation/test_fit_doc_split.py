"""Independent small tensors test loss weighting and staged adaptation."""
import unittest
import torch

from fit_doc_split import batches, configure, loss_sum


class NativeFitTests(unittest.TestCase):
    def test_accumulation_matches_one_loss_over_known_seams(self):
        weight = torch.tensor(.3, requires_grad=True)
        inputs = [torch.tensor([1.,2.,3.]),torch.tensor([4.,5.])]
        targets = [torch.tensor([-1.,0.,1.]),torch.tensor([-1.,1.])]
        rows = [{'targets':t} for t in targets]
        groups = list(batches(rows,3))
        self.assertEqual([count for group,count in groups],[3])
        for x,y in zip(inputs,targets):
            (loss_sum(weight*x,y)/3).backward()
        accumulated = weight.grad.clone()
        weight.grad = None
        (loss_sum(weight*torch.cat(inputs),torch.cat(targets))/3).backward()
        torch.testing.assert_close(weight.grad,accumulated)

    def test_classifier_step_preserves_frozen_features_and_disables_dropout(self):
        model = torch.nn.Module()
        model.encoder = torch.nn.Linear(2,2)
        model.head = torch.nn.Sequential(torch.nn.Linear(2,2),torch.nn.ReLU(),
            torch.nn.Dropout(.9),torch.nn.Linear(2,1))
        before = {k:v.clone() for k,v in model.state_dict().items()}
        configure(model,'classifier')
        self.assertFalse(model.head[2].training)
        optimizer = torch.optim.SGD((p for p in model.parameters() if p.requires_grad),lr=.1)
        loss_sum(model.head(model.encoder(torch.ones(2,2))).flatten(),torch.zeros(2)).backward()
        optimizer.step()
        for name,value in model.state_dict().items():
            if not name.startswith('head.3.'):
                torch.testing.assert_close(value,before[name],rtol=0,atol=0)
        self.assertFalse(torch.equal(model.head[3].bias,before['head.3.bias']))


if __name__=='__main__':
    unittest.main()
