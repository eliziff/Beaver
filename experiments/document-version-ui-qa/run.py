from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

from selenium import webdriver
from selenium.webdriver import ActionChains, Keys
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


ROOT = Path(__file__).parent


def visible(driver, by: str, value: str, timeout: int = 30):
    return WebDriverWait(driver, timeout).until(lambda page: next(
        (node for node in page.find_elements(by, value) if node.is_displayed()), None))


def tab_to(driver, target, limit: int = 80) -> None:
    for _ in range(limit):
        ActionChains(driver).send_keys(Keys.TAB).perform()
        if driver.switch_to.active_element == target:
            return
    raise AssertionError(f"Could not keyboard-focus {target.get_attribute('aria-label')}")


def create_history(driver, filename: str, marker: str) -> dict:
    return driver.execute_async_script(r"""
const [name,marker,done]=arguments; let documentId=null;
const request=async(path,options={})=>{
  const response=await fetch(path,options),text=await response.text();
  if(!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
};
(async()=>{
  const first=new FormData();
  first.append('file',new File([`# Version UI QA\n\nOriginal ${marker}.\n`],name,
    {type:'text/markdown'}));
  const document=await request('/api/single-documents',{method:'POST',body:first});
  documentId=document.id;
  const initial=await request(`/api/single-documents/${encodeURIComponent(documentId)}/versions`);
  const v1=initial.versions.find(version=>version.id===initial.current_version_id);
  const next=new FormData();
  next.append('file',new File([`# Version UI QA\n\nReplacement ${marker}.\n`],name,
    {type:'text/markdown'}));
  next.append('expected_current_version_id',v1.id);
  next.append('expected_working_revision',String(v1.working_revision));
  next.append('comment','QA content update');
  const v2=await request(`/api/single-documents/${encodeURIComponent(documentId)}/versions`,
    {method:'POST',body:next});
  const v3=await request(`/api/single-documents/${encodeURIComponent(documentId)}/versions/checkpoint`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      expected_current_version_id:v2.id,expected_working_revision:v2.working_revision,
      comment:'QA checkpoint'
    })
  });
  const history=await request(`/api/single-documents/${encodeURIComponent(documentId)}/versions`);
  done({ok:true,documentId,v1:v1.id,v2:v2.id,v3:v3.id,history});
})().catch(error=>done({ok:false,documentId,error:String(error)}));
""", filename, marker)


def document_state(driver, document_id: str) -> dict:
    return driver.execute_async_script(r"""
const [id,done]=arguments,url=`/api/single-documents/${encodeURIComponent(id)}`;
Promise.all([fetch(url),fetch(`${url}/versions`),fetch(`${url}/file`)]).then(async responses=>{
  if(responses.some(response=>!response.ok)) throw new Error(responses.map(r=>r.status).join(','));
  done({document:await responses[0].json(),history:await responses[1].json(),
    text:await responses[2].text()});
}).catch(error=>done({error:String(error)}));
""", document_id)


def delete_document(driver, document_id: str) -> dict:
    return driver.execute_async_script(r"""
const [id,done]=arguments,url=`/api/single-documents/${encodeURIComponent(id)}`;
(async()=>{
  const current=await fetch(url),document=await current.json();
  if(!current.ok) return done({status:current.status});
  const deleted=await fetch(url,{method:'DELETE',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({expected_current_version_id:document.current_version_id,
      expected_working_revision:document.current_working_revision,
      expected_project_id:document.project_id??null,expected_folder_id:document.folder_id??null})});
  const check=await fetch(url);
  done({status:deleted.status,checkStatus:check.status});
})().catch(error=>done({error:String(error)}));
""", document_id)


def open_document(driver, filename: str):
    search = visible(driver, By.CSS_SELECTOR, "input[type='search']")
    search.clear()
    search.send_keys(filename)
    view = visible(driver, By.XPATH, f"//button[@aria-label='View {filename}']")
    driver.execute_script("arguments[0].scrollIntoView({block:'center'})", view)
    view.click()
    dialog = visible(driver, By.CSS_SELECTOR, "dialog[open]")
    visible(driver, By.CSS_SELECTOR, "ul[aria-label='Document versions']")
    return dialog


def screenshot(driver, output: Path, name: str) -> None:
    assert driver.save_screenshot(str(output / name))


def main() -> None:
    parser = argparse.ArgumentParser(description="Real-browser document-version UI gate")
    parser.add_argument("--url", default="http://127.0.0.1:3000/")
    parser.add_argument("--output", type=Path, default=ROOT / "results")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    token = str(int(time.time() * 1_000))
    filename, marker = f"version-ui-qa-{token}.md", f"marker-{token}"
    report: dict[str, object] = {"url": args.url, "filename": filename}
    document_id = None
    failure: BaseException | None = None

    with tempfile.TemporaryDirectory(prefix="beaver-version-ui-") as profile:
        options = webdriver.ChromeOptions()
        if not args.headed:
            options.add_argument("--headless=new")
        options.add_argument(f"--user-data-dir={profile}")
        options.add_argument("--window-size=1440,900")
        options.set_capability("goog:loggingPrefs", {"browser": "ALL"})
        cached = list((Path.home() / ".cache/selenium/chromedriver/win64")
                      .glob("*/chromedriver.exe"))
        service = Service(str(max(cached, key=lambda path: tuple(
            map(int, path.parent.name.split(".")))))) if cached else Service()
        driver = webdriver.Chrome(service=service, options=options)
        driver.set_script_timeout(60)
        try:
            driver.get(args.url.rstrip("/") + "/")
            visible(driver, By.CSS_SELECTOR, "nav[aria-label='Primary']")
            driver.get_log("browser")

            created = create_history(driver, filename, marker)
            document_id = created.get("documentId")
            assert created.get("ok"), created
            assert len(created["history"]["versions"]) == 3, created
            assert created["history"]["current_version_id"] == created["v3"], created
            report["created"] = {key: created[key] for key in ("documentId", "v1", "v2", "v3")}

            library = visible(driver, By.CSS_SELECTOR,
                "nav[aria-label='Primary'] a[title='Library']")
            library.click()
            WebDriverWait(driver, 30).until(
                lambda page: urlparse(page.current_url).path.startswith("/library"))
            open_document(driver, filename)
            WebDriverWait(driver, 30).until(lambda page: len(page.find_elements(
                By.CSS_SELECTOR, "ul[aria-label='Document versions'] button[aria-label^='Preview Version ']")) == 3)
            visible(driver, By.XPATH, f"//*[contains(normalize-space(),'Replacement {marker}')]")
            screenshot(driver, args.output, "00-current-version.png")

            preview = visible(driver, By.CSS_SELECTOR,
                "button[aria-label^='Preview Version 1:']")
            tab_to(driver, preview)
            preview.send_keys(Keys.ENTER)
            visible(driver, By.XPATH, f"//*[contains(normalize-space(),'Original {marker}')]")
            before_restore = document_state(driver, document_id)
            assert len(before_restore["history"]["versions"]) == 3, before_restore
            screenshot(driver, args.output, "01-old-version-preview.png")

            restore = visible(driver, By.CSS_SELECTOR,
                "button[aria-label='Restore Version 1 as a new current version']")
            tab_to(driver, restore)
            restore.click()
            confirm_dialog = visible(driver, By.CSS_SELECTOR,
                "dialog[open][role='alertdialog']")
            confirm = visible(confirm_dialog, By.XPATH, ".//button[normalize-space()='Restore']")
            tab_to(driver, confirm)
            screenshot(driver, args.output, "02-restore-confirm.png")
            confirm.click()
            WebDriverWait(driver, 30).until(lambda page: not page.find_elements(
                By.CSS_SELECTOR, "dialog[open][role='alertdialog']"))
            WebDriverWait(driver, 30).until(lambda page: len(page.find_elements(
                By.CSS_SELECTOR, "ul[aria-label='Document versions'] button[aria-label^='Preview Version ']")) == 4)
            restored = document_state(driver, document_id)
            assert "error" not in restored, restored
            assert len(restored["history"]["versions"]) == 4, restored
            current_id = restored["history"]["current_version_id"]
            current = next(version for version in restored["history"]["versions"]
                           if version["id"] == current_id)
            assert current_id not in (created["v1"], created["v2"], created["v3"]), restored
            assert current["source"] == "restore", current
            assert f"Original {marker}" in restored["text"], restored["text"]
            screenshot(driver, args.output, "03-restored-current.png")

            driver.refresh()
            open_document(driver, filename)
            WebDriverWait(driver, 30).until(lambda page: len(page.find_elements(
                By.CSS_SELECTOR, "ul[aria-label='Document versions'] button[aria-label^='Preview Version ']")) == 4)
            durable = document_state(driver, document_id)
            assert durable["history"]["current_version_id"] == current_id, durable
            assert len(durable["history"]["versions"]) == 4, durable
            assert f"Original {marker}" in durable["text"], durable["text"]
            visible(driver, By.XPATH, f"//*[contains(normalize-space(),'Original {marker}')]")
            screenshot(driver, args.output, "04-reloaded-durable.png")
            report.update({"ok": True, "versionCount": 4, "restoredVersion": current_id})
        except BaseException as error:
            failure = error
            report.update({"ok": False, "error": repr(error)})
            screenshot(driver, args.output, "failure.png")
            (args.output / "failure.html").write_text(driver.page_source, encoding="utf-8")
        finally:
            console = driver.get_log("browser")
            severe = [entry for entry in console if entry.get("level") == "SEVERE"]
            (args.output / "browser-console.json").write_text(
                json.dumps(console, indent=2), encoding="utf-8")
            report["consoleFailures"] = severe
            if document_id:
                report["cleanup"] = delete_document(driver, document_id)
                if report["cleanup"] != {"status": 204, "checkStatus": 404} and failure is None:
                    failure = AssertionError(f"Cleanup failed: {report['cleanup']}")
            if severe and failure is None:
                failure = AssertionError(f"Severe browser console entries: {severe}")
            report["screenshots"] = sorted(path.name for path in args.output.glob("*.png")
                                           if failure or path.name != "failure.png")
            (args.output / "RESULTS.json").write_text(
                json.dumps(report, indent=2), encoding="utf-8")
            driver.quit()

    print(json.dumps(report))
    if failure:
        raise failure


if __name__ == "__main__":
    main()
