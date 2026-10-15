"""Independently invented text, fields and PDF; no real-case fixtures."""
from copy import deepcopy
from contextlib import closing
import hashlib
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import worker
import package


def fixture(texts=("Filing 🦫", "inter-", "national")):
    from worker import gold
    ids = [f'p1-l{index}' for index in range(3)]
    lengths = [package.utf16(text) for text in texts]
    baseline = {'source_sha256': 'a'*64, 'offset_unit': 'utf16', 'text': '\n'.join(texts)+'\n',
        'nodes': [{'id': 'page-1','kind': 'page','page_indexes': [0],'line_ids': ids,
                   'range': {'start': 0, 'end': sum(lengths)+2}},
                  {'id': 'page-2','kind': 'page','page_indexes': [1],'line_ids': [],
                   'range': {'start': sum(lengths)+3, 'end': sum(lengths)+3}}], 'origins': []}
    evidence = [{'atoms': [{'id': ident, 'bbox': [100,100+index*100,500,150+index*100]}
                           for index,ident in enumerate(ids)]}]
    state = gold.initial(baseline, evidence)
    state['lines'][2]['original_text'] = 'nationa1'
    state['groups'] = [{'line_ids': ids[:1], 'kind': 'heading', 'attributes': {'level':1,'parent':None}},
                       {'line_ids': ids[1:], 'kind': 'prose', 'attributes': {}}]
    state['joins'] = {ids[1]: {'next': ids[2], 'separator': ''}}
    state['annotations'].append({'id':'field-1','kind':'field','line_ids':ids[:1],
        'spans':[{'line_id':ids[0],'start':0,'end':len(texts[0])}],
        'attributes':{'type':'text','label':[{'line_id':ids[0],'start':0,'end':6}],
                      'value':[],'placeholder':[],'state':'blank'}})
    _, original = gold.materialize(baseline,state,{'submission':'machine_test','run_id':'invented-example'})
    original['mode'] = 'ocr'
    return original


class PackageTests(unittest.TestCase):
    def test_exact_unicode_physical_and_manuscript_roundtrip(self):
        original=fixture(); compact=package.pack(original)
        view=package.parser_view(compact)
        self.assertEqual(package.pack({**original,'structure':view}),compact)
        self.assertEqual(package.printed_text(compact),'Filing 🦫\ninter-\nnational\n')
        self.assertEqual(package.manuscript_text(compact),'Filing 🦫\n\ninter-national')
        self.assertNotIn('graph',compact['layers']['legal_structure'])
        self.assertNotIn('replay',compact)
        self.assertNotIn('range',compact['lines'][0])
        self.assertNotIn('original_text',compact['lines'][0])
        self.assertEqual(compact['source_text']['p1-l2'],'nationa1')

    def test_independent_fields_association_and_absent_values(self):
        original=fixture()
        record={'record_id':'invented-record','events':[{'date':None,'description':'Date blank'}],
            'exhibits':[{'exhibit_id':'attachment-1','status':'unresolved'}],
            'document_segments':[{'segment_id':'segment-1','type':'letter','standard_information':[
                {'field':'date','value':None,'state':'blank'}, {'field':'recipient','value':'North Paper Co.'},
                {'field':'account','value':None,'state':'redacted'}]},
                {'segment_id':'segment-2','type':'certificate'}]}
        item={'gold':record,'source':{'source_sha256':'a'*64},'split':{'masks':[]}}
        compact=package.pack(original,[item])
        self.assertEqual(package.record_gold(compact,'invented-record'),record)
        compact['layers']['document_classification']['invented-record'][0]['type']='memorandum'
        self.assertEqual(compact['layers']['information_extraction']['invented-record']['segment-1'][1]['value'],'North Paper Co.')
        self.assertEqual(compact['layers']['exhibit_association']['invented-record'],record['exhibits'])

    def test_logical_order_and_join_do_not_change_ocr_lines(self):
        original=fixture(('Filing','inter-','national'))
        original['structure']['rendered_text']='national\n\nFiling inter'
        extents=[(10,16),(17,22),(0,8)]
        for line,(start,end) in zip(original['source_trace'],extents):
            line['rendered_range']={'start':start,'end':end}
        compact=package.pack(original)
        self.assertEqual(list(package.line_table(compact).values()),original['source_trace'])
        self.assertEqual(package.manuscript_text(compact),'national\n\nFiling inter')
        self.assertEqual(package.printed_text(compact),'Filing\ninter-\nnational\n')
        self.assertEqual(compact['manuscript_edits']['p1-l1'],[[5,6,'']])
        original['structure']['annotations'].append({'id':'word-field','kind':'field','line_ids':['p1-l1'],
            'spans':[{'line_id':'p1-l1','range':{'start':7,'end':13}}],
            'attributes':{'type':'text','label':[],'value':[{'line_id':'p1-l1','range':{'start':7,'end':13}}],
                          'placeholder':[],'state':'filled'}})
        compact=package.pack(original)
        view=package.parser_view(compact)
        field=next(a for a in view['annotations'] if a['id']=='word-field')
        self.assertEqual(field['attributes']['value'][0]['rendered_range'],{'start':17,'end':22})
        self.assertEqual(package.pack({**original,'structure':view}),compact)

    def test_duplicate_order_and_different_source_rejected(self):
        original=fixture(); original['reading_order'].append(original['reading_order'][0])
        with self.assertRaisesRegex(ValueError,'coverage'): package.pack(original)
        with self.assertRaisesRegex(ValueError,'source'):
            package.pack(fixture(),[{'gold':{'record_id':'x'},'source':{'source_sha256':'b'*64}}])

    def test_exact_source_images_text_pagexml_and_geometry(self):
        import fitz
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); pdf=root/'source.pdf'
            with fitz.open() as document:
                page=document.new_page(width=600,height=800)
                for index,text in enumerate(('Filing','inter-','national')):
                    page.insert_text((60,110+80*index),text)
                document.new_page(width=600,height=800)
                document.save(pdf)
            original=fixture(('Filing','inter-','national'))
            original['source_sha256']=hashlib.sha256(pdf.read_bytes()).hexdigest()
            original['structure']['source_sha256']=original['source_sha256']
            geometry=[{'page':n,'width_points':600,'height_points':800,'rotation':0} for n in (1,2)]
            compact=package.pack(original,pages=geometry)
            result=package.export_ocr(compact,pdf,root/'export',dpi=72,pagexml=True,line_crops=True)
            self.assertEqual(result['pages'],2)
            self.assertEqual((root/'export/page-000001.txt').read_text(), 'Filing\ninter-\nnational')
            self.assertEqual((root/'export/page-000002.txt').read_text(), '')
            import json
            row=json.loads((root/'export/records.jsonl').read_text().splitlines()[0])
            self.assertNotIn('text',row)
            self.assertEqual(row['text_sha256'],hashlib.sha256((root/'export/page-000001.txt').read_bytes()).hexdigest())
            xml=ET.parse(root/'export/page-000001.xml')
            ns={'p':package.PAGE_NS}
            self.assertEqual([node.text for node in xml.findall('.//p:Unicode',ns)],['Filing','inter-','national'])
            self.assertFalse(xml.findall('.//p:Baseline',ns))
            self.assertFalse(result['segmentation_training_eligible'])
            self.assertEqual(result['line_crops'],3)
            crops=[json.loads(line) for line in (root/'export/lines.jsonl').read_text().splitlines()]
            from PIL import Image
            with Image.open(root/'export/page-000001.png') as image:
                for line,crop in zip(compact['lines'],crops):
                    self.assertEqual(crop['line_id'],line['id'])
                    self.assertEqual((root/'export'/crop['transcription']).read_text(),line['text'])
                    self.assertNotIn('text',crop)
                    self.assertEqual(crop['image_sha256'],worker.digest(root/'export'/crop['image']))
                    with Image.open(root/'export'/crop['image']) as actual, image.crop(crop['box_pixels']) as expected:
                        self.assertEqual(actual.tobytes(),expected.tobytes())
            with fitz.open(root/'export/page-000001.png') as image:
                self.assertEqual((image[0].rect.width,image[0].rect.height),(600,800))
            wrong=deepcopy(compact); wrong['pages'][0]['width_points']=601
            with self.assertRaisesRegex(ValueError,'transform'):
                package.export_ocr(wrong,pdf,root/'bad-geometry',dpi=72)
            wrong=deepcopy(compact); wrong['pages'][0]['rotation']=90
            with self.assertRaisesRegex(ValueError,'transform'):
                package.export_ocr(wrong,pdf,root/'bad-rotation',dpi=72)
            wrong=deepcopy(compact); wrong['lines'][0]['text']='two\nrows'
            with self.assertRaisesRegex(ValueError,'multiple lines'):
                package.export_ocr(wrong,pdf,root/'bad-line',dpi=72,line_crops=True)
            wrong=deepcopy(compact); wrong['lines'][0]['box']=[100,100,100.01,100.01]
            with self.assertRaisesRegex(ValueError,'collapses'):
                package.export_ocr(wrong,pdf,root/'bad-box',dpi=72,pagexml=True)
            wrong['source_sha256']='b'*64
            with self.assertRaisesRegex(ValueError,'source'): package.ocr_pages(wrong,pdf)

    def test_catalog_reuses_parent_artifacts_and_detects_changes(self):
        import json
        from unittest.mock import patch
        import worker
        cs=worker.corpus_store
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);parent=root/'parent';job=root/'package'
            parent.mkdir();job.mkdir();(parent/'evidence').mkdir()
            for path in (parent/'manuscript.txt',parent/'baseline.json.gz',parent/'evidence/manifest.json',job/'gold.json.gz'):
                path.write_bytes(b'independently invented artifact')
            receipt={'run_id':'invented-package','source_sha256':'a'*64,'status':'complete',
                'started_at':1,'finished_at':2,'pages':1,'configuration':{'mode':'ocr'},
                'gold_sha256':worker.digest(job/'gold.json.gz'),
                'manuscript_sha256':worker.digest(parent/'manuscript.txt'),
                'artifact_paths':{'gold':'gold.json.gz','manuscript':'../parent/manuscript.txt',
                    'baseline':'../parent/baseline.json.gz','evidence':'../parent/evidence/manifest.json'}}
            (job/'receipt.json').write_text(json.dumps(receipt))
            with patch.object(cs,'ROOT',root/'corpus'),patch.object(cs,'DB',root/'corpus/corpus.sqlite'):
                with closing(cs.connect()) as db, db:db.execute('insert into files(sha256,pages) values (?,?)',('a'*64,1))
                cs.register_gold_sources(package.VERSION,[{'sha256':'a'*64,'mode':'ocr'}])
                cs.register_gold_run(job,package.VERSION)
                self.assertEqual(cs.completed_gold(package.VERSION,'a'*64),job)
                self.assertFalse((job/'baseline.json.gz').exists())
                (job/'gold.json.gz').write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError,'changed'):cs.completed_gold(package.VERSION,'a'*64)

    def test_fixed_answers_score_new_graphs_without_export_history(self):
        import evaluate
        original=fixture(('Filing','inter-','national'))
        compact=package.pack(original);before=package.encoded(compact)
        candidate=deepcopy(original['structure'])
        first=evaluate.compare(compact,candidate)
        # Another parser strategy uses different node IDs and a paragraph node.
        for node in candidate['nodes']:
            node['id']='alternate-'+node['id']
            if node['kind']=='prose':node['kind']='paragraph'
        self.assertEqual(evaluate.compare(compact,candidate),first)
        for node in candidate['nodes']:
            if node['kind']=='heading':node['kind']='prose'
        changed=evaluate.compare(compact,candidate)
        self.assertLess(changed['metrics']['roles']['f1'],first['metrics']['roles']['f1'])
        self.assertEqual(package.encoded(compact),before)

    def test_continued_tables_survive_without_historical_native_nodes(self):
        import evaluate
        from worker import gold
        baseline={'source_sha256':'b'*64,'offset_unit':'utf16','text':'Row A\nRow B',
            'nodes':[{'id':'p1','kind':'page','page_indexes':[0],'line_ids':['p1-l1'],'range':{'start':0,'end':5}},
                     {'id':'p2','kind':'page','page_indexes':[1],'line_ids':['p2-l1'],'range':{'start':6,'end':11}},
                     {'id':'seal','kind':'image','source':'heuristic','parent_id':None,
                      'line_ids':['p1-l1'],'page_indexes':[0],'range':{'start':0,'end':5},'label':'Printed seal'}]}
        state=gold.initial(baseline,[{'atoms':[{'id':ident,'bbox':[100,100,300,150]} for ident in ('p1-l1','p2-l1')]}])
        for index,ident in enumerate(('p1-l1','p2-l1')):
            ref={'line_id':ident,'start':0,'end':5}
            state['annotations'].append({'id':f'table-part-{index}','kind':'table','line_ids':[ident],
                'spans':[ref],'attributes':{'rows':[[[ref],[] if index==0 else None]],
                'header_rows':[0] if index==0 else [],'merges':[] if index==0 else [[0,0,1,2]]}})
        state['continuations']={'table':{'p1-l1':{'kind':'table','next':'p2-l1','separator':None}}}
        _,original=gold.materialize(baseline,state,{'submission':'machine_test','run_id':'invented-continued-table'})
        original['mode']='digitalborn'
        compact=package.pack(original);view=package.parser_view(compact)
        self.assertEqual(package.pack({**original,'structure':view}),compact)
        self.assertFalse(any(n['kind']=='image' for n in view['nodes']))
        self.assertEqual(original['structure']['nodes'][-1]['label'],'Printed seal')
        table=next(a for a in compact['layers']['legal_structure']['annotations'] if a['kind']=='table')
        self.assertEqual(table['fragment_ids'],['table-part-0','table-part-1'])
        self.assertEqual(table['attributes']['rows'][0][1],[])
        self.assertIsNone(table['attributes']['rows'][1][1])
        self.assertEqual(evaluate.compare(compact,baseline),evaluate.compare(original,baseline))

    def test_scoring_uses_one_source_and_newest_annotation(self):
        import json,os
        import score_all
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            def save(mode,revision,finished,parent=None):
                job=root/mode/('a'*64)/revision;job.mkdir(parents=True)
                receipt={'status':'complete','source_sha256':'a'*64,'finished_at':finished,'configuration':{'mode':'ocr'}}
                if parent:receipt['parent_run']=os.path.relpath(parent,job)
                (job/'receipt.json').write_text(json.dumps(receipt));(job/'gold.json.gz').write_bytes(b'fixture')
                return job
            old=save('ocr','first',1);compact=save('packages','compact',100,old)
            self.assertEqual([row[1] for row in score_all.completed(root)],[compact])
            newest=save('ocr','second',2)
            self.assertEqual([row[1] for row in score_all.completed(root)],[newest])


if __name__=='__main__': unittest.main()
