"""Build one development probe in the canonical Cargo target, then run the prepared jobs locally."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from analyze import ROOT, DEFAULT_OUT, digest, read, write


def invoke(command, log, env):
    flags = subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS if os.name == 'nt' else 0
    with log.open('w', encoding='utf-8') as errors:
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=errors,
                                   text=True, encoding='utf-8', creationflags=flags)
        try:
            for line in process.stdout:
                print(line.rstrip(), flush=True)
            code = process.wait()
            if code:
                raise RuntimeError(f'Command failed ({code}): ' + log.read_text(encoding='utf-8')[-3500:])
        finally:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
            process.stdout.close()


def source_identity():
    experiment = ROOT/'experiments/ocr-structure-attribution'
    paths = set(experiment.glob('src/*.rs'))
    paths.update(experiment.glob('Cargo.*'))
    paths.update((ROOT/'experiments/legal-structure-gold/grade/src').glob('*.rs'))
    for owner in ['legal-structure', 'legal-pdf-parser']:
        directory = ROOT/owner
        paths.update(directory.glob('Cargo.*'))
        paths.update(directory.glob('*/Cargo.toml'))
        roots = [directory/'src', directory/'rust/src']
        roots += [p/'src' for p in directory.iterdir() if p.is_dir() and p.name not in ['vendor','target','experiments']]
        for source in roots:
            if source.is_dir(): paths.update(source.rglob('*.rs'))
    return {str(p.relative_to(ROOT)).replace('\\','/'):digest(p) for p in sorted(paths)}


def wait_for_cargo():
    if os.name != 'nt': return
    while True:
        result = subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',
                                 '(@(Get-Process cargo -ErrorAction SilentlyContinue)).Count'],
                                capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW, check=True)
        if int(result.stdout.strip())==0: return
        print('Another Cargo command is active; waiting before starting this build.',flush=True)
        time.sleep(10)


def main():
    parser=argparse.ArgumentParser(__doc__)
    parser.add_argument('--out',type=Path,default=DEFAULT_OUT);parser.add_argument('--skip-build',action='store_true')
    parser.add_argument('--model-pack',type=Path,default=ROOT/'legal-pdf-parser/runtime/indra')
    parser.add_argument('--runtime',type=Path,default=ROOT/'legal-pdf-parser/runtime/onnxruntime.dll')
    args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    binary=ROOT/'native/legal-structure-node/target/debug/ocr-structure-attribution.exe'
    env=dict(os.environ);env['CARGO_BUILD_JOBS']='1';env['RAYON_NUM_THREADS']='1';env['RUST_TEST_THREADS']='1'
    wait_for_cargo()
    if not args.skip_build:
        before=source_identity()
        # scripts/cargo.mjs builds it as every root-workspace build is, into the ordinary incremental target.
        print('Building the experiment binary (development, one Cargo job).',flush=True)
        invoke(['node','scripts/cargo.mjs','build','--offline','--locked','-j','1','--manifest-path','experiments/ocr-structure-attribution/Cargo.toml'],args.out/'build.log',env)
        after=source_identity()
        write(args.out/'build.json',{'binary_sha256':digest(binary),'source_files':after,
                                    'source_unchanged_during_build':before==after})
        if before!=after: raise RuntimeError('Engine sources changed during the build; rerun once they are stable.')
    if not binary.is_file(): raise ValueError('The experiment binary has not been built')
    write(args.out/'run.json',{'binary_sha256':digest(binary),'jobs_sha256':digest(args.out/'jobs.json'),
                              'model_manifest_sha256':digest(args.model_pack/'manifest.json'),'runtime_sha256':digest(args.runtime)})
    wait_for_cargo()
    print('Running the prepared native probes; inputs and weights remain local.',flush=True)
    invoke([str(binary),str(args.out/'jobs.json'),str(args.out/'native'),str(args.model_pack),str(args.runtime)],args.out/'native.log',env)
    invoke([sys.executable,str(Path(__file__).with_name('analyze.py')),'report','--out',str(args.out)],args.out/'report.log',env)


if __name__=='__main__':main()
