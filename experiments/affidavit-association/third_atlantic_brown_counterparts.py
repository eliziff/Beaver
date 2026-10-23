"""Withhold reviewed-unsafe nested negative; retain genuinely distinct full candidates."""
from third_atlantic_sources import s,O,provenance
import shutil
SH='8368ec0090edb1399075bf26a8d20c3faab64a60edfda4cdf6216fdb48a6504d'
for rid in ['an3-pe-brownvolkswagen-notice-20190709','an3-pe-brownvolkswagen-cityreply-20190801']:
 d=O/'records'/rid;p=d/'distractors.json';base=d/'review-baselines/distractors-before-source-qa.json';base.parent.mkdir(exist_ok=True)
 if not base.exists():shutil.copyfile(p,base)
 f=d/'counterparts/final-order-complete.txt';f.write_text('\f'.join((s.views_folder(s.source(SH))/f'page-{n:04}.txt').read_text('utf8') for n in range(1,20)),encoding='utf8')
 # A separately retained candidate is not an independently accepted training negative.
 s.dump(d/'counterpart-candidates.json',[dict(counterpart_id='LA19009-final-order-LA20-05',same_proceeding=True,source_files=[dict(sha256=SH,url=s.source(SH)['url'],pages=list(range(1,20)),cover_pages=[])],text_file=f.relative_to(d).as_posix(),text_sha256=s.sha(f),eligible=False,review_status='pending_distinct_counterpart_review',near_miss_rationale='Complete December15,2020 Commission adjudication quashes the June21,2019 amendment; different instrument and speaker/date from earlier Council resolution, notice, Cityresponse and its March notices. Whole published original retained, no excerpt substituted.')])
 s.dump(p,[])
 s.dump(d/'counterpart-qa-correction.json',dict(provenance(),baseline_path=base.relative_to(d).as_posix(),baseline_sha256=s.sha(base),source_gold_unchanged=True,reviewed_source_gold_unchanged=True,action='Withhold nested positive readings-sheet negative identified unsafe by fresh source review; empty canonical accepted-negative inventory until distinct complete order candidate receives separate counterpart QA.',candidate_manifest_sha256=s.sha(d/'counterpart-candidates.json')))
print('unsafe nested negative withheld; full genuine later-order candidate retained pending independent QA')
