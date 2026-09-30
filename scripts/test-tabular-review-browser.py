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
            title = "Contract review — comparing parties, payment obligations and execution across the selected agreements"
            review = request("POST", "/api/tabular-review", {"title": title,
                "document_ids": [doc["id"] for doc in documents], "columns_config": columns})
            report["reviewId"] = review["id"]
            research_title = "Contract research " + review["id"][:8]
            research = request("POST", "/api/source-workspaces", {"title": research_title})
            research_id = research["document"]["id"]
            for document in documents:
                research = request("POST", f"/api/source-workspaces/{research_id}/actions", {
                    "version_id": research["versionId"], "working_revision": research["workingRevision"],
                    "action": {"type": "source", "reference": {"provider": "library", "kind": "document",
                        "id": document["id"], "versionId": document["current_version_id"], "title": document["filename"]}}})
            report["researchId"] = research_id

            print("Tabular browser: grid, header menu, selection strip", flush=True)
            driver.get(f"{args.url}/tabular-reviews/{review['id']}")
            visible("[data-tr-col-header]")
            headers = [node.text for node in driver.find_elements(By.CSS_SELECTOR, "[data-tr-col-header]")]
            assert headers[:3] == ["Parties", "Amount", "Signed"], headers
            heading = visible("h1")
            assert heading.text == title
            assert visible("button[aria-label='Add documents']").text == "Docs"
            assert visible("button[aria-label='Add columns']").text == "+ Column"
            assert not driver.find_elements(By.XPATH, "//button[normalize-space()='Organize']")
            assert driver.execute_script("return arguments[0].scrollHeight <= arguments[0].clientHeight + 1", heading), "Review title is clipped"
            assert not driver.execute_script("return document.documentElement.scrollWidth>document.documentElement.clientWidth+1"), "Page scrolls horizontally"
            assert not driver.find_elements(By.XPATH, "//*[normalize-space()='Pending' or normalize-space()='Running']"), "Status words printed in cells"
            screenshot("01-table.png")
            header = driver.find_element(By.CSS_SELECTOR, "[data-tr-col-header]")
            ActionChains(driver).move_to_element(header).perform()
            driver.execute_script("arguments[0].click()", header.find_element(By.CSS_SELECTOR, "button[aria-label='Parties actions']"))
            menu = visible("[role='menu'][aria-label='Parties actions']")
            items = [node.text for node in menu.find_elements(By.CSS_SELECTOR, "[role^='menuitem']")]
            assert {"Edit", "Rerun column", "Clear column", "Discuss column", "Labels from this column", "Delete"}.issubset(items), items
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
            assert not failed, "The live model did not propose a table design"
            report["proposedColumns"] = [node.text for node in visible("section[aria-label='Columns']")
                .find_elements(By.CSS_SELECTOR, "button[aria-expanded]")]
            assert len(report["proposedColumns"]) >= 2, report
            assert all(name.strip() for name in report["proposedColumns"]), report
            report["designOutcome"] = "columns-proposed"
            screenshot("04-assist-proposal.png")
            driver.switch_to.active_element.send_keys(Keys.ESCAPE)

            print("Tabular browser: research-set import step", flush=True)
            driver.get(f"{args.url}/tabular-reviews")
            click_text("New tabular review")
            click_text("Create custom")
            click_text("Import a Research set")
            visible(f"input[aria-label^='Select {research_title}']").click()
            click_text("Suggest a table")
            WebDriverWait(driver, 180).until(lambda page: next((node for node in page.find_elements(
                By.XPATH, "//button[normalize-space()='Create table']") if node.is_displayed() and node.is_enabled()), None))
            assert driver.find_elements(By.CSS_SELECTOR, "input[aria-label^='Column name']"), "Import proposed no columns"
            screenshot("05-import-step.png")
            click_text("Create table")
            wait.until(lambda page: "/tabular-reviews/" in page.current_url)
            report["importedReviewId"] = driver.current_url.rstrip("/").split("/")[-1]
            imported = request("GET", f"/api/tabular-review/{report['importedReviewId']}")
            assert len(imported["documents"]) == 2, imported

            print("Tabular browser: chat and Sources dock tabs", flush=True)
            driver.get(f"{args.url}/tabular-reviews/{review['id']}")
            visible("[data-tr-col-header]")
            click_text("Actions")
            actions = visible("[role='menu'][aria-label='Actions']")
            report["actions"] = [node.text for node in actions.find_elements(By.CSS_SELECTOR, "[role^='menuitem']")]
            assert "Export XLSX" in report["actions"] and "History" in report["actions"], report["actions"]
            driver.switch_to.active_element.send_keys(Keys.ESCAPE)
            click_text("Chat")
            tabs = visible("[data-assistant-dock] [role='tablist']")
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
