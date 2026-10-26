"""Run the pinned official demo computation without its UI or hosted services.

The original upstream app stays unchanged in private upstream-code storage.
Numerical statements are compiled directly from its split() AST, not rewritten.
Source: https://huggingface.co/spaces/nutrientdocs/doc-split-demo
"""
import ast
import copy
import hashlib
from pathlib import Path

import numpy as np

DEMO_REPOSITORY = 'nutrientdocs/doc-split-demo'
DEMO_REVISION = '803671733cfa1c1f6591145528e03866242bd5fd'
DEMO_APP_SHA256 = 'a6b833909f86d5abb005de48c88fd01c15ecad2fe2a5111b4a0980fb84bd1b65'
MODEL_NAME = 'doc-split-v1 (open-weight)'


def load_reference(source):
    raw = Path(source).read_bytes()
    if hashlib.sha256(raw).hexdigest() != DEMO_APP_SHA256:
        raise ValueError('Official demo source differs from the pinned revision')
    tree = ast.parse(raw.decode('utf-8'))
    helper_names = {'_lse', '_crf_marginals', '_calibrate'}
    definitions = [copy.deepcopy(n) for n in tree.body if
                   isinstance(n, ast.FunctionDef) and n.name in helper_names or
                   isinstance(n, ast.Assign) and any(isinstance(t,ast.Name) and t.id=='_BETA' for t in n.targets)]
    original = next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='split')
    numerical = []
    copying = False
    for statement in original.body:
        assigned = [t.id for t in statement.targets if isinstance(t,ast.Name)] if isinstance(statement,ast.Assign) else []
        if assigned == ['N']:
            copying = True
        if copying:
            numerical.append(copy.deepcopy(statement))
        if assigned == ['pred']:
            break
    if not numerical or assigned != ['pred']:
        raise ValueError('Published inference structure changed')
    shell = ast.parse('def predict_pages(pages, obj, min_conf=50, model_name=MODEL_NAME):\n    pass\n').body[0]
    result = ast.parse("return {'logits':bl,'raw_probabilities':raw,'confidence':conf,'predictions':pred}").body[0]
    shell.body = numerical + [result]
    definitions.append(shell)
    namespace = {'np':np,'MODEL_NAME':MODEL_NAME}
    module = ast.fix_missing_locations(ast.Module(body=definitions,type_ignores=[]))
    exec(compile(module,str(source),'exec'),namespace)
    return namespace


class BatchedEncoder:
    """Bound per-page encoder memory; the sequence head is never chunked."""
    def __init__(self, session, batch=2):
        self.session, self.batch = session, batch

    def run(self, outputs, inputs):
        count = len(next(iter(inputs.values())))
        groups = [self.session.run(outputs,{k:v[start:start+self.batch] for k,v in inputs.items()})
                  for start in range(0,count,self.batch)]
        return [np.concatenate([g[i] for g in groups]) for i in range(len(groups[0]))]


class VerifiedImageCache:
    """Reuse identical encoded inputs; verify the official preprocessing tensor."""
    def __init__(self, images, features):
        self.images, self.features = images, features
        self.verified = 0

    def run(self, outputs, inputs):
        if outputs != ['image_embed'] or set(inputs) != {'pixel_values'}:
            raise ValueError('Unexpected upstream image-encoder contract')
        actual = inputs['pixel_values']
        if len(actual) != len(self.images):
            raise ValueError('Page sequence differs from cached features')
        for index,image in enumerate(self.images):
            expected = (np.asarray(image.convert('RGB').resize((512,512)),dtype=np.float32)/255-.5)/.5
            np.testing.assert_array_equal(actual[index],expected.transpose(2,0,1))
            self.verified += 1
        return [np.stack(self.features)]
