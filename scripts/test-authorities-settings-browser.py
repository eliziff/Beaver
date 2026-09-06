"""Real Chrome checks for Authorities settings and direct court selection."""
import argparse
import json
import runpy
import tempfile
from pathlib import Path

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.wait import WebDriverWait

helpers = runpy.run_path(str(Path(__file__).with_name("test-authorities-browser.py")))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000/table-of-authorities")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="beaver-settings-chrome-") as profile:
        driver = helpers["chrome"](Path(profile), False)
        wait = WebDriverWait(driver, 30)
        def visible(selector):
            return wait.until(lambda page: next((node for node in page.find_elements(
                By.CSS_SELECTOR, selector) if node.is_displayed()), None))
        try:
            driver.set_window_size(1440, 1000)
            driver.get(args.url)
            visible(".authorities-workspace button[aria-label='Settings']").click()
            source = visible("input[name='authorities-Source handling']")
            court = visible("button[aria-label^='Court:']")
            marking = visible("input[name='authorities-Passage marking']")
            measurements = {"court": court.rect, "source": source.rect, "marking": marking.rect}
            driver.save_screenshot(str(args.output / "01-settings.png"))
            if args.check:
                dialog = visible("dialog[open]")
                assert driver.execute_script("return arguments[0].scrollWidth <= arguments[0].clientWidth + 1", dialog)
            court.click()
            modal = wait.until(lambda page: page.find_elements(By.CSS_SELECTOR, "dialog[open]")[-1])
            choices = modal.find_elements(By.CSS_SELECTOR, "button[aria-pressed]")
            assert choices and all(choice.is_enabled() for choice in choices)
            assert "Preset not available" not in modal.text and "More jurisdictions" not in modal.text
            assert modal.rect["width"] >= 550, modal.rect
            assert modal.rect["height"] < driver.execute_script("return innerHeight"), modal.rect
            assert len(driver.find_elements(By.CSS_SELECTOR, "dialog[open]")) == 2
            assert "Federal Court" in modal.text and "Alberta" in modal.text
            assert all(abs(choice.rect["x"] - choices[0].rect["x"]) <= 1
                       and abs(choice.rect["width"] - choices[0].rect["width"]) <= 1 for choice in choices)
            measurements["courtPicker"] = modal.rect
            measurements["choices"] = [choice.text for choice in choices]
            driver.save_screenshot(str(args.output / "02-courts.png"))
            driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
                "width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": False})
            assert driver.execute_script("return arguments[0].scrollWidth <= arguments[0].clientWidth + 1", modal)
            driver.save_screenshot(str(args.output / "03-courts-narrow.png"))
            modal.send_keys(Keys.ESCAPE)
            wait.until(lambda page: len(page.find_elements(By.CSS_SELECTOR, "dialog[open]")) == 1)
            driver.save_screenshot(str(args.output / "04-settings-narrow.png"))
            visible("button[aria-label^='Court:']").click()
            federal = wait.until(lambda page: page.find_elements(By.XPATH,
                "//dialog[@open]//button[normalize-space(.)='Federal Court']"))[0]
            federal.click()
            visible("button[aria-label='Court: Federal Court']")
            assert len(driver.find_elements(By.CSS_SELECTOR, "dialog[open]")) == 1
            visible("button[aria-label='Court: Federal Court']").click()
            modal = wait.until(lambda page: page.find_elements(By.CSS_SELECTOR, "dialog[open]")[-1])
            selected = modal.find_element(By.CSS_SELECTOR, "button[aria-pressed='true']")
            assert selected.text == "Federal Court"
            selected.send_keys(Keys.ENTER)
            wait.until(lambda page: len(page.find_elements(By.CSS_SELECTOR, "dialog[open]")) == 1)
            alternative = "render"
            visible("input[name='authorities-Source handling'][value='render']").click()
            driver.find_element(By.XPATH, "//dialog[@open]//button[normalize-space(.)='Done']").click()
            driver.refresh()
            visible(".authorities-workspace button[aria-label='Settings']").click()
            visible("button[aria-label='Court: Federal Court']")
            assert visible("input[name='authorities-Source handling'][value='render']").is_selected()
            driver.save_screenshot(str(args.output / "05-settings-persisted.png"))
            errors = [row for row in driver.get_log("browser") if row["level"] == "SEVERE"]
            assert not errors, errors
            report = {"measurements": measurements, "consoleErrors": errors, "output": str(args.output)}
            (args.output / "RESULTS.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report))
        except Exception:
            driver.save_screenshot(str(args.output / "failure.png"))
            (args.output / "failure.html").write_text(driver.page_source, encoding="utf-8")
            raise
        finally:
            driver.quit()


if __name__ == "__main__":
    main()
