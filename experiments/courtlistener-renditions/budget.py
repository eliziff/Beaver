"""One disk budget for this iteration's CourtListener inputs, metadata and outputs."""
import errno
import os
import shutil
import threading
import time
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CAP = 45_000_000_000  # User-authorized shared cap in decimal GB.
LOCATIONS = [ROOT/'benchmarks/local-data/courtlistener-renditions',
             ROOT/'benchmarks/local-data/courtlistener-ucd',
             Path(os.environ['LOCALAPPDATA'])/'OpenLegalData/corpus/courtlistener-web',
             Path(os.environ['LOCALAPPDATA'])/'OpenLegalData/corpus/courtlistener-http',
             Path(os.environ['LOCALAPPDATA'])/'OpenLegalData/corpus/courtlistener-cap']

_writer_mutex = threading.RLock()
_writer_file = None

class BudgetExhausted(BaseException):
    """A persistence stop that broad copied browser exception handlers cannot swallow."""

@contextmanager
def writer():
    """Serialize guarded persistence; nested host callbacks reuse the same lock."""
    global _writer_file
    with _writer_mutex:
        if _writer_file is not None:
            yield
            return
        lock_path = LOCATIONS[0]/'.writer-lock'
        lock_path.parent.mkdir(parents=True,exist_ok=True)
        with lock_path.open('a+b') as handle:
            if handle.seek(0,os.SEEK_END)==0:
                handle.write(b'\0')
                handle.flush()
            handle.seek(0)
            if os.name=='nt':
                import msvcrt
                while True:
                    try:
                        msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
                        break
                    except OSError as error:
                        if error.errno not in (errno.EACCES,errno.EAGAIN,errno.EDEADLK):
                            raise
                        time.sleep(0.05)
            else:
                import fcntl
                fcntl.flock(handle.fileno(),fcntl.LOCK_EX)
            _writer_file = handle
            try:
                yield
            finally:
                _writer_file = None
                handle.seek(0)
                if os.name=='nt':
                    msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
                else:
                    fcntl.flock(handle.fileno(),fcntl.LOCK_UN)

def occupied():
    total = 0
    for directory in LOCATIONS:
        if directory.exists():
            for path in directory.rglob('*'):
                if path.is_file():
                    try:
                        total += path.stat().st_size
                    except FileNotFoundError:
                        pass  # A concurrent acquisition completed its atomic rename.
    return total

def metadata_growth():
    directory = LOCATIONS[0]/'metadata/source'
    sizes = {'courts':81226,'opinion-clusters':2467613433,'dockets':5144011100,'citations':127468518}
    return sum(max(0,size-sum(p.stat().st_size for p in directory.glob(f'{kind}-2026-09-30.csv.bz2*') if p.is_file()))
               for kind,size in sizes.items())

def remaining():
    return CAP-occupied()-metadata_growth()

def require_bytes(size):
    """Call within writer(), holding it through the checked writes and renames."""
    logical = remaining()
    physical = shutil.disk_usage(ROOT).free
    available = min(logical, physical)
    if size>available:
        raise BudgetExhausted(f'CourtListener persistence budget: {size:,} bytes required; '
                              f'{logical:,} owned-cap bytes and {physical:,} physical bytes remaining')
