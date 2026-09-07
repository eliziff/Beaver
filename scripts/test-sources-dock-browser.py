"""Check research-local Library placement and highlight types in the real Sources dock.

The Library picker requires an explicit target. A canonical passage is seeded
through the public API, then the dock renders the same saved highlight. The
reader's selection capture and keyboard behavior have separate component tests.
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

            research = api("POST", "/api/source-workspaces/", {"title": "PR1 smoke research"})
            before = api("GET", f"/api/single-documents/{document['id']}")
            print("Sources dock: add a Library document to an explicit research set", flush=True)
            driver.get(urljoin(args.url, "/library"))
            row = WebDriverWait(driver, 30).until(lambda page: next((node for node in page.find_elements(
                By.CSS_SELECTOR, "[data-document-row]") if node.is_displayed()
                and "Highlight me.txt" in node.text), None))
            row.find_element(By.XPATH, ".//button[@aria-label='More actions']").click()
            assert not driver.find_elements(By.XPATH, "//*[@role='menuitem' and normalize-space()='Label']")
            driver.find_element(By.XPATH, "//*[@role='menuitem' and normalize-space()='Add to research…']").click()
            picker = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            click_text(driver, "PR1 smoke research", picker)
            def added(_page):
                value = api("GET", f"/api/source-workspaces/{research['document']['id']}")
                return value if value["state"]["sources"] else False
            research = WebDriverWait(driver, 30).until(added)
            source = next(iter(research["state"]["sources"].values()))
            assert source["reference"]["id"] == document["id"]
            assert not source["labelIds"] and source["passages"] is None
            assert api("GET", f"/api/single-documents/{document['id']}") == before
            screenshot("01-explicit-target.png")

            def act(action):
                nonlocal research
                research = api("POST", f"/api/source-workspaces/{research['document']['id']}/actions", {
                    "version_id": research["versionId"], "working_revision": research["workingRevision"], "action": action})
            act({"type": "label", "name": "Rule", "scope": "highlight", "color": "#d9bc75"})
            type_id = next(iter(research["state"]["labels"]))
            act({"type": "passage", "sourceId": source["id"], "locator": {"kind": "document", "value": "document"},
                 "quote": "First passage about fairness.", "labelIds": [type_id]})
            assert research["state"]["sources"][source["id"]]["passages"]["count"] == 1
            report["researchId"] = research["document"]["id"]

            print("Sources dock: one highlight type, no synthetic unsorted folder", flush=True)
            driver.get(urljoin(args.url, f"/sources?research_file={research['document']['id']}"))
            rail = visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']")
            assert rail.find_element(By.CSS_SELECTOR, "[role='group'][aria-label='Highlight types']").is_displayed()
            assert rail.find_element(By.CSS_SELECTOR, "input[aria-label='Filter']").is_displayed()
            assert not rail.find_elements(By.XPATH, ".//*[normalize-space()='Unsorted' or normalize-space()='Unclassified']")
            click_text(driver, "Passages in Highlight me.txt", rail)
            visible(driver, By.XPATH, "//*[normalize-space()='First passage about fairness.']")
            screenshot("02-research-highlight.png")

            print("Sources dock: deleting a type preserves the saved passage", flush=True)
            act({"type": "remove", "kind": "label", "id": type_id})
            passages = api("GET", f"/api/source-workspaces/{research['document']['id']}/items?kind=passages&source_id={source['id']}")
            assert len(passages["items"]) == 1
            value = passages["items"][0]["value"]
            assert value["receipt"]["span_text"] == "First passage about fairness."
            assert len(value["labelIds"]) == 1
            assert research["state"]["labels"][value["labelIds"][0]]["name"] == "Highlight"
            driver.refresh()
            visible(driver, By.CSS_SELECTOR, "[role='group'][aria-label='Highlight types']")
            screenshot("03-type-removed-passage-retained.png")
            report["ok"] = True
        finally:
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            driver.quit()
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
