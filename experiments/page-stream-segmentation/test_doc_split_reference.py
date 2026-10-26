"""Independently invented source pages exercise native conversion and CRF math."""
import itertools
import unittest

import numpy as np

from audit_doc_split import crf_probability
from run_doc_split_reference import page_records


class ReferenceConversionTests(unittest.TestCase):
    def test_later_run_keeps_physical_ids_and_excludes_its_first_page(self):
        records=page_records(3,{p:{'page':p} for p in (9,10,11)}, {'9':1,'10':0,'11':1},['x','y','z'])
        self.assertEqual([r['position'] for r in records],[0,1,2])
        self.assertEqual([r['physical_page'] for r in records],[9,10,11])
        self.assertEqual([r['loss_mask'] for r in records],[False,True,True])

    def test_physical_pages_positions_and_unknowns(self):
        records=page_records(4,{p:{'page':p} for p in range(1,5)}, {'2':0,'4':1},['a','b','c','d'])
        self.assertEqual([r['position'] for r in records],[0,1,2,3])
        self.assertEqual([r['boundary'] for r in records],[1,0,None,1])
        self.assertEqual([r['loss_mask'] for r in records],[False,True,False,True])

    def test_crf_against_independent_path_enumeration(self):
        parameters={'trans':[[.2,-.3],[.4,.1]],'start':[.1,-.2],'end':[-.1,.3]}
        logits=np.array([1.2,-.6,.8])
        states=list(itertools.product((0,1),repeat=3))
        weights=[]
        for path in states:
            energy=parameters['start'][path[0]]+parameters['end'][path[-1]]
            energy+=sum(logits[i]*tag for i,tag in enumerate(path))
            energy+=sum(parameters['trans'][a][b] for a,b in zip(path,path[1:]))
            weights.append(np.exp(energy))
        expected=[sum(w for p,w in zip(states,weights) if p[i])/sum(weights) for i in range(3)]
        np.testing.assert_allclose(crf_probability(logits,parameters),expected,atol=1e-12)


if __name__=='__main__':
    unittest.main()
