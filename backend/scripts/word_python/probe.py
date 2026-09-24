"""Checks that this interpreter can run word_python: Python 3.10+ with requirements.txt installed exactly.
Prints one JSON line and exits non-zero when it cannot; the backend and `scripts/mike.ps1 doctor` both run it."""
import json
import os
import sys
from importlib import metadata

REQUIREMENTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'requirements.txt')
pins = dict(line.strip().split('==') for line in open(REQUIREMENTS, encoding='utf-8') if '==' in line)
installed = {}
for name in pins:
    try: installed[name] = metadata.version(name)
    except metadata.PackageNotFoundError: installed[name] = None
wrong = ['%s %s (have %s)' % (name, version, installed[name] or 'none') for name, version in pins.items() if installed[name] != version]
if sys.version_info < (3, 10): wrong.insert(0, 'Python 3.10+ (have %s)' % sys.version.split()[0])
print(json.dumps({'ok': not wrong, 'python': sys.version.split()[0], 'executable': sys.executable, 'packages': installed,
                  **({'error': 'needs ' + ', '.join(wrong)} if wrong else {})}))
sys.exit(1 if wrong else 0)
