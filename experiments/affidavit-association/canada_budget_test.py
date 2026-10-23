import json,pathlib,tempfile,unittest
from types import SimpleNamespace
import canada_budget as gate

class CallBudget(unittest.TestCase):
    def test_reserves_retries_and_prevents_dispatch_over_shared_cap(self):
        scratch=pathlib.Path('.tmp').resolve();scratch.mkdir(exist_ok=True)
        original=gate.ROOT
        try:
            with tempfile.TemporaryDirectory(prefix='canada-budget-test-',dir=scratch) as folder:
                gate.ROOT=pathlib.Path(folder);assert gate.ROOT.is_relative_to(scratch)
                receipt=gate.ROOT/'calls/existing/key/receipt.json';receipt.parent.mkdir(parents=True)
                dispatched=[];workflow=SimpleNamespace(call=lambda *a,**kw:dispatched.append(True))
                gate.install(workflow)
                receipt.write_text(json.dumps({'attempts':[{'status':'complete'}]*59}))
                args=SimpleNamespace(attempts=2,max_calls=100)
                with self.assertRaisesRegex(RuntimeError,'60-attempt cap'):
                    workflow.call('',None,[],gate.ROOT/'calls/new',args,lambda x:x)
                self.assertFalse(dispatched)
                args.attempts=1
                workflow.call('',None,[],gate.ROOT/'calls/new',args,lambda x:x)
                self.assertEqual(len(dispatched),1)
                self.assertEqual(args.max_calls,60)
                self.assertFalse(json.loads((gate.ROOT/'model-budget.json').read_text())['active'])
        finally:gate.ROOT=original

if __name__=='__main__':unittest.main()
