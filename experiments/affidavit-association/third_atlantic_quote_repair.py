"""Preserve a failed raw author response and shorten three source-verified anchors."""
import json,re
from copy import deepcopy
from third_atlantic_sources import s,O,provenance
rid='an3-nl-inquiry-griffin-20260402'
raw=s.OUT/'calls'/rid/'author/3f1f60c74d9f3f18/attempt-2/last-message.json'
result=s.read(raw);original=json.loads(result['gold_json']);gold=deepcopy(original);changes=[]
replacements={
 'SSWB’s Report on Child Welfare Services to Indigenous Children, Youth and Families':'Report on Child Welfare Services to Indigenous Children, Youth and Families',
 'the Minister’s Advisory Committee (2005)':'Advisory Committee (2005)',
 'allowed the Representative to act as the voice of the child or youth’s community in protection matters.':'allowed the Representative to act as the voice',
}
fold=lambda t:re.sub(r'\s+',' ',t).strip()
def visit(value):
    if isinstance(value,dict):
        if value.get('quote') in replacements:
            before=value['quote'];after=replacements[before]
            text='\f'.join((s.views_folder(s.source(value['source_sha256']))/f'page-{n:04}.txt').read_text(encoding='utf8')for n in value['source_pages'])
            assert after in before and fold(after) in fold(text)
            changes.append(dict(before=before,after=after,source_sha256=value['source_sha256'],source_pages=value['source_pages']))
            value['quote']=after
        for child in value.values():visit(child)
    elif isinstance(value,list):
        for child in value:visit(child)
visit(gold);assert len(changes)==3
receipt=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Only contiguous shorter literal quotations; source facts, claims, dates, page bindings and inventory unchanged. Raw failed response and failed attempt retained; independent fresh source review still required.')
result['gold_json']=json.dumps(gold,ensure_ascii=False);result['source_correction_receipt']=receipt
s.dump(O/'corrections'/(rid+'.json'),result)
print('Three shorter original-source quote anchors verified; no provider call')
