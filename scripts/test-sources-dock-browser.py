"""Check neutral Library membership and explicit research highlights in a running Beaver.

Highlight selection/shortcut reader interactions are covered by the focused
DocumentSidePanel and LegalSourceViewer tests; this browser flow verifies the
Library does not impose a workspace and that a chosen set retains typed passages.
"""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from urllib.parse import urljoin

from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException
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

            title = "Explicit research " + document["id"][:8]
            research = api("POST", "/api/source-workspaces", {"title": title})
            research_id = research["document"]["id"]
            print("Sources dock: choose an explicit research destination", flush=True)
            driver.get(urljoin(args.url, "/library"))
            row = WebDriverWait(driver, 30).until(lambda page: next((node for node in page.find_elements(
                By.CSS_SELECTOR, "[data-document-row]") if node.is_displayed()
                and "Highlight me.txt" in node.text), None))
            assert not row.find_elements(By.CSS_SELECTOR, "[data-label-dot]")
            row.find_element(By.XPATH, ".//button[@aria-label='More actions']").click()
            assert not driver.find_elements(By.XPATH, "//*[@role='menuitem' and normalize-space()='Label']")
            driver.find_element(By.XPATH, "//*[@role='menuitem' and normalize-space()='Add to research…']").click()
            dialog = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            assert not api("GET", f"/api/source-workspaces/{research_id}")["state"]["sources"]
            dialog.find_element(By.CSS_SELECTOR, "input[aria-label='Filter']").send_keys(title)
            click_text(driver, title, dialog)

            def collected_source():
                saved = api("GET", f"/api/source-workspaces/{research_id}")
                return next((item for item in saved["state"]["sources"].values()
                    if item.get("collected") and item["reference"]["id"] == document["id"]), None)

            source = WebDriverWait(driver, 30).until(lambda _page: collected_source())
            assert source["reference"]["versionId"] == document["current_version_id"]
            assert source["labelIds"] == []
            assert not api("GET", f"/api/source-workspaces/{research_id}/items?kind=passages")["items"]
            screenshot("01-explicit-membership.png")

            # Explicit save, not a read: default type is one ordinary Highlight.
            saved = api("GET", f"/api/source-workspaces/{research_id}")
            saved = api("POST", f"/api/source-workspaces/{research_id}/actions", {
                "version_id": saved["versionId"], "working_revision": saved["workingRevision"],
                "action": {"type": "passage", "sourceId": source["id"],
                    "locator": {"kind": "document", "value": "document"},
                    "quote": "First passage about fairness."}})
            items = api("GET", f"/api/source-workspaces/{research_id}/items?kind=passages")["items"]
            assert len(items) == 1, items
            type_ids = items[0]["value"]["labelIds"]
            assert len(type_ids) == 1
            assert saved["state"]["labels"][type_ids[0]]["name"] == "Highlight"
            report["researchId"] = research_id
            report["highlightId"] = items[0]["value"]["receipt"]["evidence_id"]

            driver.get(urljoin(args.url, f"/sources?research_file={research_id}"))
            rail = visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']")
            assert rail.find_element(By.CSS_SELECTOR, "[role='group'][aria-label='Highlight types']").is_displayed()
            assert rail.find_element(By.CSS_SELECTOR, "input[aria-label='Filter']").is_displayed()
            tree = rail.find_element(By.CSS_SELECTOR, "[role='tree'][aria-label='Labels and sources']")
            assert tree.is_displayed()
            assert "Highlight me.txt" in tree.text
            assert "Unsorted" not in tree.text and "Unclassified" not in tree.text
            screenshot("02-research-rail.png")
            report["ok"] = True
        finally:
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            driver.quit()
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
