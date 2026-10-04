#!/usr/bin/env python3
"""Run the Python app's own live benchmark runner in full-app, local-only mode.

Same arguments as `dev/benchtools/benchmark_live_hybrid_docx.py run`; the only
change is that the app is configured with local_only=True, so sources come
from the shared local A2AJ store and journal database, with no A2AJ API calls
and no CanLII browser. That gives a Python quote-check and full-run timing
baseline on the same local data the new pipeline reads.
"""
import contextlib
import os
import sys
from pathlib import Path

from suite import ALR  # noqa: E402
sys.path.insert(0, str(ALR))
sys.dont_write_bytecode = True
os.chdir(ALR)

import alr_quote_verifier as aqv  # noqa: E402

_configure = aqv._configure_from_args


def _local_only(args):
    args.local_only = True
    return _configure(args)


aqv._configure_from_args = _local_only

from dev.benchtools import benchmark_live_hybrid_docx as live  # noqa: E402

if __name__ == "__main__":
    sys.argv = [str(ALR / "dev" / "benchtools" / "benchmark_live_hybrid_docx.py"), *sys.argv[1:]]
    with contextlib.suppress(SystemExit):
        live.main()
