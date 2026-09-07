"""Loopback-only browser probe for the actual research conversion components.

Uses synthetic transport responses, no user documents/accounts/native parser/models.
This is not the full application smoke. Requires locked frontend dependencies,
Python Playwright and Chromium. Run with an output directory for screenshots/logs.
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--chromium", default=shutil.which("chromium") or shutil.which("google-chrome"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    frontend = root / "frontend"
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".interop-probe-", dir=frontend) as temporary:
        probe = Path(temporary)
        shutil.copy(root / "scripts/fixtures/research-interop.tsx", probe / "main.tsx")
        (probe / "probe.css").write_text('@import "../src/app/globals.css";\n@source ".";\n@source "../src/app";\n')
        config = {"root": str(probe), "define": {"process.env.NODE_ENV": '"production"'},
            "resolve": {"alias": {"@": str(frontend / "src"), "docx-preview": str(frontend / "vendor/docx-preview/index.ts")}},
            "build": {"target": "esnext", "minify": False, "cssCodeSplit": False,
                "lib": {"entry": str(probe / "main.tsx"), "formats": ["es"], "fileName": "fixture"},
                "rolldownOptions": {"output": {"codeSplitting": False}}}}
        (probe / "vite.config.mjs").write_text('import {defineConfig} from "vite"; import react from "@vitejs/plugin-react"; export default defineConfig({...' +
            json.dumps(config) + ',plugins:[react()]});')
        with (output / "build.log").open("w") as log:
            subprocess.run(["node", str(frontend / "node_modules/vite/bin/vite.js"), "build", "--config", str(probe / "vite.config.mjs")],
                cwd=frontend, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
        styles = list((probe / "dist").glob("*.css"))
        bundles = list((probe / "dist").glob("*.js")) + list((probe / "dist").glob("*.mjs"))
        assert len(styles) == len(bundles) == 1
        (probe / "dist/index.html").write_text('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Research interop fixture</title><link rel="stylesheet" href="/' + styles[0].name + '"></head><body><div id="root"></div><script type="module" src="/' + bundles[0].name + '"></script></body></html>')
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(probe / "dist")))
        origin = f"http://127.0.0.1:{server.server_port}"
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, executable_path=args.chromium, args=["--no-sandbox"])
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                page.set_default_timeout(15000)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin + "/") else route.abort())
                page.goto(origin, wait_until="networkidle")
                page.get_by_role("button", name="Review", exact=True).click()
                dialog = page.get_by_role("dialog", name="Review existing research")
                expect(dialog.get_by_text("The provisions were treated as an integrated scheme.", exact=True)).to_be_visible()
                expect(dialog.get_by_role("button", name="Create review", exact=True)).to_be_enabled()
                assert page.evaluate("__interopCalls.filter(c=>c.path.endsWith('/table')).length") == 0
                page.screenshot(path=str(output / "review-preview.png"))
                dialog.locator("summary", has_text="Why the provisions were treated together").click()
                dialog.get_by_label("Column 2 title", exact=True).fill("Why this result?")
                expect(dialog.get_by_role("button", name="Create review", exact=True)).to_be_disabled()
                dialog.get_by_role("button", name="Update preview", exact=True).click()
                expect(dialog.get_by_role("button", name="Create review", exact=True)).to_be_enabled()
                page.screenshot(path=str(output / "review-mapping.png"))
                page.set_viewport_size({"width": 390, "height": 844})
                scroller = dialog.locator(".overflow-y-auto").last
                before = dialog.get_by_role("button", name="Create review", exact=True).bounding_box()
                sizes = scroller.evaluate("e=>({height:e.clientHeight,scroll:e.scrollHeight})")
                assert sizes["scroll"] > sizes["height"] > 0
                scroller.hover()
                page.mouse.wheel(0, 2000)
                page.wait_for_function("document.querySelector('dialog .overflow-y-auto').scrollTop > 0")
                after = dialog.get_by_role("button", name="Create review", exact=True).bounding_box()
                assert before["y"] == after["y"]
                assert dialog.evaluate("e=>e.scrollWidth <= e.clientWidth")
                page.screenshot(path=str(output / "review-mobile.png"))
                dialog.get_by_role("button", name="Create review", exact=True).click()
                expect(page.get_by_text("Opened /tabular-reviews/created-review", exact=True)).to_be_visible()
                created = page.evaluate("__interopCalls.find(c=>c.path.endsWith('/table')).input")
                assert created["basis"] and created["columns"][1]["name"] == "Why this result?"
                assert created["selection"]["sourceIds"] == ["source-0", "source-1", "source-2"]
                page.set_viewport_size({"width": 1440, "height": 900})
                page.get_by_role("button", name="Collect", exact=True).click()
                collect = page.get_by_role("dialog", name="Collect chat research")
                toggle = collect.get_by_label("Save selected supporting passages as highlights", exact=True)
                expect(toggle).not_to_be_checked()
                expect(collect.get_by_text("Unselected read, not supporting evidence.", exact=True)).to_have_count(0)
                page.screenshot(path=str(output / "chat-collect.png"))
                collect.get_by_role("button", name="Open research", exact=True).click()
                assert page.evaluate("__interopCalls.filter(c=>c.path.endsWith('/save-highlights')).length") == 0
                page.get_by_role("button", name="Collect", exact=True).click()
                toggle.check()
                collect.get_by_label("Save as highlight type", exact=True).select_option("drafting")
                collect.get_by_role("button", name="Open research", exact=True).click()
                saved = page.evaluate("__interopCalls.find(c=>c.path.endsWith('/save-highlights')).input")
                assert saved["typeId"] == "drafting" and saved["evidenceIds"] == ["e_0", "e_1", "e_2"]
                page.get_by_role("button", name="Labels", exact=True).click()
                labels = page.get_by_role("dialog", name="Labels from column")
                labels.get_by_label("Parent source label", exact=True).select_option("relevance")
                labels.get_by_label("Label for value 2", exact=True).fill("Directly relevant")
                page.screenshot(path=str(output / "column-labels.png"))
                labels.get_by_role("button", name="Propose labels", exact=True).click()
                applied = page.evaluate("__interopCalls.find(c=>c.path.endsWith('/column-labels')).input")
                assert applied["parentId"] == "relevance" and applied["mapping"][2]["label"] is None
                assert applied["mapping"][0]["label"] == applied["mapping"][1]["label"]
                assert not errors, errors
                (output / "report.json").write_text(json.dumps({"browser": browser.version, "scope": "production components, synthetic transport only",
                    "preview": "populated; no create before approval; edited mappings previewed again", "mobileScroller": sizes,
                    "collection": "no highlights unless selected; support only", "labels": "explicit consolidation proposal and skips", "pageErrors": errors}, indent=2))
                browser.close()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
