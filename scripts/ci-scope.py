"""Select CI jobs from the complete Git diff; unknown inputs run both surfaces."""
import json
from fnmatch import fnmatchcase
import os
from pathlib import Path
import re
import subprocess


AUTHORITIES_PATHS = (
    'frontend/src/app/authorities/**',
    'frontend/src/app/(pages)/table-of-authorities/**',
    'frontend/src/app/standalone.css',
    'frontend/src/app/base.css',
    'frontend/src/app/components/shared/views/**',
    'backend/src/lib/authorit*',
    'backend/src/lib/structureNative.ts',
    'backend/src/lib/__tests__/structureNativeAuthorityTextUnits.test.ts',
    'backend/src/lib/chat/__tests__/quoteRepair.test.ts',
    'backend/src/routes/authorities*',
    'backend/src/authorities*',
    'shared/authorities*',
    'shared/pdf-annotations*',
    'shared/sequence-diff*',
    'scripts/*authorities*',
    'scripts/authorities-package/**',
    'native/legal-structure-node/**',
    'legal-structure',
    '.github/workflows/authorities-parity.yml',
    'shared/contracts/authoritiesBook.mts',
    'shared/contracts/pdfAssembly.mts',
    'shared/contracts/canliiPageUrls.mts',
    'shared/contracts/canliiLawUrls.mts',
    'shared/contracts/researchContract.mts',
    'shared/pdf/**',
    'shared/canonical-json.mjs',
    'shared/cited-source-pages.mjs',
    'shared/user-preferences.mjs',
    'package*.json',
    'backend/package*.json',
    'frontend/package*.json',
    'legal-pdf-parser',
    'AuthoritiesHelper',
    '.github/workflows/ci.yml',
)

FRONTEND_TEST_INPUTS = {
    'backend/src/lib/authoritiesDomain.ts',
    'backend/src/lib/authoritiesActionContract.ts',
    'backend/src/lib/authoritiesActions.ts',
    'backend/src/lib/applicationError.ts',
    'backend/src/lib/hash.ts',
    'backend/src/lib/text.ts',
    'backend/src/lib/value.ts',
    'backend/src/lib/workProduct.ts',
}

WORD_PLATFORM_PATHS = (
    'backend/scripts/word_python/**', 'backend/src/lib/wordPython.ts',
    'backend/src/lib/convert.ts', 'backend/src/lib/subprocessEnv.ts',
    '.github/workflows/word-python.yml',
)

def cloud_input(path):
    if path.startswith('frontend/'):
        return any(fnmatchcase(path, pattern) for pattern in (
            'frontend/package*.json', 'frontend/src/app/lib/api/client.ts',
            'frontend/src/app/lib/api/auth.ts', 'frontend/src/app/lib/api/account.ts',
            'frontend/src/app/lib/api/organizations.ts',
            'frontend/src/app/lib/api/uploads.ts', 'frontend/src/app/lib/api/documents.ts',
            'frontend/src/app/lib/auth*', 'frontend/src/app/lib/supabase*',
            'frontend/src/app/components/account/**',
            'frontend/src/app/components/settings/**', 'frontend/src/app/(pages)/auth/**',
            'frontend/src/app/lib/runtimeConfig*', 'frontend/src/app/contexts/AuthContext*',
            'frontend/src/app/login/**', 'frontend/src/app/signup/**',
            'frontend/src/app/authForms*', 'frontend/src/app/*router*',
        ))
    if path.startswith('backend/'):
        # Application operations run against local persistence. Only the actual
        # cloud/auth/storage composition and adapters need the cloud stack.
        return any(fnmatchcase(path, pattern) for pattern in (
            'backend/schema.sql', 'backend/package*.json', 'backend/.env*',
            'backend/src/index.ts', 'backend/src/runtime*.ts',
            'backend/src/supervisor.ts', 'backend/src/worker.ts',
            'backend/src/middleware/**', 'backend/src/routes/auth.ts',
            'backend/src/routes/auth.*.ts',
            'backend/src/routes/user*', 'backend/src/routes/organizations*',
            'backend/src/lib/relational*', 'backend/src/lib/supabase*',
            'backend/src/lib/storage*', 'backend/src/lib/authSession.ts',
            'backend/src/lib/localMode.ts', 'backend/src/lib/publicOrigin.ts',
            'backend/src/lib/applicationError.ts', 'backend/src/lib/userApplication.ts',
            'backend/src/lib/secretEncryption.ts', 'backend/src/lib/jobNotifications.ts',
            'backend/src/lib/jobQueue.ts', 'backend/src/lib/mcp/**',
            'backend/scripts/test-stack.sh', 'backend/scripts/schema-fingerprint.sql',
        ))
    if path.startswith('shared/'):
        return False
    if path.startswith('native/') or path in (
            'legal-structure', 'legal-pdf-parser', 'legal-browser-ocr', 'AuthoritiesHelper'):
        return False
    return True  # Unknown infrastructure inputs fail toward the full gate.


def scope(paths):
    backend = frontend = False
    native = False
    cloud = False
    audits = set()
    application_paths = []
    paths = list(paths)
    for path in paths:
        for directory in (".", "backend", "frontend", "shared"):
            prefix = "" if directory == "." else directory + "/"
            if path in (prefix + "package.json", prefix + "package-lock.json"):
                audits.add(".")
        if path == ".github/workflows/ci.yml":
            audits.add(".")
        if path.startswith("docs/") or ("/" not in path and path.endswith(".md")):
            continue
        if re.match(r'^(backend|frontend)/(src|scripts)/.*\.test\.[cm]?[jt]sx?$', path):
            continue  # Test edits do not change the application. E2E has its own inputs.
        application_paths.append(path)
        native |= any(fnmatchcase(path, pattern) for pattern in (
            'native/legal-structure-node/**', '.cargo/**',
            'legal-structure', 'legal-structure/**',
            'legal-pdf-parser', 'legal-pdf-parser/**',
            'common-law-cite', 'common-law-cite/**',
            'repositories.json', 'scripts/native-build.mjs',
            'scripts/native-cache-key.py', 'scripts/bootstrap-repositories.py',
            '.github/workflows/ci.yml',
        ))
        cloud |= cloud_input(path)
        if path.startswith("frontend/"):
            frontend = True
        elif path.startswith("backend/"):
            backend = True
            frontend |= path in FRONTEND_TEST_INPUTS
        else:
            # Shared or unknown inputs can affect either surface.
            backend = frontend = True
    return {"backend": backend, "frontend": frontend, "native": native, "application": backend or frontend,
            "cloud": cloud,
            "word_os": ["ubuntu-24.04", "windows-2022"] if any(
                fnmatchcase(path, pattern) for path in paths for pattern in WORD_PLATFORM_PATHS
            )
            else ["ubuntu-24.04"],
            "audit": sorted(audits),
            "authorities": any(fnmatchcase(path, pattern) for path in application_paths for pattern in AUTHORITIES_PATHS)}


def changed_paths(event, event_name):
    if event_name == "pull_request":
        before = event["pull_request"]["base"]["sha"]
        after = event["pull_request"]["head"]["sha"]
        comparison = before + "..." + after
    elif event_name == "push" and event.get("before", "0" * 40) != "0" * 40:
        comparison = event["before"] + ".." + event["after"]
    else:
        return [".github/workflows/ci.yml"]
    # No rename detection: both the old and new owner must be tested after a move.
    result = subprocess.run(["git", "diff", "--name-only", "--no-renames", "-z", comparison],
                            capture_output=True, check=True)
    return result.stdout.decode("utf-8").strip("\0").split("\0") if result.stdout else []


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    try:
        selected = scope(changed_paths(event, os.environ["GITHUB_EVENT_NAME"]))
        if os.environ["GITHUB_EVENT_NAME"] == "schedule":
            selected.update(backend=False, frontend=False, native=False, application=False, authorities=False, cloud=False)
    except subprocess.CalledProcessError:
        # Force pushes or missing history must not turn into skipped validation.
        selected = scope([".github/workflows/ci.yml"])
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for name, value in selected.items():
            output.write(f"{name}={json.dumps(value)}\n")
    print(json.dumps(selected))
