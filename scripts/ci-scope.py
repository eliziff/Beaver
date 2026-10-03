"""Select CI jobs from the complete Git diff; unknown inputs run both surfaces."""
import json
from fnmatch import fnmatchcase
import os
from pathlib import Path
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
    'shared/contracts/**',
    'shared/tsconfig.json',
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


def scope(paths):
    backend = frontend = False
    audits = set()
    paths = list(paths)
    for path in paths:
        for directory in (".", "backend", "frontend"):
            prefix = "" if directory == "." else directory + "/"
            if path in (prefix + "package.json", prefix + "package-lock.json"):
                audits.add(directory)
        if path.startswith("scripts/audit-") or path == ".github/workflows/ci.yml":
            audits.update((".", "backend", "frontend"))
        if path.startswith("docs/") or ("/" not in path and path.endswith(".md")):
            continue
        if path.startswith("frontend/"):
            frontend = True
        elif path.startswith("backend/"):
            backend = True
            frontend |= path in FRONTEND_TEST_INPUTS
        else:
            # Shared or unknown inputs can affect either surface.
            backend = frontend = True
    return {"backend": backend, "frontend": frontend, "application": backend or frontend,
            "audit": sorted(audits),
            "authorities": any(fnmatchcase(path, pattern) for path in paths for pattern in AUTHORITIES_PATHS)}


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
            selected.update(backend=False, frontend=False, application=False, authorities=False)
    except subprocess.CalledProcessError:
        # Force pushes or missing history must not turn into skipped validation.
        selected = scope([".github/workflows/ci.yml"])
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for name, value in selected.items():
            output.write(f"{name}={json.dumps(value)}\n")
    print(json.dumps(selected))
