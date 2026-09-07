"""Loopback-only Chromium checks of real research UI components (not the full app smoke).

Requires locked frontend dependencies, Python Playwright, and Chromium. No model,
account, native parser or user files are used. Transport responses are synthetic.
Run: python scripts/test-research-ui-components.py /tmp/research-ui-proof
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--chromium", default=shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    frontend = root / "frontend"
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".research-ui-probe-", dir=frontend) as temp:
        probe = Path(temp)
        shutil.copy(root / "scripts/fixtures/research-ui.tsx", probe / "main.tsx")
        (probe / "index.html").write_text('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Research UI fixture</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>')
        (probe / "probe.css").write_text('@import "../src/app/globals.css";\n@source ".";\n@source "../src/app";\n')
        # Match the app bootstrap: configuration precedes modules that consume it.
        (probe / "bootstrap.ts").write_text('import { initializeRuntimeConfig } from "@/app/lib/runtimeConfig";\n'
            'await initializeRuntimeConfig(async () => new Response(JSON.stringify({mode:"local",capabilities:{connectors:false}})));\n'
            'await import("./main");\n')
        config = {
            "define": {"process.env.NODE_ENV": '"production"'},
            "root": str(probe), "resolve": {"alias": {"@": str(frontend / "src"), "docx-preview": str(frontend / "vendor/docx-preview/index.ts")}},
            "build": {"target": "esnext", "minify": False, "cssCodeSplit": False,
                "lib": {"entry": str(probe / "bootstrap.ts"), "formats": ["es"], "fileName": "fixture"},
                "rolldownOptions": {"output": {"codeSplitting": False}}},
        }
        (probe / "vite.config.mjs").write_text('import {defineConfig} from "vite"; import react from "@vitejs/plugin-react"; export default defineConfig(' +
            json.dumps(config).replace('"root":', 'plugins:[react()],"root":', 1) + ');')
        with (output / "build.log").open("w") as log:
            subprocess.run(["node", str(frontend / "node_modules/vite/bin/vite.js"), "build", "--config", str(probe / "vite.config.mjs")],
                cwd=frontend, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
        styles = list((probe / "dist").glob("*.css"))
        bundles = list((probe / "dist").glob("*.js")) + list((probe / "dist").glob("*.mjs"))
        assert len(bundles) == 1 and len(styles) == 1, "Expected one fixture bundle and stylesheet"
        (probe / "dist/index.html").write_text('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Research fixture</title><link rel="stylesheet" href="/' + styles[0].name + '"></head><body><div id="root"></div><script type="module" src="/' + bundles[0].name + '"></script></body></html>')
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(probe / "dist")))
        origin = f"http://127.0.0.1:{server.server_port}"
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, executable_path=args.chromium, args=["--no-sandbox"])
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                page.set_default_timeout(15000)
                errors: list[str] = []
                def capture_error(error):
                    errors.append(str(error))
                    (output / "page-errors.json").write_text(json.dumps(errors, indent=2))
                page.on("pageerror", capture_error)
                page.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin + "/") else route.abort())
                page.goto(origin, wait_until="networkidle")
                page.screenshot(path=str(output / "loaded.png"))
                (output / "loaded.html").write_text(page.content())
                sources = page.get_by_role("list", name="Research sources")
                expect(sources.get_by_role("listitem")).to_have_count(4)
                page.get_by_role("button", name="Integrated scheme, 2 sources", exact=True).click()
                expect(sources.get_by_role("listitem")).to_have_count(2)
                page.get_by_role("button", name="All sources", exact=True).click()
                expect(sources.get_by_role("listitem")).to_have_count(4)
                page.get_by_role("button", name="Passages in Miller v. Northlake").click()
                expect(sources.get_by_role("button", name="The termination provisions must be read together.", exact=True)).to_be_visible()
                page.screenshot(path=str(output / "sources.png"))
                page.get_by_role("button", name="Choose highlight type", exact=True).click()
                page.get_by_role("menuitemcheckbox", name="Application", exact=True).click()
                expect(sources.get_by_role("listitem")).to_have_count(4)
                page.get_by_role("button", name="Choose highlight type", exact=True).click()
                page.get_by_role("menuitem", name="Edit highlight types…", exact=True).click()
                dialog = page.get_by_role("dialog", name="Highlight types", exact=True)
                page.screenshot(path=str(output / "highlight-types.png"))
                dialog.get_by_role("button", name="Rule options", exact=True).click()
                page.get_by_role("menuitem", name="Add child", exact=True).click()
                dialog.get_by_role("textbox", name="Highlight type name").fill("Exception")
                dialog.get_by_role("button", name="Add", exact=True).click()
                expect(dialog.get_by_role("button", name="Exception", exact=True)).to_be_visible()
                action = page.evaluate("globalThis.__researchActions.at(-1)")
                assert action["scope"] == "highlight" and action["parentId"] == "rule" and action["color"]
                dialog.get_by_role("button", name="Done", exact=True).click()
                page.get_by_role("tab", name="Memo", exact=True).click()
                expect(page.get_by_role("textbox", name="Workspace memo")).to_be_visible()
                cite = page.locator("[data-memo-citation]")
                expect(cite).to_have_text("Miller v. Northlake, 2099 EXAMPLE 1 at para 1")
                assert cite.evaluate("e => e.tagName") == "A"
                page.screenshot(path=str(output / "memo.png"))
                page.get_by_role("button", name="Table fixture").click()
                heading = page.get_by_role("heading", level=1)
                docs = page.get_by_role("button", name="Add documents")
                assert heading.bounding_box()["y"] + heading.bounding_box()["height"] <= docs.bounding_box()["y"]
                column = page.get_by_role("columnheader", name="Why the for-cause and without-cause provisions were treated together", exact=False)
                expect(column).to_be_visible()
                page.screenshot(path=str(output / "table.png"))
                page.get_by_role("cell", name="Integrated termination scheme", exact=False).first.click()
                inspector = page.get_by_role("dialog", name="Why the for-cause and without-cause provisions were treated together result")
                expect(inspector).to_be_visible()
                scrolling = inspector.locator('[aria-label="Result content"]')
                dimensions = scrolling.evaluate("e => ({visible: e.clientHeight, total:e.scrollHeight})")
                assert dimensions["visible"] > 0 and dimensions["total"] > dimensions["visible"]
                close_top = inspector.get_by_role("button", name="Close", exact=True).bounding_box()["y"]
                page.screenshot(path=str(output / "inspector.png"))
                scrolling.hover()
                page.mouse.wheel(0, 2500)
                page.wait_for_function('document.querySelector("[aria-label=\\"Result content\\"]").scrollTop > 0')
                assert inspector.get_by_role("button", name="Close", exact=True).bounding_box()["y"] == close_top
                inspector.locator("summary", has_text="More details").click()
                inspector.locator("summary", has_text="Receipt ·").first.click()
                page.screenshot(path=str(output / "inspector-scrolled.png"))
                page.set_viewport_size({"width": 375, "height": 812})
                expect(inspector).to_have_attribute("aria-modal", "true")
                assert inspector.bounding_box()["width"] <= 375
                scrolling.focus()
                page.keyboard.press("Home")
                page.screenshot(path=str(output / "inspector-mobile.png"))
                page.keyboard.press("Escape")
                expect(inspector).to_have_count(0)
                page.screenshot(path=str(output / "table-mobile.png"))
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                assert not errors, errors
                (output / "report.json").write_text(json.dumps({"browser": browser.version, "resultScroll": dimensions,
                    "labelBrowsing": "one list, nested labels, no duplicate sources", "highlightEditor": "created typed child in one action", "memo": "ordinary citation link", "inspector": "scrolls with fixed controls; mobile modal", "pageErrors": errors}, indent=2))
                browser.close()

        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
