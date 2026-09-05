"""Real Chrome folder creation through Settings; removes only its own fixtures."""
import argparse
import json
import runpy
import tempfile
import uuid
from pathlib import Path

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

helpers = runpy.run_path(str(Path(__file__).with_name("test-authorities-browser.py")))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000/sources")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="beaver-folder-chrome-") as profile:
        driver = helpers["chrome"](Path(profile), False)
        wait = WebDriverWait(driver, 30)
        original = None

        def api(path, method="GET", body=None):
            result = driver.execute_async_script("""
const [path,method,body,done]=arguments;
fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},
  ...(body===null?{}:{body:JSON.stringify(body)})}).then(async r=>
  done({ok:r.ok,status:r.status,text:await r.text()})).catch(e=>done({error:String(e)}));
""", path, method, body)
            assert result.get("ok"), result
            return json.loads(result["text"]) if result["text"] else None

        def visible(xpath):
            return wait.until(lambda page: next((node for node in page.find_elements(By.XPATH, xpath)
                                                if node.is_displayed()), None))

        def click(text):
            visible(f"//button[normalize-space(.)='{text}']").click()

        try:
            driver.set_window_size(1440, 1000)
            driver.get(args.url)
            click("Settings")
            original = api("/user/profile")["workflowFileTargets"]
            driver.execute_script("""
window.__createdFolders=[]; const original=window.fetch;
window.fetch=async(...args)=>{const response=await original(...args);
  if(String(args[0]).endsWith('/library/files/folders')&&args[1]?.method==='POST'&&response.ok)
    window.__createdFolders.push(await response.clone().json());
  return response;};
""")
            click("Choose folder")
            click("New folder")
            field = visible("//label[contains(.,'Folder name')]/input")
            field.send_keys("Cancelled", Keys.ESCAPE)
            assert not driver.find_elements(By.XPATH, "//label[contains(.,'Folder name')]/input")
            assert visible("//button[normalize-space(.)='Use folder']")
            names = [f"QA folders {uuid.uuid4().hex[:10]}", "Nested decisions"]
            for index, name in enumerate(names):
                print(f"Creating {'root' if index == 0 else 'nested'} folder through Settings", flush=True)
                click("New folder")
                field = visible("//label[contains(.,'Folder name')]/input")
                field.send_keys(name)
                driver.save_screenshot(str(args.output / f"0{index + 1}-create.png"))
                click("Create")
                wait.until(lambda _: len(driver.execute_script("return window.__createdFolders")) == index + 1)
                visible(f"//*[@aria-label='Choose destination folder']//p[normalize-space(.)='{name}']")
            created = driver.execute_script("return window.__createdFolders")
            assert created[0]["parent_folder_id"] is None
            assert created[1]["parent_folder_id"] == created[0]["id"]
            driver.set_window_size(480, 850)
            driver.save_screenshot(str(args.output / "03-nested-narrow.png"))
            click("Use folder")
            wait.until(lambda _: api("/user/profile")["workflowFileTargets"]["court-records"] == {
                "kind": "library", "folderId": created[1]["id"]})
            driver.save_screenshot(str(args.output / "04-selected.png"))
            errors = [row for row in driver.get_log("browser") if row["level"] == "SEVERE"]
            assert not errors, errors
            report = {"created": created, "selected": created[1]["id"], "consoleErrors": errors}
            (args.output / "RESULTS.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report))
        except Exception:
            driver.save_screenshot(str(args.output / "failure.png"))
            raise
        finally:
            try:
                created = driver.execute_script("return window.__createdFolders || []")
                current = api("/user/profile")["workflowFileTargets"]
                target = current.get("court-records")
                if original is not None and target and target.get("kind") == "library" and any(
                        folder["id"] == target.get("folderId") for folder in created):
                    api("/user/profile", "PATCH", {"workflowFileTargets": {
                        **current, "court-records": original["court-records"]}})
                for folder in reversed(created):
                    api(f"/library/files/folders/{folder['id']}", "DELETE")
                print("Restored file locations and removed created folders", flush=True)
            finally:
                driver.quit()


if __name__ == "__main__":
    main()
