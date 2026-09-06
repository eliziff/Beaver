"""Keep View reachable with degraded OCR; stub only the directory read, never stored files."""
import argparse
import json
import runpy
import tempfile
from pathlib import Path

from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

chrome = runpy.run_path(str(Path(__file__).with_name("test-authorities-browser.py")))["chrome"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000/library")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or Path(tempfile.mkdtemp(prefix="beaver-document-row-"))
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="beaver-document-row-chrome-") as profile:
        driver = chrome(Path(profile), False)
        try:
            driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": """
const originalFetch = window.fetch;
window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname === '/api/library/files' && (!init?.method || init.method === 'GET'))
        return Promise.resolve(new Response(JSON.stringify({items:[{kind:'document',document:{
            id:'ocr-layout-fixture',filename:'Scanned reasons for judgment.pdf',file_type:'pdf',
            project_id:null,folder_id:null,status:'ready',size_bytes:200,page_count:1,created_at:null,
            parse_state:{status:'degraded',phase:'ocr'}
        }}],next_cursor:null}),{headers:{'Content-Type':'application/json'}}));
    return originalFetch(input, init);
};
"""})
            driver.get(args.url)
            warning_modes = set()
            for width in (1900, 1440, 900, 600, 390, 320):
                driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
                    "width": width, "height": 850, "deviceScaleFactor": 1, "mobile": False,
                })
                button = WebDriverWait(driver, 30).until(lambda page: next((node for node in
                    page.find_elements(By.CSS_SELECTOR, "button[aria-label='View Scanned reasons for judgment.pdf']")
                    if node.is_displayed()), None))
                driver.execute_script("arguments[0].scrollIntoView({block:'nearest'})", button)
                bounds = driver.execute_script("""const b=arguments[0],r=b.getBoundingClientRect();
return {left:r.left,right:r.right,viewport:innerWidth,
    reachable:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};""", button)
                assert bounds["reachable"] and 0 <= bounds["left"] < bounds["right"] <= bounds["viewport"], bounds
                warning = driver.find_element(By.CSS_SELECTOR, "[aria-label='OCR · Degraded']")
                mode = "hidden" if not warning.is_displayed() else (
                    "label" if warning.find_element(By.TAG_NAME, "span").is_displayed() else "icon")
                warning_modes.add(mode)
                driver.save_screenshot(str(output / f"ocr-{width}.png"))
                print(f"View reachable at {width}px; OCR warning: {mode}", flush=True)
            assert warning_modes == {"label", "icon", "hidden"}, warning_modes
            print(json.dumps({"ok": True, "screenshots": str(output)}))
        except Exception:
            driver.save_screenshot(str(output / "failure.png"))
            raise
        finally:
            driver.quit()


if __name__ == "__main__":
    main()
