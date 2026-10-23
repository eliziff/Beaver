"""Independent invented text checks source-binding failures in the private authoring harness."""
import copy
import json
import unittest
from pathlib import Path
import tempfile
from unittest.mock import patch

import fitz
import us_author

from us_author import authored


class SourceBindingTests(unittest.TestCase):
    def setUp(self):
        self.text = 'On April 9, 2023, the workshop sent the revised diagram attached as Exhibit Q.'
        self.parts = [{'attachment': 0, 'text': self.text, 'pages': 2},
                      {'attachment': 4, 'text': 'Revised lighting diagram', 'pages': 3}]
        self.gold = {'exhibits': [{'label': 'Q', 'kind': 'chart',
                                  'references': [{'paragraph': None, 'quote': self.text}]}],
                     'events': [{'quote': self.text, 'exhibits': ['Q']}]}
        self.response = {'accept': True, 'gold_json': json.dumps(self.gold),
                         'mapping': [{'label': 'Q', 'attachment': 4, 'first': 1, 'last': 3}]}

    def test_source_bound_single_exhibit_is_valid(self):
        self.assertEqual(authored(self.response, self.parts), self.response)

    def test_line_wrapped_quote_binds_to_original_characters(self):
        source='The diagram bears reference LAMP-\n 7204 and was delivered on Tuesday.'
        quote='The diagram bears reference LAMP-7204 and was delivered on Tuesday.'
        self.assertEqual(us_author.exact_quote(quote,source),source)
        self.assertIsNone(us_author.exact_quote('A different diagram was delivered.',source))

    def test_source_interval_keeps_both_endpoints(self):
        gold=copy.deepcopy(self.gold)
        gold['events'][0].update(id='e01',date='2023-04-01/2023-04-09',precision='range',description='The workshop revised its lighting plan during this interval.')
        response={**self.response,'gold_json':json.dumps(gold)}
        with tempfile.TemporaryDirectory() as raw:
            result=us_author.source_bound_author(response,self.parts,Path(raw))
        event=json.loads(result['gold_json'])['events'][0]
        self.assertEqual((event['date'],event['date_end'],event['precision']),('2023-04-01','2023-04-09','range'))

    def test_unavailable_exhibit_does_not_erase_the_narrated_event(self):
        gold=copy.deepcopy(self.gold)
        gold['events'][0].update(id='e01',exhibits=['Q','SEALED'])
        with tempfile.TemporaryDirectory() as raw:
            result=us_author.source_bound_author({**self.response,'gold_json':json.dumps(gold)},self.parts,Path(raw))
        event=json.loads(result['gold_json'])['events'][0]
        self.assertEqual(event['quote'],self.text)
        self.assertEqual(event['exhibits'],['Q'])

    def test_fabricated_quote_and_out_of_bounds_source_are_rejected(self):
        bad = copy.deepcopy(self.response)
        changed = copy.deepcopy(self.gold)
        changed['events'][0]['quote'] = 'A different event was witnessed.'
        bad['gold_json'] = json.dumps(changed)
        with self.assertRaisesRegex(ValueError, 'quotation absent'):
            authored(bad, self.parts)
        bad = copy.deepcopy(self.response)
        bad['mapping'][0]['last'] = 4
        with self.assertRaisesRegex(ValueError, 'outside PDF'):
            authored(bad, self.parts)

    def test_filed_exhibit_split_across_attachments_keeps_both_parts(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw)
            parts=[]
            for attachment,text in enumerate([self.text,'Lighting diagram, first sheet','Lighting diagram, second sheet']):
                path=root/f'source-{attachment}.pdf'
                with fitz.open() as document:
                    page=document.new_page()
                    page.insert_text((40,50),text)
                    document.save(path)
                parts.append({'attachment':attachment,'path':str(path),'sha256':f'{attachment:064d}',
                              'url':f'https://example.invalid/invented/{attachment}.pdf','pages':1,'text':text})
            gold=copy.deepcopy(self.gold)
            gold.update(court='Invented civil court',document='Invented source declaration')
            response={**self.response,'gold_json':json.dumps(gold),'mapping':[
                {'label':'Q','attachment':1,'first':1,'last':1,'cover':False},
                {'label':'Q','attachment':2,'first':1,'last':1,'cover':False}]}
            directory=root/'work'/'invented-record'
            directory.mkdir(parents=True)
            with patch.object(us_author,'OUT',root):
                target=us_author.build('invented-record',{'case':{'prefix':'invented-proceeding'}},parts,response,None,directory)
            splitting=json.loads((target/'split.json').read_text(encoding='utf8'))
            with fitz.open(target/'files'/splitting['exhibits'][0]['file']) as document:
                self.assertEqual(len(document),2)
                self.assertIn('first sheet',document[0].get_text())
                self.assertIn('second sheet',document[1].get_text())
            self.assertEqual(len(splitting['exhibits'][0]['source_files']),2)


if __name__ == '__main__':
    unittest.main()
