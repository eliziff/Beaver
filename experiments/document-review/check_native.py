"""Check native bytes, complete attachments, quoted threads and substantive versions."""
import argparse
from email import policy
from email.parser import BytesParser
import json
from pathlib import Path

import benchmark as b
from pypdf import PdfReader


def check(key):
    folder=b.PRIVATE/'histories'/key
    world,manifest=b.read(folder/'world.json'),b.read(folder/'manifest.json')
    rows={r['doc_id']:r for r in manifest['documents']}
    assert len(rows)==len(manifest['documents'])
    assert manifest['world_sha256']==b.digest(folder/'world.json')
    mails={}
    versions={}
    for row in rows.values():
        native,printed=b.PRIVATE/row['native_file'],b.PRIVATE/row['print_file']
        assert b.digest(native)==row['native_sha256'] and b.digest(printed)==row['print_sha256']
        page_count=len(PdfReader(printed).pages)
        assert page_count>0
        attached=row['attachment_ids']
        assert len(attached)==len(row['attachment_pages'])
        for component in row['attachment_pages']:
            target=rows[component['doc_id']]
            assert len(component['pages'])==len(PdfReader(b.PRIVATE/target['print_file']).pages)
            assert all(1<=p<=page_count for p in component['pages'])
        if row['format']=='eml':
            message=BytesParser(policy=policy.default).parsebytes(native.read_bytes())
            attachments=list(message.iter_attachments())
            assert len(attachments)==len(attached)
            for actual,target in zip(attachments,attached):
                assert actual.get_payload(decode=True)==(b.PRIVATE/rows[target]['native_file']).read_bytes()
            mails[row['doc_id']]=message
        if row['format']=='xlsx':
            from openpyxl import load_workbook
            spec=row['spreadsheet']
            formulas=load_workbook(native,data_only=False)
            cached=load_workbook(native,data_only=True)
            try:
                assert formulas.active[spec['total_cell']].data_type=='f'
                assert round(sum(cached.active[c].value for c in spec['amount_cells']),2)==round(spec['total'],2)
                assert round(cached.active[spec['total_cell']].value,2)==round(spec['total'],2)
            finally:
                formulas.close()
                cached.close()
        if row['version_group']:
            versions.setdefault(row['version_group'],[]).append(row)
    threads={}
    for row in world['documents']:
        if 'thread_pos' in row['render_params']:
            threads.setdefault(row['engagement'],[]).append(row)
    for members in threads.values():
        ordered=sorted(members,key=lambda r:r['render_params']['thread_pos'])
        for previous,current in zip(ordered,ordered[1:]):
            prior=mails[previous['record_id']]
            message=mails[current['record_id']]
            assert message['In-Reply-To']==prior['Message-ID']
            assert str(prior['Message-ID']) in str(message['References'])
            assert prior.get_body(preferencelist=('plain',)).get_content().strip().splitlines()[0] in message.get_body(preferencelist=('plain',)).get_content()
    for group,members in versions.items():
        if group.endswith(':note') and len(members)>1:
            assert len({r['source_text'] for r in members})>1
    client,lawyer=world['people']['client'],world['people']['lawyer']
    assert client['email'] in str(mails['reply']['To'])
    assert lawyer['email'] in str(mails['query']['To'])
    if 'team' in mails:
        assert world['people']['co_counsel']['email'] in str(mails['team']['To'])
        assert rows['team']['attachment_ids']==['reply']
    return {'set':key,'records':len(rows),'emails':len(mails),'native_checks':'passed',
            'world_sha256':b.digest(folder/'world.json'),'manifest_sha256':b.digest(folder/'manifest.json')}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sets',nargs='+')
    args=parser.parse_args()
    results=[]
    for item in b.spec():
        if args.sets and item['id'] not in args.sets:continue
        results.append(check(item['id']))
        print(json.dumps(results[-1]),flush=True)
    b.dump(b.PRIVATE/'native-checks-latest.json',{'origin':'machine_test','run_id':b.RUN,
        'validator_sha256':b.digest(Path(__file__)),'sets':results})
