#!/usr/bin/env python3
"""Run exact verification in isolated Chrome processes and merge the shards."""
import argparse
import ctypes
from ctypes import wintypes
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
GATE = HERE / "webdriver-exact-gate.py"
MARKER_GATE = HERE / "webdriver-marker-gate.py"
LIFECYCLE_SPEC = importlib.util.spec_from_file_location("fragment_lifecycle_gate", GATE)
lifecycle_gate = importlib.util.module_from_spec(LIFECYCLE_SPEC)
LIFECYCLE_SPEC.loader.exec_module(lifecycle_gate)

if hasattr(ctypes, "windll"):
    kernel32 = ctypes.windll.kernel32
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    kernel32.SetPriorityClass.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
    kernel32.SetPriorityClass.restype = ctypes.c_int
    if not kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x00004000):
        raise ctypes.WinError()


def rows(path):
    if not path.exists():
        return []
    body = path.read_bytes()
    if body and not body.endswith((b"\n", b"\r")):
        body = body.rpartition(b"\n")[0]
    return [json.loads(line) for line in body.decode("utf-8-sig").splitlines() if line.strip()]


class _JobBasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
    )]


class _JobExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JobBasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class WindowsKillJob:
    """Exact-owner process tree; closing the handle kills every descendant."""
    KILL_ON_CLOSE = 0x00002000
    EXTENDED_LIMITS = 9

    def __init__(self, owner):
        self.handle = None
        self.closed = False
        if not hasattr(ctypes, "windll"):
            return
        api = ctypes.windll.kernel32
        api.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        api.CreateJobObjectW.restype = wintypes.HANDLE
        api.SetInformationJobObject.argtypes = (
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        )
        api.SetInformationJobObject.restype = wintypes.BOOL
        api.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        api.AssignProcessToJobObject.restype = wintypes.BOOL
        api.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
        api.TerminateJobObject.restype = wintypes.BOOL
        api.CloseHandle.argtypes = (wintypes.HANDLE,)
        api.CloseHandle.restype = wintypes.BOOL
        api.SetLastError(0)
        self.handle = api.CreateJobObjectW(None, f"Local\\BeaverTextFragment-{owner}")
        if not self.handle:
            raise ctypes.WinError(api.GetLastError())
        if api.GetLastError() == 183:
            self.close()
            raise RuntimeError(f"owned worker job already exists: {owner}")
        limits = _JobExtendedLimitInformation()
        limits.BasicLimitInformation.LimitFlags = self.KILL_ON_CLOSE
        if not api.SetInformationJobObject(
            self.handle, self.EXTENDED_LIMITS, ctypes.byref(limits), ctypes.sizeof(limits),
        ):
            error = ctypes.WinError(api.GetLastError())
            self.close()
            raise error

    def assign(self, process):
        self.assign_handle(int(process._handle))

    def assign_handle(self, process_handle):
        if self.handle is None:
            return
        api = ctypes.windll.kernel32
        if not api.AssignProcessToJobObject(self.handle, process_handle):
            raise ctypes.WinError(api.GetLastError())

    def terminate_and_close(self):
        if self.closed:
            return None
        warning = None
        try:
            if self.handle is not None:
                api = ctypes.windll.kernel32
                if not api.TerminateJobObject(self.handle, 1):
                    warning = ctypes.WinError(api.GetLastError())
        finally:
            # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the ownership contract.
            # Process enumeration is only a diagnostic and must never keep
            # this authoritative handle open.
            self.close()
        return warning

    def close(self):
        if not self.closed and self.handle is not None:
            api = ctypes.windll.kernel32
            if not api.CloseHandle(self.handle):
                raise ctypes.WinError(api.GetLastError())
        self.closed = True
        self.handle = None

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


WORKER_BOOTSTRAP = (
    "import subprocess,sys;"
    "start=sys.stdin.buffer.read(1);"
    "raise SystemExit(subprocess.call(sys.argv[1:]) if start else 125)"
)


class WorkerAttempt:
    def __init__(self, index, owner, job):
        self.index = index
        self.owner = owner
        self.job = job
        self.process = None
        self.assigned = False
        self.tree_cleaned = False
        self.profiles_cleaned = False
        self.owned_profiles = set()
        self.started_at = time.monotonic()

    def stop_tree(self):
        if self.tree_cleaned:
            return
        process = self.process
        if process is not None and process.stdin is not None and not process.stdin.closed:
            process.stdin.close()
        if self.assigned and hasattr(ctypes, "windll"):
            warning = self.job.terminate_and_close()
            if warning is not None:
                print(json.dumps({
                    "worker": self.index, "event": "job-termination-warning",
                    "error": str(warning)[:200],
                }), flush=True)
        else:
            self.job.close()
            if process is not None and process.poll() is None:
                if self.assigned:
                    process.terminate()
                else:
                    process.kill()  # The unreleased bootstrap cannot have descendants.
        if process is not None and process.poll() is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        self.tree_cleaned = True


def worker_watchdog_expired(attempt, timeout_seconds, now=None):
    return (time.monotonic() if now is None else now) - attempt.started_at >= timeout_seconds


def spawn_gated_worker(command, index, owner, attempts, register, *,
                       popen=subprocess.Popen, job_factory=WindowsKillJob):
    """Register first; release the worker only after its exact job owns it."""
    attempt = WorkerAttempt(index, owner, job_factory(owner))
    attempts.append(attempt)
    environment = os.environ.copy()
    environment[lifecycle_gate.PROFILE_OWNER_ENV] = owner
    try:
        attempt.process = popen(
            [sys.executable, "-c", WORKER_BOOTSTRAP, *command],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", env=environment,
            creationflags=(
                getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0) |
                getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            ),
        )
        attempt.job.assign(attempt.process)
        attempt.assigned = True
        register(attempt)
        attempt.process.stdin.write("\n")
        attempt.process.stdin.close()
        return attempt
    except BaseException:
        attempt.stop_tree()
        raise


def close_job_then_profiles(attempt, profile_cleanup):
    """Job closure is authoritative and always precedes profile removal."""
    errors, warnings = [], []
    if not attempt.tree_cleaned:
        try:
            attempt.stop_tree()
        except Exception as exc:
            errors.append(exc)
    if not attempt.profiles_cleaned:
        try:
            warnings = profile_cleanup()
        except Exception as exc:
            warnings = [exc]
        # A failed profile removal remains eligible for the final retry. Only
        # a verified empty cleanup closes this ownership obligation.
        if not warnings:
            attempt.profiles_cleaned = True
    return errors, warnings


def supervise_crawler(owner_pid, profile_dir):
    """Hold the crawler's exact KILL_ON_CLOSE Job outside its process tree."""
    if not hasattr(ctypes, "windll"):
        raise RuntimeError("crawler Job supervision is Windows-only")
    profile = profile_dir.resolve()
    temporary_root = Path(tempfile.gettempdir()).resolve()
    if profile.parent != temporary_root or not profile.name.startswith(
            f"stealth-crawl-{owner_pid}-"):
        raise ValueError(f"refusing unowned crawler profile: {profile}")

    api = ctypes.windll.kernel32
    api.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    api.OpenProcess.restype = wintypes.HANDLE
    api.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    api.WaitForSingleObject.restype = wintypes.DWORD
    access = 0x0001 | 0x0100 | 0x00100000  # TERMINATE | SET_QUOTA | SYNCHRONIZE
    process_handle = api.OpenProcess(access, False, owner_pid)
    if not process_handle:
        raise ctypes.WinError(api.GetLastError())
    job = None
    errors = []
    try:
        job = WindowsKillJob(f"crawler-{owner_pid}-{time.time_ns():x}")
        job.assign_handle(process_handle)
        print(json.dumps({"event": "crawler-supervisor-ready", "pid": owner_pid}), flush=True)
        if api.WaitForSingleObject(process_handle, 0xFFFFFFFF) != 0:
            raise RuntimeError(f"crawler process wait failed: {owner_pid}")
    finally:
        api.CloseHandle(process_handle)
        warning = job.terminate_and_close() if job is not None else None
        if warning is not None:
            errors.append(warning)
        try:
            lifecycle_gate.stop_owned_chrome_processes(profile, stable_empty_passes=2)
        except Exception as exc:
            errors.append(exc)
        try:
            lifecycle_gate.remove_profile_dir(profile)
        except Exception as exc:
            errors.append(exc)
    if errors:
        raise ExceptionGroup(f"crawler cleanup failed for {profile}", errors)


parent_signal_state = {"phase": "running", "interrupted": False}


def install_parent_signal_handlers():
    """Interrupt work promptly, but never interrupt exact owned cleanup."""
    def interrupt(_signal_number, _frame):
        parent_signal_state["interrupted"] = True
        if parent_signal_state["phase"] != "cleaning":
            raise KeyboardInterrupt

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        termination_signal = getattr(signal, name, None)
        if termination_signal is not None:
            signal.signal(termination_signal, interrupt)


def lifecycle_self_check():
    events = []

    class FakeStdin:
        closed = False

        def __init__(self, released):
            self.released = released

        def write(self, _value):
            assert self.released()
            events.append("release")

        def close(self):
            self.closed = True

    class FakeProcess:
        def __init__(self, released):
            self.stdin = FakeStdin(released)
            self.stdout = ()
            self.returncode = None

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            assert timeout == 5
            return self.returncode

        def kill(self):
            events.append("kill-bootstrap")
            self.returncode = -9

    class FakeJob:
        def __init__(self, owner):
            self.owner = owner
            self.process = None
            self.closed = False

        def assign(self, process):
            events.append("assign")
            self.process = process

        def terminate_and_close(self):
            events.append("terminate-job")
            self.closed = True
            if self.process is not None and self.process.returncode is None:
                self.process.returncode = -1

        def close(self):
            events.append("close-job")
            self.closed = True

    def run(register):
        attempts = []
        pending = {}

        def fake_popen(*_args, **_kwargs):
            assert len(attempts) == 1 and attempts[0].process is None
            expected_group = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            assert not expected_group or _kwargs["creationflags"] & expected_group
            events.append("popen-after-owner-registration")
            return FakeProcess(lambda: pending.get(0) is attempts[0])

        attempt = spawn_gated_worker(
            ["worker.py"], 0, "self-check-w0-a0", attempts,
            lambda item: (pending.__setitem__(0, item), register(item))[1],
            popen=fake_popen, job_factory=FakeJob,
        )
        return attempt

    normal = run(lambda _attempt: events.append("pending-before-release"))
    assert events[:4] == [
        "popen-after-owner-registration", "assign", "pending-before-release", "release",
    ], events
    normal.process.returncode = 0
    normal.stop_tree()
    assert events[-1] == "terminate-job"

    abrupt = run(lambda _attempt: None)
    abrupt.process.returncode = 9
    abrupt.stop_tree()
    assert events[-1] == "terminate-job"

    interrupted = run(lambda _attempt: None)
    errors, warnings = close_job_then_profiles(
        interrupted, lambda: events.append("remove-profile") or [],
    )
    assert not errors and not warnings
    assert events[-2:] == ["terminate-job", "remove-profile"]

    retryable = run(lambda _attempt: None)
    errors, warnings = close_job_then_profiles(
        retryable, lambda: [RuntimeError("transient profile lock")],
    )
    assert not errors and warnings and not retryable.profiles_cleaned
    errors, warnings = close_job_then_profiles(retryable, lambda: [])
    assert not errors and not warnings and retryable.profiles_cleaned

    for interruption in (RuntimeError("worker error"), KeyboardInterrupt()):
        before = events.count("terminate-job")
        try:
            run(lambda _attempt, error=interruption: (_ for _ in ()).throw(error))
        except type(interruption):
            pass
        else:
            raise AssertionError("spawn interruption was swallowed")
        assert events.count("terminate-job") == before + 1

    captured_signals = {}
    original_signal = signal.signal
    try:
        signal.signal = lambda number, handler: captured_signals.__setitem__(number, handler)
        install_parent_signal_handlers()
    finally:
        signal.signal = original_signal
    assert set(captured_signals) == {
        number for name in ("SIGINT", "SIGTERM", "SIGBREAK")
        if (number := getattr(signal, name, None)) is not None
    }
    parent_signal_state.update(phase="cleaning", interrupted=False)
    captured_signals[signal.SIGINT](signal.SIGINT, None)
    assert parent_signal_state["interrupted"]
    parent_signal_state.update(phase="running", interrupted=False)
    normal.started_at = 10
    assert not worker_watchdog_expired(normal, 5, now=14)
    assert worker_watchdog_expired(normal, 5, now=15)
    assert WindowsKillJob.KILL_ON_CLOSE == 0x00002000
    if hasattr(ctypes, "windll"):
        job = WindowsKillJob(f"self-check-{os.getpid()}-{time.time_ns():x}")
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS,
        )
        try:
            job.assign(child)
            job.terminate_and_close()
            child.wait(timeout=5)
            assert child.returncode is not None
        finally:
            job.close()
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
        crawler = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(1)"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS,
        )
        profile = Path(tempfile.mkdtemp(
            prefix=f"stealth-crawl-{crawler.pid}-", dir=tempfile.gettempdir(),
        ))
        supervise_crawler(crawler.pid, profile)
        crawler.wait(timeout=5)
        assert not profile.exists()
    print("parallel Chrome lifecycle checks passed")


parser = argparse.ArgumentParser()
parser.add_argument("--workers", type=int, default=2)
parser.add_argument("--gate", choices=("exact", "marker"), default="exact")
parser.add_argument("--only", choices=("all", "html", "pdf"), default="all")
parser.add_argument("--targets", type=Path)
parser.add_argument("--labels", type=Path)
parser.add_argument("--fresh", action="store_true")
parser.add_argument("--limit-per-worker", type=int)
parser.add_argument("--tag")
parser.add_argument("--mine-oracle", action="store_true")
parser.add_argument("--save-shots", action="store_true")
parser.add_argument("--find-probe", action="store_true")
parser.add_argument("--range-only", action="store_true")
parser.add_argument("--baseline", type=Path)
parser.add_argument("--live", action="store_true")
parser.add_argument("--headed", action="store_true")
parser.add_argument("--refresh-cache", action="store_true")
parser.add_argument("--exclude-proven-404", action="store_true")
parser.add_argument("--lifecycle-self-check", action="store_true", help=argparse.SUPPRESS)
parser.add_argument("--crawler-owner-pid", type=int, help=argparse.SUPPRESS)
parser.add_argument("--crawler-profile", type=Path, help=argparse.SUPPRESS)
parser.add_argument("--worker-timeout-seconds", type=float, default=900)
args = parser.parse_args()
if bool(args.crawler_owner_pid) != bool(args.crawler_profile):
    parser.error("--crawler-owner-pid and --crawler-profile are required together")
if args.crawler_owner_pid:
    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        termination_signal = getattr(signal, name, None)
        if termination_signal is not None:
            signal.signal(termination_signal, signal.SIG_IGN)
    supervise_crawler(args.crawler_owner_pid, args.crawler_profile)
    raise SystemExit(0)
install_parent_signal_handlers()
if args.lifecycle_self_check:
    lifecycle_self_check()
    raise SystemExit(0)
if not 1 <= args.workers <= 2:
    parser.error("--workers must be 1 or 2 for the polite headed-Chrome contract")
if args.worker_timeout_seconds <= 0:
    parser.error("--worker-timeout-seconds must be positive")
if args.refresh_cache and not args.live:
    parser.error("--refresh-cache requires --live")
if args.refresh_cache and args.gate != "marker":
    parser.error("--refresh-cache requires --gate marker")
if args.gate == "exact":
    stale_profiles = lifecycle_gate.sweep_stale_exact_profiles()
    if stale_profiles["removed"] or stale_profiles["errors"]:
        print(json.dumps({
            "event": "stale-exact-profile-sweep",
            "removed": len(stale_profiles["removed"]),
            "errors": [str(error)[:200] for error in stale_profiles["errors"]],
        }), flush=True)
corpus_targets = args.targets or lifecycle_gate.TARGETS
corpus_seeds = rows(corpus_targets)
excluded_404_seeds = [seed for seed in corpus_seeds if lifecycle_gate.is_proven_404_seed(seed)] \
    if args.exclude_proven_404 else []
if args.exclude_proven_404 and len(excluded_404_seeds) != 1:
    parser.error(
        "--exclude-proven-404 requires exactly the known "
        f"{lifecycle_gate.PROVEN_404_LABEL} label+URL row; found {len(excluded_404_seeds)}"
    )
gettable_corpus_seeds = [
    seed for seed in corpus_seeds
    if not (args.exclude_proven_404 and lifecycle_gate.is_proven_404_seed(seed))
]
name = args.tag or ("marker" if args.gate == "marker" else args.only)
shards = [RESULTS / f"webdriver-exact-{name}-shard-{index}.jsonl" for index in range(args.workers)]
if args.fresh:
    for shard in shards:
        shard.unlink(missing_ok=True)

started = time.time()
commands = {}
drainers = []
run_owner = f"{os.getpid()}-{time.time_ns():x}"
attempts = []
attempt_numbers = {index: 0 for index in range(args.workers)}
pending = {}
for index, shard in enumerate(shards):
    if args.gate == "marker":
        if not args.targets:
            parser.error("--targets is required with --gate marker")
        command = [sys.executable, str(MARKER_GATE), str(args.targets.resolve()), "--shard-index", str(index), "--shard-count", str(args.workers), "--out", str(shard), "--only", args.only]
        if not args.fresh:
            command.append("--resume")
        if args.baseline:
            command.extend(("--baseline", str(args.baseline.resolve())))
        if args.live:
            command.append("--live")
        if args.headed:
            command.append("--headed")
        if args.refresh_cache:
            command.append("--refresh-cache")
    else:
        command = [
            sys.executable, str(GATE), "--shard-index", str(index),
            "--shard-count", str(args.workers), "--out", str(shard), "--only", args.only,
            "--resume-terminal",
        ]
        if args.live:
            command.append("--live")
        if args.headed:
            command.append("--headed")
    if args.exclude_proven_404:
        command.append("--exclude-proven-404")
    if args.limit_per_worker:
        command.extend(("--limit", str(args.limit_per_worker)))
    if args.mine_oracle and args.gate == "exact":
        command.append("--mine-oracle")
    if args.targets and args.gate == "exact":
        command.extend(("--targets", str(args.targets.resolve())))
    if args.labels and args.gate == "exact":
        command.extend(("--labels", str(args.labels.resolve())))
    if args.save_shots and args.gate == "exact":
        command.append("--save-shots")
    if args.find_probe and args.gate == "exact":
        command.append("--find-probe")
    if args.range_only and args.gate == "exact":
        command.append("--range-only")
    commands[index] = command


def start_worker(index):
    attempt_number = attempt_numbers[index]
    attempt_numbers[index] += 1
    owner = f"{run_owner}-w{index}-a{attempt_number}"

    def register(attempt):
        if index in pending:
            raise RuntimeError(f"worker {index} already registered")
        pending[index] = attempt

        def drain(worker=index, stream=attempt.process.stdout):
            for line in stream or ():
                print(json.dumps({"worker": worker, "message": line.strip()}), flush=True)

        thread = threading.Thread(target=drain, daemon=True)
        thread.start()
        drainers.append(thread)

    try:
        return spawn_gated_worker(commands[index], index, owner, attempts, register)
    except BaseException:
        pending.pop(index, None)
        raise


def cleanup_worker_profiles(attempt):
    errors = []
    for prefix in ("browser-exact-profile-", "browser-profile-"):
        attempt.owned_profiles.update(
            lifecycle_gate.PROFILE_ROOT.glob(f"{prefix}{attempt.owner}-*"),
        )
    for profile in attempt.owned_profiles:
        try:
            lifecycle_gate.stop_owned_chrome_processes(
                profile.resolve(), stable_empty_passes=2,
            )
        except Exception as exc:
            errors.append(exc)
        try:
            lifecycle_gate.remove_profile_dir(profile)
        except Exception as exc:
            errors.append(exc)
    return errors


def cleanup_attempt(attempt):
    residual = []
    for cleanup_pass in range(2):
        errors, warnings = close_job_then_profiles(
            attempt, lambda: cleanup_worker_profiles(attempt),
        )
        residual = [*errors, *warnings]
        if not residual:
            return
        if cleanup_pass == 0:
            time.sleep(0.1)
    print(json.dumps({
        "worker": attempt.index, "event": "cleanup-failed",
        "errors": [str(error)[:200] for error in residual],
    }), flush=True)
    raise ExceptionGroup(f"worker {attempt.index} attempt cleanup failed", residual)



last_progress = {}
stalled_failures = {}
restart_counts = {}
failure = None
try:
    for index in range(args.workers):
        last_progress[index] = len(rows(shards[index]))
        stalled_failures[index] = 0
        restart_counts[index] = 0
        start_worker(index)
    while pending and failure is None:
        for index, attempt in list(pending.items()):
            returncode = attempt.process.poll()
            timed_out = returncode is None and worker_watchdog_expired(
                attempt, args.worker_timeout_seconds,
            )
            if returncode is None and not timed_out:
                continue
            del pending[index]
            if timed_out:
                print(json.dumps({
                    "worker": index, "event": "watchdog-timeout",
                    "seconds": args.worker_timeout_seconds,
                }), flush=True)
            cleanup_attempt(attempt)
            if timed_out:
                returncode = 124
            if returncode:
                progress = len(rows(shards[index]))
                stalled_failures[index] = 0 if progress > last_progress[index] else stalled_failures[index] + 1
                last_progress[index] = progress
                if stalled_failures[index] < 3:
                    if args.gate == "marker" and "--resume" not in commands[index]:
                        commands[index].append("--resume")
                    restart_counts[index] += 1
                    print(json.dumps({
                        "worker": index, "event": "restart", "completedRows": progress,
                        "restart": restart_counts[index], "stalledFailures": stalled_failures[index],
                    }), flush=True)
                    start_worker(index)
                else:
                    failure = (index, returncode)
                    break
        if pending and failure is None:
            time.sleep(0.05)
except KeyboardInterrupt:
    failure = ("interrupted", 130)
finally:
    parent_signal_state["phase"] = "cleaning"
    try:
        cleanup_errors = []
        for attempt in attempts:
            try:
                cleanup_attempt(attempt)
            except Exception as exc:
                cleanup_errors.append(exc)
        for thread in drainers:
            thread.join(timeout=5)
            if thread.is_alive():
                cleanup_errors.append(RuntimeError("worker output drainer survived cleanup"))
        if parent_signal_state["interrupted"] and failure is None:
            failure = ("interrupted", 130)
        if cleanup_errors:
            raise ExceptionGroup("parallel Chrome cleanup failed", cleanup_errors)
    finally:
        parent_signal_state["phase"] = "done"
if failure is not None:
    raise SystemExit(f"worker {failure[0]} failed with {failure[1]}")

merged = []
for shard in shards:
    merged.extend(rows(shard))
duplicate_labels = sorted(label for label, count in Counter(row["label"] for row in merged).items()
                          if count != 1)
by_label = {row["label"]: row for row in merged}
out = RESULTS / f"webdriver-exact-{name}.jsonl"
ordered = sorted(by_label.values(), key=lambda row: row["label"])
out.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in ordered), encoding="utf-8")
tally = {}
for row in ordered:
    tally[row["verdict"]] = tally.get(row["verdict"], 0) + 1
summary = {
    "workers": args.workers, "rows": len(ordered), "seconds": round(time.time() - started, 1),
    "verdicts": tally, "workerRestarts": sum(restart_counts.values()),
}
if args.refresh_cache:
    outcomes = {
        row["cacheFile"]: row["cacheRefresh"]["status"]
        for row in ordered if row.get("cacheRefresh")
    }
    sources = {row["cacheFile"] for row in ordered}
    failures = {}
    for status in (outcomes.get(source, "not-attempted") for source in sources):
        if status not in {"refreshed", "preserved-pdf"}:
            failures[status] = failures.get(status, 0) + 1
    summary.update({
        "cacheSources": len(sources),
        "cacheRefreshes": sum(status == "refreshed" for status in outcomes.values()),
        "cachePreservedPdfs": sum(status == "preserved-pdf" for status in outcomes.values()),
        "cacheCoveredSources": sum(status in {"refreshed", "preserved-pdf"} for status in outcomes.values()),
        "cacheRefreshFailures": failures,
    })
accepted_verdict = "marker-exact" if args.gate == "marker" else "exact-match"


def valid_cache_identity(row):
    identity = row.get("cacheIdentity") or {}
    digest = identity.get("sha256")
    return identity.get("file") == row.get("cacheFile") and \
        isinstance(identity.get("bytes"), int) and identity["bytes"] > 0 and \
        isinstance(digest, str) and len(digest) == 64 and \
        all(character in "0123456789abcdef" for character in digest.lower())


def contract_failure(row):
    if row.get("verdict") != accepted_verdict:
        return f"verdict:{row.get('verdict')}"
    expected_contract = (
        "chromium-global-intervals-v3" if args.gate == "marker" else
        lifecycle_gate.PDF_PAINT_CONTRACT
        if str(row.get("cacheFile", "")).lower().endswith(".pdf") else
        lifecycle_gate.HTML_PAINT_CONTRACT
    )
    if row.get("verificationContract") != expected_contract:
        return f"contract:{row.get('verificationContract')}"
    if row.get("sourceMode") != ("live" if args.live else "cache"):
        return f"source-mode:{row.get('sourceMode')}"
    if row.get("headed") is not args.headed:
        return f"headed:{row.get('headed')}"
    if args.gate == "marker" and row.get("refreshCache") is not args.refresh_cache:
        return f"refresh-cache:{row.get('refreshCache')}"
    if not valid_cache_identity(row):
        return "cache-identity-unverified"
    return None


contract_failures = [
    {"label": row.get("label"), "reason": reason}
    for row in ordered if (reason := contract_failure(row)) is not None
]
failed_rows = {item["label"] for item in contract_failures}
expected = None
if not args.labels and not args.limit_per_worker:
    seeds = gettable_corpus_seeds
    if args.only == "all":
        expected = {seed["label"] for seed in seeds}
    else:
        manifest = {
            lifecycle_gate.url_key(row["url"]): row
            for row in rows(lifecycle_gate.MANIFEST)
            if row.get("url") and row.get("file")
        }
        want_pdf = args.only == "pdf"
        expected = {
            seed["label"] for seed in seeds
            if bool(lifecycle_gate.PDF_RE.search(seed["target"].split("#", 1)[0]) or
                    (manifest.get(lifecycle_gate.url_key(seed["target"].split("#", 1)[0])) or {})
                    .get("file", "").lower().endswith(".pdf")) == want_pdf
        }
missing_labels = sorted(expected - set(by_label)) if expected is not None else []
unexpected_labels = sorted(set(by_label) - expected) if expected is not None else []
baseline_failures = []
if args.gate == "exact" and args.baseline:
    raw_baseline_rows = rows(args.baseline)
    duplicate_baseline_labels = sorted(
        label for label, count in Counter(row.get("label") for row in raw_baseline_rows).items()
        if count != 1
    )
    baseline_rows = {row["label"]: row for row in raw_baseline_rows}
    expected_baseline = {seed["label"]: seed["target"] for seed in gettable_corpus_seeds}
    missing_baseline = sorted(set(expected_baseline) - set(baseline_rows))
    unexpected_baseline = sorted(set(baseline_rows) - set(expected_baseline))
    if duplicate_baseline_labels:
        baseline_failures.append({"reason": "duplicate-labels", "labels": duplicate_baseline_labels})
    if missing_baseline:
        baseline_failures.append({"reason": "missing-labels", "labels": missing_baseline})
    if unexpected_baseline:
        baseline_failures.append({"reason": "unexpected-labels", "labels": unexpected_baseline})
    for label, target in expected_baseline.items():
        baseline_row = baseline_rows.get(label)
        if baseline_row is None:
            continue
        reason = None
        if baseline_row.get("verdict") != "marker-exact":
            reason = f"verdict:{baseline_row.get('verdict')}"
        elif baseline_row.get("verificationContract") != "chromium-global-intervals-v3":
            reason = f"contract:{baseline_row.get('verificationContract')}"
        elif baseline_row.get("target") != target:
            reason = "target-mismatch"
        elif baseline_row.get("sourceMode") != "cache":
            reason = f"source-mode:{baseline_row.get('sourceMode')}"
        elif baseline_row.get("headed") is not args.headed:
            reason = f"headed:{baseline_row.get('headed')}"
        elif baseline_row.get("refreshCache") is not False:
            reason = f"refresh-cache:{baseline_row.get('refreshCache')}"
        elif not valid_cache_identity(baseline_row):
            reason = "cache-identity-unverified"
        if reason:
            baseline_failures.append({"label": label, "reason": reason})
    for row in ordered:
        baseline_row = baseline_rows.get(row["label"])
        if baseline_row and (
            baseline_row.get("cacheFile") != row.get("cacheFile") or
            (baseline_row.get("cacheIdentity") or {}).get("sha256") !=
                (row.get("cacheIdentity") or {}).get("sha256")
        ):
            baseline_failures.append({"label": row["label"], "reason": "cache-bytes-mismatch"})
summary.update({
    "inputRows": len(corpus_seeds),
    "gettableRows": len(gettable_corpus_seeds),
    "excluded404": len(excluded_404_seeds),
    "acceptedVerdict": accepted_verdict,
    "failedRows": len(failed_rows),
    "contractFailures": contract_failures,
    "duplicateLabels": duplicate_labels,
    "missingLabels": missing_labels,
    "unexpectedLabels": unexpected_labels,
    "baselineFailures": baseline_failures,
    "perfect": not failed_rows and not duplicate_labels and not missing_labels and
               not unexpected_labels and not baseline_failures,
})
print(json.dumps(summary), flush=True)
if not summary["perfect"]:
    raise SystemExit(1)
