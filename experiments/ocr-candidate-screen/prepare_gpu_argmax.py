"""Remove the stock GPU ArgMax from an otherwise unchanged recognition graph."""

import argparse
import hashlib
import json
import shutil
import uuid
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, TensorProto
import onnxruntime as ort


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets-root',type=Path,default=Path('legal-browser-ocr/assets'))
    args=parser.parse_args()
    folder=args.assets_root/'gpu-argmax'
    folder.mkdir(parents=True,exist_ok=True)
    control=helper.make_model(helper.make_graph([
        helper.make_node('ArgMax',['logits'],['ids'],axis=1,keepdims=0,select_last_index=0)
    ],'argmax-control',[helper.make_tensor_value_info('logits',TensorProto.FLOAT,['rows','classes'])],
        [helper.make_tensor_value_info('ids',TensorProto.INT64,['rows'])]),opset_imports=[helper.make_opsetid('',17)],ir_version=8)
    onnx.checker.check_model(control)
    onnx.save(control,folder/'control.onnx')
    for name in ['gpu8h','gpu64h']:
        source=args.assets_root/'indra-followup'/name
        metadata=json.loads((source/'source.json').read_text(encoding='utf-8'))
        original=source/'model.onnx'
        assert sha(original)==metadata['model_sha256']
        graph=onnx.load(original)
        removed=[node for node in graph.graph.node if 'class_ids' in node.output]
        assert len(removed)==1 and removed[0].op_type=='ArgMax'
        assert not any('class_ids' in node.input for node in graph.graph.node)
        nodes=[node for node in graph.graph.node if 'class_ids' not in node.output]
        outputs=[value for value in graph.graph.output if value.name!='class_ids']
        assert {value.name for value in outputs}=={'logits','lengths'}
        del graph.graph.node[:];graph.graph.node.extend(nodes)
        del graph.graph.output[:];graph.graph.output.extend(outputs)
        onnx.checker.check_model(graph)
        destination=args.assets_root/'indra-followup'/(name+'-argmax')
        destination.mkdir(parents=True,exist_ok=True)
        path=destination/'model.onnx';onnx.save(graph,path)
        shutil.copyfile(source/'codec.json',destination/'codec.json')
        options=ort.SessionOptions();options.intra_op_num_threads=options.inter_op_num_threads=1
        before=ort.InferenceSession(str(original),options,providers=['CPUExecutionProvider'])
        after=ort.InferenceSession(str(path),options,providers=['CPUExecutionProvider'])
        image=np.random.default_rng(47).uniform(0,1,(2,1,32,128)).astype(np.float32)
        feeds={'image':image,'widths':np.array([128,96],np.int64)}
        logits,lengths,ids=before.run(['logits','lengths','class_ids'],feeds)
        actual,actual_lengths=after.run(['logits','lengths'],feeds)
        np.testing.assert_array_equal(logits,actual)
        np.testing.assert_array_equal(lengths,actual_lengths)
        np.testing.assert_array_equal(ids,actual.argmax(-1))
        result={**metadata,'origin':'machine_test','run_id':str(uuid.uuid4()),
                'original_model_sha256':sha(original),'model_sha256':sha(path),
                'removed_op':'ArgMax only; recognition weights and float32 logits unchanged',
                'logit_parity_passed':True,'document_accuracy_gate_passed':False}
        (destination/'source.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({'model':name,'sha256':sha(path),'logit_parity_passed':True}))


if __name__=='__main__':
    main()
