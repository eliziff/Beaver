"""Extract complete visible body text from unpaginated official court HTML originals."""
from html.parser import HTMLParser
from pathlib import Path
import hashlib,json,sys,re
from third_atlantic_sources import s,O,provenance
class BodyText(HTMLParser):
    def __init__(self):super().__init__(convert_charrefs=True);self.body=False;self.skip=0;self.out=[]
    def handle_starttag(self,tag,attrs):
        if tag=='body':self.body=True
        if self.body and tag in ('script','style'):self.skip+=1
        if self.body and not self.skip and tag in ('p','div','tr','br','h1','h2','h3','li'):self.out.append('\n')
        if self.body and not self.skip and tag in ('td','th'):self.out.append('\t')
    def handle_endtag(self,tag):
        if self.body and tag in ('script','style'):self.skip=max(0,self.skip-1)
        if self.body and not self.skip and tag in ('p','div','tr','h1','h2','h3','li'):self.out.append('\n')
        if tag=='body':self.body=False
    def handle_data(self,data):
        if self.body and not self.skip:self.out.append(data)
def extract(prefix, expected='Kerr'):
    item=s.source(prefix);raw=Path(item['original_path']).read_bytes();assert hashlib.sha256(raw).hexdigest()==item['sha256']
    declared=re.search(br'charset\s*=\s*["\x27]?([a-zA-Z0-9_-]+)',raw[:12000],re.I)
    assert declared, 'Original HTML must declare its encoding'
    encoding=declared.group(1).decode('ascii')
    parser=BodyText();parser.feed(raw.decode(encoding,errors='strict'));text=''.join(parser.out);assert text.strip() and expected in text
    folder=s.views_folder(item);folder.mkdir(exist_ok=True,parents=True);target=folder/'page-0001.txt';assert not target.exists();target.write_text(text,encoding='utf8')
    row=dict(provenance(),source_sha256=item['sha256'],source_url=item['url'],source_format='text/html',declared_character_encoding=encoding,source_locator_kind='whole_unpaginated_html_document',source_page=1,page_number_semantics='Logical capture unit only; not an original physical PDF page or invented pagination.',method='Python standard-library HTMLParser; complete body text, paragraph/block breaks and cell tabs; suppress only non-visible head/script/style/comment markup; preserve Unicode and all body data including footnotes.',text_sha256=s.sha(target),source_review_status='pending_independent_original_source_review',original_pdf_claim=False)
    s.dump(folder/'page-0001.json',row);s.dump(folder/'coverage.json',dict(source_sha256=item['sha256'],complete_whole_document_projection=True,original_format='unpaginated_html',logical_capture_units=[row],source_review_status='not_implied_by_extraction'))
    print(prefix,len(text),'characters; whole original body, no clipping')
if __name__=='__main__':
    import argparse
    ap=argparse.ArgumentParser();ap.add_argument('prefix',nargs='+');ap.add_argument('--expected',default='Kerr');args=ap.parse_args()
    for prefix in args.prefix:extract(prefix,args.expected)
