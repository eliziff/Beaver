"""Hash-bound author progress; canonical acceptance comes only from the review summary."""
from datetime import datetime,timezone
from third_atlantic_sources import s,O,provenance

def main():
 summary=s.read(O/'summary.json')if(O/'summary.json').exists()else{'accepted':[]};withheld=summary.get('withheld',{});records=[]
 for p in sorted((O/'records').glob('*/source-gold.json')):
  g=s.read(p);rid=g['record_id'];records.append(dict(record_id=rid,source_gold_path=p.relative_to(O).as_posix(),source_gold_sha256=s.sha(p),review_status='withheld_duplicate_prior_instrument'if rid in withheld else('accepted'if rid in summary['accepted']else'pending_independent_review'),author_provenance=g['author_provenance']))
 attempts=sum(len(s.read(p).get('attempts',[]))for p in(s.OUT/'calls').rglob('receipt.json')if'/an3-'in p.as_posix())
 s.dump(O/'author-status.json',dict(provenance(),status='source_authoring_completed'if len(records)-len(withheld)==46 else 'source_authoring_in_progress',target=46,records=records,authored_count=len(records),new_authored_count=len(records)-len(withheld),excluded_duplicate_count=len(withheld),accepted_count=len(summary['accepted']),runner_attempts=attempts,runner_attempt_limit=80,scope='Canadian criminal, family and property originals; no class-action, utility or insolvency padding',updated_at_utc=datetime.now(timezone.utc).isoformat()))
 print(len(records)-len(withheld),'distinct authored',len(summary['accepted']),'accepted',attempts,'actual runner attempts')
if __name__=='__main__':main()
