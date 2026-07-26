"""Discover the sibling OpenLegalData package for backend maintenance CLIs."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def data_root() -> Path:
    try:
        from open_legal_data.paths import data_root as shared_data_root
    except ModuleNotFoundError:
        sibling_src = Path(__file__).resolve().parents[2] / "OpenLegalData" / "src"
        if sibling_src.is_dir() and str(sibling_src) not in sys.path:
            sys.path.insert(0, str(sibling_src))
        try:
            from open_legal_data.paths import data_root as shared_data_root
        except ModuleNotFoundError:
            override = os.environ.get("OPEN_LEGAL_DATA_HOME", "").strip()
            if override:
                return Path(override).expanduser().resolve()
            if sys.platform == "win32":
                base = Path(
                    os.environ.get("LOCALAPPDATA")
                    or Path.home() / "AppData" / "Local"
                )
            elif sys.platform == "darwin":
                base = Path.home() / "Library" / "Application Support"
            else:
                base = Path(
                    os.environ.get("XDG_DATA_HOME")
                    or Path.home() / ".local" / "share"
                )
            return (base / "OpenLegalProducts" / "LegalData").resolve()
    return shared_data_root()
