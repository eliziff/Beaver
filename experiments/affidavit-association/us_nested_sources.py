"""Select a complete separately filed referring declaration, never a page chunk."""
import json
import fitz
import us_author as u


def main():
    originals=json.loads((u.OUT/'modern-case-screen.json').read_text(encoding='utf8'))
    item=next(x for x in originals if x['entry']==73)
    directory=u.OUT/'work/us-cand-ftc-microsoft-entry-73'
    directory.mkdir(parents=True,exist_ok=True)
    parts,_,_=u.packet(item,directory)
    primary=next(x for x in parts if x['source_attachment']==1)
    with fitz.open(primary['path']) as pdf:
        text='\n'.join(f'[source page {i+1}]\n{p.get_text()}' for i,p in enumerate(pdf))
    if 'DECLARATION' not in text or 'Exhibit A' not in text or 'Exhibit B' not in text:
        raise ValueError('The complete attachment is not the expected referring declaration')
    selected={**item,'parent_url':item['url'],'primary_attachment':1,
        'selection':'Complete separately filed declaration PDF; no page slicing',
        'main':next(x for x in item['parts'] if x['key'].endswith('.1.pdf')),
        'parts':[x for x in item['parts'] if not x['key'].endswith('.1.pdf')],
        'url':primary['url'],'sha256':primary['sha256'],'path':primary['path'],
        'pages':primary['pages'],'text':text}
    u.dump(u.OUT/'nested-case-screen.json',[selected])
    print(text)


if __name__=='__main__':
    main()
