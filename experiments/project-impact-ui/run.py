"""ChromeDriver pilot against an isolated project with recorded changed inputs."""
import argparse
import json
import runpy
import tempfile
from pathlib import Path

from selenium import webdriver
from selenium.webdriver import Keys
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

helpers = runpy.run_path(str(Path(__file__).resolve().parents[2] / "scripts/test-sources-dock-browser.py"))
visible, click_text, box, front, api = (helpers[key] for key in ("visible", "click_text", "box", "front", "api"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    report = {"ok": False, "screenshots": []}
    with tempfile.TemporaryDirectory(prefix="beaver-impact-chrome-") as profile:
        options = webdriver.ChromeOptions()
        options.add_argument("--headless=new")
        options.add_argument(f"--user-data-dir={profile}")
        options.add_argument("--window-size=1440,1000")
        options.set_capability("goog:loggingPrefs", {"browser": "ALL"})
        cached = list((Path.home() / ".cache/selenium/chromedriver/win64").glob("*/chromedriver.exe"))
        service = Service(str(max(cached, key=lambda item: tuple(map(int, item.parent.name.split(".")))))) if cached else Service()
        driver = webdriver.Chrome(service=service, options=options)
        def shot(name):
            driver.save_screenshot(str(output / name))
            report["screenshots"].append(name)
        try:
            driver.get(f"{args.url.rstrip('/')}/projects/{args.project}")
            click_text(driver, "Review changes")
            modal = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            box(driver, modal)
            report["impact"] = api(driver, f"/api/projects/{args.project}/impact")
            assert report["impact"]["items"], "Seed a changed recorded input before running this pilot"
            source = visible(driver, By.CSS_SELECTOR, "nav[aria-label='Files with changed inputs'] button")
            front(driver, source)
            source.click()
            visible(driver, By.XPATH, "//h3[normalize-space()='Document preview']")
            panes = driver.find_elements(By.XPATH, "//section[h3[normalize-space()='Original input' or normalize-space()='Current source']]")
            assert len(panes) == 2
            assert panes[0].text != panes[1].text
            report["preview"] = [pane.text for pane in panes]
            shot("01-comparison-desktop.png")
            click_text(driver, "Open original input")
            visible(driver, By.XPATH, "//button[normalize-space()='Back to changes']")
            WebDriverWait(driver, 30).until(lambda page: "Loading document" not in modal.text)
            shot("02-original-version.png")
            click_text(driver, "Back to changes")
            visible(driver, By.XPATH, "//h3[normalize-space()='Document preview']")
            click_text(driver, "Refresh")
            visible(driver, By.CSS_SELECTOR, "nav[aria-label='Files with changed inputs'] button").click()
            visible(driver, By.XPATH, "//h3[normalize-space()='Document preview']")
            driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
                "width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": False})
            box(driver, modal)
            assert driver.execute_script("return arguments[0].scrollWidth <= arguments[0].clientWidth + 1", modal)
            shot("03-comparison-narrow.png")
            driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
            driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
            WebDriverWait(driver, 10).until(lambda page: not page.find_elements(By.CSS_SELECTOR, "dialog[open]"))
            click_text(driver, "Review changes")
            visible(driver, By.CSS_SELECTOR, "nav[aria-label='Files with changed inputs'] button").click()
            visible(driver, By.XPATH, "//h3[normalize-space()='Document preview']")
            click_text(driver, "Review in chat")
            WebDriverWait(driver, 30).until(lambda page: f"/projects/{args.project}/assistant/chat/" in page.current_url)
            draft = visible(driver, By.CSS_SELECTOR, "textarea")
            assert f"project://{args.project}" in draft.get_attribute("value")
            assert "do not change files yet" in draft.get_attribute("value")
            shot("04-review-chat-draft.png")
            report["consoleErrors"] = [entry for entry in driver.get_log("browser") if entry["level"] == "SEVERE"]
            assert not report["consoleErrors"], report["consoleErrors"]
            report["ok"] = True
        finally:
            if not report["ok"]:
                shot("failure.png")
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            driver.quit()
    print(json.dumps({"ok": report["ok"], "output": str(output)}, indent=2))


if __name__ == "__main__":
    main()
