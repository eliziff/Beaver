"""Acquire a broad official-snapshot pool directly into checked Rust Zstandard packs.

Python is the HTTP/CSV acquisition adapter. Corpus processing uses Rust.
No inflated SQLite or uncompressed JSONL corpus is written.
"""
import argparse
import bz2
import csv
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from sample import BASE, ROOT, get_range, complete_rows, bzip2recover_path, range_plan
from sample_courtlistener_opinions import midpoint_plan
from budget import CAP, BudgetExhausted, metadata_growth, occupied, require_bytes, writer

NATIVE_SIDECAR_RESERVE = 16*1024*1024

def save(path, value):
    temporary = path.with_suffix('.pending')
    data = (json.dumps(value, indent=2) + '\n').encode('utf-8')
    with writer():
        require_bytes(len(data))
        physical_free = shutil.disk_usage(path.parent).free
        if len(data)>physical_free:
            raise BudgetExhausted(f'CourtListener physical disk: {len(data):,} bytes required; {physical_free:,} free')
        with temporary.open('xb') as output:
            output.write(data)
        temporary.replace(path)

def pack_ids(pack):
    if (pack/'index.json').is_file():
        index = json.loads((pack/'index.json').read_text())
        return {identifier for frame in index['frames'] for identifier in frame['ids']}
    pool = json.loads((pack/'source.json').read_text())
    return set().union(*(pack_ids(pack/part['path']) for part in pool['parts']))

def sidecar_allowance(rows, identifiers, columns, packs):
    # At most one frame per new row. ASCII escaping bounds Rust's UTF-8 strings;
    # maximum u64 counters bound every native size/offset/count field.
    maximum = 2**64-1
    cluster_column = columns.index('cluster_id')
    clusters, missing = set(), set()
    for row in rows:
        if row[0] in identifiers:
            if row[cluster_column]:
                clusters.add(row[cluster_column])
            else:
                missing.add(row[0])
    index = {'schema':'courtlistener.lossless-zstd-frames.v1','rows':maximum,
             'raw_bytes':maximum,'compressed_bytes':maximum,'level':9,'block_bytes':8388608,
             'frames':[{'offset':maximum,'bytes':maximum,'raw_bytes':maximum,
                        'sha256':'f'*64,'ids':[identifier]} for identifier in identifiers],
             'input_rows':maximum,'skipped_existing_rows':maximum,
             'exclusion_sources':[{'path':str(pack),
                 'receipt':'index.json' if (pack/'index.json').is_file() else 'source.json',
                 'sha256':'f'*64} for pack in packs]}
    membership = {'schema':'courtlistener.cluster-membership.v1','index_sha256':'f'*64,
                  'rows':maximum,'cluster_ids':sorted(clusters),
                  'opinions_missing_cluster_id':sorted(missing)}
    return sum(len(json.dumps(value,ensure_ascii=True,indent=2).encode('utf-8'))+1
               for value in (index, membership))

def free_gaps(blocked, start, end):
    gaps, cursor = [], start
    for left, right in sorted(blocked):
        if right < cursor:
            continue
        if left > end:
            break
        if left > cursor:
            gaps.append((cursor, min(end, left-1)))
        cursor = max(cursor, right+1)
        if cursor > end:
            break
    if cursor <= end:
        gaps.append((cursor, end))
    return gaps

def append_window(plan, size, width, base_count, excluded_windows, priorities):
    ordinal = len(plan)
    blocked = [(window['start'], window['end']) for window in plan] + excluded_windows
    if ordinal < 2*base_count-1:
        gap = ordinal-base_count
        requested, _ = midpoint_plan(size, base_count-1, width)[gap]
        low, high = plan[gap]['end']+1, plan[gap+1]['start']-1
        choices = [min(max(requested, left), right-width+1)
                   for left, right in free_gaps(blocked, low, high) if right-left+1 >= width]
        if choices:
            start = min(choices, key=lambda value:(abs(value-requested), value))
            plan.append({'ordinal':ordinal, 'start':start, 'end':start+width-1,
                         'requested_start':requested})
            return True
    gaps = [(left, right) for left, right in free_gaps(blocked, 0, size-1)
            if right-left+1 >= width]
    if not gaps:
        return False
    def rank(gap):
        score = max((item['priority'] for item in priorities['gaps']
                     if item['start'] <= gap[1] and gap[0] <= item['end']), default=0)
        return score, gap[1]-gap[0], -gap[0]
    left, right = max(gaps, key=rank)
    start = (left+right-width+1)//2
    plan.append({'ordinal':ordinal, 'start':start, 'end':start+width-1})
    return True

def coverage_priorities(path, identity):
    if path is None or not path.is_file():
        return {'ordinals':[], 'gaps':[], 'basis':'exploration-only; source position is not metadata',
                'path':str(path.resolve()) if path is not None else None}
    raw = path.read_bytes()
    value = json.loads(raw)
    if any(value['source'].get(key) != identity[key] for key in ('url', 'bytes', 'etag')):
        raise ValueError('Coverage priorities belong to a different original snapshot')
    ordinals, gaps = value.get('ordinals', []), value.get('gaps', [])
    if any(type(ordinal) is not int or ordinal < 0 for ordinal in ordinals):
        raise ValueError('Coverage priorities require nonnegative window ordinals')
    for gap in gaps:
        if (type(gap['start']) is not int or type(gap['end']) is not int
                or not 0 <= gap['start'] <= gap['end'] < identity['bytes']
                or not isinstance(gap['priority'], (int, float))
                or not -float('inf') < gap['priority'] < float('inf')):
            raise ValueError('Coverage gap priority is outside the original snapshot')
    return {**value, 'ordinals':ordinals, 'gaps':gaps, 'path':str(path.resolve()),
            'sha256':hashlib.sha256(raw).hexdigest()}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--snapshot', default='2026-09-30')
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--packer', required=True, type=Path)
    p.add_argument('--ranges', type=int, default=128)
    p.add_argument('--range-bytes', type=int, default=32*1024*1024)
    p.add_argument('--total-windows', type=int, help='Append to at least this total; retain any larger resumed plan')
    p.add_argument('--fill-budget', action='store_true', help='Keep adding uncovered windows until the shared budget stops acquisition')
    p.add_argument('--verify-parts', action='store_true', help='Independently reopen each new pack against its acquired original source bytes')
    p.add_argument('--exclude-pack', type=Path, action='append', default=[])
    p.add_argument('--exclude-source', type=Path, action='append', default=[],
                   help='Matching original source.json for each --exclude-pack, in the same order')
    p.add_argument('--coverage-priorities', type=Path, help='Reload cached metadata/all-rendition window priorities between downloads')
    p.add_argument('--working-reserve-bytes', type=int, default=1_500_000_000,
                   help='Reserved scratch/receipt headroom; existing default is unchanged')
    p.add_argument('--minimum-available-bytes', type=int, default=512*1024*1024,
                   help='Stop before packing when the available allocation is smaller')
    p.add_argument('--outstanding-browser-bytes', type=int, default=0,
                   help='Additional allocation for all queued browser collection growth')
    p.add_argument('--outstanding-output-bytes', type=int, default=0,
                   help='Additional allocation for other pending corpus outputs')
    a = p.parse_args()
    if min(a.working_reserve_bytes,a.outstanding_browser_bytes,a.outstanding_output_bytes) < 0:
        p.error('Reserved byte allocations cannot be negative')
    if a.working_reserve_bytes < a.range_bytes:
        p.error('--working-reserve-bytes must retain one original source window if packing fails')
    if a.minimum_available_bytes <= NATIVE_SIDECAR_RESERVE:
        p.error('--minimum-available-bytes must exceed the native 16 MiB sidecar reservation')
    reserved = a.working_reserve_bytes+a.outstanding_browser_bytes+a.outstanding_output_bytes
    if len(a.exclude_pack) != len(a.exclude_source):
        p.error('Each --exclude-pack requires its matching --exclude-source')
    if a.total_windows is not None and a.total_windows < a.ranges:
        p.error('--total-windows cannot be smaller than the original base plan')
    csv.field_size_limit(2**31-1)
    out, executable = a.out.resolve(), a.packer.resolve(strict=True)
    out.mkdir(parents=True, exist_ok=True)
    (out/'parts').mkdir(exist_ok=True)
    url = BASE + f'opinions-{a.snapshot}.csv.bz2'
    manifest_path = out/'source.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    with urllib.request.urlopen(urllib.request.Request(url,method='HEAD'),timeout=60) as r:
        size, etag = int(r.headers['Content-Length']), r.headers['ETag']
    first = None
    if manifest is None:
        first = get_range(url,0,a.range_bytes-1,etag)
        header = bz2.BZ2Decompressor().decompress(first).split(b'\n',1)[0].decode('utf-8')
        columns = next(csv.reader([header],escapechar='\\',doublequote=False,quoting=csv.QUOTE_NOTNULL))
    else:
        columns = manifest['source']['columns']
    if (not isinstance(columns, list) or not columns or columns[0] != 'id'
            or any(not isinstance(column, str) for column in columns)
            or 'cluster_id' not in columns or len(set(columns)) != len(columns)):
        raise ValueError('Unrecognized retained official source header')
    identity = {'url':url,'bytes':size,'etag':etag,'columns':columns,
                'ranges':a.ranges,'range_bytes':a.range_bytes}
    manifest = manifest if manifest is not None else {
        'schema':'courtlistener.acquired-pack-pool.v1','source':identity,'parts':[],
        'complete':False,'full_corpus':False,'disk_cap_bytes':CAP,
        'sampling':'Evenly spaced wide compressed windows; complete recoverable CSV records only'}
    if manifest['source'] != identity:
        raise ValueError('Existing corpus has a different source or acquisition plan')
    exclusions, excluded_windows, excluded_ids = [], [], set()
    for pack, source_path in zip(a.exclude_pack, a.exclude_source):
        source = json.loads(source_path.read_text())
        if any(source['source'].get(key) != identity[key] for key in ('url', 'bytes', 'etag', 'columns')):
            raise ValueError('Exclusion belongs to a different original source snapshot')
        windows = source.get('planned_windows', source.get('ranges', source.get('parts')))
        if not isinstance(windows, list):
            raise ValueError('Exclusion source does not identify retained byte windows')
        if any(not 0 <= window['start'] <= window['end'] < size for window in windows):
            raise ValueError('Excluded byte window is outside the original snapshot')
        excluded_windows.extend((window['start'], window['end']) for window in windows)
        pack = pack.resolve(strict=True)
        if pack == out:
            raise ValueError('The destination pool is already an implicit exclusion')
        exclusions.append({'pack':str(pack), 'source':str(source_path.resolve()),
                           'source_sha256':hashlib.sha256(source_path.read_bytes()).hexdigest()})
        excluded_ids.update(pack_ids(pack))
    if manifest.get('exclusions', exclusions) != exclusions:
        raise ValueError('Resume requires the same validated exclusions')
    manifest['exclusions'] = exclusions
    base_plan = [{'ordinal':ordinal, 'start':start, 'end':end}
                 for ordinal, (start, end) in enumerate(range_plan(size,a.ranges,a.range_bytes))]
    plan = manifest.setdefault('planned_windows', base_plan)
    if len(plan) < a.ranges or any(
            any(plan[i].get(key) != window[key] for key in ('ordinal', 'start', 'end'))
            for i, window in enumerate(base_plan)):
        raise ValueError('Retained base window plan changed')
    if any(window['ordinal'] != ordinal for ordinal, window in enumerate(plan)):
        raise ValueError('Retained acquisition ordinals changed')
    for part in manifest['parts']:
        if not 0 <= part['ordinal'] < len(plan) or any(
                part[key] != plan[part['ordinal']][key] for key in ('start', 'end')):
            raise ValueError('Completed source part differs from its retained window')
    priorities = coverage_priorities(a.coverage_priorities, identity)
    target_windows = max(a.total_windows or len(plan), len(plan))
    if a.fill_budget:
        target_windows = max(target_windows, 2*a.ranges-1)
    while len(plan) < target_windows:
        if not append_window(plan, size, a.range_bytes, a.ranges, excluded_windows, priorities):
            raise ValueError('No nonoverlapping full-width source window remains')
    manifest.pop('minimum_records',None)
    manifest.pop('stop_reason',None)
    manifest.pop('stop_admission',None)
    manifest['disk_cap_bytes']=CAP
    manifest['budget_allocations'] = {'working_reserve_bytes':a.working_reserve_bytes,
        'minimum_available_bytes':a.minimum_available_bytes,
        'outstanding_browser_bytes':a.outstanding_browser_bytes,
        'outstanding_output_bytes':a.outstanding_output_bytes,
        'native_sidecar_reserve_bytes':NATIVE_SIDECAR_RESERVE,
        'physical_free_space_protected':True}
    manifest['complete']=False
    manifest['source_position_not_metadata']=True
    manifest['sampling']='Stable base windows, then complementary uncovered gaps; complete recoverable CSV records only'
    manifest['coverage_priorities']=priorities
    save(manifest_path,manifest)
    seen = set()
    for part in manifest['parts']:
        index = json.loads((out/part['path']/'index.json').read_text())
        for frame in index['frames']:
            for identifier in frame['ids']:
                if identifier in seen:
                    raise ValueError('Duplicate source id across completed parts')
                seen.add(identifier)
    recover = bzip2recover_path(None)
    scratch = ROOT/'.tmp'
    scratch.mkdir(exist_ok=True)
    started = time.monotonic()
    completed = {part['ordinal'] for part in manifest['parts']}
    while True:
        # Leave room for the browser corpus, scratch blocks, indexes and receipts.
        growth = metadata_growth()
        logical_available = CAP-occupied()-growth-reserved
        physical_free = min(shutil.disk_usage(out).free,shutil.disk_usage(scratch).free)
        physical_available = physical_free-growth-reserved
        available = min(logical_available,physical_available)
        if available<a.minimum_available_bytes:
            manifest['stop_reason']='physical_disk_budget' if physical_available<logical_available else 'disk_budget'
            manifest['stop_admission']={'phase':'before_fetch','logical_available_bytes':logical_available,
                'physical_free_bytes':physical_free,'physical_available_bytes':physical_available,
                'metadata_growth_bytes':growth,'reserved_bytes':reserved}
            break
        priorities = coverage_priorities(a.coverage_priorities, identity)
        manifest['coverage_priorities']=priorities
        pending = [window for window in plan if window['ordinal'] not in completed]
        if not pending:
            if not a.fill_budget:
                break
            if not append_window(plan, size, a.range_bytes, a.ranges, excluded_windows, priorities):
                manifest['stop_reason']='no_uncovered_full_width_window'
                break
            save(manifest_path,manifest)
            pending = [plan[-1]]
        bits = (len(plan)-1).bit_length()
        preferred = {ordinal:index for index, ordinal in enumerate(priorities['ordinals'])}
        window = min(pending, key=lambda value:(
            preferred.get(value['ordinal'], len(preferred)),
            int(f'{value["ordinal"]:0{bits}b}'[::-1],2)))
        ordinal, start, end = window['ordinal'], window['start'], window['end']
        destination = out/'parts'/f'{ordinal:04d}'
        if destination.exists():
            # Interrupted pack outputs are preserved for inspection, never accepted as complete.
            raise ValueError(f'Uncommitted part exists: {destination}; inspect before resuming')
        data = first if start == 0 and first is not None else get_range(url,start,end,etag)
        with tempfile.TemporaryDirectory(prefix='courtlistener-range-',dir=scratch) as name:
            work = Path(name)
            with writer():
                physical_free = min(shutil.disk_usage(out).free,shutil.disk_usage(work).free)
                physical_available = physical_free-metadata_growth()-reserved
                if physical_available<max(a.minimum_available_bytes,len(data)):
                    manifest['stop_reason']='physical_disk_budget'
                    manifest['stop_admission']={'phase':'before_source_write','physical_free_bytes':physical_free,
                        'physical_available_bytes':physical_available,'source_bytes':len(data),'reserved_bytes':reserved}
                    break
                (work/'range.bin').write_bytes(data)
            with (work/'recover.log').open('w') as log:
                subprocess.run([str(recover),'range.bin'],cwd=work,stdout=log,stderr=subprocess.STDOUT,
                    check=True,creationflags=subprocess.CREATE_NO_WINDOW if sys.platform=='win32' else 0)
            blocks = sorted(work.glob('rec*.bz2'))
            raw = b''.join(bz2.decompress(b.read_bytes()) for b in blocks)
            options = sorted([complete_rows(raw,columns,False),complete_rows(raw,columns,True)],
                             key=lambda result:len(result[0]),reverse=True)
            rows,rejected = options[0]
            if not rows or len(rows)==len(options[1][0]) and rows!=options[1][0]:
                raise ValueError(f'No unambiguous complete source records: {ordinal}')
            input_ids = {row[0] for row in rows}
            if len(input_ids) != len(rows):
                raise ValueError('Duplicate id in recovered original source window')
            expected_ids = input_ids-seen-excluded_ids
            sidecar_bytes = sidecar_allowance(rows,expected_ids,columns,
                ([out] if manifest['parts'] else [])+[Path(item['pack']) for item in exclusions])
            with writer():
                pre_pack_occupied, growth = occupied(), metadata_growth()
                logical_available = CAP-pre_pack_occupied-growth-reserved
                physical_free = min(shutil.disk_usage(out).free,shutil.disk_usage(work).free)
                physical_available = physical_free-growth-reserved
                available = min(logical_available,physical_available)
                maximum_bytes = available-max(0,sidecar_bytes-NATIVE_SIDECAR_RESERVE)
                if maximum_bytes<a.minimum_available_bytes:
                    manifest['stop_reason']='physical_disk_budget' if physical_available<logical_available else 'disk_budget'
                    manifest['stop_admission']={'phase':'before_pack','logical_available_bytes':logical_available,
                        'physical_free_bytes':physical_free,'physical_available_bytes':physical_available,
                        'metadata_growth_bytes':growth,'reserved_bytes':reserved,
                        'native_maximum_bytes':maximum_bytes,'sidecar_allowance_bytes':sidecar_bytes}
                    break
                command = [str(executable),'pack',str(destination),'9','8388608',str(maximum_bytes)]
                if manifest['parts']:
                    command.extend(('--exclude-pack', str(out)))
                for exclusion in exclusions:
                    command.extend(('--exclude-pack', exclusion['pack']))
                source_jsonl_hash = hashlib.sha256()
                source_jsonl_bytes = 0
                process = subprocess.Popen(command,stdin=subprocess.PIPE)
                try:
                    for row in rows:
                        value = {'opinion':dict(zip(columns,row)),'range_index':ordinal}
                        encoded = json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')+b'\n'
                        if row[0] in expected_ids:
                            source_jsonl_hash.update(encoded)
                            source_jsonl_bytes += len(encoded)
                        process.stdin.write(encoded)
                    process.stdin.close()
                    if process.wait()!=0:
                        raise RuntimeError('Rust packer failed; source part was not committed')
                    index = json.loads((destination/'index.json').read_text())
                    skipped = index['skipped_existing_rows']
                    if index['rows']+skipped!=len(rows) or index['input_rows']!=len(rows):
                        raise ValueError('Native pack membership differs from independent acquired source')
                    stored_ids = {identifier for frame in index['frames'] for identifier in frame['ids']}
                    if stored_ids != expected_ids or len(stored_ids) != index['rows']:
                        raise ValueError('Native stored IDs differ from independently expected new source IDs')
                    if index['raw_bytes']!=source_jsonl_bytes:
                        raise ValueError('Native byte count differs from independently submitted new source JSONL')
                    artifact_bytes = sum(path.stat().st_size for path in destination.rglob('*') if path.is_file())
                    actual_sidecar_bytes = artifact_bytes-index['compressed_bytes']
                    if actual_sidecar_bytes>sidecar_bytes or artifact_bytes>available:
                        raise ValueError('Native part exceeded its preflight artifact allowance; retained uncommitted')
                except BaseException:
                    witness = out/f'uncommitted-range-{ordinal:04d}.bin'
                    if witness.exists():
                        raise FileExistsError(f'Existing interrupted source evidence: {witness}')
                    require_bytes(len(data))
                    (work/'range.bin').replace(witness)
                    save(witness.with_suffix('.json'), {'source':identity,'window':window,
                        'compressed_source_sha256':hashlib.sha256(data).hexdigest(),
                        'source_bytes':len(data),'part_committed':False,
                        'native_maximum_bytes':maximum_bytes,'sidecar_allowance_bytes':sidecar_bytes})
                    raise
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.wait()
                seen.update(stored_ids)
                manifest['parts'].append({'ordinal':ordinal,'path':destination.relative_to(out).as_posix(),
                    'start':start,'end':end,'compressed_source_sha256':hashlib.sha256(data).hexdigest(),
                    'recovered_blocks':len(blocks),'recovered_bytes':len(raw),'rows':index['rows'],
                    'recovered_rows':len(rows),'skipped_existing_rows':skipped,
                    'rejected_boundaries':rejected,'stored_bytes':index['compressed_bytes'],
                    'coverage_priority_sha256':priorities.get('sha256'),
                    'coverage_priority_basis':priorities.get('basis'),
                    'index_sha256':hashlib.sha256((destination/'index.json').read_bytes()).hexdigest(),
                    'acquired_source_jsonl':{'sha256':source_jsonl_hash.hexdigest(),'bytes':source_jsonl_bytes,
                        'rows':len(expected_ids),'source_fields_per_row':len(columns),
                        'basis':'Exact submitted original CSV-derived JSONL bytes/order for independently expected new IDs only'},
                    'budget':{'pre_pack_occupied_bytes':pre_pack_occupied,'metadata_growth_bytes':growth,
                        'logical_available_bytes':logical_available,'physical_free_bytes':physical_free,
                        'physical_available_bytes':physical_available,
                        'limiting_budget':'physical_disk' if physical_available<logical_available else 'shared_cap',
                        'available_bytes':available,'native_maximum_bytes':maximum_bytes,
                        'sidecar_allowance_bytes':sidecar_bytes,'actual_sidecar_bytes':actual_sidecar_bytes,
                        'part_artifact_bytes':artifact_bytes}})
                completed.add(ordinal)
                manifest.update(opinion_rows=len(seen),stored_bytes=sum(part['stored_bytes'] for part in manifest['parts']),
                                recovered_rows=sum(part.get('recovered_rows',part['rows']) for part in manifest['parts']),
                                skipped_existing_rows=sum(part.get('skipped_existing_rows',0) for part in manifest['parts']),
                                acquisition_seconds=time.monotonic()-started,total_iteration_bytes=occupied())
                save(manifest_path,manifest)
                if a.verify_parts:
                    try:
                        require_bytes(16*1024*1024)
                        subprocess.run(['node',str(ROOT/'experiments/courtlistener-renditions/verify-acquired-part.mjs'),
                            str(out),str(ordinal)],check=True,
                            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform=='win32' else 0)
                    except BaseException:
                        witness = out/f'uncommitted-range-{ordinal:04d}.bin'
                        if witness.exists():
                            raise FileExistsError(f'Existing interrupted source evidence: {witness}')
                        require_bytes(len(data))
                        (work/'range.bin').replace(witness)
                        manifest['stop_reason']='independent_source_verification_failed'
                        manifest['unverified_part_ordinal']=ordinal
                        save(manifest_path,manifest)
                        save(witness.with_suffix('.json'), {'source':identity,'window':window,
                            'compressed_source_sha256':hashlib.sha256(data).hexdigest(),
                            'source_bytes':len(data),'part_committed':True,'independent_source_verification_passed':False})
                        raise
                print(f'[{len(completed)}/{len(plan)}] {len(seen):,} distinct records; {manifest["stored_bytes"]:,} compressed bytes',flush=True)
                if manifest['total_iteration_bytes']+metadata_growth()+reserved>CAP:
                    manifest['stop_reason']='reserved_budget_consumed'
                    break
                if min(shutil.disk_usage(out).free,shutil.disk_usage(work).free)<metadata_growth()+reserved:
                    manifest['stop_reason']='reserved_physical_budget_consumed'
                    break
    manifest['completed_all_planned_windows'] = len(manifest['parts'])==len(plan)
    manifest['complete'] = manifest['completed_all_planned_windows']
    save(manifest_path,manifest)

if __name__=='__main__':
    main()
