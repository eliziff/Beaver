"""Drive the research Sources E surfaces in Chrome against a running Beaver and save screenshots for inspection.

Covers the research-overhaul Phase E additions: the Library table Label row
action, the document side-panel Highlight button (select-to-save plus
Ctrl+Shift+H arming), and the research-dock rail (Pens group, Filter box,
Labels/Search/Memo tabs, Labels-and-sources tree).
"""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from urllib.parse import urljoin

from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver import ActionChains, Keys
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def visible(driver, by: str, value: str, timeout=30):
    return WebDriverWait(driver, timeout, ignored_exceptions=(StaleElementReferenceException,)).until(lambda page: next(
        (node for node in page.find_elements(by, value) if node.is_displayed()), None))


def click_text(driver, text: str, root=None):
    xpath = f".//button[normalize-space()='{text}' or @aria-label='{text}']"
    scope = root or driver
    node = WebDriverWait(driver, 30).until(lambda _page: next(
        (item for item in scope.find_elements(By.XPATH, xpath) if item.is_displayed()), None))
    driver.execute_script("arguments[0].scrollIntoView({block:'center'})", node)
    node.click()
    return node


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000/")
    parser.add_argument("--output")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    output = Path(args.output) if args.output else Path(tempfile.mkdtemp(prefix="beaver-sources-dock-"))
    output.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"screenshots": str(output)}

    with tempfile.TemporaryDirectory(prefix="beaver-chrome-") as profile:
        options = webdriver.ChromeOptions()
        if not args.headed:
            options.add_argument("--headless=new")
        options.add_argument(f"--user-data-dir={profile}")
        options.add_argument("--window-size=1440,900")
        cached = list((Path.home() / ".cache/selenium/chromedriver/win64").glob("*/chromedriver.exe"))
        service = Service(str(max(cached, key=lambda path: tuple(map(int, path.parent.name.split(".")))))) \
            if cached else Service()
        driver = webdriver.Chrome(service=service, options=options)
        try:
            driver.set_window_size(1440, 900)

            def api(method, path, body=None):
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
                driver.save_screenshot(str(output / name))

            print("Sources dock: seed a library document", flush=True)
            driver.get(urljoin(args.url, "/library"))
            visible(driver, By.CSS_SELECTOR, "main, [role='main'], body")
            document = upload("Highlight me.txt",
                "First passage about fairness. Second passage about remedies.")
            report["documentId"] = document["id"]

            print("Sources dock: Label row action opens the palette", flush=True)
            driver.get(urljoin(args.url, "/library"))
            row = WebDriverWait(driver, 30).until(lambda page: next((node for node in page.find_elements(
                By.CSS_SELECTOR, "[data-document-row]") if node.is_displayed()
                and "Highlight me.txt" in node.text), None))
            row.find_element(By.XPATH, ".//button[@aria-label='More actions']").click()
            driver.find_element(By.XPATH, "//*[@role='menuitem' and normalize-space()='Label']").click()
            palette = visible(driver, By.CSS_SELECTOR, "[role='dialog'][aria-label='Labels and note']")
            assert "Highlight me.txt" in palette.text
            screenshot("01-label-palette.png")
            palette.find_element(By.CSS_SELECTOR, "button[aria-label='Close label palette']").click()

            print("Sources dock: Highlight button saves a text selection", flush=True)
            driver.get(urljoin(args.url, "/library"))
            row = WebDriverWait(driver, 30).until(lambda page: next((node for node in page.find_elements(
                By.CSS_SELECTOR, "[data-document-row]") if node.is_displayed()
                and "Highlight me.txt" in node.text), None))
            row.find_element(By.XPATH, ".//button[starts-with(@aria-label,'View ')]").click()
            dialog = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            highlight = next(node for node in dialog.find_elements(
                By.XPATH, ".//button[@aria-label='Highlight']") if node.is_displayed())
            assert highlight.get_attribute("aria-pressed") == "false"
            block = next(node for node in dialog.find_elements(
                By.CSS_SELECTOR, "[data-legal-block]") if node.is_displayed())
            driver.execute_script("""const block=arguments[0],text=block.firstChild;
const range=document.createRange();range.selectNodeContents(text.nodeType === 3 ? text : block);
const selection=getSelection();selection.removeAllRanges();selection.addRange(range);""", block)
            highlight.click()
            membership = WebDriverWait(driver, 60).until(lambda _page: api(
                "GET", f"/api/source-workspaces/membership?document_ids={document['id']}"))
            names = [label["name"] for label in membership[document["id"]]["labels"]]
            assert "Highlight" in names, names
            report["savedLabels"] = names
            screenshot("02-highlight-saved.png")

            print("Sources dock: Ctrl+Shift+H arms and Escape disarms", flush=True)
            driver.execute_script("getSelection().removeAllRanges()")
            ActionChains(driver).key_down(Keys.CONTROL).key_down(Keys.SHIFT).send_keys("h").key_up(
                Keys.SHIFT).key_up(Keys.CONTROL).perform()
            WebDriverWait(driver, 15).until(lambda _page: highlight.get_attribute("aria-pressed") == "true")
            assert dialog.find_element(By.CSS_SELECTOR, "[data-highlighter]") is not None
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()
            WebDriverWait(driver, 15).until(lambda _page: highlight.get_attribute("aria-pressed") == "false")
            screenshot("03-disarmed.png")
            dialog.find_element(By.CSS_SELECTOR, "button[aria-label='Close']").click()

            print("Sources dock: research rail shows Pens, Filter, tabs and tree", flush=True)
            workspaces = api("GET", "/api/library/files?limit=100")["items"]
            research = next(item["document"] for item in workspaces if item.get("kind") == "document"
                and item["document"]["filename"].endswith(".research.md"))
            driver.get(urljoin(args.url, f"/sources?research_file={research['id']}"))
            rail = visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']")
            assert rail.find_element(By.CSS_SELECTOR, "[role='group'][aria-label='Pens']").is_displayed()
            assert rail.find_element(By.CSS_SELECTOR, "input[aria-label='Filter']").is_displayed()
            tabs = rail.find_element(By.CSS_SELECTOR, "[role='tablist']")
            names = [node.text for node in tabs.find_elements(By.CSS_SELECTOR, "[role='tab']")]
            assert {"Labels", "Search", "Memo"} <= set(names), names
            tree = rail.find_element(By.CSS_SELECTOR, "[role='tree'][aria-label='Labels and sources']")
            assert tree.is_displayed()
            screenshot("04-research-rail.png")
            report["ok"] = True
        finally:
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            driver.quit()
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
