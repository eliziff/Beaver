"""Check publishable files without printing the personal values that matched."""
import argparse
import base64
import hashlib
import io
import os
import re
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

# Exact address fingerprints avoid flagging public court records and licenses.
# Standard build accounts and conventional synthetic placeholders are not identities.
PRIVATE_EMAILS = set(filter(None, os.environ.get('BEAVER_PRIVATE_EMAIL_SHA256', '').split(',')))
HOME = re.compile(r'(?:[a-z]:[\\/]+Users[\\/]+|/mnt/[a-z]/Users/|(?<![a-z0-9_.-])/(?:Users|home)/)(?!(?:runner|runneradmin|sandbox|build|Public|Shared|Default|user|someone)(?:[\\/]|$))[a-z0-9_.@-]+[\\/]', re.I)
EMAIL = re.compile(r'[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}', re.I)
PRIVATE_FILE = re.compile(r'(?:^|/)(?:private_sources|private_comparison|court-record-exhibits|prompt_live|\.auth)(?:/|$)|(?:^|/)(?:\.codex/sessions/|private_manifest\.jsonl?$|auth\.json$|storageState\.json$|application\.(?:sqlite|db)(?:-wal|-shm)?$)', re.I)
EMBEDDED = re.compile(rb'(?:AGFzb|UEsDB)[A-Za-z0-9+/=]{400,}')
MEDIA = {'.docx','.pdf','.png','.jpg','.jpeg','.webp','.gif','.woff','.woff2','.ttf','.ico','.pptx','.xlsx','.zip','.tgz','.gz'}

def findings(raw):
    text=raw.decode('utf-8',errors='ignore')
    if b'\0' in raw[:8192]: text+='\n'+raw.decode('utf-16-le',errors='ignore')
    result=[]
    if HOME.search(text): result.append('personal home path')
    addresses=(email for at in re.finditer('@',text) for email in EMAIL.finditer(text[max(0,at.start()-64):at.start()+256]))
    if any(hashlib.sha256(m.group().lower().encode()).hexdigest() in PRIVATE_EMAILS for m in addresses):
        result.append('private email address')
    return result

def inspect_artifact(raw,name,depth=0):
    if depth>6: raise ValueError('archive nesting exceeds six levels')
    result=[(name,'private artifact packaged')] if PRIVATE_FILE.search(name.split('!')[-1]) else []
    if zipfile.is_zipfile(io.BytesIO(raw)):
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            for item in archive.infolist():
                if not item.is_dir(): result.extend(inspect_artifact(archive.read(item),name+'!'+item.filename,depth+1))
    elif name.endswith(('.tgz','.tar.gz','.tar')):
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            for item in archive:
                if item.isfile(): result.extend(inspect_artifact(archive.extractfile(item).read(),name+'!'+item.name,depth+1))
    else:
        result.extend((name,reason) for reason in findings(raw))
        for match in EMBEDDED.finditer(raw):
            try: payload=base64.b64decode(match.group(),validate=True)
            except ValueError: continue
            if payload.startswith((b'\0asm',b'PK\x03\x04')):
                result.extend(inspect_artifact(payload,name+'!embedded',depth+1))
    return result

def git(*args): return subprocess.check_output(['git',*args])

def self_test():
    example=('C:'+ '/Users/'+'private-person'+'/project').encode()
    assert findings(example)==['personal home path']
    assert findings(example.decode().encode('utf-16-le'))==['personal home path']
    assert findings(b'https://example.test/source; project/relative/file.ts')==[]
    assert findings(b'https://example.test/home/someone/project')==[]
    assert findings((b'file:///home/' + b'private-person/project'))==['personal home path']
    assert findings((b'/mnt/c/Users/' + b'private-person/project'))==['personal home path']
    assert findings(('C:'+ '/Users/'+'<username>'+'/project').encode())==[]
    assert PRIVATE_FILE.search('benchmarks/private_sources/document.docx')
    assert PRIVATE_FILE.search('benchmarks/private_manifest.jsonl')
    invented=b'owner@example.test';fingerprint=hashlib.sha256(invented).hexdigest()
    PRIVATE_EMAILS.add(fingerprint)
    assert findings(b'public@example.test '+invented)==['private email address']
    PRIVATE_EMAILS.remove(fingerprint)
    archive=io.BytesIO()
    with zipfile.ZipFile(archive,'w') as package: package.writestr('fixture.wasm',b'\0asm'+example)
    assert inspect_artifact(archive.getvalue(),'package.zip')==[('package.zip!fixture.wasm','personal home path')]
    archive=io.BytesIO()
    with zipfile.ZipFile(archive,'w') as package: package.writestr('auth.json',b'{}')
    assert inspect_artifact(archive.getvalue(),'package.zip')==[('package.zip!auth.json','private artifact packaged')]
    print('Privacy checker self-test passed.')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged',action='store_true',help='Read staged blobs, not working files.')
    parser.add_argument('--artifact',nargs='+',type=Path,help='Inspect release files, archives and embedded WASM/ZIP payloads.')
    parser.add_argument('--self-test',action='store_true')
    args=parser.parse_args()
    if args.self_test: self_test();return 0
    configured=subprocess.run(['git','config','--get','privacy.privateEmailSha256'],capture_output=True,text=True).stdout.strip()
    PRIVATE_EMAILS.update(filter(None,configured.split(',')))
    errors=[];checked=0
    if args.artifact:
        for path in args.artifact:
            errors.extend(inspect_artifact(path.read_bytes(),path.name));checked+=1
    else:
        # A staged gitlink has no blob to read; the submodule's own repository is checked separately.
        names=git('diff','--cached','--name-only','--diff-filter=ACMR','--ignore-submodules=all','-z') if args.staged else git('ls-files','-z')
        for name in names.decode().split('\0'):
            if not name: continue
            if PRIVATE_FILE.search(name): errors.append((name,'private artifact tracked'))
            if Path(name).suffix.lower() in MEDIA: continue
            if args.staged: raw=git('show',':'+name)
            else:
                path=Path(name)
                if not path.is_file() or path.is_symlink(): continue
                raw=path.read_bytes()
            errors.extend((name,reason) for reason in findings(raw));checked+=1
        for email in git('log','--format=%ae%n%ce','HEAD').decode().splitlines():
            if hashlib.sha256(email.lower().encode()).hexdigest() in PRIVATE_EMAILS:
                errors.append(('history','private email in commit attribution; use GitHub noreply'))
    for name,reason in sorted(set(errors)): print(f'{name}: {reason}',file=sys.stderr)
    print(f'Privacy check: {checked} files, {len(set(errors))} findings. No matched personal values printed.')
    return bool(errors)

if __name__=='__main__': sys.exit(main())
