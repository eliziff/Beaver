"""Shared Chrome and fixture helpers for the browser checks."""
from pathlib import Path
import json
import os
import sys
from uuid import uuid4

from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def chrome(profile: Path, headed: bool, prefs: dict | None = None) -> webdriver.Chrome:
    options = webdriver.ChromeOptions()
    browser = next((path for path in (
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    ) if path.is_file()), None)
    if not browser:
        raise RuntimeError("Google Chrome is required.")
    options.binary_location = str(browser)
    if not headed:
        options.add_argument("--headless=new")
    for flag in ("--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
                 "--disable-crash-reporter", "--no-first-run"):
        options.add_argument(flag)
    options.add_argument(f"--user-data-dir={profile}")
    options.add_argument("--window-size=1440,900")
    if prefs:
        options.add_experimental_option("prefs", prefs)
    options.set_capability("goog:loggingPrefs", {"browser": "ALL", "performance": "ALL"})
    cached = list((Path.home() / ".cache/selenium/chromedriver/win64").glob("*/chromedriver.exe"))
    service = Service(str(max(cached, key=lambda path: tuple(map(int, path.parent.name.split(".")))))) \
        if cached else Service()
    driver = webdriver.Chrome(service=service, options=options)
    mark_test_prompts(driver)
    return driver


def mark_test_prompts(driver):
    driver.prompt_submission = {
        "origin": "machine_test",
        "run_id": os.environ.get("BEAVER_TEST_RUN_ID") or f"browser-{uuid4()}",
        "scenario": os.environ.get("BEAVER_TEST_SCENARIO") or Path(sys.argv[0]).name,
    }
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source":
        "try { sessionStorage.setItem('beaver.promptSubmission', "
        + json.dumps(json.dumps(driver.prompt_submission)) + "); } catch {}"})


def visible(driver, by: str, value: str, root=None, timeout=30):
    return WebDriverWait(driver, timeout, ignored_exceptions=(StaleElementReferenceException,)).until(lambda page: next(
        (node for node in (root or page).find_elements(by, value) if node.is_displayed()), None))


def click_text(driver, text: str, root=None, timeout=30):
    xpath = f".//button[normalize-space()='{text}' or @aria-label='{text}']"
    node = visible(driver, By.XPATH, xpath, root, timeout)
    driver.execute_script("arguments[0].scrollIntoView({block:'center'})", node)
    node.click()
    return node


def api(driver, method, path, body=None):
    if method.upper() == "POST" and path.rstrip("/") in ("/api/chat", "/chat") and isinstance(body, dict):
        body = {**body, "submission": driver.prompt_submission}
    result = driver.execute_async_script("""const [method,path,body,done]=arguments;
fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined})
  .then(async r=>done({status:r.status,value:await r.json().catch(()=>null)})).catch(e=>done({error:String(e)}));""",
        method, path, body)
    assert result.get("status") in (200, 201, 204), {"path": path, "result": result}
    return result.get("value")


def upload(driver, filename, text):
    result = driver.execute_async_script("""const [name,text,done]=arguments;
const form=new FormData();form.append('file',new File([text],name,{type:'text/plain'}));
fetch('/api/library/files/documents',{method:'POST',body:form}).then(async r=>done({status:r.status,value:await r.json()}))
  .catch(e=>done({error:String(e)}));""", filename, text)
    assert result.get("status") == 201, result
    return result["value"]
