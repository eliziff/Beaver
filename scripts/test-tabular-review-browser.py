"""Drive the Tabular Review screen in Chrome against a running Beaver and save screenshots for inspection."""
from __future__ import annotations

import argparse
import json
import runpy
import tempfile
from pathlib import Path

from selenium.webdriver import ActionChains, Keys
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

chrome = runpy.run_path(str(Path(__file__).with_name("test-authorities-browser.py")))["chrome"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {}
    with tempfile.TemporaryDirectory(prefix="beaver-tabular-browser-") as profile:
        driver = chrome(Path(profile), args.headed)
        wait = WebDriverWait(driver, 60)

        def visible(selector, root=None):
            return wait.until(lambda page: next((node for node in (root or page).find_elements(
                By.CSS_SELECTOR, selector) if node.is_displayed()), None))

        def click_text(text, root=None):
            xpath = f".//button[normalize-space()='{text}' or @aria-label='{text}']"
            node = wait.until(lambda page: next((item for item in (root or page).find_elements(By.XPATH, xpath)
                if item.is_displayed()), None))
            driver.execute_script("arguments[0].scrollIntoView({block:'center'})", node)
            node.click()
            return node

        def request(method, path, body=None):
            result = driver.execute_async_script("""const [method,path,body,done]=arguments;
fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined})
  .then(async r=>done({status:r.status,value:await r.json().catch(()=>null)})).catch(e=>done({error:String(e)}));""",
                method, path, body)
            assert result.get("status") in (200, 201, 204), {"path": path, "result": result}
            return result.get("value")

        def upload(filename, text):
            result = driver.execute_async_script("""const [name,text,done]=arguments;
const form=new FormData();form.append('file',new File([text],name,{type:'text/plain'}));
fetch('/api/library/files/documents',{method:'POST',body:form}).then(async r=>done({status:r.status,value:await r.json()}))
  .catch(e=>done({error:String(e)}));""", filename, text)
            assert result.get("status") == 201, result
            return result["value"]

        def screenshot(name):
            driver.save_screenshot(str(args.output / name))

        try:
            driver.set_window_size(1440, 900)
            driver.get(args.url + "/tabular-reviews")
            visible("main, [role='main'], body")
            print("Tabular browser: seeding documents and reviews", flush=True)
            documents = [upload("Lease agreement.txt", "This lease between Alpha Ltd and Beta Inc is signed. Total rent is $12,000."),
                         upload("Services contract.txt", "Services contract between Gamma Corp and Delta LLC. Fee: $4,500. Unsigned draft.")]
            columns = [{"index": 0, "name": "Parties", "prompt": "Identify the parties to the agreement.", "format": "text"},
                       {"index": 1, "name": "Amount", "prompt": "State the total amount payable.", "format": "monetary_amount"},
                       {"index": 2, "name": "Signed", "prompt": "Is the document signed?", "format": "yes_no"}]
            review = request("POST", "/api/tabular-review", {"title": "Browser check",
                "document_ids": [doc["id"] for doc in documents], "columns_config": columns})
            report["reviewId"] = review["id"]

            print("Tabular browser: grid, header menu, selection strip", flush=True)
            driver.get(f"{args.url}/tabular-reviews/{review['id']}")
            visible("[data-tr-col-header]")
            headers = [node.text for node in driver.find_elements(By.CSS_SELECTOR, "[data-tr-col-header]")]
            assert headers[:3] == ["Parties", "Amount", "Signed"], headers
            assert not driver.execute_script("return document.documentElement.scrollWidth>document.documentElement.clientWidth+1"), "Page scrolls horizontally"
            assert not driver.find_elements(By.XPATH, "//*[normalize-space()='Pending' or normalize-space()='Running']"), "Status words printed in cells"
            screenshot("01-table.png")
            header = driver.find_element(By.CSS_SELECTOR, "[data-tr-col-header]")
            ActionChains(driver).move_to_element(header).perform()
            driver.execute_script("arguments[0].click()", header.find_element(By.CSS_SELECTOR, "button[aria-label='Parties actions']"))
            menu = visible("[role='menu'][aria-label='Parties actions']")
            items = [node.text for node in menu.find_elements(By.CSS_SELECTOR, "[role^='menuitem']")]
            assert items == ["Edit", "Rerun column", "Clear column", "Delete"], items
            screenshot("02-column-menu.png")
            driver.switch_to.active_element.send_keys(Keys.ESCAPE)
            row_boxes = [node for node in driver.find_elements(By.CSS_SELECTOR, "input[type='checkbox']") if node.is_displayed()]
            assert len(row_boxes) >= 3, "Expected a select-all box plus one per row"
            row_boxes[1].click()
            strip = wait.until(lambda page: next((node for node in page.find_elements(By.XPATH, "//*[contains(normalize-space(),'1 selected')]")
                if node.is_displayed()), None))
            assert strip is not None
            screenshot("03-selection-strip.png")
            row_boxes[1].click()
            wait.until(lambda page: not [node for node in page.find_elements(By.XPATH, "//*[contains(normalize-space(),'1 selected')]") if node.is_displayed()])

            print("Tabular browser: chat-assist proposal flow", flush=True)
            driver.get(f"{args.url}/tabular-reviews")
            click_text("New tabular review")
            click_text("Create custom")
            click_text("Chat assist")
            design_box = visible("textarea[aria-label='Describe the review']")
            design_box.send_keys("Review leases for parties and amounts.")
            click_text("Propose design")
            WebDriverWait(driver, 180).until(lambda page: next((node for node in page.find_elements(
                By.XPATH, ".//button[normalize-space()='Propose design']") if node.is_displayed()), None))
            failed = [node for node in driver.find_elements(By.XPATH,
                "//p[@role='alert' and contains(normalize-space(),'Could not propose a design')]") if node.is_displayed()]
            report["designOutcome"] = "error-shown" if failed else "columns-proposed"
            screenshot("04-assist-proposal.png")
            driver.switch_to.active_element.send_keys(Keys.ESCAPE)

            print("Tabular browser: research-set import step", flush=True)
            driver.get(f"{args.url}/tabular-reviews")
            click_text("New tabular review")
            click_text("Create custom")
            click_text("Import a Research set")
            visible("fieldset legend")
            rows = visible("fieldset")
            assert "Sources" in rows.text and "Passages" in rows.text, rows.text
            assert driver.find_elements(By.XPATH,
                "//button[normalize-space()='Create']"), "Import Create action missing"
            screenshot("05-import-step.png")
            driver.switch_to.active_element.send_keys(Keys.ESCAPE)

            print("Tabular browser: chat and Sources dock tabs", flush=True)
            driver.get(f"{args.url}/tabular-reviews/{review['id']}")
            visible("[data-tr-col-header]")
            click_text("Actions")
            actions = visible("[role='menu'][aria-label='Actions']")
            report["actions"] = [node.text for node in actions.find_elements(By.CSS_SELECTOR, "[role^='menuitem']")]
            assert "Export XLSX" in report["actions"] and "History" in report["actions"], report["actions"]
            driver.switch_to.active_element.send_keys(Keys.ESCAPE)
            click_text("Chat")
            tabs = visible("[role='tablist']")
            names = [node.text for node in tabs.find_elements(By.CSS_SELECTOR, "[role='tab']")]
            assert "Chat" in names and "Sources" in names, names
            tabs.find_element(By.XPATH, ".//*[@role='tab' and normalize-space()='Sources']").click()
            visible("section[aria-label='Research collection']")
            screenshot("06-sources-dock.png")
            report["ok"] = True
        finally:
            (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            driver.quit()
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
