"""Preserve Oland author output; shorten anchors around extracted paragraph numbers."""
import json,re
from third_atlantic_sources import s,O,provenance
rid='an3-nb-oland-appellant-factum';raw=list((s.OUT/'calls'/rid/'author').rglob('last-message.json'))[-1];r=s.read(raw);g=json.loads(r['gold_json']);changes=[]
def walk(x):
    if isinstance(x,dict):
        old=x.get('quote','');new=None
        if old.startswith('discovered Richard'):new='body on the office floor.'
        elif old=='He was charged the following day.':new='charged the following day.'
        elif old=='arguable grounds with a potential prospect of obtaining a new trial or acquittal':new='arguable grounds with a potential prospect of'
        if new:
            text='\f'.join((s.views_folder(s.source(x['source_sha256']))/f'page-{n:04}.txt').read_text('utf8')for n in x['source_pages'])
            assert new in old and re.sub(r'\s+',' ',new)in re.sub(r'\s+',' ',text)
            changes.append(dict(before=old,after=new,source_sha256=x['source_sha256'],source_pages=x['source_pages'],basis='Longer extracted phrase crosses an interposed original paragraph number; use an exact shorter contiguous source phrase.'))
            x['quote']=new
        for v in x.values():walk(v)
    elif isinstance(x,list):
        for v in x:walk(v)
walk(g);assert len(changes)==3
r['gold_json']=json.dumps(g,ensure_ascii=False);r['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Only three contiguous shorter literal source anchors. All claims, dates, sources and complete inventory unchanged; no extra provider call.')
s.dump(O/'corrections'/(rid+'-author.json'),r);print('3 literal anchors repaired')
