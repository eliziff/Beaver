"""Real conversion/highlight components with synthetic transport, not full native-app smoke.
Run with locked frontend dependencies, Python Playwright and Chromium:
  python scripts/test-research-interop-browser.py /tmp/interop-proof --chromium /path/to/chromium
No model, account, external network or user documents are used.
"""
from __future__ import annotations
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from playwright.sync_api import sync_playwright, expect


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--chromium", default=shutil.which("chromium") or shutil.which("google-chrome"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    frontend, output = root / "frontend", args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".interop-probe-", dir=frontend) as temp:
        probe = Path(temp)
        shutil.copy(root / "scripts/fixtures/research-interop.tsx", probe / "main.tsx")
        (probe / "probe.css").write_text('@import "../src/app/globals.css";\n@source ".";\n@source "../src/app";\n')
        config = {"root": str(probe), "define": {"process.env.NODE_ENV": '"production"'},
            "resolve": {"alias": {"@": str(frontend / "src"), "docx-preview": str(frontend / "vendor/docx-preview/index.ts")}},
            "build": {"target": "esnext", "minify": False, "cssCodeSplit": False,
                "lib": {"entry": str(probe / "main.tsx"), "formats": ["es"], "fileName": "fixture"},
                "rolldownOptions": {"output": {"codeSplitting": False}}}}
        (probe / "vite.config.mjs").write_text('import {defineConfig} from "vite"; import react from "@vitejs/plugin-react"; export default defineConfig(' +
            json.dumps(config).replace('"root":', 'plugins:[react()],"root":', 1) + ');')
        with (output / "build.log").open("w") as log:
            subprocess.run(["node", str(frontend / "node_modules/vite/bin/vite.js"), "build", "--config", str(probe / "vite.config.mjs")],
                cwd=frontend, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
        dist = probe / "dist"
        css = list(dist.glob("*.css"))
        js = list(dist.glob("*.js")) + list(dist.glob("*.mjs"))
        assert len(css) == len(js) == 1
        (dist / "index.html").write_text('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>Interoperability fixture</title><link rel="stylesheet" href="/' + css[0].name + '"></head><body><div id="root"></div>' +
            '<script type="module" src="/' + js[0].name + '"></script></body></html>')
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(dist)))
        origin = f"http://127.0.0.1:{server.server_port}"
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(headless=True, executable_path=args.chromium, args=["--no-sandbox"])
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin + "/") else route.abort())
                page.goto(origin, wait_until="networkidle")
                dialog = page.get_by_role("dialog", name="Review this research", exact=True)
                expect(dialog.get_by_text("4 rows · 12 populated cells · 0 unanswered")).to_be_visible()
                page.screenshot(path=str(output / "conversion-desktop.png"))
                assert not page.evaluate('globalThis.__interopRequests.some(r => r.path.endsWith("/table"))')
                dialog.get_by_label("What would you like to compare?").fill("Also compare costs")
                dialog.get_by_role("button", name="Suggest layout", exact=True).click()
                expect(dialog.get_by_text("4 rows · 12 populated cells · 4 unanswered")).to_be_visible()
                expect(dialog.get_by_text("New question", exact=True)).to_be_attached()
                assert not page.evaluate('globalThis.__interopRequests.some(r => r.path.endsWith("/table"))')
                page.screenshot(path=str(output / "conversion-assisted.png"))
                page.set_viewport_size({"width": 390, "height": 844})
                expect(dialog.get_by_role("button", name="Open review")).to_be_in_viewport()
                assert dialog.bounding_box()["width"] <= 390
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                page.screenshot(path=str(output / "conversion-mobile.png"))
                dialog.get_by_role("button", name="Open review").click()
                expect(dialog).to_have_count(0)
                expect(page.get_by_role("status")).to_contain_text("created-review")
                submitted = page.evaluate('globalThis.__interopRequests.find(r => r.path.endsWith("/table")).body')
                assert submitted["fingerprint"] == "a" * 64 and submitted["chatId"] == "chat"
                assert len(submitted["design"]["columns"]) == 4 and len(submitted["design"]["cells"]) == 12
                page.get_by_label("Save highlight type").select_option("rule")
                page.get_by_role("button", name="Save highlights", exact=True).click()
                expect(page.get_by_text("1 highlight saved")).to_be_visible()
                saved = page.evaluate('globalThis.__interopRequests.find(r => r.path.endsWith("/save-findings")).body')
                assert saved["typeId"] == "rule" and saved["references"] == [{"kind": "cell", "reviewId": "created-review", "rowId": "case-0", "columnIndex": 2}]
                page.screenshot(path=str(output / "saved-highlights-mobile.png"))
                assert not errors, errors
                (output / "report.json").write_text(json.dumps({"browser": browser.version, "viewports": ["1440x900", "390x844"],
                    "preview": "existing classifications, excerpts and answers; unanswered new column",
                    "acceptance": "no automatic writes; exact reviewed mapping and fingerprint submitted",
                    "highlight": "explicit chosen type and original finding reference", "pageErrors": errors}, indent=2))
                browser.close()
        finally:
            server.shutdown(); server.server_close()


if __name__ == "__main__":
    main()
