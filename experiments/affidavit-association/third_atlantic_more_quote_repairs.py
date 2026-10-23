"""Source-verified mechanical corrections to preserved failed Gold responses."""
import json,re
from third_atlantic_sources import s,O,provenance
for rid,phase in [('an3-nl-inquiry-griffin-20260402','review'),('an3-yt-nachonyakdun-appellant-factum','author')]:
    raw=list((s.OUT/'calls'/rid/phase).rglob('last-message.json'))[-1]
    result=s.read(raw);gold=json.loads(result['gold_json']);changes=[]
    def walk(value):
        if isinstance(value,dict):
            if rid.endswith('factum') and value.get('label')=='Letter from Chief Eddie Taylor et al. to Minister Brad Cathers et al.':
                old=value['label'];value['label']+=', '+value['date']
                changes.append(dict(field='label',before=old,after=value['label'],basis='Existing distinct source-grounded dates and instrument_ids identify two same-title letters. Append actual date to distinguish them; no source or factual change.'))
            replacements={'the Minister’s Advisory Committee (2005)':'Advisory Committee (2005)','Introducing new sweeping proposals and concepts at this stage of the land use planning process would undermine the process set out in Chapter 11':'new sweeping proposals and concepts at this stage of the land use planning process would undermine the process set out in Chapter 11'}
            if value.get('quote') in replacements:
                old=value['quote'];new=replacements[old]
                text='\f'.join((s.views_folder(s.source(value['source_sha256']))/f'page-{n:04}.txt').read_text('utf8')for n in value['source_pages'])
                assert new in old and re.sub(r'\s+',' ',new)in re.sub(r'\s+',' ',text)
                value['quote']=new;changes.append(dict(field='quote',before=old,after=new,source_sha256=value['source_sha256'],source_pages=value['source_pages']))
            for child in value.values():walk(child)
        elif isinstance(value,list):
            for child in value:walk(child)
    walk(gold)
    assert len(changes)==(1 if phase=='review' else 3)
    result['gold_json']=json.dumps(gold,ensure_ascii=False)
    result['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Only source-verified label date disambiguation and/or contiguous shorter quotations. All original claims, dates, source parts and inventories unchanged; no extra provider call.')
    s.dump(O/'corrections'/(rid+'-'+phase+'.json'),result)
    print(rid,len(changes))
