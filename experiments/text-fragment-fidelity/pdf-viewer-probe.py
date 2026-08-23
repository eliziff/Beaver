#!/usr/bin/env python3
"""Inspect Chrome PDF viewer surfaces needed by the exact-placement gate."""
import json
import functools
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
label = "CT_2026_Comp_Trib_19_p1_short-exact"
target = next(json.loads(line) for line in (RESULTS / "targets.jsonl").read_text(encoding="utf-8").splitlines() if json.loads(line)["label"] == label)
file = RESULTS / "page-html/cbcbe35d70df6ce079ccabb7c169251c130a48af.pdf"


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(file.parent)))
threading.Thread(target=server.serve_forever, daemon=True).start()
options = Options()
options.add_argument("--headless=new")
options.add_argument("--no-sandbox")
options.add_argument("--disable-gpu")
options.add_argument("--window-size=800,900")
options.add_argument(f"--user-data-dir={tempfile.mkdtemp(prefix='pdf-probe-')}")
driver = webdriver.Chrome(service=Service(str(Path.home() / ".cache/selenium/chromedriver/win64/151.0.7922.138/chromedriver.exe")), options=options)
try:
    fragment = target["target"].split("#", 1)[1]
    driver.get(f"http://127.0.0.1:{server.server_port}/{quote(file.name)}#{fragment}")
    time.sleep(3)
    print(json.dumps(driver.execute_script("""
      const walk = (root, depth=0) => [...root.querySelectorAll('*')].flatMap((el) => [{tag:el.tagName,id:el.id,shadow:Boolean(el.shadowRoot),depth}, ...(el.shadowRoot && depth < 8 ? walk(el.shadowRoot, depth+1) : [])]);
      return {url:location.href, title:document.title, body:document.body.innerText, tree:walk(document).filter(x=>x.shadow||x.id).slice(0,100)};
    """), ensure_ascii=False, indent=2))
    ax = driver.execute_cdp_cmd("Accessibility.getFullAXTree", {})
    useful = [{"role": n.get("role", {}).get("value"), "name": n.get("name", {}).get("value")} for n in ax.get("nodes", []) if n.get("name", {}).get("value")]
    print(json.dumps(useful[:100], ensure_ascii=False, indent=2))
    print(json.dumps(driver.execute_cdp_cmd("Target.getTargets", {}), ensure_ascii=False, indent=2))
    (RESULTS / "pdf-viewer-probe.png").write_bytes(driver.get_screenshot_as_png())
finally:
    driver.quit()
    server.shutdown()
